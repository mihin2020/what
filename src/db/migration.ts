/**
 * Migration ponctuelle du schema mono-utilisateur (lignes uniques `id = 1`)
 * vers le schema multi-utilisateur (cle primaire `jid`).
 *
 * Idempotente et sans table de version : la FORME de la table `profil` fait
 * office de marqueur. Si elle a une colonne `id`, l'ancien schema est present
 * et la migration s'execute ; si elle a une colonne `jid` (deja migree) ou
 * n'existe pas encore (installation neuve), c'est un no-op.
 */
import { logger } from '../logger.js';
import { jidProprietaire } from '../identite.js';
import type { BaseDeDonnees } from './schema.js';

/** Cles de `parametres` propres a un utilisateur, a deplacer vers `parametres_utilisateur`. */
const CLES_PAR_UTILISATEUR = [
  'seuil_score',
  'lieux_acceptes',
  'max_offres_digest',
  'max_anciennete_jours',
  'frequence',
  'heure',
  'jour_hebdo',
  'veille_en_pause',
  'cron_actif',
  'dernier_accueil',
];

function schemaEstAncien(db: BaseDeDonnees): boolean {
  const colonnes = db.prepare('PRAGMA table_info(profil)').all() as { name: string }[];
  return colonnes.some((c) => c.name === 'id');
}

export function migrerVersMultiUtilisateur(db: BaseDeDonnees): void {
  if (!schemaEstAncien(db)) return; // installation neuve, ou deja migree

  logger.warn('Ancien schema mono-utilisateur detecte : migration vers le schema multi-utilisateur', {
    proprietaire: jidProprietaire,
  });

  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE profil RENAME TO profil_v1');
    db.exec('ALTER TABLE etat_conversation RENAME TO etat_conversation_v1');
    db.exec('ALTER TABLE offres RENAME TO offres_v1');

    db.exec(`
      CREATE TABLE profil (
        jid    TEXT PRIMARY KEY,
        donnees TEXT NOT NULL,
        cv_hash TEXT NOT NULL,
        cree_le TEXT NOT NULL,
        maj_le  TEXT NOT NULL
      );
      CREATE TABLE etat_conversation (
        jid       TEXT PRIMARY KEY,
        attente   TEXT,
        contexte  TEXT,
        expire_le TEXT
      );
      CREATE TABLE offres (
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
      CREATE TABLE offres_utilisateur (
        jid        TEXT NOT NULL,
        offre_hash TEXT NOT NULL REFERENCES offres(hash) ON DELETE CASCADE,
        score      INTEGER,
        raison     TEXT,
        envoyee    INTEGER DEFAULT 0,
        vue_le     TEXT NOT NULL,
        PRIMARY KEY (jid, offre_hash)
      );
      CREATE TABLE parametres_utilisateur (
        jid    TEXT NOT NULL,
        cle    TEXT NOT NULL,
        valeur TEXT NOT NULL,
        maj_le TEXT NOT NULL,
        PRIMARY KEY (jid, cle)
      );
    `);

    db.prepare(
      `INSERT INTO profil (jid, donnees, cv_hash, cree_le, maj_le)
       SELECT ?, donnees, cv_hash, cree_le, maj_le FROM profil_v1 WHERE id = 1`,
    ).run(jidProprietaire);

    db.prepare(
      `INSERT INTO etat_conversation (jid, attente, contexte, expire_le)
       SELECT ?, attente, contexte, expire_le FROM etat_conversation_v1 WHERE id = 1`,
    ).run(jidProprietaire);

    db.prepare(
      `INSERT INTO offres (hash, source, id_source, titre, entreprise, lieu, url, date_publication, vue_le)
       SELECT hash, source, id_source, titre, entreprise, lieu, url, date_publication, vue_le FROM offres_v1`,
    ).run();

    db.prepare(
      `INSERT INTO offres_utilisateur (jid, offre_hash, score, raison, envoyee, vue_le)
       SELECT ?, hash, score, raison, envoyee, vue_le FROM offres_v1`,
    ).run(jidProprietaire);

    for (const cle of CLES_PAR_UTILISATEUR) {
      const ligne = db.prepare('SELECT valeur, maj_le FROM parametres WHERE cle = ?').get(cle) as
        | { valeur: string; maj_le: string }
        | undefined;
      if (!ligne) continue;
      db.prepare(
        'INSERT INTO parametres_utilisateur (jid, cle, valeur, maj_le) VALUES (?, ?, ?, ?)',
      ).run(jidProprietaire, cle, ligne.valeur, ligne.maj_le);
      db.prepare('DELETE FROM parametres WHERE cle = ?').run(cle);
    }

    db.exec('DROP TABLE profil_v1');
    db.exec('DROP TABLE etat_conversation_v1');
    db.exec('DROP TABLE offres_v1');

    db.exec('COMMIT');
    logger.warn('Migration multi-utilisateur terminee', { proprietaire: jidProprietaire });
  } catch (erreur) {
    db.exec('ROLLBACK');
    logger.error('Migration multi-utilisateur en echec, base inchangee', erreur);
    throw erreur;
  }
}
