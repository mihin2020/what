/**
 * Isole la base du script de verification.
 *
 * Ce module DOIT etre importe en premier par tools/verification.ts : en ESM les
 * dependances sont evaluees dans l'ordre des declarations d'import, donc poser
 * la variable ici garantit qu'elle est lue par src/config.ts, qui construit le
 * chemin SQLite au moment de son evaluation.
 */
process.env.FICHIER_SQLITE = 'verification.sqlite';
process.env.PREFIXE_LOG = 'verification';
