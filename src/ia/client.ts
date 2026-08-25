/**
 * Wrapper unique autour du SDK `openai` pointe sur l'API DeepSeek.
 *
 * Exigences (section 6.6) :
 *  - retry sur 429 / 500 / 502 / 503 : 3 tentatives, backoff exponentiel avec gigue ;
 *  - timeout de 90 s par requete ;
 *  - journalisation systematique des tokens consommes ;
 *  - aucune donnee personnelle non anonymisee ne transite par ce module.
 *
 * Note modeles : `deepseek-chat` et `deepseek-reasoner` ont ete retires le
 * 24 juillet 2026. On utilise `deepseek-v4-flash` (defaut) ou `deepseek-v4-pro`.
 */
import OpenAI from 'openai';
import { z } from 'zod';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { journaliserIA, lireParametre } from '../db/repository.js';

const TIMEOUT_MS = 90_000;
const TENTATIVES_MAX = 3;

const CODES_RETRY = new Set([429, 500, 502, 503]);

/** Cle DeepSeek EFFECTIVE : celle modifiee depuis le dashboard admin (base)
 *  prime toujours sur .env, comme le reste des reglages (section 7). Construit
 *  un client a chaque appel plutot qu'un singleton : cout negligeable (aucun
 *  reseau), et rend le changement de cle effectif sans redemarrer le process. */
function client(): OpenAI {
  return new OpenAI({
    apiKey: lireParametre('deepseek_api_key') || config.DEEPSEEK_API_KEY,
    baseURL: config.DEEPSEEK_BASE_URL,
    timeout: TIMEOUT_MS,
    // Le retry est gere ici, pas par le SDK, pour maitriser la gigue et le journal.
    maxRetries: 0,
  });
}

/**
 * Extension DeepSeek absente des types du SDK `openai` (generique OpenAI).
 * Sans elle, le modele fait par defaut un raisonnement interne
 * (thinking.type = "enabled", reasoning_effort = "high") qui peut consommer
 * a lui seul tout `max_tokens` avant de produire la moindre sortie utile —
 * constate le 17/08/2026 : ~9500-10000 tokens de raisonnement, finish_reason
 * "length", contenu final vide. Nos deux usages (extraction de profil,
 * scoring d'offres) sont des taches d'extraction structuree qui n'en ont pas
 * besoin : on le desactive purement et simplement.
 */
type ParametresAvecThinking = OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & {
  thinking?: { type: 'enabled' | 'disabled' };
};

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Delais 1 s, 2 s, 4 s, chacun avec une gigue de +/- 30 %. */
function delaiAvecGigue(tentative: number): number {
  const base = 1000 * 2 ** (tentative - 1);
  const gigue = base * 0.3 * (Math.random() * 2 - 1);
  return Math.round(base + gigue);
}

function codeHttp(erreur: unknown): number | null {
  const e = erreur as { status?: number; response?: { status?: number } };
  return e?.status ?? e?.response?.status ?? null;
}

function estRejouable(erreur: unknown): boolean {
  const code = codeHttp(erreur);
  if (code !== null) return CODES_RETRY.has(code);
  // Erreurs reseau / timeout : rejouables.
  const nom = (erreur as { name?: string })?.name ?? '';
  const message = (erreur as { message?: string })?.message ?? '';
  return /timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|APIConnection/i.test(
    `${nom} ${message}`,
  );
}

export interface OptionsAppel<T> {
  /** Utilisateur a qui attribuer le cout (commande !stats). null pour un appel systeme. */
  jid: string | null;
  /** Sert uniquement au journal des couts. */
  operation: 'analyse_cv' | 'scoring';
  systeme: string;
  utilisateur: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  /** 0 pour l'analyse structuree, un peu plus haut pour la redaction. */
  temperature?: number;
  modele?: string;
  maxTokens?: number;
}

export class ErreurIA extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ErreurIA';
  }
}

/**
 * Appelle le modele en mode JSON natif et valide la reponse avec Zod.
 * Leve `ErreurIA` si l'appel echoue apres les tentatives, ou si le JSON
 * renvoye ne respecte pas le schema.
 */
export async function appelJSON<T>(options: OptionsAppel<T>): Promise<T> {
  const modele = options.modele ?? config.DEEPSEEK_MODELE;
  let derniereErreur: unknown = null;

  for (let tentative = 1; tentative <= TENTATIVES_MAX; tentative++) {
    const debut = Date.now();
    try {
      // Variable intermediaire, pas un objet litteral inline : sinon TS
      // applique une verification de proprietes en exces sur `thinking`,
      // absent des types generiques OpenAI du SDK.
      const parametres: ParametresAvecThinking = {
        model: modele,
        temperature: options.temperature ?? 0,
        max_tokens: options.maxTokens ?? 4000,
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' },
        messages: [
          { role: 'system', content: options.systeme },
          { role: 'user', content: options.utilisateur },
        ],
      };
      const reponse = await client().chat.completions.create(parametres);

      const tokensEntree = reponse.usage?.prompt_tokens ?? 0;
      const tokensSortie = reponse.usage?.completion_tokens ?? 0;

      const contenu = reponse.choices[0]?.message?.content ?? '';
      let brut: unknown;
      try {
        brut = JSON.parse(nettoyerJSON(contenu));
      } catch (erreurParse) {
        journaliserIA({ jid: options.jid, operation: options.operation, modele, tokensEntree, tokensSortie, succes: false });
        // Diagnostic : un contenu vide avec finish_reason "length" indique que
        // le budget de tokens a ete consomme par un raisonnement interne avant
        // toute sortie utile (certains modeles exposent ce raisonnement dans un
        // champ hors-schema OpenAI, ex. reasoning_content) plutot que par une
        // reponse tronquee classique.
        const choix = reponse.choices[0] as unknown as {
          finish_reason?: string;
          message?: { reasoning_content?: string };
        };
        logger.warn('Reponse IA non parsable en JSON', {
          operation: options.operation,
          longueur: contenu.length,
          finish_reason: choix?.finish_reason,
          a_raisonnement: Boolean(choix?.message?.reasoning_content),
          longueur_raisonnement: choix?.message?.reasoning_content?.length ?? 0,
          tokensSortie,
        });
        throw new ErreurIA('La reponse du modele n est pas un JSON valide', erreurParse);
      }

      const valide = options.schema.safeParse(brut);
      journaliserIA({
        jid: options.jid,
        operation: options.operation,
        modele,
        tokensEntree,
        tokensSortie,
        succes: valide.success,
      });

      logger.info('Appel IA', {
        operation: options.operation,
        modele,
        tokens_entree: tokensEntree,
        tokens_sortie: tokensSortie,
        duree_ms: Date.now() - debut,
        valide: valide.success,
      });

      if (!valide.success) {
        throw new ErreurIA(
          `Reponse IA non conforme au schema : ${valide.error.issues
            .map((i) => `${i.path.join('.')} ${i.message}`)
            .join(' ; ')}`,
        );
      }

      return valide.data;
    } catch (erreur) {
      derniereErreur = erreur;

      // Une erreur de schema ou de parsing n'est pas rejouable telle quelle :
      // l'appelant decidera de relancer avec un prompt renforce.
      if (erreur instanceof ErreurIA) throw erreur;

      const code = codeHttp(erreur);
      if (tentative < TENTATIVES_MAX && estRejouable(erreur)) {
        const attente = delaiAvecGigue(tentative);
        logger.warn(
          `Appel IA en echec (tentative ${tentative}/${TENTATIVES_MAX}), nouvelle tentative dans ${attente} ms`,
          { operation: options.operation, code },
        );
        await dormir(attente);
        continue;
      }

      journaliserIA({ jid: options.jid, operation: options.operation, modele, tokensEntree: 0, tokensSortie: 0, succes: false });
      logger.error('Appel IA definitivement en echec', { operation: options.operation, code, erreur });
      throw new ErreurIA('Appel au modele impossible', erreur);
    }
  }

  throw new ErreurIA('Appel au modele impossible', derniereErreur);
}

/** Retire d'eventuelles balises de code autour du JSON. */
function nettoyerJSON(contenu: string): string {
  const texte = contenu.trim();
  const bloc = texte.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (bloc?.[1]) return bloc[1].trim();
  return texte;
}
