/**
 * Ouverture de la base SQLite et creation du schema.
 *
 * Le module natif `node:sqlite` (Node 22+) est utilise en priorite. Il est
 * encore derriere le drapeau `--experimental-sqlite` sur Node 22 LTS : les
 * scripts npm et la configuration pm2 le passent deja. En cas d'indisponibilite,
 * on retombe sur `better-sqlite3` s'il est installe (§ 5.3).
 *
 * Aucun ORM : requetes SQL parametrees, parametres positionnels `?` uniquement
 * (seule syntaxe commune aux deux pilotes).
 *
 * Schema multi-utilisateur (section 6.9) : `profil`/`etat_conversation` sont
 * keyees par `jid` (un par utilisateur WhatsApp) au lieu d'une ligne unique
 * `id = 1`. `offres` reste une table FACTUELLE globale (dedupliquee par hash
 * d'URL, partagee entre utilisateurs : les faits sur une offre ne dependent
 * de personne) ; `offres_utilisateur` porte le score/la raison/le statut
 * d'envoi PROPRES A CHAQUE utilisateur pour cette offre. `parametres` reste
 * pour les cles SYSTEME globales (ex. le throttle quotidien d'une source
 * scrapee, qui doit rester global et non se dupliquer par utilisateur) ;
 * `parametres_utilisateur` porte les reglages propres a chaque utilisateur
 * (seuil, frequence, etc.). Voir src/db/migration.ts pour la bascule depuis
 * l'ancien schema mono-utilisateur.
 */
import { createRequire } from 'node:module';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { migrerVersMultiUtilisateur } from './migration.js';

const requireCJS = createRequire(import.meta.url);

export interface Requete {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

export interface BaseDeDonnees {
  prepare(sql: string): Requete;
  exec(sql: string): void;
  close(): void;
}

function ouvrir(): BaseDeDonnees {
  try {
    const { DatabaseSync } = requireCJS('node:sqlite') as {
      DatabaseSync: new (chemin: string) => BaseDeDonnees;
    };
    logger.info('Base SQLite ouverte via node:sqlite', { fichier: config.chemins.sqlite });
    return new DatabaseSync(config.chemins.sqlite);
  } catch (erreur) {
    logger.warn('node:sqlite indisponible, tentative de repli sur better-sqlite3', erreur);
    try {
      const BetterSqlite3 = requireCJS('better-sqlite3') as new (chemin: string) => BaseDeDonnees;
      logger.info('Base SQLite ouverte via better-sqlite3', { fichier: config.chemins.sqlite });
      return new BetterSqlite3(config.chemins.sqlite);
    } catch (erreur2) {
      logger.error(
        'Aucun pilote SQLite disponible. Lance le processus avec --experimental-sqlite ' +
          '(Node 22) ou installe better-sqlite3.',
        erreur2,
      );
      throw erreur2;
    }
  }
}

export const db: BaseDeDonnees = ouvrir();

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS profil (
  jid               TEXT PRIMARY KEY,
  donnees           TEXT NOT NULL,
  cv_hash           TEXT NOT NULL,
  cree_le           TEXT NOT NULL,
  maj_le            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS offres (
  hash              TEXT PRIMARY KEY,
  source            TEXT NOT NULL,
  id_source         TEXT,
  titre             TEXT NOT NULL,
  entreprise        TEXT,
  lieu              TEXT,
  url               TEXT NOT NULL,
  date_publication  TEXT,
  vue_le            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_offres_vue ON offres(vue_le);

CREATE TABLE IF NOT EXISTS offres_utilisateur (
  jid               TEXT NOT NULL,
  offre_hash        TEXT NOT NULL REFERENCES offres(hash) ON DELETE CASCADE,
  score             INTEGER,
  raison            TEXT,
  envoyee           INTEGER DEFAULT 0,
  vue_le            TEXT NOT NULL,
  PRIMARY KEY (jid, offre_hash)
);

CREATE INDEX IF NOT EXISTS idx_offres_utilisateur_jid ON offres_utilisateur(jid);
CREATE INDEX IF NOT EXISTS idx_offres_utilisateur_envoyee ON offres_utilisateur(jid, envoyee);

CREATE TABLE IF NOT EXISTS parametres (
  cle               TEXT PRIMARY KEY,
  valeur            TEXT NOT NULL,
  maj_le            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS parametres_utilisateur (
  jid               TEXT NOT NULL,
  cle               TEXT NOT NULL,
  valeur            TEXT NOT NULL,
  maj_le            TEXT NOT NULL,
  PRIMARY KEY (jid, cle)
);

CREATE INDEX IF NOT EXISTS idx_parametres_utilisateur_jid ON parametres_utilisateur(jid);

CREATE TABLE IF NOT EXISTS etat_conversation (
  jid               TEXT PRIMARY KEY,
  attente           TEXT,
  contexte          TEXT,
  expire_le         TEXT
);

CREATE TABLE IF NOT EXISTS journal_ia (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  jid               TEXT,
  horodatage        TEXT NOT NULL,
  operation         TEXT NOT NULL,
  modele            TEXT NOT NULL,
  tokens_entree     INTEGER,
  tokens_sortie     INTEGER,
  succes            INTEGER
);

CREATE INDEX IF NOT EXISTS idx_journal_ia_horodatage ON journal_ia(horodatage);
CREATE INDEX IF NOT EXISTS idx_journal_ia_jid ON journal_ia(jid);
`;

/** Ajoute la colonne `jid` a `journal_ia` si elle est absente (base anterieure au multi-utilisateur). */
function assurerColonneJidJournal(db: BaseDeDonnees): void {
  const colonnes = db.prepare('PRAGMA table_info(journal_ia)').all() as { name: string }[];
  if (colonnes.length === 0) return; // table pas encore creee, SCHEMA s'en charge
  if (colonnes.some((c) => c.name === 'jid')) return; // deja presente
  db.exec('ALTER TABLE journal_ia ADD COLUMN jid TEXT');
}

/** Cree/migre les tables si necessaire. Idempotent : appelable a chaque demarrage. */
export function initialiserSchema(): void {
  migrerVersMultiUtilisateur(db);
  // AVANT le bloc SCHEMA : celui-ci cree un index sur journal_ia.jid, qui doit
  // deja exister sur une base preexistante (sinon "no such column: jid").
  assurerColonneJidJournal(db);
  db.exec(SCHEMA);
  logger.info('Schema SQLite verifie');
}
