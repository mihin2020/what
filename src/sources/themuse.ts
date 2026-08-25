/**
 * Connecteur The Muse (offres entreprises — API publique sans cle).
 *
 * Endpoint : GET https://www.themuse.com/api/public/jobs
 * Filtre par mot-cle (category / level optionnels). Les resultats portent une
 * date de publication ; les offres trop anciennes sont eliminees par le
 * prefiltre (MAX_ANCIENNETE_JOURS + date_limite si detectee dans le texte).
 */
import { logger } from '../logger.js';
import type { Profil } from '../cv/analyse.js';
import {
  dateISO,
  detecteTeletravail,
  extraireDateLimite,
  requeteJSON,
  texteBrut,
  type Offre,
  type Source,
} from './types.js';

const NOM = 'themuse';
const ENDPOINT = 'https://www.themuse.com/api/public/jobs';
const LIMITE = 40;

interface ReponseTheMuse {
  results?: {
    id?: number;
    name?: string;
    contents?: string;
    publication_date?: string;
    type?: string;
    locations?: { name?: string }[];
    categories?: { name?: string }[];
    company?: { name?: string };
    refs?: { landing_page?: string };
  }[];
}

function requete(profil: Profil): string {
  return (profil.mots_cles_recherche[0] ?? profil.metier_cible).trim();
}

async function chercher(profil: Profil): Promise<Offre[]> {
  const q = requete(profil);
  // The Muse : 1re page publique, puis filtre cote client (le parametre
  // category n'accepte que des slugs connus, pas un metier libre).
  const reponse = await requeteJSON<ReponseTheMuse>(NOM, `${ENDPOINT}?page=1`);

  const jetons = [q, ...profil.mots_cles_recherche.slice(0, 4)]
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 3);

  let results = reponse.results ?? [];
  const filtrees = results.filter((j) => {
    if (jetons.length === 0) return true;
    const corpus = [j.name, j.company?.name, ...(j.categories ?? []).map((c) => c.name)]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return jetons.some((t) => corpus.includes(t));
  });
  // Si le filtre est trop strict (0 resultat), garder un echantillon brut pour
  // laisser le prefiltre heuristique faire son travail.
  if (filtrees.length === 0) results = results.slice(0, LIMITE);
  else results = filtrees.slice(0, LIMITE);

  const offres: Offre[] = results.map((j) => {
    const description = texteBrut(j.contents);
    const lieu = j.locations?.map((l) => l.name).filter(Boolean).join(', ') || null;
    const url = j.refs?.landing_page ?? (j.id ? `https://www.themuse.com/jobs/${j.id}` : '');
    return {
      id_source: String(j.id ?? url),
      source: NOM,
      titre: j.name?.trim() || 'Offre sans titre',
      entreprise: j.company?.name ?? null,
      lieu,
      pays: null,
      description,
      url,
      date_publication: dateISO(j.publication_date),
      date_limite: extraireDateLimite(j.name, description),
      teletravail: detecteTeletravail(j.name, description, lieu),
      contrat: j.type ?? null,
    };
  });

  const valides = offres.filter((o) => o.url);
  logger.info('Source interrogee', { source: NOM, q, brut: valides.length });
  return valides;
}

export const themuse: Source = {
  nom: NOM,
  actif: true,
  chercher,
};
