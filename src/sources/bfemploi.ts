/**
 * Connecteur bfemploi.com (portail d'annonces au Burkina Faso).
 *
 * Source SCRAPEE (pas d'API). Verifie en direct le 19/08/2026 :
 *  - Structure : rendue cote serveur, annonces en HTML brut
 *    (`annonce-details-XXXX.html`).
 *  - Date de publication au jour precis ("Publié le DD/MM/YYYY") : meilleure
 *    granularite que emploi.lefaso.net.
 *  - robots.txt : pas de restriction trouvee sur les pages d'annonces.
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

const NOM = 'bfemploi';
const URL_LISTING = 'https://www.bfemploi.com/';
const LIMITE = 50;

/** Format confirme en direct : "Publié le 05/08/2026". */
function dateJourFr(texte: string): string {
  const m = texte.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return new Date().toISOString();
  const [, jour, mois, annee] = m;
  const d = new Date(Date.UTC(Number(annee), Number(mois) - 1, Number(jour)));
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

async function chercher(_profil: Profil): Promise<Offre[]> {
  const html = await requeteHTML(NOM, URL_LISTING);
  const $ = cheerio.load(html);

  const offres: Offre[] = [];

  $('a[href^="annonce-details-"]').each((_i, lien) => {
    if (offres.length >= LIMITE) return;

    const $lien = $(lien);
    const href = $lien.attr('href');
    if (!href) return;

    const titre = $lien.find('span.ance_titre').first().text().trim() || $lien.text().trim();
    if (!titre) return;

    const contexte = $lien.closest('div, li, tr, article').text();
    const dateMatch = contexte.match(/Publi[ée]\s+le\s+(\d{2}\/\d{2}\/\d{4})/i);
    const structure = $lien.closest('div, li, tr, article').find('a[href*="recherche_offre-structure"]').first().text().trim();

    const url = href.startsWith('http') ? href : `https://www.bfemploi.com/${href.replace(/^\/+/, '')}`;

    offres.push({
      id_source: href,
      source: NOM,
      titre,
      entreprise: structure || null,
      lieu: null,
      pays: 'Burkina Faso',
      description: texteBrut(contexte.slice(0, 500)),
      url,
      date_publication: dateMatch ? dateJourFr(dateMatch[1] as string) : new Date().toISOString(),
      date_limite: extraireDateLimite(titre, contexte),
      teletravail: detecteTeletravail(titre, contexte),
      contrat: null,
    });
  });

  logger.info('Source interrogee', { source: NOM, brut: offres.length });
  return offres;
}

export const bfemploi: Source = {
  nom: NOM,
  actif: true,
  chercher,
};
