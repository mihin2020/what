/**
 * Connecteur alertejob.org (annonces BF / Afrique de l'Ouest).
 *
 * Source SCRAPEE (WordPress / job listings). Listing :
 * https://alertejob.org/?post_type=job_listing
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

const NOM = 'alertejob';
const URL_LISTING = 'https://alertejob.org/?post_type=job_listing';
const LIMITE = 50;

async function chercher(_profil: Profil): Promise<Offre[]> {
  const html = await requeteHTML(NOM, URL_LISTING);
  const $ = cheerio.load(html);
  const offres: Offre[] = [];
  const vus = new Set<string>();

  $('a[rel="bookmark"][href*="/job/"]').each((_i, lien) => {
    if (offres.length >= LIMITE) return;
    const $lien = $(lien);
    const href = ($lien.attr('href') ?? '').split('#')[0]?.trim();
    const titre = $lien.text().replace(/\s+/g, ' ').trim();
    if (!href || !titre || vus.has(href)) return;
    vus.add(href);

    const bloc = $lien.closest('article, li, div').text().replace(/\s+/g, ' ').trim();
    const id = href.match(/\/job\/(\d+)/)?.[1] ?? href;

    offres.push({
      id_source: id,
      source: NOM,
      titre,
      entreprise: null,
      lieu: /burkina/i.test(bloc) ? 'Burkina Faso' : null,
      pays: /burkina/i.test(bloc) ? 'Burkina Faso' : null,
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

export const alertejob: Source = {
  nom: NOM,
  actif: true,
  chercher,
};
