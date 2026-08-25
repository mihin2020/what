/**
 * Connecteur Jooble (agregateur international).
 *
 * Cle gratuite partenaire : https://jooble.org/api/about
 * Endpoint : POST https://jooble.org/api/{cle}
 *
 * Se desactive si JOOBLE_CLE manque.
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
  type Offre,
  type Source,
} from './types.js';

const NOM = 'jooble';
const ENDPOINT = 'https://jooble.org/api';
const LIMITE = 50;

interface ReponseJooble {
  jobs?: {
    id?: number | string;
    title?: string;
    company?: string;
    location?: string;
    snippet?: string;
    link?: string;
    updated?: string;
    type?: string;
  }[];
}

function motsCles(profil: Profil): string {
  return [profil.metier_cible, ...profil.mots_cles_recherche.slice(0, 4)]
    .map((t) => t.trim())
    .filter(Boolean)
    .join(' ');
}

async function chercher(profil: Profil): Promise<Offre[]> {
  const keywords = motsCles(profil);
  const location =
    config.lieuxAcceptesListe.find((z) => !/teletravail|remote/i.test(z)) ?? 'Burkina Faso';

  const reponse = await requeteJSON<ReponseJooble>(NOM, `${ENDPOINT}/${config.JOOBLE_CLE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      keywords,
      location,
      page: 1,
      ResultOnPage: LIMITE,
    }),
  });

  const offres: Offre[] = (reponse.jobs ?? []).slice(0, LIMITE).map((j) => {
    const description = texteBrut(j.snippet);
    return {
      id_source: String(j.id ?? j.link ?? ''),
      source: NOM,
      titre: j.title?.trim() || 'Offre sans titre',
      entreprise: j.company ?? null,
      lieu: j.location ?? null,
      pays: null,
      description,
      url: j.link ?? '',
      date_publication: dateISO(j.updated),
      date_limite: extraireDateLimite(j.title, description),
      teletravail: detecteTeletravail(j.title, description, j.location),
      contrat: j.type ?? null,
    };
  });

  const valides = offres.filter((o) => o.url);
  logger.info('Source interrogee', { source: NOM, keywords, brut: valides.length });
  return valides;
}

export const jooble: Source = {
  nom: NOM,
  actif: Boolean(config.JOOBLE_CLE),
  chercher,
};
