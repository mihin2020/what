/**
 * Connecteur ReliefWeb (ONG, agences onusiennes, cooperation).
 *
 * Endpoint : POST https://api.reliefweb.int/v2/jobs?appname=...
 *
 * IMPORTANT — evolution constatee le 15 aout 2026 :
 *  - l'API v1 est decommissionnee (HTTP 410) ; seule la v2 repond ;
 *  - la v2 n'accepte plus n'importe quel `appname` : il doit avoir ete APPROUVE
 *    par ReliefWeb, sinon toute requete renvoie HTTP 403. La demande est
 *    gratuite : https://apidoc.reliefweb.int/parameters#appname
 *
 * Tant que l'appname n'est pas approuve, la source echoue proprement et le
 * cycle continue avec les autres connecteurs.
 */
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { Profil } from '../cv/analyse.js';
import {
  dateISO,
  detecteTeletravail,
  requeteJSON,
  texteBrut,
  type Offre,
  type Source,
} from './types.js';

const NOM = 'reliefweb';
const ENDPOINT = 'https://api.reliefweb.int/v2/jobs';
const LIMITE = 50;

interface ReponseReliefWeb {
  data?: {
    id: string;
    fields?: {
      title?: string;
      body?: string;
      url?: string;
      url_alias?: string;
      date?: { created?: string; closing?: string };
      source?: { name?: string; shortname?: string }[];
      country?: { name?: string }[];
      city?: { name?: string }[];
      type?: { name?: string }[];
      career_categories?: { name?: string }[];
    };
  }[];
}

/**
 * Format de date attendu par le filtre `date.created` de la v2 : ISO 8601 avec
 * decalage horaire EXPLICITE. Verifie le 15 aout 2026 :
 *   "2026-08-01T00:00:00+00:00"  -> accepte
 *   "2026-08-01" / "...Z" / sans decalage -> HTTP 400
 */
function dateFiltre(joursEnArriere: number): string {
  const d = new Date(Date.now() - joursEnArriere * 24 * 3600 * 1000);
  return `${d.toISOString().slice(0, 19)}+00:00`;
}

/**
 * ReliefWeb attend une requete plein texte unique. On assemble les mots-cles
 * du profil en une expression OR, limitee pour rester lisible par le moteur.
 */
function construireRequete(profil: Profil): string {
  const termes = [profil.metier_cible, ...profil.mots_cles_recherche]
    .map((t) => t.trim())
    .filter((t) => t.length > 2)
    .slice(0, 8)
    .map((t) => `"${t.replace(/"/g, '')}"`);
  return termes.join(' OR ');
}

async function chercher(profil: Profil): Promise<Offre[]> {
  const url = `${ENDPOINT}?appname=${encodeURIComponent(config.RELIEFWEB_APPNAME)}`;

  const corps = {
    limit: LIMITE,
    offset: 0,
    sort: ['date.created:desc'],
    fields: {
      include: [
        'id',
        'title',
        'body',
        'url',
        'url_alias',
        'date.created',
        'date.closing',
        'source.name',
        'source.shortname',
        'country.name',
        'city.name',
        'type.name',
        'career_categories.name',
      ],
    },
    query: {
      value: construireRequete(profil),
      operator: 'OR',
      fields: ['title', 'body', 'career_categories.name', 'theme.name'],
    },
    filter: {
      field: 'date.created',
      value: { from: dateFiltre(config.MAX_ANCIENNETE_JOURS) },
    },
  };

  const reponse = await requeteJSON<ReponseReliefWeb>(NOM, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corps),
  });

  const donnees = reponse.data ?? [];
  logger.info('Source interrogee', { source: NOM, brut: donnees.length });

  return donnees.map((element): Offre => {
    // La v2 peut renvoyer les champs a plat plutot que sous `fields` :
    // on accepte les deux formes pour ne pas dependre d'un detail d'enveloppe.
    const f = element.fields ?? (element as unknown as NonNullable<typeof element.fields>) ?? {};
    const pays = f.country?.[0]?.name ?? null;
    const ville = f.city?.[0]?.name ?? null;
    const description = texteBrut(f.body);

    return {
      id_source: String(element.id),
      source: NOM,
      titre: f.title?.trim() || 'Offre sans titre',
      entreprise: f.source?.[0]?.name ?? f.source?.[0]?.shortname ?? null,
      lieu: ville ?? pays,
      pays,
      description,
      url: f.url_alias ?? f.url ?? `https://reliefweb.int/node/${element.id}`,
      date_publication: dateISO(f.date?.created),
      teletravail: detecteTeletravail(f.title, description),
      contrat: f.type?.[0]?.name ?? null,
    };
  });
}

export const reliefweb: Source = {
  nom: NOM,
  // Pas de cle API, mais un appname approuve est indispensable depuis la v2.
  actif: Boolean(config.RELIEFWEB_APPNAME),
  chercher,
};
