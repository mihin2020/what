/**
 * Routage des commandes texte et gestion du parcours conversationnel
 * (sections 6.5, 6.9 et 6.10).
 *
 * Multi-utilisateur : chaque fonction recoit `jid`, l'identifiant canonique
 * de l'utilisateur WhatsApp a l'origine du message (voir src/whatsapp.ts).
 * Aucune fonction ici ne doit lire/ecrire un etat global specifique a un
 * utilisateur sans passer par ce parametre.
 *
 * Regles :
 *  - toute commande recoit une reponse, y compris en cas d'erreur ;
 *  - une commande connue est toujours executee, meme si le systeme attend une
 *    reponse a une question : l'attente est alors levee (section 6.5.1) ;
 *  - toute commande inconnue renvoie vers !aide.
 */
import { config } from './config.js';
import { logger } from './logger.js';
import { jidProprietaire } from './identite.js';
import { envoyer, type PieceJointe } from './whatsapp.js';
import { extraireCV } from './cv/extraction.js';
import { analyserCV, ErreurDocumentNonCV } from './cv/analyse.js';
import { executerCycle, executerRecherchePostCv, etatSources } from './veille.js';
import { SOURCES } from './sources/index.js';
import {
  MESSAGE_AIDE,
  MESSAGE_ACCUEIL,
  MESSAGE_CHOIX_PORTEE,
  messageProfil,
  messageProfilConfirme,
  messageSources,
  messageStats,
  dateHeure,
} from './formatage.js';
import {
  definirAttente,
  ecrireParametreUtilisateur,
  hashCV,
  leverAttente,
  lireAttente,
  lireParametreUtilisateur,
  lireProfil,
  enregistrerProfil,
  reinitialiserDonnees,
  statistiques,
} from './db/repository.js';
import {
  appliquer,
  arreterTaches,
  basculerTestMinute,
  decrire,
  enregistrerPlanification,
  FREQUENCES,
  JOURS,
  lirePlanification,
  MAX_EXECUTIONS_TEST,
  MESSAGE_CHOIX_FREQUENCE,
  MESSAGE_CHOIX_HEURE,
  MESSAGE_CHOIX_JOUR,
  MESSAGE_HEURE_INVALIDE,
  prochaineEcheance,
  REGEX_HEURE,
  type Frequence,
} from './planification.js';

/* ------------------------------------------------------------------ */
/* Accueil reactif (remplace l'accueil unique au demarrage)             */
/* ------------------------------------------------------------------ */

/**
 * Envoie le message d'accueil au tout premier contact d'un jid, une seule
 * fois. Remplace l'ancien accueil au demarrage du process (qui n'avait de
 * sens que mono-utilisateur) : ici chaque utilisateur est accueilli quand
 * IL se manifeste, pas quand le bot redemarre.
 */
async function accueillirSiNouveau(jid: string): Promise<void> {
  if (lireProfil(jid) !== null) return;
  if (lireParametreUtilisateur(jid, 'dernier_accueil') !== null) return;
  ecrireParametreUtilisateur(jid, 'dernier_accueil', new Date().toISOString());
  await envoyer(jid, MESSAGE_ACCUEIL);
}

/* ------------------------------------------------------------------ */
/* Point d'entree : un message texte                                   */
/* ------------------------------------------------------------------ */

export async function traiterTexte(jid: string, texte: string): Promise<void> {
  await accueillirSiNouveau(jid);

  const brut = texte.trim();

  if (brut.startsWith('!')) {
    // Une commande explicite l'emporte toujours sur une attente en cours.
    leverAttente(jid);
    await executerCommande(jid, brut);
    return;
  }

  const attente = lireAttente(jid);
  if (attente) {
    await repondreAAttente(jid, attente.attente, attente.contexte, brut);
    return;
  }

  await envoyer(jid, "Je n'ai pas compris. Tape !aide pour voir les commandes disponibles.");
}

/* ------------------------------------------------------------------ */
/* Commandes                                                           */
/* ------------------------------------------------------------------ */

async function executerCommande(jid: string, entree: string): Promise<void> {
  const [commandeBrute = '', ...reste] = entree.slice(1).split(/\s+/);
  const commande = commandeBrute.toLowerCase();
  const argument = reste.join(' ').trim();

  logger.info('Commande recue', { jid, commande });

  try {
    switch (commande) {
      case 'aide':
      case 'help':
      case 'start':
        await envoyer(jid, MESSAGE_AIDE);
        return;

      case 'profil':
        await commandeProfil(jid);
        return;

      case 'veille':
        await commandeVeille(jid);
        return;

      case 'frequence':
      case 'fréquence':
        await commandeFrequence(jid);
        return;

      case 'planning':
        await commandePlanning(jid);
        return;

      case 'pause':
        await commandePause(jid, true);
        return;

      case 'reprendre':
        await commandePause(jid, false);
        return;

      case 'lieu':
      case 'lieux':
        await commandeLieu(jid, argument);
        return;

      case 'sources':
        await envoyer(jid, messageSources(SOURCES, etatSources()));
        return;

      case 'stats':
        await envoyer(jid, messageStats(statistiques(jid)));
        return;

      case 'reinitialiser':
        await commandeReinitialiser(jid, argument);
        return;

      // Volontairement absente de MESSAGE_AIDE : commande de debug reservee
      // au proprietaire (voir commandeTestMinute), personne d'autre ne doit
      // meme savoir qu'elle existe.
      case 'testminute':
        await commandeTestMinute(jid);
        return;

      default:
        await envoyer(jid, `Commande inconnue : !${commande}. Tape !aide pour voir les commandes disponibles.`);
        return;
    }
  } catch (erreur) {
    logger.error('Commande en echec', { jid, commande, erreur });
    await envoyer(
      jid,
      "Aie, quelque chose s'est mal passe en traitant cette commande. Reessaie dans un instant.",
    );
  }
}

async function commandeProfil(jid: string): Promise<void> {
  const profil = lireProfil(jid);
  if (!profil) {
    await envoyer(
      jid,
      "Je n'ai pas encore de profil pour toi. Envoie-moi ton CV en piece jointe (PDF ou DOCX).",
    );
    return;
  }
  await envoyer(jid, messageProfil(profil));
}

async function commandeVeille(jid: string): Promise<void> {
  await envoyer(jid, '🔎 Je lance la recherche, ca prend une minute...');
  await executerCycle(jid, { manuel: true });
}

async function commandeFrequence(jid: string): Promise<void> {
  const plan = lirePlanification(jid);
  const entete = plan
    ? `Reglage actuel : ${decrire(plan)}${plan.enPause ? ' (en pause)' : ''}.\n\nNouvelle frequence ?`
    : "Aucune frequence n'est configuree pour le moment.";

  definirAttente(jid, 'frequence', {});
  await envoyer(jid, `${entete}\n\n${MESSAGE_CHOIX_FREQUENCE}`);
}

async function commandePlanning(jid: string): Promise<void> {
  const plan = lirePlanification(jid);

  if (!plan) {
    await envoyer(
      jid,
      'Aucune veille programmee pour le moment.\n\nTape !frequence pour en configurer une.',
    );
    return;
  }

  const lignes = [`🔔 Reglage actuel : ${decrire(plan)}.`, `Fuseau : ${config.FUSEAU}`];

  if (plan.enPause) {
    lignes.push('', '⏸ Les envois sont en pause. Tape !reprendre pour les relancer.');
  } else {
    const prochaine = prochaineEcheance(plan);
    lignes.push(
      '',
      prochaine
        ? `Prochaine echeance : ${dateHeure(prochaine)}.`
        : 'Prochaine echeance : indeterminee.',
    );
  }

  lignes.push('', 'Tu peux changer ca avec !frequence.');
  await envoyer(jid, lignes.join('\n'));
}

async function commandePause(jid: string, pause: boolean): Promise<void> {
  ecrireParametreUtilisateur(jid, 'veille_en_pause', pause ? '1' : '0');
  appliquer(jid);

  if (pause) {
    await envoyer(jid, '⏸ Veille suspendue. Tape !reprendre quand tu veux la relancer.');
    return;
  }

  const plan = lirePlanification(jid);
  if (!plan) {
    definirAttente(jid, 'frequence', {});
    await envoyer(
      jid,
      `▶️ C'est reparti. Il me manque juste une frequence.\n\n${MESSAGE_CHOIX_FREQUENCE}`,
    );
    return;
  }

  const prochaine = prochaineEcheance(plan);
  await envoyer(
    jid,
    `▶️ Veille reactivee : ${decrire(plan)}.` +
      (prochaine ? `\nProchaine echeance : ${dateHeure(prochaine)}.` : ''),
  );
}

async function commandeLieu(jid: string, argument: string): Promise<void> {
  if (argument === '') {
    const actuels = lireParametreUtilisateur(jid, 'lieux_acceptes') ?? config.LIEUX_ACCEPTES;
    await envoyer(
      jid,
      `📍 Zones acceptees : ${actuels}\n\n` +
        'Pour les changer : !lieu Ouagadougou, Bobo-Dioulasso, Remote\n' +
        '(!lieu tout pour ne plus filtrer sur le lieu)',
    );
    return;
  }

  if (argument.toLowerCase() === 'tout') {
    ecrireParametreUtilisateur(jid, 'lieux_acceptes', '');
    await envoyer(jid, '📍 Filtre geographique desactive : je regarde partout.');
    return;
  }

  const zones = argument
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (zones.length === 0) {
    await envoyer(jid, 'Donne-moi au moins une zone. Exemple : !lieu Ouagadougou, Remote');
    return;
  }

  ecrireParametreUtilisateur(jid, 'lieux_acceptes', zones.join(','));
  await envoyer(jid, `📍 Zones acceptees mises a jour : ${zones.join(', ')}`);
}

/* ------------------------------------------------------------------ */
/* Parcours conversationnel : frequence, jour, heure                   */
/* ------------------------------------------------------------------ */

async function repondreAAttente(
  jid: string,
  attente: string,
  contexte: Record<string, unknown>,
  reponse: string,
): Promise<void> {
  switch (attente) {
    case 'portee_geo':
      await reponsePorteeGeo(jid, reponse);
      return;
    case 'frequence':
      await reponseFrequence(jid, reponse);
      return;
    case 'jour_hebdo':
      await reponseJour(jid, contexte, reponse);
      return;
    case 'heure':
      await reponseHeure(jid, contexte, reponse);
      return;
    default:
      leverAttente(jid);
      await envoyer(jid, "Je n'ai pas compris. Tape !aide pour voir les commandes disponibles.");
  }
}

const LIEUX_NATIONAL =
  'Burkina Faso,Ouagadougou,Bobo-Dioulasso,Koudougou,Kaya,Banfora,Ouahigouya';
const LIEUX_LES_DEUX = 'Burkina Faso,Ouagadougou,Teletravail,Remote';

/** Interprete 1/2/3 ou libelles pour la portee geographique. */
function interpreterPortee(reponse: string): 'national' | 'international' | 'les_deux' | null {
  const n = reponse.trim().toLowerCase().replace(/[^\wàâéèêëïôùûüç]/gi, '');
  if (n === '1' || /^(national|burkina|local|bf|burkinafaso)$/.test(n)) return 'national';
  if (n === '2' || /^(international|etranger|monde|remote|teletravail)$/.test(n)) return 'international';
  if (n === '3' || /^(lesdeux|deux|partout|both)$/.test(n)) return 'les_deux';
  return null;
}

async function reponsePorteeGeo(jid: string, reponse: string): Promise<void> {
  const portee = interpreterPortee(reponse);
  if (!portee) {
    definirAttente(jid, 'portee_geo', {});
    await envoyer(jid, `Reponds par 1, 2 ou 3.\n\n${MESSAGE_CHOIX_PORTEE}`);
    return;
  }

  ecrireParametreUtilisateur(jid, 'portee_recherche', portee);
  if (portee === 'national') {
    ecrireParametreUtilisateur(jid, 'lieux_acceptes', LIEUX_NATIONAL);
  } else if (portee === 'international') {
    // Liste large : le prefiltre exclut deja le BF local non-remote.
    ecrireParametreUtilisateur(jid, 'lieux_acceptes', 'Teletravail,Remote');
  } else {
    ecrireParametreUtilisateur(jid, 'lieux_acceptes', LIEUX_LES_DEUX);
  }

  leverAttente(jid);

  const libelle =
    portee === 'national'
      ? 'au Burkina Faso'
      : portee === 'international'
        ? "a l'international"
        : 'au Burkina et a l international';

  await envoyer(jid, `✅ Portee notee : ${libelle}.`);
  await executerRecherchePostCv(jid);

  const plan = lirePlanification(jid);
  if (!plan) {
    definirAttente(jid, 'frequence', {});
    await envoyer(jid, `✅ Profil pret.\n\n${MESSAGE_CHOIX_FREQUENCE}`);
    return;
  }

  const prochaine = prochaineEcheance(plan);
  await envoyer(
    jid,
    `🔔 Ta veille reste reglee : ${decrire(plan)}.` +
      (prochaine ? `\nProchaine echeance : ${dateHeure(prochaine)}.` : '') +
      '\n\nTape !frequence pour la modifier.',
  );
}

/** Accepte "1".."4" ou le libelle ("quotidien", "hebdo", ...). */
function interpreterFrequence(reponse: string): Frequence | null {
  const nettoye = reponse.trim().toLowerCase().replace(/[^\w]/g, '');

  const parChiffre = FREQUENCES[nettoye];
  if (parChiffre) return parChiffre;

  if (/^(quotidien|chaquejour|jour|tous?lesjours)$/.test(nettoye)) return 'quotidien';
  if (/^(semaine|lunven|lundivendredi|ouvrable)$/.test(nettoye)) return 'semaine';
  if (/^(hebdo|hebdomadaire|unefoisparsemaine)$/.test(nettoye)) return 'hebdo';
  if (/^(biquotidien|deuxfois|matinsoir)$/.test(nettoye)) return 'biquotidien';

  return null;
}

async function reponseFrequence(jid: string, reponse: string): Promise<void> {
  const frequence = interpreterFrequence(reponse);

  if (!frequence) {
    definirAttente(jid, 'frequence', {});
    await envoyer(jid, `Reponds par un chiffre de 1 a 4.\n\n${MESSAGE_CHOIX_FREQUENCE}`);
    return;
  }

  if (frequence === 'hebdo') {
    definirAttente(jid, 'jour_hebdo', { frequence });
    await envoyer(jid, MESSAGE_CHOIX_JOUR);
    return;
  }

  definirAttente(jid, 'heure', { frequence });
  await envoyer(jid, MESSAGE_CHOIX_HEURE);
}

async function reponseJour(jid: string, contexte: Record<string, unknown>, reponse: string): Promise<void> {
  const chiffre = Number.parseInt(reponse.trim(), 10);

  if (!Number.isFinite(chiffre) || chiffre < 1 || chiffre > 7) {
    definirAttente(jid, 'jour_hebdo', contexte);
    await envoyer(jid, `Reponds par un chiffre de 1 a 7.\n\n${MESSAGE_CHOIX_JOUR}`);
    return;
  }

  // 1 = lundi ... 7 = dimanche, converti en numerotation cron (0 = dimanche).
  const jourHebdo = chiffre === 7 ? 0 : chiffre;
  definirAttente(jid, 'heure', { frequence: 'hebdo', jourHebdo });
  await envoyer(jid, `${JOURS[jourHebdo]}, note. ${MESSAGE_CHOIX_HEURE}`);
}

async function reponseHeure(jid: string, contexte: Record<string, unknown>, reponse: string): Promise<void> {
  const frequence = (contexte.frequence as Frequence) ?? 'quotidien';
  const jourHebdo = typeof contexte.jourHebdo === 'number' ? contexte.jourHebdo : 1;
  const essais = typeof contexte.essais === 'number' ? contexte.essais : 0;

  // Tolere "7h30", "07h30", "7:30", "0730".
  const normalisee = reponse
    .trim()
    .toLowerCase()
    .replace(/\s/g, '')
    .replace(/h/, ':')
    .replace(/^(\d{2})(\d{2})$/, '$1:$2')
    .replace(/:$/, ':00');

  if (!REGEX_HEURE.test(normalisee)) {
    if (essais === 0) {
      definirAttente(jid, 'heure', { ...contexte, essais: 1 });
      await envoyer(jid, MESSAGE_HEURE_INVALIDE);
      return;
    }

    // Deuxieme echec : on applique la valeur de repli plutot que de boucler.
    await finaliserPlanification(jid, frequence, config.HEURE_DEFAUT, jourHebdo, true);
    return;
  }

  const [h = '0', m = '00'] = normalisee.split(':');
  const heure = `${h.padStart(2, '0')}:${m}`;
  await finaliserPlanification(jid, frequence, heure, jourHebdo, false);
}

async function finaliserPlanification(
  jid: string,
  frequence: Frequence,
  heure: string,
  jourHebdo: number,
  repli: boolean,
): Promise<void> {
  leverAttente(jid);
  enregistrerPlanification(jid, frequence, heure, jourHebdo);
  // Configurer explicitement une frequence vaut reprise de la veille.
  ecrireParametreUtilisateur(jid, 'veille_en_pause', '0');

  const taches = appliquer(jid);
  const plan = lirePlanification(jid);
  const prochaine = plan ? prochaineEcheance(plan) : null;

  const lignes: string[] = [];
  if (repli) {
    lignes.push(
      `Je n'ai toujours pas compris l'heure, je prends ${config.HEURE_DEFAUT} par defaut.`,
      '',
    );
  }
  lignes.push(`🔔 Veille activee : ${plan ? decrire(plan) : `${frequence} a ${heure}`}.`);
  if (prochaine) lignes.push(`Prochaine echeance : ${dateHeure(prochaine)}.`);
  lignes.push('', 'Tu peux changer ca avec !frequence.');

  logger.info('Planification enregistree', { jid, frequence, heure, jourHebdo, taches });
  await envoyer(jid, lignes.join('\n'));
}

/* ------------------------------------------------------------------ */
/* Piece jointe : analyse du CV                                        */
/* ------------------------------------------------------------------ */

/**
 * Repart de zero pour CET utilisateur : supprime son profil, ses offres et sa
 * planification. Ne touche jamais les donnees des autres utilisateurs ni le
 * cache factuel global d'offres. Destructif, donc exige une confirmation
 * explicite en argument plutot qu'un second message (plus sur : rien a taper
 * au mauvais moment qui declenche la suppression).
 */
async function commandeReinitialiser(jid: string, argument: string): Promise<void> {
  if (argument.trim().toLowerCase() !== 'confirmer') {
    await envoyer(
      jid,
      '⚠️ Ceci va supprimer ton profil, l historique des offres et la planification ' +
        '(retour a l etat du tout premier lancement).\n\n' +
        'Tape *!reinitialiser confirmer* pour continuer.',
    );
    return;
  }

  arreterTaches(jid);
  reinitialiserDonnees(jid);
  leverAttente(jid);

  await envoyer(
    jid,
    '🧹 Tout est reinitialise.\n\nEnvoie-moi un CV (PDF ou DOCX) pour recommencer.',
  );
}

/**
 * Commande de debug cachee (jamais dans !aide), reservee au proprietaire.
 * Declenche un cycle de veille chaque minute pour verifier que le
 * declenchement PROGRAMME fonctionne reellement (pas seulement !veille, qui
 * ne teste que le declenchement manuel). Pour tout autre utilisateur, se
 * comporte exactement comme une commande inconnue : meme texte, pour ne
 * jamais laisser deviner que la commande existe.
 */
async function commandeTestMinute(jid: string): Promise<void> {
  if (jid !== jidProprietaire) {
    await envoyer(jid, 'Commande inconnue : !testminute. Tape !aide pour voir les commandes disponibles.');
    return;
  }

  const { demarre } = basculerTestMinute(jid);
  await envoyer(
    jid,
    demarre
      ? `🧪 Test lance : un cycle de veille chaque minute (${MAX_EXECUTIONS_TEST} fois maximum, ` +
          'puis arret automatique). Tape a nouveau !testminute pour arreter avant.'
      : '🧪 Test arrete.',
  );
}

export async function traiterPieceJointe(jid: string, piece: PieceJointe): Promise<void> {
  await accueillirSiNouveau(jid);

  const extraction = await extraireCV(piece.base64, piece.mimetype, piece.nom);

  if (!extraction.ok) {
    await envoyer(jid, extraction.message);
    return;
  }

  await envoyer(jid, '📄 CV bien recu, je l analyse...');

  let profil;
  try {
    profil = await analyserCV(jid, extraction.texte);
  } catch (erreur) {
    if (erreur instanceof ErreurDocumentNonCV) {
      logger.info('Document rejete : pas un CV', { jid, raison: erreur.raisonModele });
      await envoyer(
        jid,
        `Ce document ne ressemble pas a un CV (${erreur.raisonModele}). ` +
          'Envoie-moi plutot ton CV en PDF ou DOCX.',
      );
      return;
    }
    logger.error('Analyse du CV en echec', { jid, erreur });
    await envoyer(
      jid,
      "Je n'ai pas reussi a analyser ce CV (le service d'analyse n'a pas repondu correctement). " +
        'Reessaie dans quelques minutes.',
    );
    return;
  }

  enregistrerProfil(jid, profil, hashCV(extraction.texte));
  await envoyer(jid, messageProfilConfirme(profil));

  // Avant toute recherche : demander la portee geo (national / international / les deux).
  definirAttente(jid, 'portee_geo', {});
  await envoyer(jid, MESSAGE_CHOIX_PORTEE);
}
