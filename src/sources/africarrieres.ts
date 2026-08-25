/**
 * Connecteur africarrieres.com (portail d'offres pan-africain, sections par
 * pays). Source SCRAPEE (pas d'API) : cadence limitee a une fois par jour et
 * robots.txt respecte (section 6.7 / docs/AJOUT_SOURCE.md).
 *
 * Verifie en direct le 17/08/2026 :
 *  - robots.txt : User-agent * -> Allow: /, Content-Signal search=yes,
 *    ai-input=yes, ai-train=no. Seuls /dashboard/, /employeur/, /connexion
 *    et autres chemins de compte sont exclus (aucun rapport avec les
 *    pages de listing publiques utilisees ici).
 *  - Structure : page rendue cote serveur (Laravel/Tailwind), aucun indice
 *    de SPA JS. La carte d'offre sur la page de LISTING contient deja tout
 *    le necessaire (titre, employeur, lieu, contrat, date relative) : pas
 *    besoin de visiter chaque page de detail (evite N+1 requetes).
 *
 * Portee actuelle : Burkina Faso uniquement (seul pays teste). Le
 * connecteur ne s'active que si le profil analyse indique ce pays — voir
 * PAYS_COUVERTS. Etendre a un autre pays suppose de repeter la meme
 * verification (robots.txt/structure) sur son URL, pas de la presumer.
 */
import * as cheerio from 'cheerio';
import { logger } from '../logger.js';
import { ecrireParametre, lireParametre } from '../db/repository.js';
import type { Profil } from '../cv/analyse.js';
import { requeteHTML, texteBrut, type Offre, type Source } from './types.js';

const NOM = 'africarrieres';

/** Segment d'URL par pays couvert. Un seul pour l'instant : voir portee ci-dessus. */
const PAYS_COUVERTS: Record<string, string> = {
  'burkina faso': 'burkina-faso',
};

const DELAI_ENTRE_SCRAPES_MS = 24 * 3600 * 1000;
const LIMITE = 30;

function segmentPays(pays: string): string | null {
  const normalise = pays.trim().toLowerCase();
  for (const [cle, segment] of Object.entries(PAYS_COUVERTS)) {
    if (normalise.includes(cle)) return segment;
  }
  return null;
}

/**
 * Convertit une date relative anglaise ("4 hours ago", "2 days ago") en ISO.
 * Format specifique a la locale /en/ de ce site (verifie en direct) — pas
 * un parseur de dates relatives generique.
 */
function dateRelativeVersISO(texte: string): string {
  const m = texte.trim().toLowerCase().match(/^(\d+)\s+(minute|hour|day|week|month)s?\s+ago$/);
  if (!m) return new Date().toISOString();

  const [, quantiteBrute, unite] = m;
  const quantite = Number(quantiteBrute);
  const MS_PAR_UNITE: Record<string, number> = {
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 7 * 86_400_000,
    month: 30 * 86_400_000,
  };
  return new Date(Date.now() - quantite * (MS_PAR_UNITE[unite as string] ?? 0)).toISOString();
}

/** Verifie et pose l'horodatage AVANT la requete : au plus une tentative par jour, meme en cas d'echec. */
function autoriseAScraperAujourdhui(): boolean {
  const cle = `dernier_scrape_${NOM}`;
  const dernier = lireParametre(cle);
  if (dernier && Date.now() - new Date(dernier).getTime() < DELAI_ENTRE_SCRAPES_MS) {
    return false;
  }
  ecrireParametre(cle, new Date().toISOString());
  return true;
}

async function chercher(profil: Profil): Promise<Offre[]> {
  const segment = segmentPays(profil.pays);
  if (!segment) {
    // Profil hors couverture (pays non mappe, ou "non precise") : source
    // non pertinente pour ce profil, silencieuse plutot que forcee.
    return [];
  }

  if (!autoriseAScraperAujourdhui()) {
    logger.info('Source ignoree (deja scrapee aujourd hui)', { source: NOM });
    return [];
  }

  const url = `https://africarrieres.com/${segment}/en/emplois`;
  const html = await requeteHTML(NOM, url);
  const $ = cheerio.load(html);

  const offres: Offre[] = [];

  $('a[href*="/emplois/"]').each((_i, lien) => {
    if (offres.length >= LIMITE) return;

    const $lien = $(lien);
    const href = $lien.attr('href');
    if (!href) return;

    const titre = $lien.find('h3').first().text().trim();
    if (!titre) return; // pas une carte d'offre (ex. lien de menu)

    const entreprise = $lien.find('p.text-primary-600 span').first().text().trim() || null;

    const spansInfo = $lien.find('div.text-gray-500 span');
    const lieu = spansInfo.first().text().trim() || null;
    const contrat =
      spansInfo
        .slice(1)
        .map((_j, s) => $(s).text().trim())
        .get()
        .filter(Boolean)
        .join(' / ') || null;

    const dateTexte = $lien.find('p.text-gray-400').first().text().trim();

    offres.push({
      id_source: href,
      source: NOM,
      titre,
      entreprise,
      lieu,
      pays: profil.pays,
      description: texteBrut(''), // non disponible sur la liste ; pas de requete detail par offre (voir entete).
      url: href,
      date_publication: dateTexte ? dateRelativeVersISO(dateTexte) : new Date().toISOString(),
      teletravail: null,
      contrat,
    });
  });

  logger.info('Source interrogee', { source: NOM, pays: profil.pays, brut: offres.length });
  return offres;
}

export const africarrieres: Source = {
  nom: NOM,
  actif: true,
  chercher,
};
