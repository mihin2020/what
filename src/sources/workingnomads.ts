/**
 * Connecteur WorkingNomads (offres 100% teletravail, tous secteurs).
 *
 * Pas de cle requise. Endpoint : GET https://www.workingnomads.com/api/exposed_jobs/
 * Verifie en direct le 19/08/2026 : endpoint public sans authentification,
 * robots.txt totalement ouvert. NON documente officiellement par le site
 * (pas de page API publique trouvee) : a surveiller, peut changer sans
 * preavis contrairement aux API documentees (jobicy, arbeitnow).
 */
import { logger } from '../logger.js';
import type { Profil } from '../cv/analyse.js';
import { dateISO, requeteJSON, texteBrut, type Offre, type Source } from './types.js';

const NOM = 'workingnomads';
const ENDPOINT = 'https://www.workingnomads.com/api/exposed_jobs/';
const LIMITE = 50;

interface OffreWorkingNomads {
  url?: string;
  title?: string;
  description?: string;
  company_name?: string;
  category_name?: string;
  tags?: string;
  location?: string;
  pub_date?: string;
}

async function chercher(_profil: Profil): Promise<Offre[]> {
  const reponse = await requeteJSON<OffreWorkingNomads[]>(NOM, ENDPOINT);

  const offres: Offre[] = (Array.isArray(reponse) ? reponse : []).slice(0, LIMITE).map((r) => ({
    id_source: r.url ?? '',
    source: NOM,
    titre: r.title?.trim() || 'Offre sans titre',
    entreprise: r.company_name ?? null,
    lieu: r.location || 'Remote',
    pays: null,
    description: texteBrut(r.description),
    url: r.url ?? '',
    date_publication: dateISO(r.pub_date),
    teletravail: true,
    contrat: r.category_name ?? null,
  }));

  const valides = offres.filter((o) => o.url);
  logger.info('Source interrogee', { source: NOM, brut: valides.length });
  return valides;
}

export const workingnomads: Source = {
  nom: NOM,
  actif: true,
  chercher,
};
