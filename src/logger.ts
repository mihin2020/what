/**
 * Journalisation centralisee : console (captee par pm2) + fichier rotatif.
 *
 * Contrainte du cahier des charges (§ 8.2) : aucune donnee personnelle issue
 * du CV ne doit apparaitre dans les journaux. Les modules qui manipulent le
 * texte du CV ne journalisent donc que des metriques (longueur, hash).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

type Niveau = 'error' | 'warn' | 'info' | 'debug';

const ORDRE: Record<Niveau, number> = { error: 0, warn: 1, info: 2, debug: 3 };
const SEUIL = ORDRE[config.LOG_LEVEL];

/** Taille au-dela de laquelle le fichier du jour est archive. */
const TAILLE_MAX_OCTETS = 5 * 1024 * 1024;
/** Nombre de fichiers journaliers conserves. */
const RETENTION_JOURS = 14;

function jour(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Prefixe des fichiers de log. Le script de verification le change pour ne pas
 * melanger ses traces a celles du bot en fonctionnement (diagnostic illisible).
 */
const PREFIXE_LOG = process.env.PREFIXE_LOG ?? 'veille';

function fichierDuJour(): string {
  return path.join(config.chemins.logs, `${PREFIXE_LOG}-${jour()}.log`);
}

function purgerAnciensFichiers(): void {
  try {
    const limite = Date.now() - RETENTION_JOURS * 24 * 3600 * 1000;
    for (const nom of fs.readdirSync(config.chemins.logs)) {
      if (!nom.startsWith(`${PREFIXE_LOG}-`)) continue;
      const complet = path.join(config.chemins.logs, nom);
      if (fs.statSync(complet).mtimeMs < limite) fs.unlinkSync(complet);
    }
  } catch {
    /* la purge des journaux ne doit jamais faire echouer le processus */
  }
}

function ecrireFichier(ligne: string): void {
  try {
    const cible = fichierDuJour();
    if (fs.existsSync(cible) && fs.statSync(cible).size > TAILLE_MAX_OCTETS) {
      fs.renameSync(cible, `${cible}.${Date.now()}.old`);
    }
    fs.appendFileSync(cible, ligne + '\n', 'utf8');
  } catch {
    /* un disque plein ne doit pas tuer le bot */
  }
}

function formater(niveau: Niveau, message: string, extra?: unknown): string {
  const horodatage = new Date().toISOString();
  let suffixe = '';
  if (extra !== undefined) {
    if (extra instanceof Error) {
      suffixe = ` | ${extra.name}: ${extra.message}`;
    } else if (typeof extra === 'object' && extra !== null) {
      try {
        suffixe = ` | ${JSON.stringify(extra)}`;
      } catch {
        suffixe = ' | [objet non serialisable]';
      }
    } else {
      suffixe = ` | ${String(extra)}`;
    }
  }
  return `${horodatage} [${niveau.toUpperCase()}] ${message}${suffixe}`;
}

function emettre(niveau: Niveau, message: string, extra?: unknown): void {
  if (ORDRE[niveau] > SEUIL) return;
  const ligne = formater(niveau, message, extra);
  if (niveau === 'error') console.error(ligne);
  else if (niveau === 'warn') console.warn(ligne);
  else console.log(ligne);
  ecrireFichier(ligne);
}

purgerAnciensFichiers();
setInterval(purgerAnciensFichiers, 24 * 3600 * 1000).unref();

export const logger = {
  error: (message: string, extra?: unknown) => emettre('error', message, extra),
  warn: (message: string, extra?: unknown) => emettre('warn', message, extra),
  info: (message: string, extra?: unknown) => emettre('info', message, extra),
  debug: (message: string, extra?: unknown) => emettre('debug', message, extra),
};
