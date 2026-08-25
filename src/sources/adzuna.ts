/**
 * Connecteur Adzuna (couverture Europe et international).
 *
 * Cle gratuite a demander sur https://developer.adzuna.com/
 * Endpoint : GET https://api.adzuna.com/v1/api/jobs/{pays}/search/{page}
 *
 * La source se desactive d'elle-meme si ADZUNA_APP_ID ou ADZUNA_APP_KEY
 * manquent : le cycle de veille continue alors avec les autres sources.
 */
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { Profil } from '../cv/analyse.js';
import {
  dateISO,
  detecteTeletravail,
  requeteJSON,
  texteBrut,
  type Offre,
  type Source,
} from './types.js';

const NOM = 'adzuna';
const BASE = 'https://api.adzuna.com/v1/api/jobs';
const RESULTATS_PAR_PAGE = 50;
/** Nombre de requetes distinctes (une par groupe de mots-cles). */
const NB_REQUETES = 2;
/** Delai entre deux requetes vers la meme source, par politesse. */
const DELAI_ENTRE_REQUETES_MS = 2000;

interface ReponseAdzuna {
  results?: {
    id?: string | number;
    title?: string;
    description?: string;
    redirect_url?: string;
    created?: string;
    company?: { display_name?: string };
    location?: { display_name?: string; area?: string[] };
    contract_type?: string;
    contract_time?: string;
  }[];
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Adzuna n'accepte qu'une expression courte par requete. On decoupe donc les
 * mots-cles du profil en quelques requetes distinctes, fusionnees ensuite.
 */
function construireRequetes(profil: Profil): string[] {
  const termes = [profil.metier_cible, ...profil.mots_cles_recherche]
    .map((t) => t.trim())
    .filter((t) => t.length > 2);

  const uniques = [...new Set(termes.map((t) => t.toLowerCase()))].slice(0, 6);
  const requetes: string[] = [];
  const taille = Math.max(1, Math.ceil(uniques.length / NB_REQUETES));

  for (let i = 0; i < uniques.length && requetes.length < NB_REQUETES; i += taille) {
    requetes.push(uniques.slice(i, i + taille).join(' '));
  }
  return requetes.length > 0 ? requetes : [profil.metier_cible];
}

async function chercher(profil: Profil): Promise<Offre[]> {
  const collectees = new Map<string, Offre>();
  const requetes = construireRequetes(profil);

  for (const [index, quoi] of requetes.entries()) {
    if (index > 0) await dormir(DELAI_ENTRE_REQUETES_MS);

    const parametres = new URLSearchParams({
      app_id: config.ADZUNA_APP_ID,
      app_key: config.ADZUNA_APP_KEY,
      results_per_page: String(RESULTATS_PAR_PAGE),
      what_or: quoi,
      max_days_old: String(config.MAX_ANCIENNETE_JOURS),
      sort_by: 'date',
      'content-type': 'application/json',
    });

    const url = `${BASE}/${encodeURIComponent(config.ADZUNA_PAYS)}/search/1?${parametres.toString()}`;
    const reponse = await requeteJSON<ReponseAdzuna>(NOM, url);

    for (const r of reponse.results ?? []) {
      const lien = r.redirect_url;
      if (!lien) continue;

      const description = texteBrut(r.description);
      const zone = r.location?.area ?? [];
      const offre: Offre = {
        id_source: String(r.id ?? lien),
        source: NOM,
        titre: r.title?.trim() || 'Offre sans titre',
        entreprise: r.company?.display_name ?? null,
        lieu: r.location?.display_name ?? null,
        pays: zone[0] ?? null,
        description,
        url: lien,
        date_publication: dateISO(r.created),
        teletravail: detecteTeletravail(r.title, description, r.location?.display_name),
        contrat: [r.contract_type, r.contract_time].filter(Boolean).join(' / ') || null,
      };
      collectees.set(offre.url, offre);
    }
  }

  logger.info('Source interrogee', { source: NOM, requetes: requetes.length, brut: collectees.size });
  return [...collectees.values()];
}

export const adzuna: Source = {
  nom: NOM,
  actif: Boolean(config.ADZUNA_APP_ID && config.ADZUNA_APP_KEY),
  chercher,
};
