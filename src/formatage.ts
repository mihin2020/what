/**
 * Mise en forme des messages WhatsApp (section 6.9).
 *
 * Regle structurante : le digest est decoupe en plusieurs messages (un en-tete,
 * puis un message par offre). Un message unique de grande taille est illisible
 * sur mobile.
 *
 * Regle imperative : le systeme ne reste JAMAIS silencieux a une echeance.
 * Trois familles de messages existent donc — digest, "aucune offre", et alerte
 * technique — la derniere devant rester visuellement distincte des deux autres.
 */
import { config } from './config.js';
import type { OffreScoree } from './matching/scoring.js';
import type { Profil } from './cv/analyse.js';
import type { Statistiques } from './db/repository.js';

/** Date longue en francais, dans le fuseau configure : "samedi 15 aout". */
export function dateLongue(date = new Date()): string {
  return new Intl.DateTimeFormat('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: config.FUSEAU,
  }).format(date);
}

/** Date et heure courtes : "samedi 15 aout a 07:30". */
export function dateHeure(date: Date): string {
  const jour = dateLongue(date);
  const heure = new Intl.DateTimeFormat('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: config.FUSEAU,
  }).format(date);
  return `${jour} a ${heure}`;
}

/** "il y a 2 jours", "aujourd'hui", "hier". */
export function anciennete(dateISO: string): string {
  const publiee = new Date(dateISO).getTime();
  if (!Number.isFinite(publiee)) return 'date inconnue';

  const jours = Math.floor((Date.now() - publiee) / (24 * 3600 * 1000));
  if (jours <= 0) return "publiee aujourd'hui";
  if (jours === 1) return 'publiee hier';
  return `publiee il y a ${jours} jours`;
}

/* ------------------------------------------------------------------ */
/* Digest                                                              */
/* ------------------------------------------------------------------ */

export function enTeteDigest(nombre: number, manuel = false, seuil = 50): string {
  const prefixe = manuel ? '🔎 Recherche du' : '🌅 Veille du';
  const phrase =
    nombre === 1
      ? `1 offre vraiment en lien avec ton profil (score ≥ ${seuil}).`
      : `${nombre} offres vraiment en lien avec ton profil (score ≥ ${seuil}).`;
  return `${prefixe} ${dateLongue()}\n\n${phrase}`;
}

export function messageOffre(offre: OffreScoree): string {
  const lignes = [`*${offre.titre}*`];

  if (offre.entreprise) lignes.push(`🏢 ${offre.entreprise}`);

  const lieu = [offre.lieu, offre.pays].filter(Boolean).join(', ');
  if (lieu) lignes.push(`📍 ${lieu}${offre.teletravail ? ' · teletravail possible' : ''}`);
  else if (offre.teletravail) lignes.push('📍 Teletravail');

  lignes.push(`📅 ${anciennete(offre.date_publication)}`);
  if (offre.contrat) lignes.push(`📄 ${offre.contrat}`);
  lignes.push(`🎯 Score : ${offre.score}/100`);

  if (offre.raison) lignes.push('', `_${offre.raison}_`);
  lignes.push('', `🔗 ${offre.url}`);

  return lignes.join('\n');
}

/**
 * Cycle sans aucune offre a montrer (rien de nouveau collecte, ou l'IA n'a
 * rien pu evaluer). Le nombre d'annonces examinees est indispensable : il
 * prouve que la veille a bien tourne.
 */
export function messageAucuneOffre(options: {
  examinees: number;
  aucuneCollecte: boolean;
  manuel?: boolean;
  sousSeuil?: number;
  seuil?: number;
}): string {
  const prefixe = options.manuel ? '🔎 Recherche du' : '🌅 Veille du';
  const lignes = [`${prefixe} ${dateLongue()}`, ''];
  const seuil = options.seuil ?? 50;

  if (options.aucuneCollecte) {
    lignes.push(
      'Aucune offre a te montrer aujourd hui : les sources interrogees n ont publie aucune nouvelle annonce exploitable depuis le dernier cycle.',
    );
  } else if ((options.sousSeuil ?? 0) > 0) {
    const n = options.sousSeuil!;
    const examinees =
      options.examinees === 1 ? '1 annonce' : `${options.examinees} annonces`;
    lignes.push(
      `J'ai examine ${examinees} : ${n} trop eloignee(s) de ton profil (score < ${seuil}).`,
      'Aucune offre suffisamment pertinente a t afficher pour le moment.',
    );
  } else {
    const annonces =
      options.examinees === 1 ? "J'ai examine 1 annonce" : `J'ai examine ${options.examinees} annonces`;
    lignes.push(`${annonces}, mais aucune n'a pu etre evaluee (echec technique cote IA).`);
  }

  lignes.push('', 'Tu peux elargir avec !lieu, ou relancer avec !veille.');
  return lignes.join('\n');
}

/** Echec technique total : visuellement distinct du message precedent. */
export function messageEchecTechnique(details?: string): string {
  const lignes = [
    `⚠️ Veille du ${dateLongue()}`,
    '',
    "Je n'ai pas pu interroger les sources d'offres ce matin",
    '(erreur technique). Je reessaie a la prochaine echeance.',
    '',
    'Tu peux forcer un nouvel essai avec !veille.',
  ];
  if (details) lignes.push('', `_${details}_`);
  return lignes.join('\n');
}

/* ------------------------------------------------------------------ */
/* Messages de service                                                 */
/* ------------------------------------------------------------------ */

export const MESSAGE_ACCUEIL = [
  '👋 Salut, je suis ton assistant de veille emploi.',
  '',
  'Envoie-moi ton CV en piece jointe (PDF ou DOCX) :',
  "je l'analyse, je te demande ou chercher (Burkina / international),",
  'puis je ne te montre que les offres vraiment en lien avec ton profil.',
  '',
  'Tape !aide pour voir toutes les commandes.',
].join('\n');

/** Question posee juste apres l'analyse du CV, AVANT la recherche. */
export const MESSAGE_CHOIX_PORTEE = [
  '🌍 *Ou veux-tu chercher des offres ?*',
  '',
  '1️⃣  Au Burkina Faso (national)',
  "2️⃣  A l'international (hors Burkina / teletravail mondial)",
  '3️⃣  Les deux',
  '',
  'Reponds par 1, 2 ou 3 — ensuite je lance la recherche.',
].join('\n');

export const MESSAGE_AIDE = [
  '📖 *Commandes disponibles*',
  '',
  '📎 _Piece jointe_ — envoie ton CV (PDF ou DOCX) pour creer ou mettre a jour ton profil',
  '',
  '!profil — affiche le profil enregistre',
  '!veille — lance tout de suite une recherche',
  '!frequence — change la frequence et l heure des envois',
  '!planning — regle actuel et prochaine echeance',
  '!pause — suspend les envois automatiques',
  '!reprendre — reactive les envois automatiques',
  '!lieu <zones> — zones acceptees, separees par des virgules',
  '!sources — liste des sources et leur etat',
  '!stats — offres traitees, envoyees, cout IA du mois',
  '!reinitialiser — efface profil, offres et planification pour repartir de zero',
  '!aide — ce message',
].join('\n');

export function messageProfil(profil: Profil): string {
  return [
    '👤 *Ton profil*',
    '',
    `🎯 Metier cible : ${profil.metier_cible}`,
    `⏳ Experience : ${profil.annees_experience} an(s)`,
    `🎓 Niveau : ${profil.niveau_etude}`,
    '',
    `🛠 Competences : ${profil.competences.join(', ')}`,
    profil.secteurs.length ? `🏭 Secteurs : ${profil.secteurs.join(', ')}` : '',
    profil.langues.length ? `🗣 Langues : ${profil.langues.join(', ')}` : '',
    '',
    `🔍 Mots-cles de recherche : ${profil.mots_cles_recherche.join(', ')}`,
    '',
    `_Analyse le ${dateHeure(new Date(profil.analyse_le))}._`,
    'Renvoie-moi un CV a tout moment pour mettre a jour ce profil.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export function messageProfilConfirme(profil: Profil): string {
  return [
    '✅ CV analyse.',
    '',
    `🎯 ${profil.metier_cible} — ${profil.annees_experience} an(s) d experience`,
    `🎓 ${profil.niveau_etude}`,
    `🛠 ${profil.competences.slice(0, 8).join(', ')}`,
    '',
    '_Verifie avec !profil, et renvoie un CV si quelque chose cloche._',
  ].join('\n');
}

export function messageStats(stats: Statistiques): string {
  return [
    '📊 *Statistiques*',
    '',
    `Offres connues en base : ${stats.offresConnues}`,
    `Offres envoyees (total) : ${stats.offresEnvoyees}`,
    '',
    '*Ce mois-ci*',
    `Offres vues : ${stats.offresMois}`,
    `Offres envoyees : ${stats.envoyeesMois}`,
    `Appels IA : ${stats.appelsMois}${stats.echecsMois ? ` (dont ${stats.echecsMois} en echec)` : ''}`,
    `Tokens : ${stats.tokensEntreeMois} en entree / ${stats.tokensSortieMois} en sortie`,
    `Cout IA estime : ${stats.coutEstimeUSD.toFixed(3)} USD`,
  ].join('\n');
}

export function messageSources(
  sources: { nom: string; actif: boolean }[],
  dernierCycle?: { nom: string; ok: boolean; nombre: number }[],
): string {
  const lignes = ['🔌 *Sources*', ''];

  for (const source of sources) {
    const etat = source.actif ? '✅ active' : '⛔ inactive';
    const dernier = dernierCycle?.find((d) => d.nom === source.nom);
    const detail = dernier
      ? dernier.ok
        ? ` — dernier cycle : ${dernier.nombre} offre(s)`
        : ' — dernier cycle : en echec'
      : '';
    lignes.push(`• ${source.nom} : ${etat}${detail}`);
  }

  return lignes.join('\n');
}
