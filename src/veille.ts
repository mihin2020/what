/**
 * Orchestration d'un cycle de veille (section 6.8 et 6.9).
 *
 * Enchainement : collecte -> prefiltre -> scoring IA -> selection -> envoi.
 *
 * Regle imperative : un cycle se termine TOUJOURS par un message a
 * l'utilisateur — digest, "aucune offre", ou alerte technique. Le silence est
 * indistinguable d'une panne.
 *
 * Exception : le mode `complement` (apres un flash post-CV) peut rester
 * silencieux s'il n'y a rien de nouveau, pour ne pas spammer.
 */
import { config } from './config.js';
import { logger } from './logger.js';
import { envoyer } from './whatsapp.js';
import {
  collecter,
  sourcesActives,
  type ModeCollecte,
  type ResultatSource,
} from './sources/index.js';
import { prefiltrer } from './matching/prefiltre.js';
import { scorer, selectionner } from './matching/scoring.js';
import {
  enTeteDigest,
  messageAucuneOffre,
  messageEchecTechnique,
  messageOffre,
} from './formatage.js';
import {
  enregistrerOffre,
  enregistrerScoreUtilisateur,
  lireEntierUtilisateur,
  lireProfil,
  marquerEnvoyee,
  purgerAnciennesOffres,
} from './db/repository.js';

export interface ResumeCycle {
  lance: boolean;
  collectees: number;
  retenuesPrefiltre: number;
  examinees: number;
  envoyees: number;
  sourcesOk: number;
  sourcesEchec: number;
  duree_ms: number;
}

/** Empeche deux cycles simultanes (echeance + !veille au meme moment). */
let cycleEnCours = false;

/** Etat du dernier cycle, expose a la commande !sources. */
let dernierEtatSources: { nom: string; ok: boolean; nombre: number }[] = [];
export const etatSources = () => dernierEtatSources;

export const cycleActif = () => cycleEnCours;

/** Plafonds du premier jet (juste apres un CV) : reponse rapide. */
const MAX_OFFRES_FLASH = 5;
const MAX_SCOREES_FLASH = 30;

export async function executerCycle(
  jid: string,
  options: {
    manuel?: boolean;
    mode?: ModeCollecte;
    /** Si true, n'envoie pas "aucune offre" quand le digest est vide. */
    silenceSiVide?: boolean;
  } = {},
): Promise<ResumeCycle> {
  const manuel = options.manuel ?? false;
  const mode: ModeCollecte = options.mode ?? 'complet';
  const silenceSiVide = options.silenceSiVide ?? false;
  const debut = Date.now();
  const vide: ResumeCycle = {
    lance: false,
    collectees: 0,
    retenuesPrefiltre: 0,
    examinees: 0,
    envoyees: 0,
    sourcesOk: 0,
    sourcesEchec: 0,
    duree_ms: 0,
  };

  if (cycleEnCours) {
    logger.warn('Cycle deja en cours, demande ignoree', { jid, manuel, mode });
    if (!silenceSiVide) {
      await envoyer(jid, '⏳ Une recherche est deja en cours, je t envoie le resultat dans un instant.');
    }
    return vide;
  }

  const profil = lireProfil(jid);
  if (!profil) {
    logger.warn('Cycle demande sans profil enregistre', { jid });
    await envoyer(
      jid,
      "Je n'ai pas encore ton profil. Envoie-moi ton CV en piece jointe (PDF ou DOCX) et je m'en occupe.",
    );
    return vide;
  }

  cycleEnCours = true;
  try {
    /* --- 1. Collecte ------------------------------------------------ */
    const resultats: ResultatSource[] = await collecter(profil, mode);
    const etatCycle = resultats.map((r) => ({ nom: r.nom, ok: r.ok, nombre: r.offres.length }));
    if (mode === 'complet' || mode === 'flash') {
      dernierEtatSources = etatCycle;
    } else {
      // Complement : fusionne avec l'etat flash precedent.
      const parNom = new Map(dernierEtatSources.map((e) => [e.nom, e]));
      for (const e of etatCycle) parNom.set(e.nom, e);
      dernierEtatSources = [...parNom.values()];
    }

    const enEchec = resultats.filter((r) => !r.ok);
    const reussies = resultats.filter((r) => r.ok);
    const collectees = resultats.flatMap((r) => r.offres);

    if (resultats.length > 0 && reussies.length === 0) {
      const details = enEchec.map((r) => `${r.nom} : ${r.erreur ?? 'erreur inconnue'}`).join(' ; ');
      logger.error('Toutes les sources ont echoue', { mode, details });
      if (!silenceSiVide) {
        await envoyer(jid, messageEchecTechnique(details.slice(0, 300)));
      }
      return {
        ...vide,
        lance: true,
        sourcesEchec: enEchec.length,
        duree_ms: Date.now() - debut,
      };
    }

    if (resultats.length === 0) {
      if (mode === 'complement') {
        return { ...vide, lance: true, duree_ms: Date.now() - debut };
      }
      logger.error('Aucune source active');
      await envoyer(
        jid,
        messageEchecTechnique('Aucune source n est activee : verifie les cles API dans le fichier .env.'),
      );
      return { ...vide, lance: true, duree_ms: Date.now() - debut };
    }

    /* --- 2. Prefiltre ---------------------------------------------- */
    const { retenues, nouvelles, rejets } = prefiltrer(jid, collectees, profil);

    /* --- 3. Scoring IA --------------------------------------------- */
    const plafondScore = mode === 'flash' ? MAX_SCOREES_FLASH : undefined;
    const aScorer = plafondScore ? retenues.slice(0, plafondScore) : retenues;
    const { scorees, examinees, lotsEnEchec } = await scorer(jid, aScorer, profil);

    const maximumBase = lireEntierUtilisateur(jid, 'max_offres_digest', config.MAX_OFFRES_DIGEST);
    const maximum = mode === 'flash' ? Math.min(MAX_OFFRES_FLASH, maximumBase) : maximumBase;
    const seuil = lireEntierUtilisateur(jid, 'seuil_score', config.SEUIL_SCORE_DEFAUT);
    const selection = selectionner(scorees, maximum, seuil);
    const sousSeuil = scorees.filter((o) => o.score < seuil).length;

    /* --- 4. Persistance -------------------------------------------- */
    const parHash = new Map(scorees.map((o) => [o.hash, o]));
    for (const offre of nouvelles) {
      enregistrerOffre(offre);
      const scoree = parHash.get(offre.hash);
      enregistrerScoreUtilisateur(jid, offre.hash, scoree?.score ?? null, scoree?.raison ?? null);
    }

    /* --- 5. Envoi --------------------------------------------------- */
    if (selection.length > 0) {
      const prefixe =
        mode === 'flash'
          ? '⚡ Premieres offres pertinentes\n'
          : mode === 'complement'
            ? '➕ Complements pertinents\n'
            : '';
      await envoyer(jid, prefixe + enTeteDigest(selection.length, manuel, seuil));
      for (const offre of selection) {
        await envoyer(jid, messageOffre(offre));
        marquerEnvoyee(jid, offre.hash);
      }
    } else if (!silenceSiVide) {
      if (retenues.length > 0 && examinees > 0 && scorees.length === 0 && lotsEnEchec > 0) {
        await envoyer(
          jid,
          messageEchecTechnique(
            "Les offres ont bien ete collectees mais l'analyse IA n'a pas repondu.",
          ),
        );
      } else {
        await envoyer(
          jid,
          messageAucuneOffre({
            examinees,
            aucuneCollecte: nouvelles.length === 0,
            manuel,
            sousSeuil,
            seuil,
          }),
        );
      }
    }

    const duree = Date.now() - debut;
    logger.info('Cycle de veille termine', {
      manuel,
      mode,
      par_source: etatCycle,
      collectees: collectees.length,
      nouvelles: nouvelles.length,
      rejets,
      retenues_prefiltre: retenues.length,
      scorees: scorees.length,
      envoyees: selection.length,
      lots_en_echec: lotsEnEchec,
      duree_ms: duree,
    });

    return {
      lance: true,
      collectees: collectees.length,
      retenuesPrefiltre: retenues.length,
      examinees,
      envoyees: selection.length,
      sourcesOk: reussies.length,
      sourcesEchec: enEchec.length,
      duree_ms: duree,
    };
  } catch (erreur) {
    logger.error('Cycle de veille interrompu par une erreur', { jid, mode, erreur });
    if (!silenceSiVide) {
      try {
        await envoyer(jid, messageEchecTechnique('Erreur interne pendant le cycle de veille.'));
      } catch (erreurEnvoi) {
        logger.error('Envoi du message d echec impossible', erreurEnvoi);
      }
    }
    return { ...vide, lance: true, duree_ms: Date.now() - debut };
  } finally {
    cycleEnCours = false;
  }
}

/**
 * Juste apres un CV : jet rapide (sources API) puis complement (scrapes)
 * en arriere-plan, sans bloquer la suite de la conversation.
 */
export async function executerRecherchePostCv(jid: string): Promise<void> {
  await envoyer(jid, '🔎 Je cherche uniquement des offres vraiment adaptees a ton profil…');
  const flash = await executerCycle(jid, { manuel: true, mode: 'flash' });

  void (async () => {
    try {
      if (flash.envoyees > 0) {
        await envoyer(jid, '🔎 Je continue sur les autres sites pour d eventuels complements…');
      }
      await executerCycle(jid, {
        manuel: true,
        mode: 'complement',
        silenceSiVide: true,
      });
    } catch (erreur) {
      logger.error('Complement post-CV en echec', { jid, erreur });
    }
  })();
}

/** Purge hebdomadaire des offres de plus de 90 jours (section 7). */
export function purgeHebdomadaire(): void {
  try {
    const supprimees = purgerAnciennesOffres(90);
    logger.info('Purge des anciennes offres', { supprimees });
  } catch (erreur) {
    logger.error('Purge des anciennes offres en echec', erreur);
  }
}

/** Nombre de sources actives, pour les messages de service. */
export const nombreSourcesActives = () => sourcesActives().length;
