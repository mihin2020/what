/**
 * Transformation du texte d'un CV en profil structure, via DeepSeek (section 6.4).
 *
 * Le texte est TOUJOURS anonymise avant l'appel. La reponse est validee par Zod ;
 * en cas d'echec, une seconde tentative est faite avec un prompt renforce.
 */
import { z } from 'zod';
import { appelJSON, ErreurIA } from '../ia/client.js';
import {
  SYSTEME_ANALYSE_CV,
  SYSTEME_ANALYSE_CV_RENFORCE,
  promptAnalyseCV,
} from '../ia/prompts.js';
import { anonymiser } from './anonymisation.js';
import { logger } from '../logger.js';

/** Longueur maximale de CV envoyee au modele (maitrise du cout). */
const MAX_CARACTERES_CV = 18_000;

export const schemaProfil = z.object({
  metier_cible: z.string().min(2),
  annees_experience: z.coerce.number().int().min(0).max(60),
  competences: z.array(z.string().min(1)).min(3).max(30),
  secteurs: z.array(z.string().min(1)).max(15).default([]),
  langues: z.array(z.string().min(1)).max(10).default([]),
  niveau_etude: z.string().min(1).default('non precise'),
  mots_cles_recherche: z.array(z.string().min(1)).min(3).max(20),
  // Signal de routage pour les sources d'offres nationales (section 6.7) : pas
  // un filtre strict, sert a activer/desactiver les connecteurs specifiques a
  // un pays selon le profil analyse, plutot que de figer une source sur un pays.
  pays: z.string().min(1).default('non precise'),
  analyse_le: z.string().default(() => new Date().toISOString()),
});

export type Profil = z.infer<typeof schemaProfil>;

/**
 * Reponse brute du modele : soit un CV (profil complet), soit un document
 * sans rapport (facture, rapport...) avec la raison donnee par le modele.
 */
const schemaReponseAnalyse = z.discriminatedUnion('est_cv', [
  schemaProfil.extend({ est_cv: z.literal(true) }),
  z.object({ est_cv: z.literal(false), raison: z.string().min(1) }),
]);

/** Leve quand le document envoye n'est pas un CV. */
export class ErreurDocumentNonCV extends Error {
  constructor(public readonly raisonModele: string) {
    super(`Le document fourni ne semble pas etre un CV : ${raisonModele}`);
    this.name = 'ErreurDocumentNonCV';
  }
}

/**
 * Analyse un CV deja extrait en texte brut.
 * @throws ErreurDocumentNonCV si le document n'est pas un CV.
 * @throws ErreurIA si le modele echoue deux fois de suite.
 */
export async function analyserCV(jid: string, texteBrut: string): Promise<Profil> {
  const { texte, compteurs } = anonymiser(texteBrut);
  logger.info('CV anonymise avant envoi au modele', {
    caracteres: texte.length,
    remplacements: compteurs,
  });

  const tronque = texte.slice(0, MAX_CARACTERES_CV);
  if (texte.length > MAX_CARACTERES_CV) {
    logger.warn('CV tronque avant analyse', { origine: texte.length, envoye: tronque.length });
  }

  const utilisateur = promptAnalyseCV(tronque);

  let reponse;
  try {
    reponse = await appelJSON({
      jid,
      operation: 'analyse_cv',
      systeme: SYSTEME_ANALYSE_CV,
      utilisateur,
      schema: schemaReponseAnalyse,
      temperature: 0,
      maxTokens: 3000,
    });
  } catch (erreur) {
    if (!(erreur instanceof ErreurIA)) throw erreur;

    logger.warn('Premiere analyse invalide, seconde tentative avec prompt renforce', {
      message: erreur.message,
    });

    reponse = await appelJSON({
      jid,
      operation: 'analyse_cv',
      systeme: SYSTEME_ANALYSE_CV_RENFORCE,
      utilisateur,
      schema: schemaReponseAnalyse,
      temperature: 0,
      maxTokens: 3000,
    });
  }

  if (!reponse.est_cv) throw new ErreurDocumentNonCV(reponse.raison);

  const { est_cv: _est_cv, ...profilBrut } = reponse;
  return finaliser(profilBrut);
}

/** Normalise le profil : horodatage et nettoyage des doublons. */
function finaliser(profil: Profil): Profil {
  const unique = (liste: string[]) => [
    ...new Map(liste.map((v) => [v.trim().toLowerCase(), v.trim()])).values(),
  ];
  return {
    ...profil,
    competences: unique(profil.competences),
    secteurs: unique(profil.secteurs),
    langues: unique(profil.langues),
    mots_cles_recherche: unique(profil.mots_cles_recherche),
    analyse_le: new Date().toISOString(),
  };
}
