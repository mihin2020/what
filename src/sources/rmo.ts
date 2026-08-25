/**
 * Connecteur rmo-jobcenter.com (RMO Burkina Faso — interim / recrutement).
 *
 * Source SCRAPEE. Listing pays :
 * https://www.rmo-jobcenter.com/fr/burkina-faso.html
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

const NOM = 'rmo';
const URL_LISTING = 'https://www.rmo-jobcenter.com/fr/burkina-faso.html';
const LIMITE = 50;

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
  const vus = new Set<string>();

  $('a[href*="/offres-emploi/"]').each((_i, lien) => {
    if (offres.length >= LIMITE) return;
    const $lien = $(lien);
    const hrefBrut = ($lien.attr('href') ?? '').trim();
    if (!hrefBrut || /offres-emploi\.html$/i.test(hrefBrut)) return;

    const href = hrefBrut.startsWith('http')
      ? hrefBrut
      : `https://www.rmo-jobcenter.com/${hrefBrut.replace(/^\/+/, '')}`;
    if (vus.has(href)) return;
    vus.add(href);

    const texte = $lien.text().replace(/\s+/g, ' ').trim();
    if (!texte || texte.length < 8) return;

    // Ex. "Directeur des RH22/07/2026 - Ref :#447077Industrie/..."
    const dateMatch = texte.match(/(\d{2}\/\d{2}\/\d{4})/);
    const titre = (dateMatch ? texte.slice(0, dateMatch.index).trim() : texte.split(' - Ref')[0]?.trim()) || texte;
    if (!titre || titre.length < 4) return;

    const id = href.split('/').pop()?.replace(/\.html$/i, '') ?? href;

    offres.push({
      id_source: id,
      source: NOM,
      titre: titre.slice(0, 200),
      entreprise: 'RMO Burkina Faso',
      lieu: 'Burkina Faso',
      pays: 'Burkina Faso',
      description: texteBrut(texte.slice(0, 800)),
      url: href,
      date_publication: dateMatch ? dateJourFr(dateMatch[1] as string) : new Date().toISOString(),
      date_limite: extraireDateLimite(titre, texte),
      teletravail: detecteTeletravail(titre, texte),
      contrat: null,
    });
  });

  logger.info('Source interrogee', { source: NOM, brut: offres.length });
  return offres;
}

export const rmo: Source = {
  nom: NOM,
  actif: true,
  chercher,
};
