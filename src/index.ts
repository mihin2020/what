/**
 * Point d'entree : cablage des modules.
 *
 * Le service est un processus long unique, sans serveur HTTP entrant :
 * la connexion WhatsApp est sortante et persistante, la planification interne.
 */
import cron from 'node-cron';
import { config } from './config.js';
import { logger } from './logger.js';
import { initialiserSchema } from './db/schema.js';
import { listerJidsAvecPlanification } from './db/repository.js';
import { bus, demarrer, arreter, envoyer } from './whatsapp.js';
import { demarrerServeurWeb, arreterServeurWeb } from './web.js';
import { traiterPieceJointe, traiterTexte } from './commandes.js';
import { appliquer, decrire, definirExecuteur, lirePlanification, prochaineEcheance } from './planification.js';
import { executerCycle, purgeHebdomadaire } from './veille.js';

/* ------------------------------------------------------------------ */
/* Filets de securite (section 8.1)                                    */
/* ------------------------------------------------------------------ */

process.on('uncaughtException', (erreur) => {
  logger.error('Exception non capturee', erreur);
});

process.on('unhandledRejection', (raison) => {
  logger.error('Promesse rejetee sans gestionnaire', raison);
});

/* ------------------------------------------------------------------ */
/* Amorcage HTTP d'abord (healthcheck Railway / Fly)                   */
/* ------------------------------------------------------------------ */

logger.info('Demarrage de whatsapp-veille', {
  fuseau: config.FUSEAU,
  modele: config.DEEPSEEK_MODELE,
  node: process.version,
  bind: config.WEB_BIND,
  port: config.PORT,
  data: config.chemins.data,
  build: process.env.BUILD_MARKER ?? 'local',
  qrMode: 'memory',
});

try {
  initialiserSchema();
} catch (erreur) {
  logger.error('Schema SQLite en echec — le dashboard demarre quand meme', erreur);
}

// Le healthcheck ne doit pas attendre WhatsApp.
demarrerServeurWeb();

/* ------------------------------------------------------------------ */
/* Cablage des evenements                                              */
/* ------------------------------------------------------------------ */

definirExecuteur(async (jid) => {
  await executerCycle(jid, { manuel: false });
});

bus.on('texte', (jid: string, texte: string) => {
  traiterTexte(jid, texte).catch((erreur) => {
    logger.error('Traitement du texte en echec', { jid, erreur });
    void envoyer(jid, 'Aie, une erreur interne. Reessaie, ou tape !aide.');
  });
});

bus.on('piece_jointe', (jid: string, piece) => {
  traiterPieceJointe(jid, piece).catch((erreur) => {
    logger.error('Traitement de la piece jointe en echec', { jid, erreur });
    void envoyer(jid, "Je n'ai pas reussi a traiter ce fichier. Reessaie dans un instant.");
  });
});

bus.on('deconnexion', (raison: string) => {
  logger.warn('Deconnexion signalee au niveau applicatif', { raison });
});

bus.on('abandon', () => {
  logger.error('Arret du processus apres echec des reconnexions (pm2 prendra le relais)');
  void arreterProprement(1);
});

bus.on('pret', () => {
  void auDemarrage();
});

/**
 * Restaure la planification de CHAQUE utilisateur connu (multi-utilisateur,
 * section 6.9) : un redemarrage ne doit jamais faire perdre un reglage. Pas
 * de message de bienvenue envoye ici (decide explicitement) : au demarrage,
 * envoyer un message a tous les utilisateurs passes lirait comme du spam
 * bot ; l'accueil se fait desormais reactivement, au premier message de
 * chacun (voir accueillirSiNouveau() dans commandes.ts).
 */
async function auDemarrage(): Promise<void> {
  const jids = listerJidsAvecPlanification();
  let restaurees = 0;

  for (const jid of jids) {
    const taches = appliquer(jid);
    const plan = lirePlanification(jid);
    if (plan) {
      restaurees++;
      const prochaine = prochaineEcheance(plan);
      logger.info('Planification restauree', {
        jid,
        reglage: decrire(plan),
        en_pause: plan.enPause,
        taches,
        prochaine: prochaine?.toISOString() ?? null,
      });
    }
  }

  logger.info('Service operationnel', { utilisateurs_avec_planification: restaurees });
}

/* ------------------------------------------------------------------ */
/* Taches de maintenance                                               */
/* ------------------------------------------------------------------ */

// Purge hebdomadaire des offres de plus de 90 jours (section 7).
// Independante du reglage utilisateur : dimanche 03:00, fuseau configure.
cron.schedule('0 3 * * 0', purgeHebdomadaire, { scheduled: true, timezone: config.FUSEAU });

/* ------------------------------------------------------------------ */
/* Cycle de vie du processus                                           */
/* ------------------------------------------------------------------ */

let arretEnCours = false;

async function arreterProprement(code = 0): Promise<void> {
  if (arretEnCours) return;
  arretEnCours = true;
  logger.info('Arret demande, fermeture propre en cours');
  try {
    arreterServeurWeb();
    await arreter();
  } finally {
    process.exit(code);
  }
}

process.on('SIGINT', () => void arreterProprement(0));
process.on('SIGTERM', () => void arreterProprement(0));

demarrer().catch((erreur) => {
  logger.error(
    "Demarrage du client WhatsApp impossible. L interface web reste disponible.",
    erreur,
  );
});
