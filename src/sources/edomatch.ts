/**
 * Connecteur edomatch.com (agregateur d'offres Afrique).
 *
 * Source SCRAPEE. Listing : https://www.edomatch.com/jobs
 * Fiches : /jobs/{slug}
 */
import * as cheerio from 'cheerio';
import { logger } from '../logger.js';
import type { Profil } from '../cv/analyse.js';
import {
  detecteTeletravail,
  extraireDateLimite,
  requeteHTML,
  texteBrut,
  type Offre,
  type Source,
} from './types.js';

const NOM = 'edomatch';
const URL_LISTING = 'https://www.edomatch.com/jobs';
const LIMITE = 50;

async function chercher(profil: Profil): Promise<Offre[]> {
  const mots = (profil.mots_cles_recherche ?? []).slice(0, 3).join(' ').trim();
  const url = mots
    ? `${URL_LISTING}?q=${encodeURIComponent(mots)}`
    : `${URL_LISTING}?country=${encodeURIComponent('Burkina Faso')}`;

  const html = await requeteHTML(NOM, url);
  const $ = cheerio.load(html);
  const offres: Offre[] = [];
  const vus = new Set<string>();

  $('a[href*="/jobs/"]').each((_i, lien) => {
    if (offres.length >= LIMITE) return;
    const $lien = $(lien);
    let href = ($lien.attr('href') ?? '').split('?')[0]?.trim() ?? '';
    if (!href || href === '/jobs' || href.endsWith('/jobs')) return;
    if (!href.startsWith('http')) href = `https://www.edomatch.com${href.startsWith('/') ? '' : '/'}${href}`;
    if (vus.has(href)) return;
    vus.add(href);

    const brut = $lien.text().replace(/\s+/g, ' ').trim();
    // Texte type : "CSSExternalIngénieur(e)...View details..."
    const sansDetails = brut.replace(/View details.*/i, '').trim();
    const titre =
      sansDetails
        .replace(/^([A-Za-z0-9 .,&'’-]+?)(External|Internal)/i, '')
        .replace(/^(External|Internal)/i, '')
        .trim() || sansDetails;
    if (!titre || titre.length < 4) return;

    const entrepriseMatch = brut.match(/^(.+?)(External|Internal)/i);
    const entreprise = entrepriseMatch?.[1]?.trim() || null;
    const id = href.split('/').filter(Boolean).pop() ?? href;

    offres.push({
      id_source: id,
      source: NOM,
      titre: titre.slice(0, 200),
      entreprise,
      lieu: null,
      pays: null,
      description: texteBrut(brut.slice(0, 800)),
      url: href,
      date_publication: new Date().toISOString(),
      date_limite: extraireDateLimite(titre, brut),
      teletravail: detecteTeletravail(titre, brut),
      contrat: null,
    });
  });

  logger.info('Source interrogee', { source: NOM, brut: offres.length });
  return offres;
}

export const edomatch: Source = {
  nom: NOM,
  actif: true,
  chercher,
};
