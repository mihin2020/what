/**
 * Registre des sources.
 *
 * Pour ajouter une source : creer le fichier, l'importer ici, l'ajouter au
 * tableau. Aucune autre modification du code n'est necessaire (section 6.7).
 * Voir docs/AJOUT_SOURCE.md.
 */
import { logger } from '../logger.js';
import { reliefweb } from './reliefweb.js';
import { adzuna } from './adzuna.js';
import { himalayas } from './himalayas.js';
import { jobicy } from './jobicy.js';
import { arbeitnow } from './arbeitnow.js';
import { africarrieres } from './africarrieres.js';
import { goafricaonline } from './goafricaonline.js';
import { lefaso } from './lefaso.js';
import { bfemploi } from './bfemploi.js';
import { educarriere } from './educarriere.js';
import { workingnomads } from './workingnomads.js';
import { weworkremotely } from './weworkremotely.js';
import { nodesk } from './nodesk.js';
import { remotive } from './remotive.js';
import { remoteok } from './remoteok.js';
import { themuse } from './themuse.js';
import { novojob } from './novojob.js';
import { jooble } from './jooble.js';
import { careerjet } from './careerjet.js';
import type { Offre, Source } from './types.js';
import type { Profil } from '../cv/analyse.js';

export const SOURCES: Source[] = [
  reliefweb,
  adzuna,
  jooble,
  careerjet,
  himalayas,
  jobicy,
  arbeitnow,
  remotive,
  remoteok,
  themuse,
  africarrieres,
  goafricaonline,
  lefaso,
  bfemploi,
  educarriere,
  novojob,
  workingnomads,
  weworkremotely,
  nodesk,
];

/**
 * Sources rapides (API) pour le premier digest juste apres un CV.
 * Les scrapes et sources lentes passent dans le complement.
 */
export const NOMS_SOURCES_FLASH = new Set([
  'reliefweb',
  'adzuna',
  'jooble',
  'careerjet',
  'himalayas',
  'jobicy',
  'arbeitnow',
  'remotive',
  'remoteok',
  'themuse',
  'lefaso',
  'bfemploi',
]);

export const sourcesActives = (): Source[] => SOURCES.filter((s) => s.actif);

export type ModeCollecte = 'complet' | 'flash' | 'complement';

export interface ResultatSource {
  nom: string;
  ok: boolean;
  offres: Offre[];
  erreur?: string;
  duree_ms: number;
}

function selectionnerSources(mode: ModeCollecte): Source[] {
  const actives = sourcesActives();
  if (mode === 'flash') return actives.filter((s) => NOMS_SOURCES_FLASH.has(s.nom));
  if (mode === 'complement') return actives.filter((s) => !NOMS_SOURCES_FLASH.has(s.nom));
  return actives;
}

/**
 * Interroge les sources actives en parallele (ou un sous-ensemble selon le mode).
 * Un connecteur en echec ne doit JAMAIS interrompre le cycle (section 6.7) :
 * l'erreur est capturee, journalisee, et un tableau vide est retourne.
 */
export async function collecter(
  profil: Profil,
  mode: ModeCollecte = 'complet',
): Promise<ResultatSource[]> {
  const selection = selectionnerSources(mode);

  if (selection.length === 0) {
    logger.warn('Aucune source active pour ce mode', { mode });
    return [];
  }

  return Promise.all(
    selection.map(async (source): Promise<ResultatSource> => {
      const debut = Date.now();
      try {
        const offres = await source.chercher(profil);
        return { nom: source.nom, ok: true, offres, duree_ms: Date.now() - debut };
      } catch (erreur) {
        const message = erreur instanceof Error ? erreur.message : String(erreur);
        logger.error('Source en echec', { source: source.nom, message });
        return {
          nom: source.nom,
          ok: false,
          offres: [],
          erreur: message,
          duree_ms: Date.now() - debut,
        };
      }
    }),
  );
}

export type { Offre, Source } from './types.js';
