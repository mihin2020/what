/**
 * Extraction du texte brut d'un CV recu en piece jointe WhatsApp.
 *
 * Regles (section 6.2) :
 *  - PDF via pdf-parse, DOCX via mammoth, tout autre type rejete ;
 *  - taille maximale 5 Mo ;
 *  - moins de 200 caracteres extraits = echec (PDF scanne) ;
 *  - aucune tentative d'OCR en v1.
 */
import { createRequire } from 'node:module';
import mammoth from 'mammoth';
import { logger } from '../logger.js';

const requireCJS = createRequire(import.meta.url);

/**
 * pdf-parse expose un mode "debug" quand il est charge sans parent CommonJS,
 * ce qui le pousse a lire un PDF de test inexistant. On cible donc directement
 * l'implementation pour eviter ce comportement.
 */
type PdfParse = (donnees: Buffer) => Promise<{ text: string; numpages: number }>;
function chargerPdfParse(): PdfParse {
  try {
    return requireCJS('pdf-parse/lib/pdf-parse.js') as PdfParse;
  } catch {
    return requireCJS('pdf-parse') as PdfParse;
  }
}

export const TAILLE_MAX_OCTETS = 5 * 1024 * 1024;
export const LONGUEUR_MIN_TEXTE = 200;

export const MIME_PDF = 'application/pdf';
export const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export type ResultatExtraction =
  | { ok: true; texte: string; format: 'pdf' | 'docx'; octets: number }
  | { ok: false; motif: 'type' | 'taille' | 'illisible' | 'erreur'; message: string };

/** Message utilisateur associe a chaque motif de rejet. */
export const MESSAGES_REJET: Record<'type' | 'taille' | 'illisible' | 'erreur', string> = {
  type:
    'Je ne sais lire que les CV en PDF ou en DOCX. ' +
    'Renvoie-moi ton CV dans un de ces deux formats.',
  taille: 'Ce fichier depasse 5 Mo. Envoie-moi une version plus legere de ton CV.',
  illisible:
    "Je n'arrive pas a lire le contenu de ce fichier. " +
    "S'il s'agit d'un scan, envoie-moi une version texte du CV.",
  erreur:
    "Je n'ai pas reussi a ouvrir ce fichier. Verifie qu'il n'est pas protege par mot de passe, " +
    'puis renvoie-le moi.',
};

/** Normalise les blancs sans detruire la structure en lignes du CV. */
function nettoyer(texte: string): string {
  return texte
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @param base64   contenu de la piece jointe
 * @param mimetype type MIME declare par WhatsApp
 * @param nom      nom du fichier, utilise en repli quand le mimetype est generique
 */
export async function extraireCV(
  base64: string,
  mimetype: string,
  nom = '',
): Promise<ResultatExtraction> {
  let donnees: Buffer;
  try {
    donnees = Buffer.from(base64, 'base64');
  } catch (erreur) {
    logger.warn('Piece jointe non decodable', erreur);
    return { ok: false, motif: 'erreur', message: MESSAGES_REJET.erreur };
  }

  if (donnees.length > TAILLE_MAX_OCTETS) {
    logger.info('CV rejete : taille', { octets: donnees.length });
    return { ok: false, motif: 'taille', message: MESSAGES_REJET.taille };
  }

  const type = mimetype.split(';')[0]?.trim().toLowerCase() ?? '';
  const extension = nom.toLowerCase().split('.').pop() ?? '';

  const estPdf = type === MIME_PDF || (type === 'application/octet-stream' && extension === 'pdf');
  const estDocx = type === MIME_DOCX || (type === 'application/octet-stream' && extension === 'docx');

  if (!estPdf && !estDocx) {
    logger.info('CV rejete : type non supporte', { type, extension });
    return { ok: false, motif: 'type', message: MESSAGES_REJET.type };
  }

  let texte = '';
  try {
    if (estPdf) {
      const pdfParse = chargerPdfParse();
      const resultat = await pdfParse(donnees);
      texte = nettoyer(resultat.text ?? '');
    } else {
      const resultat = await mammoth.extractRawText({ buffer: donnees });
      texte = nettoyer(resultat.value ?? '');
    }
  } catch (erreur) {
    logger.warn('Echec d extraction du CV', { format: estPdf ? 'pdf' : 'docx', erreur });
    return { ok: false, motif: 'erreur', message: MESSAGES_REJET.erreur };
  }

  if (texte.length < LONGUEUR_MIN_TEXTE) {
    // On ne journalise que la longueur : jamais le contenu (section 8.2).
    logger.info('CV illisible : texte trop court', { longueur: texte.length });
    return { ok: false, motif: 'illisible', message: MESSAGES_REJET.illisible };
  }

  logger.info('CV extrait', {
    format: estPdf ? 'pdf' : 'docx',
    octets: donnees.length,
    caracteres: texte.length,
  });

  return { ok: true, texte, format: estPdf ? 'pdf' : 'docx', octets: donnees.length };
}
