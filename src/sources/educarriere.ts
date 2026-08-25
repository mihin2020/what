/**
 * Connecteur emploi.educarriere.ci (portail d'annonces majeur en Cote
 * d'Ivoire, francophone, gros volume — pertinent pour un profil ouvert a
 * la sous-region).
 *
 * Source SCRAPEE (pas d'API). Verifie en direct le 19/08/2026 :
 *  - Structure : rendue cote serveur, cartes `.ej-card` completes en HTML
 *    brut (titre, entreprise, lieu, date, type de contrat).
 *  - Date de publication au jour precis ("Publié le DD/MM/YYYY").
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

const NOM = 'educarriere';
const URL_LISTING = 'https://emploi.educarriere.ci/';
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

  $('.ej-card').each((_i, carte) => {
    if (offres.length >= LIMITE) return;

    const $carte = $(carte);
    // .ej-poste EST l'ancre elle-meme (verifie dans le HTML brut), pas un
    // conteneur autour d'un <a> : chercher un descendant "a" ne trouve rien.
    const $lienTitre = $carte.find('.ej-poste').first();
    const href = $lienTitre.attr('href');
    const titre = $lienTitre.text().trim();
    if (!href || !titre) return;

    const entreprise = $carte.find('.ej-societe').first().text().trim() || null;

    // .ej-lieu apparait deux fois : lieu, puis date (avec icone calendrier).
    const blocsLieu = $carte.find('.ej-lieu');
    const lieu = blocsLieu.eq(0).text().trim() || null;
    const dateTexte = blocsLieu.eq(1).text().trim();
    const contexte = $carte.text();

    const contrat = $carte.find('.ej-tag').first().text().trim() || null;

    const url = href.startsWith('http') ? href : `https://emploi.educarriere.ci${href.startsWith('/') ? '' : '/'}${href}`;

    offres.push({
      id_source: href,
      source: NOM,
      titre,
      entreprise,
      lieu,
      pays: "Cote d'Ivoire",
      description: texteBrut(contexte.slice(0, 500)),
      url,
      date_publication: dateTexte ? dateJourFr(dateTexte) : new Date().toISOString(),
      date_limite: extraireDateLimite(titre, contexte),
      teletravail: detecteTeletravail(titre, contexte, lieu),
      contrat,
    });
  });

  logger.info('Source interrogee', { source: NOM, brut: offres.length });
  return offres;
}

export const educarriere: Source = {
  nom: NOM,
  actif: true,
  chercher,
};
