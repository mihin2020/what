/**
 * Connecteur emploi.lefaso.net (portail d'annonces du site d'actualite
 * lefaso.net, tres suivi au Burkina Faso).
 *
 * Source SCRAPEE (pas d'API). Verifie en direct le 19/08/2026 :
 *  - robots.txt : autorise (`Disallow` limite a /local/, /ecrire/, /prive/ ;
 *    `Crawl-delay: 1` respecte de fait, une seule requete par cycle).
 *  - Structure : rendue cote serveur, offres presentes dans le HTML brut.
 *  - Date de publication a granularite MOIS/ANNEE seulement (ex. "PUBLIÉE
 *    Septembre 2025"), jamais le jour. Le prefiltre par anciennete
 *    (MAX_ANCIENNETE_JOURS) sera donc moins precis sur cette source.
 */
import * as cheerio from 'cheerio';
import { logger } from '../logger.js';
import type { Profil } from '../cv/analyse.js';
import { requeteHTML, texteBrut, type Offre, type Source } from './types.js';

const NOM = 'lefaso';
const URL_LISTING = 'https://emploi.lefaso.net/';
const LIMITE = 50;

const MOIS_FR: Record<string, number> = {
  janvier: 0,
  fevrier: 1,
  février: 1,
  mars: 2,
  avril: 3,
  mai: 4,
  juin: 5,
  juillet: 6,
  aout: 7,
  août: 7,
  septembre: 8,
  octobre: 9,
  novembre: 10,
  decembre: 11,
  décembre: 11,
};

/** Format confirme en direct : "PUBLIÉE Septembre 2025" (jamais de jour). */
function dateMoisAnneeFr(texte: string): string {
  const m = texte
    .toLowerCase()
    .match(/(janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre)\s+(\d{4})/);
  if (!m) return new Date().toISOString();

  const mois = MOIS_FR[m[1] as string];
  if (mois === undefined) return new Date().toISOString();

  return new Date(Date.UTC(Number(m[2]), mois, 1)).toISOString();
}

async function chercher(_profil: Profil): Promise<Offre[]> {
  const html = await requeteHTML(NOM, URL_LISTING);
  const $ = cheerio.load(html);

  const offres: Offre[] = [];

  $('h2.offre-title > a').each((_i, lien) => {
    if (offres.length >= LIMITE) return;

    const $lien = $(lien);
    const href = $lien.attr('href');
    const titre = $lien.text().trim();
    if (!href || !titre) return;

    // Le lieu, l'entreprise et la date sont meles dans le meme bloc texte
    // libre (pas de champs separes) : seule la date est extraite de facon
    // fiable via un motif regulier, le reste resterait une supposition.
    const sousTitre = $lien.closest('.offre-title, div, article').next('.offre-subtitle').text()
      || $lien.parent().siblings('.offre-subtitle').text()
      || '';

    const url = href.startsWith('http') ? href : `https://emploi.lefaso.net/${href.replace(/^\/+/, '')}`;

    offres.push({
      id_source: href,
      source: NOM,
      titre,
      entreprise: null,
      lieu: null,
      pays: 'Burkina Faso',
      description: texteBrut(''), // pas de detail sur la liste, pas de requete par offre (evite N+1)
      url,
      date_publication: sousTitre ? dateMoisAnneeFr(sousTitre) : new Date().toISOString(),
      teletravail: null,
      contrat: null,
    });
  });

  logger.info('Source interrogee', { source: NOM, brut: offres.length });
  return offres;
}

export const lefaso: Source = {
  nom: NOM,
  actif: true,
  chercher,
};
