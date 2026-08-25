/**
 * Parcours de configuration de la frequence et planification dynamique (section 6.5).
 *
 * Trois principes non negociables :
 *  1. aucune planification par defaut : tant que l'utilisateur n'a pas choisi,
 *     aucune tache n'est active ;
 *  2. toute reconfiguration DETRUIT les taches existantes avant d'en creer de
 *     nouvelles (l'accumulation de taches est un defaut bloquant) ;
 *  3. la configuration vit en base : un redemarrage la restaure a l'identique.
 */
import cron, { type ScheduledTask } from 'node-cron';
import { config } from './config.js';
import { logger } from './logger.js';
import { ecrireParametreUtilisateur, lireBooleenUtilisateur, lireParametreUtilisateur } from './db/repository.js';

export type Frequence = 'quotidien' | 'semaine' | 'hebdo' | 'biquotidien';

export const FREQUENCES: Record<string, Frequence> = {
  '1': 'quotidien',
  '2': 'semaine',
  '3': 'hebdo',
  '4': 'biquotidien',
};

export const LIBELLES: Record<Frequence, string> = {
  quotidien: 'chaque jour',
  semaine: 'du lundi au vendredi',
  hebdo: 'une fois par semaine',
  biquotidien: 'deux fois par jour (matin et soir)',
};

export const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

export const REGEX_HEURE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/* ------------------------------------------------------------------ */
/* Messages du parcours conversationnel                                */
/* ------------------------------------------------------------------ */

export const MESSAGE_CHOIX_FREQUENCE = [
  'A quelle frequence veux-tu recevoir les offres ?',
  '',
  '1️⃣  Chaque jour',
  '2️⃣  Du lundi au vendredi',
  '3️⃣  Une fois par semaine',
  '4️⃣  Deux fois par jour (matin et soir)',
  '',
  'Reponds par le chiffre, ou tape !frequence plus tard.',
].join('\n');

export const MESSAGE_CHOIX_HEURE = [
  'A quelle heure ? (format 24h, ex. 07:30)',
  `Fuseau : ${config.FUSEAU}`,
].join('\n');

export const MESSAGE_HEURE_INVALIDE = [
  "Je n'ai pas compris cette heure.",
  'Donne-la au format 24h, par exemple 07:30 ou 18:00.',
].join('\n');

export const MESSAGE_CHOIX_JOUR = [
  'Quel jour de la semaine ?',
  '',
  '1️⃣ Lundi  2️⃣ Mardi  3️⃣ Mercredi  4️⃣ Jeudi',
  '5️⃣ Vendredi  6️⃣ Samedi  7️⃣ Dimanche',
].join('\n');

/* ------------------------------------------------------------------ */
/* Lecture de la configuration                                         */
/* ------------------------------------------------------------------ */

export interface Planification {
  frequence: Frequence;
  heure: string;
  jourHebdo: number;
  enPause: boolean;
}

/** Retourne la planification de CET utilisateur, ou null s'il n'a rien choisi. */
export function lirePlanification(jid: string): Planification | null {
  const frequence = lireParametreUtilisateur(jid, 'frequence') as Frequence | null;
  const heure = lireParametreUtilisateur(jid, 'heure');

  if (!frequence || !heure || !REGEX_HEURE.test(heure)) return null;
  if (!(frequence in LIBELLES)) return null;

  return {
    frequence,
    heure,
    jourHebdo: Number(lireParametreUtilisateur(jid, 'jour_hebdo') ?? '1'),
    enPause: lireBooleenUtilisateur(jid, 'veille_en_pause', false),
  };
}

export function enregistrerPlanification(
  jid: string,
  frequence: Frequence,
  heure: string,
  jourHebdo?: number,
): void {
  ecrireParametreUtilisateur(jid, 'frequence', frequence);
  ecrireParametreUtilisateur(jid, 'heure', heure);
  if (jourHebdo !== undefined) ecrireParametreUtilisateur(jid, 'jour_hebdo', String(jourHebdo));
}

/* ------------------------------------------------------------------ */
/* Traduction en expressions cron                                      */
/* ------------------------------------------------------------------ */

/** Une frequence peut donner plusieurs expressions (cas biquotidien). */
export function construireCrons(plan: Planification): string[] {
  const [heureStr = '8', minuteStr = '0'] = plan.heure.split(':');
  const H = Number(heureStr);
  const M = Number(minuteStr);

  switch (plan.frequence) {
    case 'quotidien':
      return [`${M} ${H} * * *`];
    case 'semaine':
      return [`${M} ${H} * * 1-5`];
    case 'hebdo':
      return [`${M} ${H} * * ${plan.jourHebdo}`];
    case 'biquotidien':
      return [`${M} ${H} * * *`, `${M} ${(H + 12) % 24} * * *`];
  }
}

/** Libelle lisible du reglage courant. */
export function decrire(plan: Planification): string {
  const [heureStr = '8', minuteStr = '00'] = plan.heure.split(':');
  const heure = `${heureStr.padStart(2, '0')}:${minuteStr}`;

  switch (plan.frequence) {
    case 'quotidien':
      return `chaque jour a ${heure}`;
    case 'semaine':
      return `du lundi au vendredi a ${heure}`;
    case 'hebdo':
      return `chaque ${JOURS[plan.jourHebdo % 7]} a ${heure}`;
    case 'biquotidien': {
      const soir = `${String((Number(heureStr) + 12) % 24).padStart(2, '0')}:${minuteStr}`;
      return `deux fois par jour, a ${heure} et a ${soir}`;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Gestion dynamique des taches                                        */
/* ------------------------------------------------------------------ */

/** Une entree par utilisateur : chacun a ses propres taches cron independantes. */
const tachesParJid = new Map<string, ScheduledTask[]>();
let executeur: ((jid: string) => Promise<void>) | null = null;

/** Enregistre la fonction a executer a chaque echeance. Appele une fois au demarrage. */
export function definirExecuteur(fn: (jid: string) => Promise<void>): void {
  executeur = fn;
}

/** Detruit les taches actives de CET utilisateur (n'affecte pas les autres). */
export function arreterTaches(jid: string): void {
  const taches = tachesParJid.get(jid) ?? [];
  for (const tache of taches) {
    try {
      tache.stop();
    } catch (erreur) {
      logger.warn('Arret d une tache cron en echec', { jid, erreur });
    }
  }
  if (taches.length > 0) logger.info('Taches cron detruites', { jid, nombre: taches.length });
  tachesParJid.delete(jid);
}

/**
 * (Re)construit les taches de CET utilisateur a partir de sa configuration en
 * base. Retourne le nombre de taches actives (0 si rien n'est configure ou si
 * la veille est en pause).
 */
export function appliquer(jid: string): number {
  arreterTaches(jid);

  const plan = lirePlanification(jid);
  if (!plan) {
    ecrireParametreUtilisateur(jid, 'cron_actif', '');
    logger.info('Aucune planification configuree : aucune tache creee', { jid });
    return 0;
  }

  const expressions = construireCrons(plan);
  ecrireParametreUtilisateur(jid, 'cron_actif', expressions.join(' | '));

  if (plan.enPause) {
    logger.info('Veille en pause : taches non creees', { jid, cron: expressions.join(' | ') });
    return 0;
  }

  const nouvelles: ScheduledTask[] = [];
  for (const expression of expressions) {
    if (!cron.validate(expression)) {
      logger.error('Expression cron invalide, tache ignoree', { jid, expression });
      continue;
    }
    const tache = cron.schedule(
      expression,
      () => {
        if (!executeur) {
          logger.error('Echeance atteinte mais aucun executeur defini');
          return;
        }
        executeur(jid).catch((erreur) => logger.error('Cycle planifie en echec', { jid, erreur }));
      },
      { scheduled: true, timezone: config.FUSEAU },
    );
    nouvelles.push(tache);
  }
  tachesParJid.set(jid, nouvelles);

  logger.info('Planification active', {
    jid,
    frequence: plan.frequence,
    heure: plan.heure,
    fuseau: config.FUSEAU,
    taches: nouvelles.length,
  });

  return nouvelles.length;
}

export const nombreTachesActives = (jid: string): number => tachesParJid.get(jid)?.length ?? 0;

/* ------------------------------------------------------------------ */
/* Test de bout en bout du declenchement PROGRAMME (commande cachee)   */
/* ------------------------------------------------------------------ */

/**
 * Debug uniquement, jamais expose dans !aide. `!veille` teste deja le
 * declenchement MANUEL (executerCycle appele directement) ; ceci teste le
 * declenchement PROGRAMME lui-meme (cron -> executeur), le seul chemin que
 * !veille ne couvre pas. Independant de la planification reelle de
 * l'utilisateur : ne lit ni n'ecrit `frequence`/`heure` en base, s'arrete
 * seule apres MAX_EXECUTIONS_TEST executions pour ne jamais tourner
 * indefiniment si l'utilisateur oublie de l'arreter.
 */
export const MAX_EXECUTIONS_TEST = 5;

let tacheTest: ScheduledTask | null = null;
let executionsTest = 0;

/** Bascule le test toutes-les-minutes pour CET utilisateur. Retourne l'etat resultant. */
export function basculerTestMinute(jid: string): { demarre: boolean } {
  if (tacheTest) {
    tacheTest.stop();
    tacheTest = null;
    logger.info('Test !testminute arrete manuellement', { jid });
    return { demarre: false };
  }

  executionsTest = 0;
  tacheTest = cron.schedule(
    '* * * * *',
    () => {
      executionsTest++;
      if (!executeur) {
        logger.error('Test !testminute : aucun executeur defini');
        return;
      }
      executeur(jid).catch((erreur) => logger.error('Test !testminute : cycle en echec', { jid, erreur }));

      if (executionsTest >= MAX_EXECUTIONS_TEST) {
        tacheTest?.stop();
        tacheTest = null;
        logger.info('Test !testminute arrete automatiquement (limite atteinte)', {
          jid,
          executions: executionsTest,
        });
      }
    },
    { scheduled: true, timezone: config.FUSEAU },
  );

  logger.warn('Test !testminute demarre : un cycle de veille chaque minute', {
    jid,
    limite: MAX_EXECUTIONS_TEST,
  });
  return { demarre: true };
}

/* ------------------------------------------------------------------ */
/* Prochaine echeance (pour !planning)                                 */
/* ------------------------------------------------------------------ */

/** Decalage du fuseau par rapport a UTC, en ms, pour un instant donne. */
function decalageMs(instant: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: config.FUSEAU,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(instant)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const commeUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return commeUTC - instant.getTime();
}

/** Convertit une date/heure locale (dans FUSEAU) en instant absolu. */
function instantDepuisLocal(annee: number, mois: number, jour: number, h: number, m: number): Date {
  const approximation = Date.UTC(annee, mois - 1, jour, h, m, 0);
  // Deux passes suffisent pour absorber un changement d'offset.
  let ts = approximation - decalageMs(new Date(approximation));
  ts = approximation - decalageMs(new Date(ts));
  return new Date(ts);
}

/** Date du jour dans le fuseau configure, en composantes. */
function aujourdHuiLocal(): { annee: number; mois: number; jour: number } {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.FUSEAU,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [annee = '1970', mois = '01', jour = '01'] = dtf.format(new Date()).split('-');
  return { annee: Number(annee), mois: Number(mois), jour: Number(jour) };
}

/**
 * Calcule la prochaine echeance a partir du reglage courant.
 * Retourne null si rien n'est planifie ou si la veille est en pause.
 */
export function prochaineEcheance(plan: Planification | null): Date | null {
  if (!plan || plan.enPause) return null;

  const [heureStr = '8', minuteStr = '0'] = plan.heure.split(':');
  const H = Number(heureStr);
  const M = Number(minuteStr);

  const heuresDuJour = plan.frequence === 'biquotidien' ? [H, (H + 12) % 24].sort((a, b) => a - b) : [H];
  const base = aujourdHuiLocal();
  const maintenant = Date.now();

  for (let decalageJours = 0; decalageJours <= 14; decalageJours++) {
    // Date.UTC gere le passage de mois/annee ; on relit ensuite les composantes.
    const reference = new Date(Date.UTC(base.annee, base.mois - 1, base.jour + decalageJours));
    const annee = reference.getUTCFullYear();
    const mois = reference.getUTCMonth() + 1;
    const jour = reference.getUTCDate();
    const jourSemaine = reference.getUTCDay(); // 0 = dimanche

    if (plan.frequence === 'semaine' && (jourSemaine === 0 || jourSemaine === 6)) continue;
    if (plan.frequence === 'hebdo' && jourSemaine !== plan.jourHebdo % 7) continue;

    for (const h of heuresDuJour) {
      const instant = instantDepuisLocal(annee, mois, jour, h, M);
      if (instant.getTime() > maintenant) return instant;
    }
  }

  return null;
}
