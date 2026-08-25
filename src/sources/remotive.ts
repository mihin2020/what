/**
 * Connecteur Remotive (offres remote actives uniquement — pas d'API key).
 *
 * Endpoint : GET https://remotive.com/api/remote-jobs
 * L'API ne renvoie que les annonces encore ouvertes : les offres expirees
 * n'apparaissent pas. Attribution requise via l'URL Remotive renvoyee.
 */
import { logger } from '../logger.js';
import type { Profil } from '../cv/analyse.js';
import { dateISO, requeteJSON, texteBrut, type Offre, type Source } from './types.js';

const NOM = 'remotive';
const ENDPOINT = 'https://remotive.com/api/remote-jobs';
const LIMITE = 50;

interface ReponseRemotive {
  jobs?: {
    id?: number | string;
    url?: string;
    title?: string;
    company_name?: string;
    category?: string;
    job_type?: string;
    publication_date?: string;
    candidate_required_location?: string;
    description?: string;
  }[];
}

function requete(profil: Profil): string {
  return (profil.mots_cles_recherche[0] ?? profil.metier_cible).trim();
}

async function chercher(profil: Profil): Promise<Offre[]> {
  const search = requete(profil);
  const parametres = new URLSearchParams({ limit: String(LIMITE) });
  if (search) parametres.set('search', search);

  const reponse = await requeteJSON<ReponseRemotive>(NOM, `${ENDPOINT}?${parametres.toString()}`);

  const offres: Offre[] = (reponse.jobs ?? []).slice(0, LIMITE).map((j) => {
    const description = texteBrut(j.description);
    return {
      id_source: String(j.id ?? j.url ?? ''),
      source: NOM,
      titre: j.title?.trim() || 'Offre sans titre',
      entreprise: j.company_name ?? null,
      lieu: j.candidate_required_location || 'Remote',
      pays: null,
      description,
      url: j.url ?? '',
      date_publication: dateISO(j.publication_date),
      // Remotive ne publie que des offres actives : pas de date_limite explicite.
      date_limite: null,
      teletravail: true,
      contrat: j.job_type ?? null,
    };
  });

  const valides = offres.filter((o) => o.url);
  logger.info('Source interrogee', { source: NOM, search, brut: valides.length });
  return valides;
}

export const remotive: Source = {
  nom: NOM,
  actif: true,
  chercher,
};
