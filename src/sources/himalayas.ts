/**
 * Connecteur Himalayas (offres 100% teletravail, tous secteurs).
 *
 * Pas de cle requise. Endpoint : GET https://himalayas.app/jobs/api/search?q=...
 * Verifie en direct le 17/08/2026 : enveloppe {comments, updatedAt, offset,
 * limit, totalCount, jobs: [...]}, filtrage par "q" reellement effectif.
 */
import { logger } from '../logger.js';
import type { Profil } from '../cv/analyse.js';
import { dateISO, requeteJSON, texteBrut, type Offre, type Source } from './types.js';

const NOM = 'himalayas';
const ENDPOINT = 'https://himalayas.app/jobs/api/search';
const LIMITE = 50;

interface ReponseHimalayas {
  jobs?: {
    guid?: string;
    title?: string;
    excerpt?: string;
    description?: string;
    companyName?: string;
    locationRestrictions?: string[];
    employmentType?: string;
    pubDate?: number;
    applicationLink?: string;
  }[];
}

/** Un seul terme libre : metier cible en priorite, complete par les mots-cles. */
function construireRequete(profil: Profil): string {
  const termes = [profil.metier_cible, ...profil.mots_cles_recherche.slice(0, 3)]
    .map((t) => t.trim())
    .filter(Boolean);
  return termes.slice(0, 2).join(' ');
}

async function chercher(profil: Profil): Promise<Offre[]> {
  const q = construireRequete(profil);
  const parametres = new URLSearchParams({ q, limit: String(LIMITE) });
  const reponse = await requeteJSON<ReponseHimalayas>(NOM, `${ENDPOINT}?${parametres.toString()}`);

  const offres: Offre[] = (reponse.jobs ?? []).slice(0, LIMITE).map((j) => {
    const description = texteBrut(j.description ?? j.excerpt);
    return {
      id_source: j.guid ?? j.applicationLink ?? '',
      source: NOM,
      titre: j.title?.trim() || 'Offre sans titre',
      entreprise: j.companyName ?? null,
      lieu: j.locationRestrictions?.length ? j.locationRestrictions.join(', ') : 'Remote (monde entier)',
      pays: j.locationRestrictions?.[0] ?? null,
      description,
      url: j.applicationLink ?? j.guid ?? '',
      date_publication: dateISO(j.pubDate ? j.pubDate * 1000 : null),
      // Board 100% teletravail : pas d'ambiguite a lever via detecteTeletravail().
      teletravail: true,
      contrat: j.employmentType ?? null,
    };
  });

  const valides = offres.filter((o) => o.url);
  logger.info('Source interrogee', { source: NOM, q, brut: valides.length });
  return valides;
}

export const himalayas: Source = {
  nom: NOM,
  actif: true,
  chercher,
};
