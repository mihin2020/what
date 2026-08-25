/**
 * Acces aux donnees. Unique point de contact avec SQLite : aucun autre module
 * ne doit ecrire de SQL.
 *
 * Multi-utilisateur (section 6.9) : les fonctions dont le premier parametre
 * est `jid` operent sur les donnees d'UN utilisateur WhatsApp precis. Les
 * fonctions sans `jid` (lireParametre/ecrireParametre/lireEntier/lireBooleen,
 * offreConnue, purgerAnciennesOffres) restent volontairement globales : soit
 * ce sont des cles SYSTEME partagees par construction (ex. le throttle
 * quotidien d'une source scrapee, qui ne doit surtout pas se dupliquer par
 * utilisateur), soit des donnees factuelles sans notion d'utilisateur (le
 * cache d'offres dedupliquees par URL).
 */
import crypto from 'node:crypto';
import { db } from './schema.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { schemaProfil, type Profil } from '../cv/analyse.js';
import type { Offre } from '../sources/types.js';

const maintenant = () => new Date().toISOString();

/* ------------------------------------------------------------------ */
/* Profil                                                              */
/* ------------------------------------------------------------------ */

export function enregistrerProfil(jid: string, profil: Profil, cvHash: string): void {
  const ts = maintenant();
  const existant = db.prepare('SELECT cree_le FROM profil WHERE jid = ?').get(jid) as
    | { cree_le: string }
    | undefined;

  db.prepare(
    `INSERT INTO profil (jid, donnees, cv_hash, cree_le, maj_le)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(jid) DO UPDATE SET donnees = excluded.donnees,
                                    cv_hash = excluded.cv_hash,
                                    maj_le  = excluded.maj_le`,
  ).run(jid, JSON.stringify(profil), cvHash, existant?.cree_le ?? ts, ts);
}

export function lireProfil(jid: string): Profil | null {
  const ligne = db.prepare('SELECT donnees FROM profil WHERE jid = ?').get(jid) as
    | { donnees: string }
    | undefined;
  if (!ligne) return null;
  try {
    // Revalide via le schema (pas un simple cast) : un profil enregistre
    // avant l'ajout d'un champ (ex. "pays", ajoute le 17/08/2026) recupere
    // sa valeur par defaut au lieu d'un `undefined` qui romprait le typage
    // a l'execution pour tout code qui suppose le champ present.
    return schemaProfil.parse(JSON.parse(ligne.donnees));
  } catch (erreur) {
    logger.error('Profil illisible en base', { jid, erreur });
    return null;
  }
}

export function hashCV(texte: string): string {
  return crypto.createHash('sha256').update(texte).digest('hex');
}

/* ------------------------------------------------------------------ */
/* Parametres SYSTEME (globaux, partages par tous les utilisateurs)    */
/* ------------------------------------------------------------------ */

export function lireParametre(cle: string): string | null {
  const ligne = db.prepare('SELECT valeur FROM parametres WHERE cle = ?').get(cle) as
    | { valeur: string }
    | undefined;
  return ligne ? ligne.valeur : null;
}

export function ecrireParametre(cle: string, valeur: string): void {
  db.prepare(
    `INSERT INTO parametres (cle, valeur, maj_le) VALUES (?, ?, ?)
     ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur, maj_le = excluded.maj_le`,
  ).run(cle, valeur, maintenant());
}

export function supprimerParametre(cle: string): void {
  db.prepare('DELETE FROM parametres WHERE cle = ?').run(cle);
}

/** Ecrit la valeur seulement si la cle est absente (amorcage au 1er lancement). */
export function amorcerParametre(cle: string, valeur: string): void {
  if (lireParametre(cle) === null) ecrireParametre(cle, valeur);
}

export function lireEntier(cle: string, defaut: number): number {
  const brut = lireParametre(cle);
  if (brut === null) return defaut;
  const n = Number.parseInt(brut, 10);
  return Number.isFinite(n) ? n : defaut;
}

export function lireBooleen(cle: string, defaut: boolean): boolean {
  const brut = lireParametre(cle);
  if (brut === null) return defaut;
  return brut === '1' || brut.toLowerCase() === 'true';
}

/* ------------------------------------------------------------------ */
/* Parametres PROPRES A CHAQUE UTILISATEUR                             */
/* ------------------------------------------------------------------ */

export function lireParametreUtilisateur(jid: string, cle: string): string | null {
  const ligne = db.prepare('SELECT valeur FROM parametres_utilisateur WHERE jid = ? AND cle = ?').get(
    jid,
    cle,
  ) as { valeur: string } | undefined;
  return ligne ? ligne.valeur : null;
}

export function ecrireParametreUtilisateur(jid: string, cle: string, valeur: string): void {
  db.prepare(
    `INSERT INTO parametres_utilisateur (jid, cle, valeur, maj_le) VALUES (?, ?, ?, ?)
     ON CONFLICT(jid, cle) DO UPDATE SET valeur = excluded.valeur, maj_le = excluded.maj_le`,
  ).run(jid, cle, valeur, maintenant());
}

export function amorcerParametreUtilisateur(jid: string, cle: string, valeur: string): void {
  if (lireParametreUtilisateur(jid, cle) === null) ecrireParametreUtilisateur(jid, cle, valeur);
}

export function lireEntierUtilisateur(jid: string, cle: string, defaut: number): number {
  const brut = lireParametreUtilisateur(jid, cle);
  if (brut === null) return defaut;
  const n = Number.parseInt(brut, 10);
  return Number.isFinite(n) ? n : defaut;
}

export function lireBooleenUtilisateur(jid: string, cle: string, defaut: boolean): boolean {
  const brut = lireParametreUtilisateur(jid, cle);
  if (brut === null) return defaut;
  return brut === '1' || brut.toLowerCase() === 'true';
}

/** JID de tous les utilisateurs ayant une planification enregistree (restauration au demarrage). */
export function listerJidsAvecPlanification(): string[] {
  return (
    db.prepare("SELECT DISTINCT jid FROM parametres_utilisateur WHERE cle = 'frequence'").all() as {
      jid: string;
    }[]
  ).map((l) => l.jid);
}

/* ------------------------------------------------------------------ */
/* Etat conversationnel                                                */
/* ------------------------------------------------------------------ */

export type Attente = 'frequence' | 'heure' | 'jour_hebdo' | 'portee_geo';

export interface EtatConversation {
  attente: Attente;
  contexte: Record<string, unknown>;
}

/** Duree de vie d'une attente conversationnelle (section 6.5.1) : 30 minutes. */
const DUREE_ATTENTE_MS = 30 * 60 * 1000;

export function definirAttente(
  jid: string,
  attente: Attente,
  contexte: Record<string, unknown> = {},
): void {
  const expire = new Date(Date.now() + DUREE_ATTENTE_MS).toISOString();
  db.prepare(
    `INSERT INTO etat_conversation (jid, attente, contexte, expire_le) VALUES (?, ?, ?, ?)
     ON CONFLICT(jid) DO UPDATE SET attente = excluded.attente,
                                    contexte = excluded.contexte,
                                    expire_le = excluded.expire_le`,
  ).run(jid, attente, JSON.stringify(contexte), expire);
}

export function leverAttente(jid: string): void {
  db.prepare(
    `INSERT INTO etat_conversation (jid, attente, contexte, expire_le) VALUES (?, NULL, NULL, NULL)
     ON CONFLICT(jid) DO UPDATE SET attente = NULL, contexte = NULL, expire_le = NULL`,
  ).run(jid);
}

export function lireAttente(jid: string): EtatConversation | null {
  const ligne = db
    .prepare('SELECT attente, contexte, expire_le FROM etat_conversation WHERE jid = ?')
    .get(jid) as
    | { attente: string | null; contexte: string | null; expire_le: string | null }
    | undefined;

  if (!ligne || !ligne.attente) return null;

  if (ligne.expire_le && new Date(ligne.expire_le).getTime() < Date.now()) {
    leverAttente(jid);
    return null;
  }

  let contexte: Record<string, unknown> = {};
  try {
    contexte = ligne.contexte ? (JSON.parse(ligne.contexte) as Record<string, unknown>) : {};
  } catch {
    contexte = {};
  }
  return { attente: ligne.attente as Attente, contexte };
}

/* ------------------------------------------------------------------ */
/* Offres : cache FACTUEL global (dedup par hash d'URL, sans utilisateur) */
/* ------------------------------------------------------------------ */

/** Normalise une URL avant hachage : sans parametres de tracking ni ancre. */
export function normaliserUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const cle of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref$|source$)/i.test(cle)) u.searchParams.delete(cle);
    }
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    const chemin = u.pathname.replace(/\/+$/, '');
    u.pathname = chemin === '' ? '/' : chemin;
    return u.toString();
  } catch {
    return url.trim();
  }
}

export function hashOffre(url: string): string {
  return crypto.createHash('sha256').update(normaliserUrl(url)).digest('hex');
}

/** Vrai si l'offre existe deja dans le cache factuel (tous utilisateurs confondus). */
export function offreConnue(hash: string): boolean {
  return db.prepare('SELECT 1 FROM offres WHERE hash = ?').get(hash) !== undefined;
}

export function enregistrerOffre(offre: Offre & { hash: string }): void {
  db.prepare(
    `INSERT INTO offres
       (hash, source, id_source, titre, entreprise, lieu, url, date_publication, vue_le)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(hash) DO NOTHING`,
  ).run(
    offre.hash,
    offre.source,
    offre.id_source,
    offre.titre,
    offre.entreprise,
    offre.lieu,
    offre.url,
    offre.date_publication,
    maintenant(),
  );
}

/** Purge des offres de plus de 90 jours (section 7). Retourne le nombre supprime.
 *  `offres_utilisateur` est nettoyee automatiquement (ON DELETE CASCADE). */
export function purgerAnciennesOffres(joursRetention = 90): number {
  const limite = new Date(Date.now() - joursRetention * 24 * 3600 * 1000).toISOString();
  const res = db.prepare('DELETE FROM offres WHERE vue_le < ?').run(limite);
  return Number(res.changes);
}

/* ------------------------------------------------------------------ */
/* Offres : relevance/statut PROPRES A CHAQUE UTILISATEUR               */
/* ------------------------------------------------------------------ */

/** Vrai si CET utilisateur a deja vu cette offre (score deja calcule ou envoyee). */
export function offreVuePourUtilisateur(jid: string, hash: string): boolean {
  return db.prepare('SELECT 1 FROM offres_utilisateur WHERE jid = ? AND offre_hash = ?').get(jid, hash) !== undefined;
}

export function enregistrerScoreUtilisateur(
  jid: string,
  hash: string,
  score: number | null,
  raison: string | null,
): void {
  db.prepare(
    `INSERT INTO offres_utilisateur (jid, offre_hash, score, raison, envoyee, vue_le)
     VALUES (?, ?, ?, ?, 0, ?)
     ON CONFLICT(jid, offre_hash) DO UPDATE SET score  = excluded.score,
                                                 raison = excluded.raison`,
  ).run(jid, hash, score, raison, maintenant());
}

export function marquerEnvoyee(jid: string, hash: string): void {
  db.prepare('UPDATE offres_utilisateur SET envoyee = 1 WHERE jid = ? AND offre_hash = ?').run(jid, hash);
}

export interface OffreEnregistree extends Offre {
  hash: string;
  score?: number | null;
  raison?: string | null;
  envoyee?: boolean;
}

/** Offres scorees les plus recentes pour CET utilisateur (ex. affichage interface web). */
export function listerOffresRecentes(jid: string, limite = 20): OffreEnregistree[] {
  return db
    .prepare(
      `SELECT o.hash, o.source, o.id_source, o.titre, o.entreprise, o.lieu, o.url,
              o.date_publication, ou.score, ou.raison, ou.envoyee
       FROM offres_utilisateur ou
       JOIN offres o ON o.hash = ou.offre_hash
       WHERE ou.jid = ? AND ou.score IS NOT NULL
       ORDER BY ou.vue_le DESC
       LIMIT ?`,
    )
    .all(jid, limite) as unknown as OffreEnregistree[];
}

/* ------------------------------------------------------------------ */
/* Journal IA et statistiques                                          */
/* ------------------------------------------------------------------ */

export function journaliserIA(entree: {
  jid: string | null;
  operation: 'analyse_cv' | 'scoring';
  modele: string;
  tokensEntree: number;
  tokensSortie: number;
  succes: boolean;
}): void {
  db.prepare(
    `INSERT INTO journal_ia (jid, horodatage, operation, modele, tokens_entree, tokens_sortie, succes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entree.jid,
    maintenant(),
    entree.operation,
    entree.modele,
    entree.tokensEntree,
    entree.tokensSortie,
    entree.succes ? 1 : 0,
  );
}

export interface Statistiques {
  offresConnues: number;
  offresEnvoyees: number;
  offresMois: number;
  envoyeesMois: number;
  tokensEntreeMois: number;
  tokensSortieMois: number;
  appelsMois: number;
  echecsMois: number;
  coutEstimeUSD: number;
}

export function statistiques(jid: string): Statistiques {
  const debutMois = new Date();
  debutMois.setUTCDate(1);
  debutMois.setUTCHours(0, 0, 0, 0);
  const seuil = debutMois.toISOString();

  const nb = (sql: string, ...p: unknown[]): number => {
    const l = db.prepare(sql).get(...p) as { n: number | bigint | null } | undefined;
    return Number(l?.n ?? 0);
  };

  const tokens = db
    .prepare(
      `SELECT COALESCE(SUM(tokens_entree),0) AS e,
              COALESCE(SUM(tokens_sortie),0) AS s,
              COUNT(*) AS appels,
              COALESCE(SUM(CASE WHEN succes = 0 THEN 1 ELSE 0 END),0) AS echecs
       FROM journal_ia WHERE jid = ? AND horodatage >= ?`,
    )
    .get(jid, seuil) as { e: number; s: number; appels: number; echecs: number };

  const tokensEntreeMois = Number(tokens.e);
  const tokensSortieMois = Number(tokens.s);

  return {
    // Cache factuel : figure globale (partagee entre utilisateurs), volontairement non filtree par jid.
    offresConnues: nb('SELECT COUNT(*) AS n FROM offres'),
    offresEnvoyees: nb('SELECT COUNT(*) AS n FROM offres_utilisateur WHERE jid = ? AND envoyee = 1', jid),
    offresMois: nb('SELECT COUNT(*) AS n FROM offres_utilisateur WHERE jid = ? AND vue_le >= ?', jid, seuil),
    envoyeesMois: nb(
      'SELECT COUNT(*) AS n FROM offres_utilisateur WHERE jid = ? AND envoyee = 1 AND vue_le >= ?',
      jid,
      seuil,
    ),
    tokensEntreeMois,
    tokensSortieMois,
    appelsMois: Number(tokens.appels),
    echecsMois: Number(tokens.echecs),
    coutEstimeUSD:
      (tokensEntreeMois / 1_000_000) * config.PRIX_ENTREE_USD_PAR_M +
      (tokensSortieMois / 1_000_000) * config.PRIX_SORTIE_USD_PAR_M,
  };
}

/* ------------------------------------------------------------------ */
/* Vue d ensemble multi-utilisateurs (dashboard admin)                 */
/* ------------------------------------------------------------------ */

export interface UtilisateurResume {
  jid: string;
  numero: string;
  aProfil: boolean;
  /** Valeur brute ('quotidien', 'hebdo', ...), null si aucune planification. */
  frequence: string | null;
  derniereActivite: string | null;
  offresEnvoyees: number;
  /** Nombre d'appels IA attribues a cet utilisateur (analyse de CV + scoring) : proxy d'activite. */
  actionsIA: number;
}

/** Tous les jids connus, tous utilisateurs confondus (union des tables qui portent un jid). */
function tousLesJids(): string[] {
  return (
    db
      .prepare(
        `SELECT jid FROM profil
         UNION SELECT jid FROM parametres_utilisateur
         UNION SELECT jid FROM offres_utilisateur
         ORDER BY jid`,
      )
      .all() as { jid: string }[]
  ).map((l) => l.jid);
}

export function listerUtilisateurs(): UtilisateurResume[] {
  return tousLesJids().map((jid) => {
    const profilLigne = db.prepare('SELECT maj_le FROM profil WHERE jid = ?').get(jid) as
      | { maj_le: string }
      | undefined;
    const envoyees = db
      .prepare('SELECT COUNT(*) AS n FROM offres_utilisateur WHERE jid = ? AND envoyee = 1')
      .get(jid) as { n: number };
    const actions = db.prepare('SELECT COUNT(*) AS n FROM journal_ia WHERE jid = ?').get(jid) as { n: number };
    const frequence = db
      .prepare("SELECT valeur FROM parametres_utilisateur WHERE jid = ? AND cle = 'frequence'")
      .get(jid) as { valeur: string } | undefined;

    return {
      jid,
      numero: jid.split('@')[0] ?? jid,
      aProfil: profilLigne !== undefined,
      frequence: frequence?.valeur ?? null,
      derniereActivite: profilLigne?.maj_le ?? null,
      offresEnvoyees: Number(envoyees.n),
      actionsIA: Number(actions.n),
    };
  });
}

export interface PointJournalier {
  date: string;
  nombre: number;
}

/** Nouveaux profils par jour (proxy d'inscription), sur les `jours` derniers jours, zero-rempli. */
export function inscriptionsParJour(jours = 30): PointJournalier[] {
  const depuis = new Date(Date.now() - (jours - 1) * 24 * 3600 * 1000);
  depuis.setUTCHours(0, 0, 0, 0);

  const lignes = db
    .prepare(`SELECT substr(cree_le, 1, 10) AS jour, COUNT(*) AS n FROM profil WHERE cree_le >= ? GROUP BY jour`)
    .all(depuis.toISOString()) as { jour: string; n: number }[];
  const parJour = new Map(lignes.map((l) => [l.jour, Number(l.n)]));

  const resultat: PointJournalier[] = [];
  for (let i = jours - 1; i >= 0; i--) {
    const cle = new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
    resultat.push({ date: cle, nombre: parJour.get(cle) ?? 0 });
  }
  return resultat;
}

export interface PointActivite {
  date: string;
  offres: number;
  appelsIA: number;
}

/**
 * Activite quotidienne agregee TOUS UTILISATEURS, sur les `jours` derniers jours,
 * zero-remplie (un point par jour, meme sans activite : le graphe du dashboard a
 * besoin d'un axe temporel continu, sinon les trous se referment et la date ment).
 *
 * `offres` compte les offres reellement envoyees : comme `statsPeriode`, on date
 * l'envoi par `offres_utilisateur.vue_le` (le schema ne porte pas d'horodatage
 * d'envoi distinct — l'envoi suit le scoring dans le meme cycle).
 */
export function activiteParJour(jours = 30): PointActivite[] {
  const depuis = new Date(Date.now() - (jours - 1) * 24 * 3600 * 1000);
  depuis.setUTCHours(0, 0, 0, 0);
  const depuisISO = depuis.toISOString();

  const parJour = (sql: string): Map<string, number> => {
    const lignes = db.prepare(sql).all(depuisISO) as { jour: string; n: number }[];
    return new Map(lignes.map((l) => [l.jour, Number(l.n)]));
  };

  const offres = parJour(
    `SELECT substr(vue_le, 1, 10) AS jour, COUNT(*) AS n
     FROM offres_utilisateur WHERE envoyee = 1 AND vue_le >= ? GROUP BY jour`,
  );
  const appels = parJour(
    `SELECT substr(horodatage, 1, 10) AS jour, COUNT(*) AS n
     FROM journal_ia WHERE horodatage >= ? GROUP BY jour`,
  );

  const resultat: PointActivite[] = [];
  for (let i = jours - 1; i >= 0; i--) {
    const cle = new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
    resultat.push({ date: cle, offres: offres.get(cle) ?? 0, appelsIA: appels.get(cle) ?? 0 });
  }
  return resultat;
}

export interface PeriodeStats {
  offresEnvoyees: number;
  appelsIA: number;
  tokensEntree: number;
  tokensSortie: number;
  coutEstimeUSD: number;
}

function statsPeriode(depuisISO: string): PeriodeStats {
  const tokens = db
    .prepare(
      `SELECT COALESCE(SUM(tokens_entree),0) AS e, COALESCE(SUM(tokens_sortie),0) AS s, COUNT(*) AS appels
       FROM journal_ia WHERE horodatage >= ?`,
    )
    .get(depuisISO) as { e: number; s: number; appels: number };
  const envoyees = db
    .prepare('SELECT COUNT(*) AS n FROM offres_utilisateur WHERE envoyee = 1 AND vue_le >= ?')
    .get(depuisISO) as { n: number };

  const tokensEntree = Number(tokens.e);
  const tokensSortie = Number(tokens.s);

  return {
    offresEnvoyees: Number(envoyees.n),
    appelsIA: Number(tokens.appels),
    tokensEntree,
    tokensSortie,
    coutEstimeUSD:
      (tokensEntree / 1_000_000) * config.PRIX_ENTREE_USD_PAR_M +
      (tokensSortie / 1_000_000) * config.PRIX_SORTIE_USD_PAR_M,
  };
}

export interface StatistiquesGlobales {
  nombreUtilisateurs: number;
  offresConnues: number;
  offresEnvoyeesTotal: number;
  semaine: PeriodeStats;
  mois: PeriodeStats;
}

/** Statistiques agregees TOUS UTILISATEURS confondus (dashboard admin, distinct de `statistiques(jid)`). */
export function statistiquesGlobales(): StatistiquesGlobales {
  const debutSemaine = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const debutMois = new Date();
  debutMois.setUTCDate(1);
  debutMois.setUTCHours(0, 0, 0, 0);

  const nb = (sql: string, ...p: unknown[]): number => {
    const l = db.prepare(sql).get(...p) as { n: number | bigint | null } | undefined;
    return Number(l?.n ?? 0);
  };

  return {
    nombreUtilisateurs: tousLesJids().length,
    offresConnues: nb('SELECT COUNT(*) AS n FROM offres'),
    offresEnvoyeesTotal: nb('SELECT COUNT(*) AS n FROM offres_utilisateur WHERE envoyee = 1'),
    semaine: statsPeriode(debutSemaine),
    mois: statsPeriode(debutMois.toISOString()),
  };
}

/* ------------------------------------------------------------------ */
/* Reinitialisation (usage : commande !reinitialiser)                  */
/* ------------------------------------------------------------------ */

/**
 * Efface le profil, les offres et la planification d'UN SEUL utilisateur,
 * pour qu'il reparte comme au premier contact. Ne touche jamais `offres`
 * (cache factuel partage) ni `parametres` (cles systeme partagees) : ce sont
 * des donnees d'autres utilisateurs, ou du systeme, jamais uniquement les
 * siennes. Ne touche pas non plus `journal_ia` (historique de cout).
 */
export function reinitialiserDonnees(jid: string): void {
  db.prepare('DELETE FROM profil WHERE jid = ?').run(jid);
  db.prepare('DELETE FROM offres_utilisateur WHERE jid = ?').run(jid);
  db.prepare('DELETE FROM parametres_utilisateur WHERE jid = ?').run(jid);
  db.prepare('DELETE FROM etat_conversation WHERE jid = ?').run(jid);

  logger.warn('Donnees utilisateur reinitialisees', { jid });
}
