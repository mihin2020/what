/**
 * Contrat commun a toutes les sources d'offres (section 6.7).
 *
 * Ajouter une source = creer un fichier qui exporte un objet `Source`,
 * puis l'enregistrer dans `sources/index.ts`. Rien d'autre ne doit changer.
 */
import type { Profil } from '../cv/analyse.js';

export interface Offre {
  /** Identifiant natif chez la source. */
  id_source: string;
  /** Nom court de la source : 'reliefweb', 'adzuna', ... */
  source: string;
  titre: string;
  entreprise: string | null;
  lieu: string | null;
  pays: string | null;
  /** Texte brut, tronque a 2000 caracteres. */
  description: string;
  url: string;
  /** ISO 8601. */
  date_publication: string;
  /**
   * Date limite de candidature (ISO 8601), si connue.
   * Une offre dont la date limite est passee est exclue du digest.
   */
  date_limite?: string | null;
  teletravail: boolean | null;
  contrat: string | null;
}

export interface Source {
  nom: string;
  actif: boolean;
  chercher(profil: Profil): Promise<Offre[]>;
}

/* ------------------------------------------------------------------ */
/* Utilitaires partages par les connecteurs                            */
/* ------------------------------------------------------------------ */

/** Timeout impose a chaque requete HTTP sortante (section 6.7). */
export const TIMEOUT_HTTP_MS = 20_000;

/** User-Agent explicite et honnete, comme exige par le cahier des charges. */
export const USER_AGENT =
  'whatsapp-veille/1.0 (assistant personnel de veille emploi; contact via WhatsApp)';

export const LONGUEUR_DESCRIPTION = 2000;

export class ErreurSource extends Error {
  constructor(
    readonly source: string,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(`[${source}] ${message}`);
    this.name = 'ErreurSource';
  }
}

/** Requete HTTP JSON avec timeout, User-Agent et erreur explicite. */
export async function requeteJSON<T>(
  source: string,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), TIMEOUT_HTTP_MS);
  try {
    const reponse = await fetch(url, {
      ...init,
      signal: controleur.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        ...(init.headers ?? {}),
      },
    });

    if (!reponse.ok) {
      const corps = (await reponse.text().catch(() => '')).slice(0, 300);
      throw new ErreurSource(source, `HTTP ${reponse.status} ${reponse.statusText} ${corps}`);
    }

    return (await reponse.json()) as T;
  } catch (erreur) {
    if (erreur instanceof ErreurSource) throw erreur;
    if ((erreur as Error)?.name === 'AbortError') {
      throw new ErreurSource(source, `delai depasse (${TIMEOUT_HTTP_MS} ms)`, erreur);
    }
    throw new ErreurSource(source, 'requete impossible', erreur);
  }
}

/**
 * Requete HTTP HTML avec le meme timeout/User-Agent que requeteJSON, pour les
 * sources scrapees (sans API). Renvoie le texte brut de la reponse, a passer
 * a un parseur HTML (cheerio) par l'appelant.
 */
export async function requeteHTML(source: string, url: string, init: RequestInit = {}): Promise<string> {
  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), TIMEOUT_HTTP_MS);
  try {
    const reponse = await fetch(url, {
      ...init,
      signal: controleur.signal,
      headers: {
        Accept: 'text/html',
        'User-Agent': USER_AGENT,
        ...(init.headers ?? {}),
      },
    });

    if (!reponse.ok) {
      throw new ErreurSource(source, `HTTP ${reponse.status} ${reponse.statusText}`);
    }

    return await reponse.text();
  } catch (erreur) {
    if (erreur instanceof ErreurSource) throw erreur;
    if ((erreur as Error)?.name === 'AbortError') {
      throw new ErreurSource(source, `delai depasse (${TIMEOUT_HTTP_MS} ms)`, erreur);
    }
    throw new ErreurSource(source, 'requete impossible', erreur);
  } finally {
    clearTimeout(minuteur);
  }
}

/** Convertit un fragment HTML ou Markdown en texte brut tronque. */
export function texteBrut(contenu: string | null | undefined, limite = LONGUEUR_DESCRIPTION): string {
  if (!contenu) return '';
  return contenu
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[#*_>`]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
    .slice(0, limite);
}

/** Detecte une mention de teletravail dans un titre ou une description. */
export function detecteTeletravail(...textes: (string | null | undefined)[]): boolean | null {
  const corpus = textes.filter(Boolean).join(' ').toLowerCase();
  if (!corpus) return null;
  return /\b(t[eé]l[eé]travail|remote|home ?office|100% distanciel|full remote|a distance|à distance)\b/.test(
    corpus,
  );
}

/** Normalise une date en ISO 8601 ; retourne l'instant courant si illisible. */
export function dateISO(valeur: string | number | null | undefined): string {
  if (valeur === null || valeur === undefined || valeur === '') return new Date().toISOString();
  const d = new Date(valeur);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

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

/**
 * Extraire une date limite de candidature depuis un texte libre
 * (titre, description, encart "Date limite : …").
 * Retourne null si aucune date exploitable n'est trouvee.
 */
export function extraireDateLimite(...textes: (string | null | undefined)[]): string | null {
  const corpus = textes.filter(Boolean).join(' \n ');
  if (!corpus) return null;

  const motifs: RegExp[] = [
    /(?:date\s*limite|limite\s*de\s*candidature|candidatures?\s*(?:avant|jusqu(?:'|’)(?:au)?|closes?)|expire(?:r)?|cl[ôo]ture|deadline|closing\s*date|apply\s*by|before)\s*[:\-]?\s*(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/i,
    /(?:date\s*limite|limite\s*de\s*candidature|candidatures?\s*(?:avant|jusqu(?:'|’)(?:au)?)|deadline|closing\s*date|apply\s*by)\s*[:\-]?\s*(\d{1,2}\s+(?:janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre)\s+\d{4})/i,
    /(?:date\s*limite|deadline|closing\s*date|apply\s*by)\s*[:\-]?\s*([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i,
  ];

  for (const motif of motifs) {
    const m = corpus.match(motif);
    if (!m?.[1]) continue;
    const parse = parserDateLibre(m[1]);
    if (parse) return parse;
  }
  return null;
}

/** Parse DD/MM/YYYY, "25 aout 2026", ou date anglaise lisible par Date. */
function parserDateLibre(brut: string): string | null {
  const texte = brut.trim();

  const num = texte.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
  if (num) {
    const jour = Number(num[1]);
    const mois = Number(num[2]) - 1;
    let annee = Number(num[3]);
    if (annee < 100) annee += 2000;
    const d = new Date(Date.UTC(annee, mois, jour, 23, 59, 59));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  const fr = texte.match(/^(\d{1,2})\s+([A-Za-zéûôà]+)\s+(\d{4})$/i);
  if (fr) {
    const moisNom = fr[2]!.toLowerCase().normalize('NFC');
    const mois = MOIS_FR[moisNom];
    if (mois !== undefined) {
      const d = new Date(Date.UTC(Number(fr[3]), mois, Number(fr[1]), 23, 59, 59));
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
  }

  const d = new Date(texte);
  if (!Number.isNaN(d.getTime())) {
    d.setUTCHours(23, 59, 59, 0);
    return d.toISOString();
  }
  return null;
}

/** Vrai si l'offre est encore ouverte (pas de date limite, ou date limite dans le futur). */
export function offreEncoreOuverte(offre: Pick<Offre, 'date_limite' | 'description' | 'titre'>): boolean {
  const limite =
    offre.date_limite ??
    extraireDateLimite(offre.titre, offre.description);
  if (!limite) return true;
  const t = new Date(limite).getTime();
  if (!Number.isFinite(t)) return true;
  return t >= Date.now();
}
