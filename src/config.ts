/**
 * Chargement et validation des variables d'environnement.
 *
 * Rappel du cahier des charges (§ 7) : les valeurs presentes dans la table
 * `parametres` PRIMENT toujours sur ces variables. Ce qui est defini ici ne
 * sert qu'a amorcer la base au tout premier lancement.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { z } from 'zod';

const ICI = path.dirname(fileURLToPath(import.meta.url));
export const RACINE = path.resolve(ICI, '..');

dotenv.config({ path: path.join(RACINE, '.env') });

/** Railway / Fly / Render : le healthcheck doit atteindre 0.0.0.0. */
function hebergeurCloud(): boolean {
  return Boolean(
    process.env.RAILWAY_ENVIRONMENT ||
      process.env.RAILWAY_PROJECT_ID ||
      process.env.FLY_APP_NAME ||
      process.env.RENDER ||
      process.env.K_SERVICE,
  );
}

if (hebergeurCloud()) {
  // Toujours joignable par le proxy / healthcheck (jamais 127.0.0.1 en cloud).
  if (!process.env.WEB_BIND || process.env.WEB_BIND === '127.0.0.1' || process.env.WEB_BIND === 'localhost') {
    process.env.WEB_BIND = '0.0.0.0';
  }
  if (!process.env.WHATSAPP_TLS_INSECURE) process.env.WHATSAPP_TLS_INSECURE = 'false';
  // Volume Railway/Fly : toujours /data (evite /app/data inexistant).
  if (!process.env.DATA_DIR?.trim() || process.env.DATA_DIR.trim() === './data') {
    process.env.DATA_DIR = '/data';
  }
  // Placeholders pour ne pas tuer le process avant le healthcheck.
  // Remplace-les dans les variables Railway (sinon WhatsApp / IA ne marcheront pas).
  if (!process.env.NUMERO_AUTORISE?.trim()) {
    console.warn('[WARN] NUMERO_AUTORISE manquant — placeholder temporaire pour demarrer.');
    process.env.NUMERO_AUTORISE = '00000000000@c.us';
  }
  if (!process.env.DEEPSEEK_API_KEY?.trim()) {
    console.warn('[WARN] DEEPSEEK_API_KEY manquant — placeholder temporaire pour demarrer.');
    process.env.DEEPSEEK_API_KEY = 'MISSING_SET_IN_RAILWAY';
  }
}

const heureRegex = /^([01]?\d|2[0-3]):([0-5]\d)$/;

const schema = z.object({
  NUMERO_AUTORISE: z
    .string()
    .min(1, 'NUMERO_AUTORISE est obligatoire')
    .refine((v) => v.endsWith('@c.us'), 'NUMERO_AUTORISE doit se terminer par @c.us')
    .refine((v) => !v.startsWith('226XXXXXXXX'), 'NUMERO_AUTORISE contient encore la valeur d exemple'),

  DEEPSEEK_API_KEY: z.string().min(1, 'DEEPSEEK_API_KEY est obligatoire'),
  DEEPSEEK_MODELE: z.string().default('deepseek-v4-flash'),
  DEEPSEEK_BASE_URL: z.string().url().default('https://api.deepseek.com/v1'),
  PRIX_ENTREE_USD_PAR_M: z.coerce.number().nonnegative().default(0.28),
  PRIX_SORTIE_USD_PAR_M: z.coerce.number().nonnegative().default(0.42),

  RELIEFWEB_APPNAME: z.string().default('whatsapp-veille'),
  ADZUNA_APP_ID: z.string().optional().default(''),
  ADZUNA_APP_KEY: z.string().optional().default(''),
  ADZUNA_PAYS: z.string().default('fr'),
  // Cle API Jooble (https://jooble.org/api/about) — laisse vide pour desactiver.
  JOOBLE_CLE: z.string().optional().default(''),
  // Affiliate ID Careerjet (https://www.careerjet.com/partners) — laisse vide pour desactiver.
  CAREERJET_AFFID: z.string().optional().default(''),
  CAREERJET_LOCALE: z.string().default('fr_FR'),

  SEUIL_SCORE_DEFAUT: z.coerce.number().int().min(0).max(100).default(50),
  FREQUENCE_DEFAUT: z.enum(['quotidien', 'semaine', 'hebdo', 'biquotidien']).default('quotidien'),
  HEURE_DEFAUT: z.string().regex(heureRegex, 'HEURE_DEFAUT doit etre au format HH:MM').default('08:00'),
  FUSEAU: z.string().default('Africa/Ouagadougou'),
  MAX_OFFRES_DIGEST: z.coerce.number().int().min(1).max(20).default(8),
  MAX_ANCIENNETE_JOURS: z.coerce.number().int().min(1).max(90).default(14),
  LIEUX_ACCEPTES: z.string().default('Burkina Faso,Ouagadougou,Teletravail,Remote'),

  // Appairage par code a 8 caracteres au lieu du QR (utile si le terminal
  // rend le QR illisible). Le numero est deduit de NUMERO_AUTORISE.
  APPAIRAGE_PAR_CODE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Desactive la verification des certificats TLS pour la connexion WhatsApp.
  // Necessaire sur beaucoup de Windows ou un antivirus intercepte le HTTPS
  // (erreur UNABLE_TO_VERIFY_LEAF_SIGNATURE → "Impossible de connecter l appareil").
  // Defaut : active. Mettre false uniquement si ta chaine de certificats est saine.
  WHATSAPP_TLS_INSECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),

  // Panneau d'administration. En local : 127.0.0.1. Sur Render : 0.0.0.0
  // (obligatoire pour les health checks) + ADMIN_USER / ADMIN_PASSWORD.
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WEB_BIND: z.string().default('127.0.0.1'),
  // Identifiants HTTP Basic pour le dashboard si WEB_BIND != 127.0.0.1.
  ADMIN_USER: z.string().optional().default(''),
  ADMIN_PASSWORD: z.string().optional().default(''),
  // Disque persistant (Render Disk) : session WhatsApp + SQLite. Ex. /var/data
  DATA_DIR: z.string().optional().default(''),
});

const resultat = schema.safeParse(process.env);

if (!resultat.success) {
  const details = resultat.error.issues
    .map((i) => `  - ${i.path.join('.')} : ${i.message}`)
    .join('\n');
  console.error(
    `\nConfiguration invalide. Corrige le fichier .env (voir .env.example) :\n${details}\n`,
  );
  process.exit(1);
}

const env = resultat.data;

/** Verifie que le fuseau fourni est reconnu par l'ICU embarque. */
try {
  new Intl.DateTimeFormat('fr-FR', { timeZone: env.FUSEAU });
} catch {
  console.error(`\nFUSEAU invalide : "${env.FUSEAU}". Utilise un identifiant IANA, ex. Africa/Ouagadougou.\n`);
  process.exit(1);
}

const dossierData = env.DATA_DIR.trim()
  ? path.resolve(env.DATA_DIR.trim())
  : path.join(RACINE, 'data');
const dossierLogs = path.join(RACINE, 'logs');
fs.mkdirSync(dossierData, { recursive: true });
fs.mkdirSync(dossierLogs, { recursive: true });

const webExposePubliquement = env.WEB_BIND !== '127.0.0.1' && env.WEB_BIND !== 'localhost';
if (webExposePubliquement && (!env.ADMIN_USER || !env.ADMIN_PASSWORD)) {
  // Ne pas tuer le process : sinon le healthcheck Railway echoue en boucle.
  // Le dashboard refuse alors tout acces jusqu'a configuration des identifiants.
  console.warn(
    '\n[WARN] ADMIN_USER / ADMIN_PASSWORD manquants : le dashboard restera inaccessible (401).\n' +
      'Ajoute-les dans les variables Railway, puis redeploie.\n',
  );
}

export const config = {
  ...env,
  webExposePubliquement,

  /** Chemins absolus des volumes persistants. */
  chemins: {
    racine: RACINE,
    data: dossierData,
    logs: dossierLogs,
    session: path.join(dossierData, 'session'),
    // FICHIER_SQLITE permet d'isoler la base : le script de verification s'en
    // sert pour ne jamais ecrire dans la base de production.
    sqlite: path.join(dossierData, process.env.FICHIER_SQLITE ?? 'veille.sqlite'),
  },

  /** Zones geographiques acceptees, deja decoupees. */
  lieuxAcceptesListe: env.LIEUX_ACCEPTES.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
} as const;

export type Config = typeof config;
