/**
 * Connecteur NoDesk (offres 100% teletravail, tous secteurs).
 *
 * Source SCRAPEE (pas d'API). Verifie en direct le 19/08/2026 :
 *  - Structure : rendue cote serveur, cartes completes en HTML brut.
 *  - Piege verifie : la page contient AUSSI des tuiles de navigation par
 *    categorie utilisant elles aussi un `h2 > a[href^="/remote-jobs/"]`
 *    (ex. lien vers /remote-jobs/customer-support/) — un selecteur trop
 *    large les confond avec de vraies offres. Seules les vraies cartes
 *    d'offre ont la classe `lh-title` sur leur `h2` (verifie en direct) :
 *    c'est ce qui les distingue de facon fiable.
 *  - Date de publication non confirmee sur la page de listing (visible
 *    seulement sur la page de detail, non recuperee ici pour eviter une
 *    requete par offre) : on utilise l'instant du scrape, comme repli
 *    documente dans docs/AJOUT_SOURCE.md.
 */
import * as cheerio from 'cheerio';
import { logger } from '../logger.js';
import type { Profil } from '../cv/analyse.js';
import { requeteHTML, texteBrut, type Offre, type Source } from './types.js';

const NOM = 'nodesk';
const URL_LISTING = 'https://nodesk.co/remote-jobs/';
const LIMITE = 50;

async function chercher(_profil: Profil): Promise<Offre[]> {
  const html = await requeteHTML(NOM, URL_LISTING);
  const $ = cheerio.load(html);

  const offres: Offre[] = [];

  $('h2.lh-title > a[href^="/remote-jobs/"]').each((_i, lien) => {
    if (offres.length >= LIMITE) return;

    const $lien = $(lien);
    const href = $lien.attr('href');
    const titre = $lien.text().trim();
    if (!href || !titre) return;

    const entreprise = $lien.closest('h2').next('h3').first().text().trim() || null;

    offres.push({
      id_source: href,
      source: NOM,
      titre,
      entreprise,
      lieu: 'Remote',
      pays: null,
      description: texteBrut(''), // pas de detail sur la liste, pas de requete par offre (evite N+1)
      url: `https://nodesk.co${href}`,
      date_publication: new Date().toISOString(),
      teletravail: true,
      contrat: null,
    });
  });

  logger.info('Source interrogee', { source: NOM, brut: offres.length });
  return offres;
}

export const nodesk: Source = {
  nom: NOM,
  actif: true,
  chercher,
};
