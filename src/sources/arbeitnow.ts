/**
 * Connecteur Arbeitnow (tous secteurs, remote et sur site).
 *
 * Pas de cle requise. Endpoint : GET https://arbeitnow.com/api/job-board-api
 * Verifie en direct le 17/08/2026 : PAS de filtrage serveur par mot-cle,
 * l'API renvoie un flux brut. On laisse donc prefiltrer() (source-agnostique)
 * eliminer le hors-sujet plutot que dupliquer sa logique ici.
 *
 * Piege verifie : created_at est en secondes Unix, pas en millisecondes.
 * dateISO() interprete un nombre comme des millisecondes -> sans la
 * conversion ci-dessous, toutes les offres dateraient de 1970 et seraient
 * rejetees comme perimees par prefiltrer().
 */
import { logger } from '../logger.js';
import type { Profil } from '../cv/analyse.js';
import { dateISO, detecteTeletravail, requeteJSON, texteBrut, type Offre, type Source } from './types.js';

const NOM = 'arbeitnow';
const ENDPOINT = 'https://arbeitnow.com/api/job-board-api';
const LIMITE = 50;

interface ReponseArbeitnow {
  data?: {
    slug?: string;
    url?: string;
    title?: string;
    company_name?: string;
    location?: string;
    description?: string;
    remote?: boolean;
    job_types?: string[];
    created_at?: number;
  }[];
}

async function chercher(_profil: Profil): Promise<Offre[]> {
  const reponse = await requeteJSON<ReponseArbeitnow>(NOM, ENDPOINT);

  const offres: Offre[] = (reponse.data ?? []).slice(0, LIMITE).map((r) => {
    const description = texteBrut(r.description);
    const lien = r.url ?? '';
    return {
      id_source: r.slug ?? lien,
      source: NOM,
      titre: r.title?.trim() || 'Offre sans titre',
      entreprise: r.company_name ?? null,
      lieu: r.location ?? null,
      pays: null,
      description,
      url: lien,
      date_publication: dateISO(r.created_at ? r.created_at * 1000 : null),
      teletravail: r.remote === true ? true : detecteTeletravail(r.title, description, r.location),
      contrat: Array.isArray(r.job_types) ? r.job_types.join(' / ') : null,
    };
  });

  const valides = offres.filter((o) => o.url);
  logger.info('Source interrogee', { source: NOM, brut: valides.length });
  return valides;
}

export const arbeitnow: Source = {
  nom: NOM,
  actif: true,
  chercher,
};
