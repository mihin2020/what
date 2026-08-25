/**
 * Connecteur Novojob (portail d'annonces Afrique francophone).
 *
 * Source SCRAPEE : https://www.novojob.com/offres-d-emploi
 * Structure verifiee : cartes `.job-details` + liens `/offre-d-emploi/...`.
 * Les dates limites eventuelles sont extraites du texte de la carte.
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

const NOM = 'novojob';
const URL_LISTING = 'https://www.novojob.com/offres-d-emploi';
const LIMITE = 50;

function dateJourFr(texte: string): string {
  const m = texte.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (!m) return new Date().toISOString();
  let annee = Number(m[3]);
  if (annee < 100) annee += 2000;
  const d = new Date(Date.UTC(annee, Number(m[2]) - 1, Number(m[1])));
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

async function chercher(_profil: Profil): Promise<Offre[]> {
  const html = await requeteHTML(NOM, URL_LISTING);
  const $ = cheerio.load(html);
  const offres: Offre[] = [];
  const vues = new Set<string>();

  $('.job-details, .row-fluid.job-details').each((_i, carte) => {
    if (offres.length >= LIMITE) return;

    const $carte = $(carte);
    const $lien = $carte.find('a[href*="offre-d-emploi"]').first();
    const href = ($lien.attr('href') || '').trim();
    if (!href) return;

    const titre = $lien.text().replace(/\s+/g, ' ').trim();
    if (!titre || titre.length < 5) return;

    const url = href.startsWith('http') ? href : `https://www.novojob.com${href.startsWith('/') ? '' : '/'}${href}`;
    if (vues.has(url)) return;
    vues.add(url);

    const contexte = $carte.text().replace(/\s+/g, ' ').trim();
    const entreprise =
      $carte.find('.company, .entreprise, [class*="company"]').first().text().trim() || null;
    const lieu =
      $carte.find('.location, .lieu, [class*="location"]').first().text().trim() || null;
    const dateMatch = contexte.match(/(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/);

    // Pays approximatif depuis l'URL (/cote-d-ivoire/, /senegal/, …).
    const paysMatch = url.match(/offre-d-emploi\/([a-z0-9\-]+)\//i);
    const paysSlug = paysMatch?.[1] && !/^\d/.test(paysMatch[1]) ? paysMatch[1] : null;

    offres.push({
      id_source: href,
      source: NOM,
      titre,
      entreprise,
      lieu,
      pays: paysSlug ? paysSlug.replace(/-/g, ' ') : null,
      description: texteBrut(contexte.slice(0, 600)),
      url,
      date_publication: dateMatch ? dateJourFr(dateMatch[1] as string) : new Date().toISOString(),
      date_limite: extraireDateLimite(titre, contexte),
      teletravail: detecteTeletravail(titre, contexte, lieu),
      contrat: null,
    });
  });

  // Repli si la structure CSS change : liens bruts.
  if (offres.length === 0) {
    $('a[href*="offre-d-emploi/"]').each((_i, lien) => {
      if (offres.length >= LIMITE) return;
      const href = ($(lien).attr('href') || '').trim();
      const titre = $(lien).text().replace(/\s+/g, ' ').trim();
      if (!href || !titre || titre.length < 8) return;
      const url = href.startsWith('http') ? href : `https://www.novojob.com${href.startsWith('/') ? '' : '/'}${href}`;
      if (vues.has(url)) return;
      vues.add(url);
      offres.push({
        id_source: href,
        source: NOM,
        titre,
        entreprise: null,
        lieu: null,
        pays: null,
        description: '',
        url,
        date_publication: new Date().toISOString(),
        date_limite: extraireDateLimite(titre),
        teletravail: detecteTeletravail(titre),
        contrat: null,
      });
    });
  }

  logger.info('Source interrogee', { source: NOM, brut: offres.length });
  return offres;
}

export const novojob: Source = {
  nom: NOM,
  actif: true,
  chercher,
};
