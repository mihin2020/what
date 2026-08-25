/**
 * Connecteur criburkina.com (cabinet de recrutement CRI Burkina).
 *
 * Source SCRAPEE. Listing : https://criburkina.com/listeroffre
 * Fiches : /offredetail/{id}
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

const NOM = 'criburkina';
const URL_LISTING = 'https://criburkina.com/';
const LIMITE = 50;

async function chercher(_profil: Profil): Promise<Offre[]> {
  const html = await requeteHTML(NOM, URL_LISTING);
  const $ = cheerio.load(html);
  const offres: Offre[] = [];
  const vus = new Set<string>();

  $('a[href*="/offredetail/"]').each((_i, lien) => {
    if (offres.length >= LIMITE) return;
    const $lien = $(lien);
    const hrefBrut = ($lien.attr('href') ?? '').trim();
    if (!hrefBrut) return;
    const href = hrefBrut.startsWith('http')
      ? hrefBrut
      : `https://criburkina.com/${hrefBrut.replace(/^\/+/, '')}`;
    const titre = $lien.text().replace(/\s+/g, ' ').trim();
    if (
      !titre ||
      titre.length < 8 ||
      /^(en savoir plus|détail|detail|voir|lire la suite)$/i.test(titre) ||
      vus.has(href)
    ) {
      return;
    }
    vus.add(href);

    const bloc = $lien.closest('article, li, div, tr').text().replace(/\s+/g, ' ').trim();
    const id = href.match(/offredetail\/(\d+)/)?.[1] ?? href;

    offres.push({
      id_source: id,
      source: NOM,
      titre,
      entreprise: 'CRI Burkina',
      lieu: 'Burkina Faso',
      pays: 'Burkina Faso',
      description: texteBrut(bloc.slice(0, 800)),
      url: href,
      date_publication: new Date().toISOString(),
      date_limite: extraireDateLimite(titre, bloc),
      teletravail: detecteTeletravail(titre, bloc),
      contrat: null,
    });
  });

  logger.info('Source interrogee', { source: NOM, brut: offres.length });
  return offres;
}

export const criburkina: Source = {
  nom: NOM,
  actif: true,
  chercher,
};
