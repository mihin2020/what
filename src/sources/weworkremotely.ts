/**
 * Connecteur We Work Remotely (flux RSS public, offres 100% teletravail).
 *
 * Pas de cle requise. Flux : GET https://weworkremotely.com/remote-jobs.rss
 * Verifie en direct le 19/08/2026 : flux RSS public documente comme tel par
 * le site, robots.txt ouvert. Le titre est au format "Entreprise: Poste" —
 * a scinder sur le premier ": ".
 */
import * as cheerio from 'cheerio';
import { logger } from '../logger.js';
import type { Profil } from '../cv/analyse.js';
import { requeteHTML, texteBrut, dateISO, type Offre, type Source } from './types.js';

const NOM = 'weworkremotely';
const URL_FLUX = 'https://weworkremotely.com/remote-jobs.rss';
const LIMITE = 50;

/** Titre au format "Entreprise: Poste" (verifie en direct) ; repli sur le titre entier si absent. */
function separerEntrepriseEtTitre(titreBrut: string): { entreprise: string | null; titre: string } {
  const index = titreBrut.indexOf(': ');
  if (index === -1) return { entreprise: null, titre: titreBrut };
  return {
    entreprise: titreBrut.slice(0, index).trim() || null,
    titre: titreBrut.slice(index + 2).trim() || titreBrut,
  };
}

async function chercher(_profil: Profil): Promise<Offre[]> {
  const xml = await requeteHTML(NOM, URL_FLUX);
  const $ = cheerio.load(xml, { xmlMode: true });

  const offres: Offre[] = [];

  $('item').each((_i, item) => {
    if (offres.length >= LIMITE) return;

    const $item = $(item);
    const lien = $item.find('link').first().text().trim();
    const titreBrut = $item.find('title').first().text().trim();
    if (!lien || !titreBrut) return;

    const { entreprise, titre } = separerEntrepriseEtTitre(titreBrut);
    const region = $item.find('region').first().text().trim() || null;
    const type = $item.find('type').first().text().trim() || null;
    const pubDate = $item.find('pubDate').first().text().trim();

    offres.push({
      id_source: lien,
      source: NOM,
      titre,
      entreprise,
      lieu: region,
      pays: null,
      description: texteBrut($item.find('description').first().text()),
      url: lien,
      date_publication: dateISO(pubDate),
      teletravail: true,
      contrat: type,
    });
  });

  logger.info('Source interrogee', { source: NOM, brut: offres.length });
  return offres;
}

export const weworkremotely: Source = {
  nom: NOM,
  actif: true,
  chercher,
};
