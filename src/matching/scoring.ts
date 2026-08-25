/**
 * Etage 2 du matching : scoring IA par lots (section 6.8).
 *
 * Contraintes de cout :
 *  - au plus 100 offres scorees par cycle (les plus recentes) ;
 *  - lots de 25 offres maximum, un seul appel par lot ;
 *  - un lot en echec n'annule pas les autres.
 */
import { z } from 'zod';
import { appelJSON } from '../ia/client.js';
import { SYSTEME_SCORING, promptScoring } from '../ia/prompts.js';
import { logger } from '../logger.js';
import type { OffreCandidate } from './prefiltre.js';
import type { Profil } from '../cv/analyse.js';

export const TAILLE_LOT = 25;
export const MAX_OFFRES_SCOREES = 100;

const schemaScoring = z.object({
  resultats: z
    .array(
      z.object({
        index: z.coerce.number().int().min(0),
        score: z.coerce.number().min(0).max(100),
        raison: z.string().default(''),
      }),
    )
    .default([]),
});

export interface OffreScoree extends OffreCandidate {
  score: number;
  raison: string;
}

export interface ResultatScoring {
  scorees: OffreScoree[];
  /** Nombre d'offres reellement soumises au modele. */
  examinees: number;
  /** Nombre de lots dont l'appel a echoue. */
  lotsEnEchec: number;
}

function decouperEnLots<T>(elements: T[], taille: number): T[][] {
  const lots: T[][] = [];
  for (let i = 0; i < elements.length; i += taille) {
    lots.push(elements.slice(i, i + taille));
  }
  return lots;
}

/**
 * Score les offres candidates. Les offres dont le lot a echoue sont simplement
 * absentes du resultat : le cycle continue avec ce qui a pu etre evalue.
 */
export async function scorer(
  jid: string,
  candidates: OffreCandidate[],
  profil: Profil,
): Promise<ResultatScoring> {
  if (candidates.length === 0) {
    return { scorees: [], examinees: 0, lotsEnEchec: 0 };
  }

  let aScorer = candidates;
  if (candidates.length > MAX_OFFRES_SCOREES) {
    logger.warn('Plafond de scoring atteint : seules les offres les plus recentes sont evaluees', {
      candidates: candidates.length,
      plafond: MAX_OFFRES_SCOREES,
    });
    aScorer = [...candidates]
      .sort(
        (a, b) =>
          new Date(b.date_publication).getTime() - new Date(a.date_publication).getTime(),
      )
      .slice(0, MAX_OFFRES_SCOREES);
  }

  const lots = decouperEnLots(aScorer, TAILLE_LOT);
  const scorees: OffreScoree[] = [];
  let lotsEnEchec = 0;

  for (const [numero, lot] of lots.entries()) {
    try {
      const reponse = await appelJSON({
        jid,
        operation: 'scoring',
        systeme: SYSTEME_SCORING,
        utilisateur: promptScoring(profil, lot),
        schema: schemaScoring,
        temperature: 0,
        maxTokens: 2500,
      });

      for (const resultat of reponse.resultats) {
        const offre = lot[resultat.index];
        if (!offre) {
          logger.warn('Index de scoring hors lot, resultat ignore', {
            index: resultat.index,
            taille_lot: lot.length,
          });
          continue;
        }
        scorees.push({
          ...offre,
          score: Math.round(resultat.score),
          raison: resultat.raison.trim(),
        });
      }
    } catch (erreur) {
      lotsEnEchec++;
      logger.error('Lot de scoring en echec', { lot: numero + 1, sur: lots.length, erreur });
    }
  }

  logger.info('Scoring termine', {
    soumises: aScorer.length,
    scorees: scorees.length,
    lots: lots.length,
    lots_en_echec: lotsEnEchec,
  });

  return { scorees, examinees: aScorer.length, lotsEnEchec };
}

/**
 * Trie par score decroissant, elimine les offres sous le seuil (defaut 50),
 * puis limite la taille du digest. En dessous du seuil : hors sujet ou trop
 * faible pour etre propose — l'utilisateur ne doit plus les voir.
 */
export const SEUIL_SCORE_DEFAUT = 50;

export function selectionner(
  scorees: OffreScoree[],
  maximum: number,
  seuil = SEUIL_SCORE_DEFAUT,
): OffreScoree[] {
  return [...scorees]
    .filter((o) => o.score >= seuil)
    .sort((a, b) => b.score - a.score)
    .slice(0, maximum);
}
