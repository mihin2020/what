/**
 * Connecteur RemoteOK (offres remote — pas d'API key).
 *
 * Endpoint : GET https://remoteok.com/api
 * Le premier element du tableau est un bandeau legal ; les suivants sont des
 * offres. Attribution : conserver l'URL RemoteOK renvoyee.
 */
import { logger } from '../logger.js';
import type { Profil } from '../cv/analyse.js';
import { dateISO, requeteJSON, texteBrut, type Offre, type Source } from './types.js';

const NOM = 'remoteok';
const ENDPOINT = 'https://remoteok.com/api';
const LIMITE = 50;

interface OffreRemoteOK {
  id?: string | number;
  slug?: string;
  url?: string;
  position?: string;
  company?: string;
  location?: string;
  description?: string;
  tags?: string[];
  date?: string;
  epoch?: number;
  // Bandeau legal : present uniquement sur le 1er element.
  legal?: string;
}

function correspondAuProfil(offre: OffreRemoteOK, profil: Profil): boolean {
  const jetons = [
    profil.metier_cible,
    ...profil.mots_cles_recherche.slice(0, 5),
    ...profil.competences.slice(0, 8),
  ]
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 3);

  if (jetons.length === 0) return true;

  const corpus = [offre.position, ...(offre.tags ?? []), offre.description?.slice(0, 400)]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return jetons.some((j) => corpus.includes(j));
}

async function chercher(profil: Profil): Promise<Offre[]> {
  const brut = await requeteJSON<OffreRemoteOK[]>(NOM, ENDPOINT);
  const annonces = (Array.isArray(brut) ? brut : []).filter((j) => !j.legal && (j.url || j.slug));

  const filtrees = annonces.filter((j) => correspondAuProfil(j, profil)).slice(0, LIMITE);

  const offres: Offre[] = filtrees.map((j) => {
    const description = texteBrut(j.description);
    const url = j.url || (j.slug ? `https://remoteok.com/remote-jobs/${j.slug}` : '');
    return {
      id_source: String(j.id ?? j.slug ?? url),
      source: NOM,
      titre: j.position?.trim() || 'Offre sans titre',
      entreprise: j.company ?? null,
      lieu: j.location || 'Remote',
      pays: null,
      description,
      url,
      date_publication: dateISO(j.epoch ? j.epoch * 1000 : j.date),
      date_limite: null,
      teletravail: true,
      contrat: null,
    };
  });

  const valides = offres.filter((o) => o.url);
  logger.info('Source interrogee', { source: NOM, brut: valides.length });
  return valides;
}

export const remoteok: Source = {
  nom: NOM,
  actif: true,
  chercher,
};
