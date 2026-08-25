/**
 * Retrait des donnees directement identifiantes avant tout envoi vers l'API
 * DeepSeek (section 6.3).
 *
 * Ce qui est retire : email, telephone, URL de profils personnels, adresse
 * postale detectable, identifiants de reseaux sociaux.
 * Ce qui est conserve : competences, experiences, formations, langues,
 * intitules de poste — c'est la matiere analytique.
 */

export interface ResultatAnonymisation {
  texte: string;
  /** Nombre de remplacements par categorie, utile au journal (sans contenu). */
  compteurs: Record<string, number>;
}

interface Regle {
  nom: string;
  motif: RegExp;
  remplacement: string;
  /** Si defini et vrai, la correspondance est conservee telle quelle. */
  exception?: (correspondance: string) => boolean;
}

/**
 * Un CV est plein de suites de chiffres qui ne sont pas des telephones :
 * "2019 - 2021", "2015/2018", "Bac+5 2010". On les preserve, sinon l'IA ne
 * peut plus estimer l'anciennete.
 */
function ressembleADesAnnees(correspondance: string): boolean {
  const chiffres = correspondance.replace(/\D/g, '');
  if (chiffres.length !== 8) return false;
  const a1 = Number(chiffres.slice(0, 4));
  const a2 = Number(chiffres.slice(4));
  const plausible = (a: number) => a >= 1950 && a <= 2100;
  return plausible(a1) && plausible(a2);
}

/**
 * Les motifs sont volontairement larges : un faux positif coute une information
 * peu utile a l'analyse, un faux negatif expose une donnee personnelle.
 */
const REGLES: Regle[] = [
  {
    nom: 'email',
    motif: /[\w.+-]+@[\w-]+\.[\w.-]{2,}/g,
    remplacement: '[EMAIL]',
  },
  {
    nom: 'url_profil',
    motif:
      /\b(?:https?:\/\/)?(?:[\w-]+\.)?(?:linkedin\.com|github\.com|gitlab\.com|twitter\.com|x\.com|facebook\.com|instagram\.com|behance\.net|dribbble\.com|malt\.fr)\/[^\s,;)]*/gi,
    remplacement: '[PROFIL]',
  },
  {
    nom: 'url_autre',
    motif: /\bhttps?:\/\/[^\s,;)]+/gi,
    remplacement: '[LIEN]',
  },
  {
    // Formats internationaux (+226 70 00 00 00, 00226...) et locaux (06 12 34 56 78).
    nom: 'telephone',
    motif:
      /(?:(?:\+|00)\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d(?:[\s.-]?\d){7,13}\b/g,
    remplacement: '[TELEPHONE]',
    exception: ressembleADesAnnees,
  },
  {
    nom: 'adresse_postale',
    motif:
      /\b\d{1,4}(?:\s?(?:bis|ter))?,?\s+(?:rue|avenue|av\.|boulevard|bd|impasse|allee|allée|chemin|route|place|secteur|quartier|porte)\s+[^\n,;]{2,60}/gi,
    remplacement: '[ADRESSE]',
  },
  {
    nom: 'code_postal_ville',
    motif: /\b(?:BP|B\.P\.)\s?\d{1,6}\b/gi,
    remplacement: '[ADRESSE]',
  },
  {
    nom: 'date_naissance',
    motif:
      /\b(?:ne|nee|né|née)\s+le\s+\d{1,2}[\/\s.-](?:\d{1,2}|[a-zéû]+)[\/\s.-]\d{2,4}/gi,
    remplacement: '[NAISSANCE]',
  },
];

/**
 * Anonymise le texte d'un CV.
 *
 * L'ordre des regles compte : les URL de profil sont traitees avant les URL
 * generiques, et les emails avant les telephones (un email peut contenir des
 * chiffres qui ressemblent a un numero).
 */
export function anonymiser(texte: string): ResultatAnonymisation {
  const compteurs: Record<string, number> = {};
  let sortie = texte;

  for (const regle of REGLES) {
    let occurrences = 0;
    sortie = sortie.replace(regle.motif, (correspondance) => {
      if (regle.exception?.(correspondance)) return correspondance;
      occurrences++;
      return regle.remplacement;
    });
    if (occurrences > 0) compteurs[regle.nom] = occurrences;
  }

  return { texte: sortie, compteurs };
}
