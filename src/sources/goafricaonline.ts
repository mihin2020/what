/**
 * Connecteur GoAfricaOnline (portail generaliste multi-pays, section emploi).
 *
 * Source SCRAPEE (pas d'API). Verifie en direct le 19/08/2026 :
 *  - robots.txt : `Disallow: /api/*`, `/graphql/*`, `/ajax/*` — le chemin de
 *    listing `/bf/emploi` n'est pas concerne, donc autorise.
 *  - Structure : app SvelteKit mais rendue cote SERVEUR (SSR actif), les
 *    offres sont bien presentes dans le HTML brut, pas seulement apres
 *    hydratation JS.
 *  - Seuls le titre, l'URL et la date de publication ont ete confirmes de
 *    facon fiable lors de la verification (salaire/contrat/lieu vus a
 *    l'ecran mais sans selecteur CSS stable identifie) : on ne devine pas
 *    ces champs, ils restent `null` plutot que risquer une extraction fausse.
 *
 * Portee actuelle : Burkina Faso uniquement (`/bf/emploi`), site multi-pays
 * (`/bj/`, `/ao/`, ...) mais seul `/bf/` a ete verifie en direct.
 */
import * as cheerio from 'cheerio';
import { logger } from '../logger.js';
import type { Profil } from '../cv/analyse.js';
import { requeteHTML, texteBrut, type Offre, type Source } from './types.js';

const NOM = 'goafricaonline';
const URL_LISTING = 'https://www.goafricaonline.com/bf/emploi';
const LIMITE = 50;

const MOIS_EN: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/** Format confirme en direct : "Posted on Aug 19, 2026". */
function dateAnglaiseVersISO(texte: string): string {
  const m = texte
    .toLowerCase()
    .match(/([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (!m) return new Date().toISOString();

  const mois = MOIS_EN[m[1] as string];
  if (mois === undefined) return new Date().toISOString();

  return new Date(Date.UTC(Number(m[3]), mois, Number(m[2]))).toISOString();
}

async function chercher(_profil: Profil): Promise<Offre[]> {
  const html = await requeteHTML(NOM, URL_LISTING);
  const $ = cheerio.load(html);

  const offres: Offre[] = [];

  $('a[href*="/emploi/job-"]').each((_i, lien) => {
    if (offres.length >= LIMITE) return;

    const $lien = $(lien);
    const href = $lien.attr('href');
    if (!href) return;

    const titre = $lien.text().trim();
    if (!titre) return; // pas une carte d'offre exploitable

    const contexte = $lien.closest('div, li, article').text();
    const dateMatch = contexte.match(/Posted on\s+([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/i);

    const url = href.startsWith('http') ? href : `https://www.goafricaonline.com${href}`;

    offres.push({
      id_source: href,
      source: NOM,
      titre,
      entreprise: null,
      lieu: null,
      pays: 'Burkina Faso',
      description: texteBrut(''), // pas de detail sur la liste, pas de requete par offre (evite N+1)
      url,
      date_publication: dateMatch ? dateAnglaiseVersISO(dateMatch[1] as string) : new Date().toISOString(),
      teletravail: null,
      contrat: null,
    });
  });

  logger.info('Source interrogee', { source: NOM, brut: offres.length });
  return offres;
}

export const goafricaonline: Source = {
  nom: NOM,
  actif: true,
  chercher,
};
