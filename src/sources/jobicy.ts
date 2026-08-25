/**
 * Connecteur Jobicy (offres 100% teletravail, tous secteurs).
 *
 * Pas de cle requise. Endpoint : GET https://jobicy.com/api/v2/remote-jobs
 * Verifie en direct le 17/08/2026 : le parametre "tag" filtre reellement
 * (compare a un appel sans tag, les resultats different nettement).
 */
import { logger } from '../logger.js';
import type { Profil } from '../cv/analyse.js';
import { dateISO, requeteJSON, texteBrut, type Offre, type Source } from './types.js';

const NOM = 'jobicy';
const ENDPOINT = 'https://jobicy.com/api/v2/remote-jobs';
const NB_RESULTATS = 50;

interface ReponseJobicy {
  jobs?: {
    id?: number | string;
    url?: string;
    jobTitle?: string;
    companyName?: string;
    jobGeo?: string | string[];
    jobType?: string | string[];
    jobExcerpt?: string;
    jobDescription?: string;
    pubDate?: string;
  }[];
}

/**
 * Jobicy est un board anglophone : "metier_cible" (toujours en francais, voir
 * ia/prompts.ts) y matche rarement. Les mots-cles de competences/outils sont
 * plus souvent deja en anglais dans un CV tech (React, DevOps, etc.) — on les
 * essaie donc en priorite, avec repli sur metier_cible si la liste est vide.
 */
function choisirTag(profil: Profil): string {
  return (profil.mots_cles_recherche[0] ?? profil.metier_cible).trim();
}

async function chercher(profil: Profil): Promise<Offre[]> {
  const tag = choisirTag(profil);
  const parametres = new URLSearchParams({ count: String(NB_RESULTATS), tag });
  const reponse = await requeteJSON<ReponseJobicy>(NOM, `${ENDPOINT}?${parametres.toString()}`);

  const offres: Offre[] = (reponse.jobs ?? []).slice(0, NB_RESULTATS).map((j) => {
    const description = texteBrut(j.jobDescription ?? j.jobExcerpt);
    const geo = Array.isArray(j.jobGeo) ? j.jobGeo.join(', ') : j.jobGeo;
    return {
      id_source: String(j.id ?? j.url ?? ''),
      source: NOM,
      titre: j.jobTitle?.trim() || 'Offre sans titre',
      entreprise: j.companyName ?? null,
      lieu: geo || 'Remote',
      // jobGeo est une zone textuelle ("Worldwide", "USA Only"), pas un code pays fiable.
      pays: null,
      description,
      url: j.url ?? '',
      date_publication: dateISO(j.pubDate),
      teletravail: true,
      contrat: Array.isArray(j.jobType) ? j.jobType.join(' / ') : (j.jobType ?? null),
    };
  });

  const valides = offres.filter((o) => o.url);
  logger.info('Source interrogee', { source: NOM, tag, brut: valides.length });
  return valides;
}

export const jobicy: Source = {
  nom: NOM,
  actif: true,
  chercher,
};
