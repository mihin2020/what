/**
 * Etage 1 du matching : filtre heuristique, sans appel IA (section 6.8).
 *
 * Objectif : ne payer du scoring que pour des offres plausibles. Quatre motifs
 * de rejet : deja vue, trop ancienne, titre sans rapport, lieu hors zone.
 */
import { config } from '../config.js';
import { logger } from '../logger.js';
import { hashOffre, lireEntierUtilisateur, lireParametreUtilisateur, offreVuePourUtilisateur } from '../db/repository.js';
import { offreEncoreOuverte, type Offre } from '../sources/types.js';
import type { Profil } from '../cv/analyse.js';

export interface OffreCandidate extends Offre {
  hash: string;
}

export interface ResultatPrefiltre {
  retenues: OffreCandidate[];
  /** Toutes les offres nouvelles (retenues ou non), pour la persistance. */
  nouvelles: OffreCandidate[];
  rejets: {
    doublon: number;
    anciennete: number;
    expiree: number;
    motsCles: number;
    lieu: number;
  };
}

/** Minuscules sans accents, ponctuation reduite a des espaces. */
export function normaliser(texte: string): string {
  return texte
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Empreinte "meme poste" : titre + entreprise + lieu.
 * Sert a fusionner une offre republiee sur plusieurs agregateurs
 * (Jooble + Adzuna + Careerjet, etc.) en une seule proposition.
 */
export function empreinteOffre(offre: Pick<Offre, 'titre' | 'entreprise' | 'lieu' | 'pays'>): string {
  const titre = normaliser(offre.titre);
  const entreprise = normaliser(offre.entreprise ?? '');
  const lieu = normaliser([offre.lieu, offre.pays].filter(Boolean).join(' '));
  return `${titre}|${entreprise}|${lieu}`;
}

/**
 * Plus le chiffre est bas, plus la source est preferee quand deux URLs
 * designent le meme poste (on garde le lien le plus "direct").
 */
const PRIORITE_SOURCE: Record<string, number> = {
  reliefweb: 10,
  lefaso: 15,
  bfemploi: 16,
  alertejob: 17,
  criburkina: 18,
  rmo: 19,
  edomatch: 21,
  educarriere: 22,
  africarrieres: 23,
  novojob: 24,
  goafricaonline: 25,
  remotive: 40,
  himalayas: 42,
  jobicy: 44,
  arbeitnow: 46,
  weworkremotely: 48,
  workingnomads: 50,
  nodesk: 52,
  themuse: 55,
  remoteok: 58,
  adzuna: 70,
  jooble: 75,
  careerjet: 78,
};

export function prioriteSource(nom: string): number {
  return PRIORITE_SOURCE[nom] ?? 100;
}

/** Mots trop courants pour discriminer quoi que ce soit. */
const MOTS_VIDES = new Set([
  'de', 'la', 'le', 'les', 'des', 'du', 'et', 'en', 'un', 'une', 'pour', 'dans', 'sur',
  'chez', 'avec', 'chargé', 'charge', 'agent', 'poste', 'emploi', 'job', 'offre', 'the',
  'and', 'for', 'with', 'senior', 'junior', 'h', 'f', 'cdi', 'cdd', 'stage',
]);

/** Construit l'ensemble des jetons discriminants du profil. */
export function jetonsProfil(profil: Profil): Set<string> {
  const source = [
    profil.metier_cible,
    ...profil.mots_cles_recherche,
    ...profil.competences,
    ...profil.secteurs,
  ];

  const jetons = new Set<string>();
  for (const brut of source) {
    for (const mot of normaliser(brut).split(' ')) {
      if (mot.length >= 4 && !MOTS_VIDES.has(mot)) jetons.add(mot);
    }
  }
  return jetons;
}

/** Vrai si le titre partage assez de jetons avec le profil (filtre anti hors-sujet). */
function titreCompatible(titre: string, jetons: Set<string>, profil: Profil): boolean {
  if (jetons.size === 0) return true;
  const motsTitre = normaliser(titre).split(' ').filter(Boolean);
  const matches = motsTitre.filter((mot) => jetons.has(mot));
  if (matches.length >= 2) return true;

  // Un seul mot suffit seulement s'il appartient au metier cible (pas un soft-skill).
  const jetonsMetier = new Set(
    normaliser(profil.metier_cible)
      .split(' ')
      .filter((mot) => mot.length >= 4 && !MOTS_VIDES.has(mot)),
  );
  return matches.some((mot) => jetonsMetier.has(mot));
}

/**
 * Portee geographique choisie apres le CV :
 *  - national : Burkina Faso uniquement
 *  - international : hors BF local (teletravail mondial OK)
 *  - les_deux : zones configurees (!lieu / .env)
 */
function lieuAcceptable(offre: Offre, jid: string, zonesConfigurees: string[]): boolean {
  const portee = lireParametreUtilisateur(jid, 'portee_recherche') ?? 'les_deux';
  const cible = normaliser([offre.lieu, offre.pays].filter(Boolean).join(' '));
  const estBurkina =
    /burkina|ouagadougou|bobo|koudougou|kaya|banfora|ouahigouya/.test(cible);

  if (portee === 'national') {
    if (estBurkina) return true;
    // Teletravail sans lieu : on laisse passer, le scoring jugera.
    if (!cible && offre.teletravail === true) return true;
    if (!cible) return true;
    return false;
  }

  if (portee === 'international') {
    if (offre.teletravail === true) return true;
    if (!cible) return true;
    // Poste clairement local BF sans teletravail : hors portee internationale.
    if (estBurkina) return false;
    return true;
  }

  // les_deux : comportement historique (liste de zones + teletravail).
  if (zonesConfigurees.length === 0) return true;
  if (offre.teletravail === true) return true;
  if (cible === '') return true;

  return zonesConfigurees.some((zone) => {
    const z = normaliser(zone);
    if (z === '') return false;
    return cible.includes(z) || z.includes(cible);
  });
}

/** Zones acceptees pour CET utilisateur : la base prime sur l'environnement (section 7). */
export function lieuxAcceptes(jid: string): string[] {
  const enBase = lireParametreUtilisateur(jid, 'lieux_acceptes');
  const brut = enBase ?? config.LIEUX_ACCEPTES;
  return brut
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function prefiltrer(jid: string, offres: Offre[], profil: Profil): ResultatPrefiltre {
  const jetons = jetonsProfil(profil);
  const zones = lieuxAcceptes(jid);
  const maxAnciennete = lireEntierUtilisateur(jid, 'max_anciennete_jours', config.MAX_ANCIENNETE_JOURS);
  const limiteDate = Date.now() - maxAnciennete * 24 * 3600 * 1000;

  const rejets = { doublon: 0, anciennete: 0, expiree: 0, motsCles: 0, lieu: 0 };
  const retenues: OffreCandidate[] = [];
  const nouvelles: OffreCandidate[] = [];
  const vuesDansCeCycle = new Set<string>();
  /** Empreinte titre|entreprise|lieu -> index dans retenues (dedup multi-sites). */
  const empreintesRetenues = new Map<string, number>();

  for (const offre of offres) {
    const hash = hashOffre(offre.url);

    if (vuesDansCeCycle.has(hash) || offreVuePourUtilisateur(jid, hash)) {
      rejets.doublon++;
      continue;
    }
    vuesDansCeCycle.add(hash);

    const candidate: OffreCandidate = { ...offre, hash };
    nouvelles.push(candidate);

    const publiee = new Date(offre.date_publication).getTime();
    if (Number.isFinite(publiee) && publiee < limiteDate) {
      rejets.anciennete++;
      continue;
    }

    if (!offreEncoreOuverte(offre)) {
      rejets.expiree++;
      continue;
    }

    if (!titreCompatible(offre.titre, jetons, profil)) {
      rejets.motsCles++;
      continue;
    }

    if (!lieuAcceptable(offre, jid, zones)) {
      rejets.lieu++;
      continue;
    }

    const empreinte = empreinteOffre(offre);
    const indexExistant = empreintesRetenues.get(empreinte);
    if (indexExistant !== undefined) {
      const actuelle = retenues[indexExistant]!;
      if (prioriteSource(offre.source) < prioriteSource(actuelle.source)) {
        retenues[indexExistant] = candidate;
      }
      rejets.doublon++;
      continue;
    }

    empreintesRetenues.set(empreinte, retenues.length);
    retenues.push(candidate);
  }

  logger.info('Prefiltre applique', {
    entrantes: offres.length,
    retenues: retenues.length,
    rejets,
  });

  return { retenues, nouvelles, rejets };
}
