/**
 * Client WhatsApp : connexion, ecoute, filtrage de l'expediteur, envoi
 * temporise (section 6.1).
 *
 * Implemente avec Baileys, qui parle le protocole WhatsApp directement (pas
 * de navigateur, pas de store interne a interroger). Remplace whatsapp-web.js,
 * dont le magasin de messages s'est revele inaccessible sur cette session
 * (recherche par identifiant et par chat toutes deux en echec, y compris
 * apres reappairage) — voir le journal du 15/08/2026.
 *
 * Points de vigilance :
 *  - useMultiFileAuthState pointe sur data/session : un redemarrage ne
 *    redemande pas d'appairage ;
 *  - MULTI-UTILISATEUR (section 6.9) : tout chat WhatsApp individuel (pas
 *    un groupe, pas un statut, pas une newsletter) est traite comme un
 *    utilisateur a part entiere, identifie par son JID canonique. Il n'y a
 *    plus de notion de "chat personnel" reserve au proprietaire — voir
 *    estChatIndividuel()/jidCanonique(). Ouvert a tous sans liste blanche ni
 *    quota (choix assume : n'importe qui connaissant le numero peut
 *    declencher des appels DeepSeek factures au proprietaire) ;
 *  - un meme contact peut arriver adresse en @lid OU en @s.whatsapp.net
 *    (observe le 17/08/2026 pour le proprietaire) : jidCanonique() normalise
 *    toujours vers @s.whatsapp.net via le mapping LID de Baileys, jamais
 *    l'inverse — c'est ce qui permet a un profil migre depuis l'ancien
 *    schema mono-utilisateur (voir src/db/migration.ts) de rester retrouve ;
 *  - les envois sont serialises avec une temporisation de 1 a 2 s.
 */
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import qrimage from 'qrcode';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  jidDecode,
  useMultiFileAuthState,
  downloadMediaMessage,
  type WASocket,
  type WAMessage,
} from '@whiskeysockets/baileys';
import { config } from './config.js';
import { logger } from './logger.js';
import { jidProprietaire } from './identite.js';

export interface PieceJointe {
  base64: string;
  mimetype: string;
  nom: string;
}

/** Evenements applicatifs distincts, consommes par index.ts. Chaque evenement
 *  porte le JID de l'utilisateur concerne, en premier element. */
export interface EvenementsBot {
  pret: [];
  texte: [string, string];
  piece_jointe: [string, PieceJointe];
  deconnexion: [string];
  abandon: [];
}

class BusEvenements extends EventEmitter {}
export const bus = new BusEvenements();

/** Numero sans le suffixe @c.us : format attendu par l'appairage Baileys. */
const numeroBrut = config.NUMERO_AUTORISE.replace(/@c\.us$/, '');
/** Toujours sous DATA_DIR (ex. /data sur Railway), jamais ./data relatif. */
const CHEMIN_QR = join(config.chemins.data, 'qr.png');

/** Logger interne de Baileys : redirige vers le notre serait bruyant, on le tait. */
const waLogger = pino({ level: 'silent' });

let sock: WASocket | undefined;
let pret = false;
/** Horodatage du dernier QR ecrit (dashboard : savoir s'il y a une image fraiche). */
let qrGenereLe: number | null = null;
/** PNG du QR en memoire (evite un ecart disque entre process et dashboard). */
let qrPng: Buffer | null = null;
/** Code d'appairage a 8 caracteres, si APPAIRAGE_PAR_CODE est actif. */
let codeAppairage: string | null = null;
/** true juste apres un scan reussi (515) : la session se finalise. */
let liaisonEnCours = false;
/** Version WhatsApp Web mise en cache pour ne pas retarder les reconnexions post-scan. */
let versionCache: [number, number, number] | undefined;

export const estPret = () => pret;
export const dernierQrGenereLe = () => qrGenereLe;
export const tamponQrPng = () => qrPng;
export const codeAppairageActuel = () => codeAppairage;
export const estLiaisonEnCours = () => liaisonEnCours;

/** Numero du compte actuellement appaire (dashboard admin), null si non connecte. */
export function numeroConnecte(): string | null {
  if (!pret || !sock?.user?.id) return null;
  return jidDecode(sock.user.id)?.user ?? null;
}

/** Efface la session locale (fichiers Baileys + image QR). */
async function effacerSessionLocale(): Promise<void> {
  await rm(config.chemins.session, { recursive: true, force: true });
  await rm(CHEMIN_QR, { force: true }).catch(() => undefined);
  qrGenereLe = null;
  qrPng = null;
  codeAppairage = null;
}

/**
 * Session "zombie" : un appairage a demarre puis a echoue a mi-chemin
 * (`me` present mais `registered: false`, sans preuve d'une session deja
 * utilisee). On ne purge PAS au simple motif `me && !registered` : apres un
 * scan reussi, Baileys peut ecrire `me` avant `registered=true`, et une purge
 * ici detruirait une liaison fraiche (constate le 25/08/2026).
 */
async function sessionIncoherente(): Promise<boolean> {
  try {
    const brut = await readFile(join(config.chemins.session, 'creds.json'), 'utf8');
    const creds = JSON.parse(brut) as {
      registered?: boolean;
      me?: unknown;
      lastAccountSyncTimestamp?: number;
      accountSyncCounter?: number;
    };
    if (creds.registered === true) return false;
    if (!creds.me) return false;
    // Session deja synchronisee au moins une fois : tenter la reconnexion.
    if (creds.lastAccountSyncTimestamp || (creds.accountSyncCounter ?? 0) > 0) return false;
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Envoi temporise et serialise                                        */
/* ------------------------------------------------------------------ */

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Temporisation aleatoire entre deux messages : 1 a 2 secondes. */
const temporisation = () => 1000 + Math.floor(Math.random() * 1000);

/** Decoupe defensive : WhatsApp rend mal les messages tres longs. */
const LONGUEUR_MAX_MESSAGE = 4000;

function decouper(message: string, taille: number): string[] {
  if (message.length <= taille) return [message];

  const morceaux: string[] = [];
  let reste = message;
  while (reste.length > taille) {
    const coupure = reste.lastIndexOf('\n', taille);
    const index = coupure > taille * 0.5 ? coupure : taille;
    morceaux.push(reste.slice(0, index));
    reste = reste.slice(index).replace(/^\n/, '');
  }
  if (reste) morceaux.push(reste);
  return morceaux;
}

/**
 * Identifiants des messages emis par CE client, et empreintes de leur contenu.
 *
 * Deux filets independants contre l'auto-reponse en boucle (le chat personnel
 * ne distingue pas "envoye par le bot" de "tape par l'utilisateur" via
 * fromMe : les deux valent true). L'identifiant est fiable avec Baileys
 * (contrairement a whatsapp-web.js, ou la forme changeait entre l'envoi et la
 * reception) ; le contenu reste en secours au cas ou.
 */
const idsEmis = new Set<string>();
const MAX_IDS_EMIS = 200;

function memoriserEmission(id: string): void {
  idsEmis.add(id);
  if (idsEmis.size > MAX_IDS_EMIS) {
    const plusAncien = idsEmis.values().next().value;
    if (plusAncien !== undefined) idsEmis.delete(plusAncien);
  }
}

const empreintesEmises = new Map<string, number>();
const DUREE_EMPREINTE_MS = 5 * 60_000;

function empreinte(texte: string): string {
  return texte.trim().slice(0, 500);
}

function memoriserContenuEmis(texte: string): void {
  const maintenant = Date.now();
  for (const [cle, date] of empreintesEmises) {
    if (maintenant - date > DUREE_EMPREINTE_MS) empreintesEmises.delete(cle);
  }
  empreintesEmises.set(empreinte(texte), maintenant);
}

function contenuDejaEmis(texte: string): boolean {
  const date = empreintesEmises.get(empreinte(texte));
  return date !== undefined && Date.now() - date <= DUREE_EMPREINTE_MS;
}

/**
 * Coupe-circuit : au-dela de ce rythme, l'envoi est suspendu. Un digest legitime
 * fait au maximum une dizaine de messages d'affilee ; au-dela, c'est une boucle.
 * Verrouillage definitif : ne se referme pas tout seul, pour ne jamais laisser
 * une boucle repartir au rythme du seuil.
 */
const MAX_ENVOIS_PAR_MINUTE = 25;
const horodatagesEnvois: number[] = [];
let circuitOuvert = false;

function envoiAutoriseParCircuit(): boolean {
  if (circuitOuvert) return false;

  const maintenant = Date.now();
  while (horodatagesEnvois.length && maintenant - horodatagesEnvois[0]! > 60_000) {
    horodatagesEnvois.shift();
  }

  if (horodatagesEnvois.length >= MAX_ENVOIS_PAR_MINUTE) {
    circuitOuvert = true;
    logger.error(
      `Coupe-circuit : plus de ${MAX_ENVOIS_PAR_MINUTE} messages en une minute. ` +
        'Envois definitivement suspendus jusqu au redemarrage du processus.',
    );
    return false;
  }

  horodatagesEnvois.push(maintenant);
  return true;
}

let file: Promise<void> = Promise.resolve();
let dernierEnvoi = 0;

/**
 * Envoi centralise. C'est la SEULE fonction autorisee a ecrire sur WhatsApp.
 * `jid` designe l'utilisateur destinataire — plus de destination fixe unique.
 * Le coupe-circuit anti-boucle reste volontairement GLOBAL (tout compte
 * confondu), pas par utilisateur : c'est un filet de securite contre un bug
 * qui s'emballerait, pas un quota, et le repartir par utilisateur laisserait
 * une boucle affectant plusieurs jids passer sous chaque seuil individuel.
 */
export function envoyer(jid: string, message: string): Promise<void> {
  const suite = file.then(async () => {
    if (!pret || !sock) {
      logger.warn('Message non envoye : client WhatsApp non pret', { jid, longueur: message.length });
      return;
    }

    const morceaux = decouper(message, LONGUEUR_MAX_MESSAGE);

    for (const morceau of morceaux) {
      const ecoule = Date.now() - dernierEnvoi;
      const attente = temporisation();
      if (ecoule < attente) await dormir(attente - ecoule);

      if (!envoiAutoriseParCircuit()) return;

      try {
        memoriserContenuEmis(morceau);
        const envoye = await sock.sendMessage(jid, { text: morceau });
        if (envoye?.key?.id) memoriserEmission(envoye.key.id);
        dernierEnvoi = Date.now();
        // En INFO : un envoi est un evenement significatif, et c'est en le
        // taisant qu'une boucle a tourne 40 s sans laisser de trace lisible
        // (constate le 15/08/2026 avec l'ancienne bibliotheque).
        logger.info('Message envoye', { jid, caracteres: morceau.length });
      } catch (erreur) {
        logger.error('Envoi WhatsApp en echec', { jid, erreur });
      }
    }
  });

  // La file ne doit jamais rester bloquee sur une erreur.
  file = suite.catch((erreur) => {
    logger.error('Erreur dans la file d envoi', erreur);
  });

  return file;
}

/* ------------------------------------------------------------------ */
/* Reception                                                           */
/* ------------------------------------------------------------------ */

function estStatutOuBroadcast(jid: string | undefined | null): boolean {
  if (!jid) return true;
  return isJidStatusBroadcast(jid) || jid === 'status@broadcast';
}

/** Vrai pour tout chat individuel (1:1) : exclut groupes, newsletters, statuts. */
function estChatIndividuel(remoteJid: string | undefined | null): boolean {
  if (!remoteJid) return false;
  if (isJidGroup(remoteJid) || isJidNewsletter(remoteJid) || estStatutOuBroadcast(remoteJid)) return false;
  return Boolean(jidDecode(remoteJid)?.user);
}

/**
 * Normalise un JID entrant vers sa forme canonique @s.whatsapp.net (jamais
 * l'inverse), via le mapping LID<->numero que Baileys tient a jour en interne
 * (sock.signalRepository.lidMapping). Necessaire car un meme contact peut
 * arriver adresse en @lid ou en @s.whatsapp.net selon l'etat de la migration
 * LID de WhatsApp (observe le 17/08/2026 pour le proprietaire). Repli sur le
 * LID brut si la resolution echoue (contact tres recent, mapping pas encore
 * connu de Baileys) : risque faible qu'un meme contact se scinde alors en
 * deux identites si la resolution reussit plus tard sur un message suivant.
 */
async function jidCanonique(remoteJid: string): Promise<string | null> {
  const decoded = jidDecode(remoteJid);
  if (!decoded?.user) return null;

  if (decoded.server === 'lid') {
    try {
      const pn = await sock?.signalRepository.lidMapping.getPNForLID(remoteJid);
      // getPNForLID() peut renvoyer un JID avec suffixe d'appareil
      // (ex. "226...:0@s.whatsapp.net") : on le repasse par jidDecode() pour
      // ne garder que le numero, exactement comme sur l'autre branche.
      // Bug reel constate le 17/08/2026 : sans cette normalisation, TOUS les
      // jids issus de cette branche gardaient ":0", y compris celui du
      // proprietaire — rendant son profil fraichement migre injoignable
      // (cle differente de celle ecrite par la migration).
      const utilisateur = pn ? jidDecode(pn)?.user : undefined;
      if (utilisateur) return `${utilisateur}@s.whatsapp.net`;
    } catch (erreur) {
      logger.warn('Resolution LID -> numero en echec, repli sur le LID brut', { remoteJid, erreur });
    }
    return `${decoded.user}@lid`;
  }
  return `${decoded.user}@s.whatsapp.net`;
}

/** Telecharge une piece jointe. Baileys lit directement les serveurs media de
 * WhatsApp via les cles chiffrees du message : pas de navigateur, pas de
 * magasin interne, donc pas de la classe de panne rencontree avec
 * whatsapp-web.js. */
async function traiterPieceJointeEntrante(
  jid: string,
  message: WAMessage,
  mimetype: string | null | undefined,
  nom: string | null | undefined,
): Promise<void> {
  if (!sock) return;

  try {
    const buffer = await downloadMediaMessage(
      message,
      'buffer',
      {},
      { logger: waLogger, reuploadRequest: sock.updateMediaMessage },
    );

    bus.emit('piece_jointe', jid, {
      base64: buffer.toString('base64'),
      mimetype: mimetype ?? '',
      nom: nom ?? 'cv',
    } satisfies PieceJointe);
  } catch (erreur) {
    logger.error('Telechargement de la piece jointe en echec', erreur);
    await envoyer(jid, "Je n'ai pas reussi a telecharger ce fichier. Renvoie-le moi.");
  }
}

async function traiterMessage(message: WAMessage): Promise<void> {
  logger.debug('Message a traiter', {
    remoteJid: message.key.remoteJid,
    fromMe: message.key.fromMe,
    id: message.key.id,
    aDocument: Boolean(message.message?.documentMessage),
    aTexte: Boolean(message.message?.conversation ?? message.message?.extendedTextMessage?.text),
    cles: message.message ? Object.keys(message.message) : [],
  });

  const remoteJid = message.key.remoteJid;
  if (!estChatIndividuel(remoteJid)) return;

  const jid = await jidCanonique(remoteJid!);
  if (!jid) return;

  const id = message.key.id;
  if (id && idsEmis.has(id)) {
    // Message emis par le bot : ne jamais le retraiter comme une entree.
    return;
  }

  const document = message.message?.documentMessage;
  if (document) {
    await traiterPieceJointeEntrante(jid, message, document.mimetype, document.fileName);
    return;
  }

  const texte = message.message?.conversation ?? message.message?.extendedTextMessage?.text;
  if (typeof texte === 'string' && texte.length > 0) {
    // Le filet par contenu ne sert que pour le chat du proprietaire (seul cas
    // ou fromMe est ambigu entre "tape par lui" et "echo du bot"). Pour un
    // tiers, fromMe est fiable et le filet par identifiant (idsEmis) suffit
    // deja ; l'appliquer a tout le monde risquerait de supprimer a tort le
    // message d'un second utilisateur tapant le meme texte que le
    // proprietaire dans les 5 minutes precedentes.
    if (jid === jidProprietaire && contenuDejaEmis(texte)) {
      logger.debug('Message emis par le bot, ignore (contenu identique)');
      return;
    }
    bus.emit('texte', jid, texte);
    return;
  }

  // Reaction, accuse de lecture, appel... rien d'exploitable : ignore silencieusement.
}

/* ------------------------------------------------------------------ */
/* Cycle de vie                                                        */
/* ------------------------------------------------------------------ */

/** Pendant l'attente du scan QR, WhatsApp ferme souvent avec 408 : ce n'est
 *  pas un echec reseau, il faut continuer a regenerer des QR sans abandonner. */
const MAX_RECONNEXIONS = 5;
const MAX_RECONNEXIONS_APPAIRAGE = 40;
/** Evite une boucle de purge session (500 a repetition = rate-limit WhatsApp). */
const DELAI_MIN_PURGE_MS = 45_000;
let tentativesReconnexion = 0;
let reconnexionEnCours = false;
let dernierePurgeSession = 0;
/** true tant que l'on attend un premier appairage (pas encore `open`). */
let enAttenteAppairage = false;

async function fermerSocketCourant(): Promise<void> {
  const actuel = sock;
  sock = undefined;
  if (!actuel) return;
  try {
    actuel.ev.removeAllListeners('connection.update');
    actuel.ev.removeAllListeners('creds.update');
    actuel.ev.removeAllListeners('messages.upsert');
    // end() peut rester bloque plusieurs dizaines de secondes apres un 515 :
    // on plafonne pour ne pas faire attendre l'utilisateur apres un scan.
    await Promise.race([actuel.end(undefined), dormir(1500)]);
  } catch {
    // deja ferme
  }
}

async function resoudreVersionWhatsApp(): Promise<[number, number, number] | undefined> {
  if (versionCache) return versionCache;
  try {
    const wa = await Promise.race([
      fetchLatestWaWebVersion(),
      dormir(4000).then(() => null),
    ]);
    if (wa && 'isLatest' in wa && wa.isLatest) {
      versionCache = wa.version;
      return versionCache;
    }
    const baileys = await Promise.race([
      fetchLatestBaileysVersion(),
      dormir(3000).then(() => null),
    ]);
    if (baileys && 'version' in baileys) {
      versionCache = baileys.version;
      return versionCache;
    }
  } catch (erreur) {
    logger.debug('Version WhatsApp Web indisponible, valeur Baileys par defaut', erreur);
  }
  return versionCache;
}

async function reconnecter(immediat: boolean, reinitialiserSession = false): Promise<void> {
  if (reconnexionEnCours) return;
  reconnexionEnCours = true;

  try {
    await fermerSocketCourant();

    if (reinitialiserSession) {
      const depuis = Date.now() - dernierePurgeSession;
      if (depuis < DELAI_MIN_PURGE_MS) {
        const attente = DELAI_MIN_PURGE_MS - depuis;
        logger.warn(
          `Purge session ignoree (derniere il y a ${Math.round(depuis / 1000)} s) — ` +
            `attente ${Math.round(attente / 1000)} s pour eviter un blocage WhatsApp`,
        );
        await dormir(attente);
      } else {
        await effacerSessionLocale();
        dernierePurgeSession = Date.now();
        tentativesReconnexion = 0;
        enAttenteAppairage = true;
      }
    }

    if (immediat && !reinitialiserSession) {
      // restartRequired (515) suit systematiquement un appairage reussi.
      tentativesReconnexion = 0;
      liaisonEnCours = true;
      logger.info('Scan accepte — finalisation de la liaison WhatsApp…');
    } else if (!immediat || reinitialiserSession) {
      const plafond = enAttenteAppairage ? MAX_RECONNEXIONS_APPAIRAGE : MAX_RECONNEXIONS;
      if (tentativesReconnexion >= plafond) {
        logger.error(
          `Reconnexion impossible apres ${plafond} tentatives. Arret propre du processus ; ` +
            'pm2 le relancera. Si le probleme persiste : efface data/session et relance, ' +
            'ou verifie la connexion reseau.',
        );
        bus.emit('abandon');
        return;
      }
    }

    // Apres une purge, toujours patienter un peu (WhatsApp rate-limit les
    // handshakes trop rapproches — cause frequente de "Impossible de connecter").
    const attente = immediat && !reinitialiserSession
      ? 0
      : Math.min(30_000, (reinitialiserSession ? 5000 : 3000) * 2 ** Math.min(tentativesReconnexion, 4));
    tentativesReconnexion++;

    if (attente > 0) {
      const plafond = enAttenteAppairage ? MAX_RECONNEXIONS_APPAIRAGE : MAX_RECONNEXIONS;
      logger.warn(
        `Reconnexion WhatsApp dans ${Math.round(attente / 1000)} s ` +
          `(tentative ${tentativesReconnexion}/${plafond})`,
      );
      await dormir(attente);
    }

    sock = await creerSocket();
  } catch (erreur) {
    logger.error('Reconnexion WhatsApp en echec', erreur);
  } finally {
    reconnexionEnCours = false;
  }
}

async function creerSocket(): Promise<WASocket> {
  const { state, saveCreds } = await useMultiFileAuthState(config.chemins.session);
  enAttenteAppairage = !state.creds.registered;

  const version = await resoudreVersionWhatsApp();
  if (version) {
    logger.info('Version WhatsApp Web utilisee', { version: version.join('.') });
  }

  // Empreinte navigateur proche d'un vrai WhatsApp Desktop (Windows ici).
  const navigateur =
    process.platform === 'win32'
      ? Browsers.windows('Chrome')
      : process.platform === 'darwin'
        ? Browsers.macOS('Chrome')
        : Browsers.ubuntu('Chrome');

  const s = makeWASocket({
    auth: state,
    logger: waLogger,
    browser: navigateur,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    keepAliveIntervalMs: 15_000,
    ...(version ? { version } : {}),
  });

  s.ev.on('creds.update', saveCreds);

  if (config.APPAIRAGE_PAR_CODE && !state.creds.registered) {
    // Le socket doit avoir entame sa connexion avant d'accepter la demande.
    setTimeout(() => {
      s.requestPairingCode(numeroBrut)
        .then((code) => {
          const lisible = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
          codeAppairage = lisible;
          logger.info(`Code d appairage : ${lisible}`);
          logger.info(
            `A saisir sur le telephone : WhatsApp > Appareils lies > Lier un appareil > ` +
              `Lier avec le numero de telephone (numero attendu : +${numeroBrut})`,
          );
        })
        .catch((erreur) => logger.error('Demande du code d appairage en echec', erreur));
    }, 3000);
  }

  s.ev.on('connection.update', (maj) => {
    const { connection, lastDisconnect, qr } = maj;

    if (qr && !config.APPAIRAGE_PAR_CODE) {
      // Un nouveau QR = connexion saine cote serveur : on remet le compteur
      // (sinon les 408 d'expiration du QR epuisent le plafond et tuent le process
      // avant que l'utilisateur ait pu scanner).
      tentativesReconnexion = 0;
      enAttenteAppairage = true;
      liaisonEnCours = false;
      logger.info('QR code a scanner (WhatsApp > Appareils lies > Lier un appareil)');
      qrcode.generate(qr, { small: true });
      qrimage
        .toBuffer(qr, { width: 512, margin: 2, errorCorrectionLevel: 'M' })
        .then((buf) => {
          qrPng = buf;
          qrGenereLe = Date.now();
          logger.info('QR pret pour le dashboard', { octets: buf.length });
        })
        .catch((erreur) => logger.error('Generation du QR en image en echec', erreur));
    }

    if (connection === 'open') {
      pret = true;
      enAttenteAppairage = false;
      liaisonEnCours = false;
      tentativesReconnexion = 0;
      qrGenereLe = null;
      qrPng = null;
      codeAppairage = null;
      void rm(CHEMIN_QR, { force: true }).catch(() => undefined);
      logger.info('Client WhatsApp pret');
      bus.emit('pret');
    }

    if (connection === 'close') {
      pret = false;
      const boom = lastDisconnect?.error as
        | { message?: string; output?: { statusCode?: number }; data?: { code?: string } }
        | undefined;
      const code = boom?.output?.statusCode;
      const messageErreur = boom?.message ?? '';
      const codeTls = boom?.data?.code ?? '';
      logger.warn('Client WhatsApp deconnecte', {
        code: code ?? 'inconnu',
        detail: messageErreur || undefined,
      });
      bus.emit('deconnexion', String(code ?? 'inconnu'));

      const erreurTls =
        /UNABLE_TO_VERIFY|certificate|LEAF_SIGNATURE/i.test(messageErreur) ||
        /UNABLE_TO_VERIFY|LEAF_SIGNATURE/i.test(codeTls);

      if (erreurTls) {
        logger.error(
          'Echec TLS vers WhatsApp (souvent un antivirus qui intercepte le HTTPS). ' +
            'Verifie que WHATSAPP_TLS_INSECURE=true dans .env, puis relance.',
        );
        void reconnecter(false);
        return;
      }

      if (code === DisconnectReason.loggedOut) {
        logger.error(
          'Appareil delie cote WhatsApp : la session est revoquee. ' +
            'Reinitialisation pour generer un nouvel appairage.',
        );
        liaisonEnCours = false;
        void reconnecter(true, true);
        return;
      }

      // badSession n'a de sens que si on avait deja des creds enregistrees.
      // Un 500 sur session vierge (ex. TLS mappe en 500) ne doit PAS purger en boucle.
      if (code === DisconnectReason.badSession && state.creds.registered) {
        logger.warn(
          'Session invalide (badSession / 500) : purge et nouvel appairage. ' +
            'Cote telephone, cela se traduisait souvent par "Impossible de connecter l appareil".',
        );
        liaisonEnCours = false;
        void reconnecter(false, true);
        return;
      }

      if (code === DisconnectReason.connectionReplaced) {
        logger.error(
          'Connexion remplacee : une autre instance de whatsapp-veille a pris la session. ' +
            'Arrete-la avant de relancer celle-ci.',
        );
        bus.emit('abandon');
        return;
      }

      // 515 = scan accepte, redemarrage immediat (ne pas ralentir ici).
      // 408 pendant l'attente du QR = expiration normale.
      void reconnecter(code === DisconnectReason.restartRequired);
    }
  });

  s.ev.on('messages.upsert', ({ messages, type }) => {
    logger.debug('messages.upsert recu', { type, nombre: messages.length });
    // 'append' correspond a un lot d'historique (rejoue a chaque reconnexion) :
    // le traiter reexecuterait de vieilles commandes. Seul 'notify' est du direct.
    if (type !== 'notify') return;
    for (const message of messages) {
      traiterMessage(message).catch((erreur) => logger.error('Traitement du message en echec', erreur));
    }
  });

  return s;
}

export async function demarrer(): Promise<void> {
  if (config.WHATSAPP_TLS_INSECURE) {
    // Antivirus / proxy SSL local : sans cela, le handshake WhatsApp echoue
    // avec UNABLE_TO_VERIFY_LEAF_SIGNATURE et le telephone affiche
    // "Impossible de connecter l appareil".
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    logger.warn(
      'Verification TLS desactivee pour WhatsApp (WHATSAPP_TLS_INSECURE=true). ' +
        'Normal sur Windows avec antivirus ; mets false si ta chaine de certificats est saine.',
    );
  }

  logger.info('Initialisation du client WhatsApp', { session: config.chemins.session });

  if (await sessionIncoherente()) {
    logger.warn(
      'Session WhatsApp incomplete detectee (me present, registered=false) : purge avant demarrage',
    );
    await effacerSessionLocale();
  }

  sock = await creerSocket();
}

export async function arreter(): Promise<void> {
  pret = false;
  try {
    await sock?.end(undefined);
    logger.info('Client WhatsApp arrete');
  } catch (erreur) {
    logger.warn('Arret du client WhatsApp en echec', erreur);
  }
}

/**
 * Deconnecte le numero actuellement appaire et efface la session locale, pour
 * permettre d'en appairer un autre (dashboard admin). Contrairement a
 * `arreter()` (arret propre au shutdown du process), celle-ci relance
 * immediatement une connexion pour generer un nouveau QR.
 */
export async function deconnecterEtReinitialiser(): Promise<void> {
  pret = false;
  try {
    await sock?.logout();
  } catch (erreur) {
    logger.warn('Logout WhatsApp en echec (session peut-etre deja invalide)', erreur);
  }
  try {
    await sock?.end(undefined);
  } catch {
    // deja ferme par logout() dans la plupart des cas.
  }
  sock = undefined;

  await effacerSessionLocale();
  tentativesReconnexion = 0;
  enAttenteAppairage = true;

  logger.warn('Session WhatsApp reinitialisee depuis le dashboard, nouvel appairage requis');
  sock = await creerSocket();
}
