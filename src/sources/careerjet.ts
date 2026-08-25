/**
 * Connecteur Careerjet (agregateur international).
 *
 * Compte partenaire : https://www.careerjet.com/partners
 * Endpoint : GET https://search.api.careerjet.net/v4/query
 *
 * Se desactive si CAREERJET_AFFID manque.
 */
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { Profil } from '../cv/analyse.js';
import {
  dateISO,
  detecteTeletravail,
  extraireDateLimite,
  requeteJSON,
  texteBrut,
  USER_AGENT,
  type Offre,
  type Source,
} from './types.js';

const NOM = 'careerjet';
const ENDPOINT = 'https://search.api.careerjet.net/v4/query';
const LIMITE = 50;

interface ReponseCareerjet {
  type?: string;
  jobs?: {
    title?: string;
    company?: string;
    locations?: string;
    description?: string;
    url?: string;
    date?: string;
    site?: string;
  }[];
}

function motsCles(profil: Profil): string {
  return [profil.metier_cible, ...profil.mots_cles_recherche.slice(0, 3)]
    .map((t) => t.trim())
    .filter(Boolean)
    .join(' ');
}

async function chercher(profil: Profil): Promise<Offre[]> {
  const keywords = motsCles(profil);
  const location =
    config.lieuxAcceptesListe.find((z) => !/teletravail|remote/i.test(z)) ?? 'Burkina Faso';

  const parametres = new URLSearchParams({
    affid: config.CAREERJET_AFFID,
    keywords,
    location,
    locale_code: config.CAREERJET_LOCALE,
    page_size: String(LIMITE),
    page: '1',
    sort: 'date',
    user_ip: '127.0.0.1',
    user_agent: USER_AGENT,
    // URL de "page resultats" exigee par l'API partenaire.
    url: 'https://localhost/veille',
  });

  const reponse = await requeteJSON<ReponseCareerjet>(NOM, `${ENDPOINT}?${parametres.toString()}`);

  // Modes "location" / erreurs : pas de jobs, on renvoie vide proprement.
  if (!Array.isArray(reponse.jobs)) {
    logger.info('Source interrogee', {
      source: NOM,
      keywords,
      brut: 0,
      type: reponse.type ?? 'sans_jobs',
    });
    return [];
  }

  const offres: Offre[] = reponse.jobs.slice(0, LIMITE).map((j, index) => {
    const description = texteBrut(j.description);
    const url = j.url ?? '';
    return {
      id_source: url || `${NOM}-${index}`,
      source: NOM,
      titre: j.title?.trim() || 'Offre sans titre',
      entreprise: j.company ?? null,
      lieu: j.locations ?? null,
      pays: null,
      description,
      url,
      date_publication: dateISO(j.date),
      date_limite: extraireDateLimite(j.title, description),
      teletravail: detecteTeletravail(j.title, description, j.locations),
      contrat: null,
    };
  });

  const valides = offres.filter((o) => o.url);
  logger.info('Source interrogee', { source: NOM, keywords, brut: valides.length });
  return valides;
}

export const careerjet: Source = {
  nom: NOM,
  actif: Boolean(config.CAREERJET_AFFID),
  chercher,
};
