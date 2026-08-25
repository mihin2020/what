/**
 * Script de verification (recette). Ne fait AUCUN appel a WhatsApp ni a DeepSeek :
 * il verifie la base, le prefiltre, la deduplication, la planification dynamique,
 * le parcours conversationnel, l anonymisation et le formatage des messages.
 *
 * Usage :  npm run verifier
 *
 * Le script ecrit dans data/verification.sqlite, JAMAIS dans la base de
 * production data/veille.sqlite (voir tools/base-de-test.ts).
 *
 * Multi-utilisateur (section 6.9) : toutes les fonctions operent desormais
 * par jid. Ce script simule un unique utilisateur de test (JID_TEST).
 */
import './base-de-test.js';
import { traiterTexte } from '../src/commandes.js';
import { reliefweb } from '../src/sources/reliefweb.js';
import { initialiserSchema } from '../src/db/schema.js';
import {
  ecrireParametreUtilisateur,
  lireParametreUtilisateur,
  hashOffre,
  normaliserUrl,
  enregistrerOffre,
  enregistrerScoreUtilisateur,
  offreConnue,
  definirAttente,
  lireAttente,
  leverAttente,
  statistiques,
  journaliserIA,
  enregistrerProfil,
  purgerAnciennesOffres,
  lireProfil,
} from '../src/db/repository.js';
import {
  appliquer,
  arreterTaches,
  construireCrons,
  decrire,
  definirExecuteur,
  enregistrerPlanification,
  lirePlanification,
  nombreTachesActives,
  prochaineEcheance,
} from '../src/planification.js';
import { prefiltrer } from '../src/matching/prefiltre.js';
import { anonymiser } from '../src/cv/anonymisation.js';
import { extraireCV } from '../src/cv/extraction.js';
import {
  enTeteDigest,
  messageAucuneOffre,
  messageEchecTechnique,
  messageOffre,
  dateHeure,
} from '../src/formatage.js';
import type { Profil } from '../src/cv/analyse.js';
import type { Offre } from '../src/sources/types.js';

const JID_TEST = 'test-utilisateur@s.whatsapp.net';

const ok = (nom: string, condition: boolean, detail = '') => {
  console.log(`${condition ? 'OK  ' : 'KO  '} ${nom}${detail ? ' :: ' + detail : ''}`);
  if (!condition) process.exitCode = 1;
};

initialiserSchema();

// Le script doit pouvoir etre rejoue : on repart d'une table d'offres vide,
// sinon tout est rejete comme doublon des la deuxieme execution.
purgerAnciennesOffres(0);

/* --- Parametres et etat conversationnel --- */
ecrireParametreUtilisateur(JID_TEST, 'max_offres_digest', '7');
ok('parametre relu', lireParametreUtilisateur(JID_TEST, 'max_offres_digest') === '7');

definirAttente(JID_TEST, 'frequence', { origine: 'test' });
ok('attente posee', lireAttente(JID_TEST)?.attente === 'frequence');
leverAttente(JID_TEST);
ok('attente levee', lireAttente(JID_TEST) === null);

/* --- Deduplication --- */
const u1 = 'https://WWW.Exemple.org/offre/12?utm_source=x#ancre';
const u2 = 'https://exemple.org/offre/12';
ok('normalisation URL', normaliserUrl(u1) === normaliserUrl(u2), normaliserUrl(u1));
ok('hash identique', hashOffre(u1) === hashOffre(u2));

/* --- Profil --- */
const profil: Profil = {
  metier_cible: 'Charge de projet suivi-evaluation',
  annees_experience: 6,
  competences: ['suivi-evaluation', 'gestion de projet', 'humanitaire', 'Excel', 'redaction'],
  secteurs: ['ONG', 'humanitaire'],
  langues: ['francais', 'anglais'],
  niveau_etude: 'Bac+5',
  mots_cles_recherche: ['suivi evaluation', 'gestion de projet', 'coordination humanitaire'],
  pays: 'Burkina Faso',
  analyse_le: new Date().toISOString(),
};
enregistrerProfil(JID_TEST, profil, 'hash-test');
ok('profil persiste', lireProfil(JID_TEST)?.metier_cible === profil.metier_cible);

/* --- Prefiltre --- */
const base = {
  source: 'test',
  entreprise: 'Croix-Rouge',
  pays: 'Burkina Faso',
  description: 'Poste de suivi-evaluation.',
  teletravail: false,
  contrat: 'CDD',
};
const offres: Offre[] = [
  {
    ...base,
    id_source: '1',
    titre: 'Charge de suivi-evaluation',
    lieu: 'Ouagadougou',
    url: 'https://exemple.org/a',
    date_publication: new Date().toISOString(),
  },
  {
    ...base,
    id_source: '2',
    titre: 'Boulanger patissier',
    lieu: 'Ouagadougou',
    url: 'https://exemple.org/b',
    date_publication: new Date().toISOString(),
  },
  {
    ...base,
    id_source: '3',
    titre: 'Charge de projet humanitaire',
    lieu: 'Tokyo',
    pays: 'Japon',
    url: 'https://exemple.org/c',
    date_publication: new Date().toISOString(),
  },
  {
    ...base,
    id_source: '4',
    titre: 'Charge de suivi-evaluation',
    lieu: 'Ouagadougou',
    url: 'https://exemple.org/d',
    date_publication: new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString(),
  },
  {
    ...base,
    id_source: '5',
    titre: 'Charge de suivi-evaluation',
    lieu: 'Ouagadougou',
    url: 'https://exemple.org/e',
    date_publication: new Date().toISOString(),
    date_limite: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
  },
  {
    ...base,
    id_source: '6',
    source: 'jooble',
    titre: 'Charge de suivi-evaluation',
    entreprise: 'Croix-Rouge',
    lieu: 'Ouagadougou',
    url: 'https://jooble.exemple/offre-identique',
    date_publication: new Date().toISOString(),
  },
];

const r1 = prefiltrer(JID_TEST, offres, profil);
ok('prefiltre retient le poste pertinent', r1.retenues.length === 1, JSON.stringify(r1.rejets));
ok('rejet mots-cles', r1.rejets.motsCles === 1);
ok('rejet lieu', r1.rejets.lieu === 1);
ok('rejet anciennete', r1.rejets.anciennete === 1);
ok('rejet offre expiree', r1.rejets.expiree === 1);
ok('dedup multi-sites (meme poste URLs differentes)', r1.rejets.doublon === 1);
ok('garde la source prioritaire (jooble > test)', r1.retenues[0]?.source === 'jooble');

// Cache factuel (global) + statut "vu" pour CET utilisateur : c'est ce second
// point qui doit faire jouer le rejet "doublon" a la deuxieme passe.
for (const o of r1.nouvelles) {
  enregistrerOffre(o);
  enregistrerScoreUtilisateur(JID_TEST, o.hash, null, null);
}
ok('offre connue apres persistance', offreConnue(hashOffre('https://exemple.org/a')));

const r2 = prefiltrer(JID_TEST, offres, profil);
// Toutes les offres de r1.nouvelles sont deja "vues" : 6 doublons, 0 retenue.
ok('deuxieme passe : aucun doublon', r2.retenues.length === 0 && r2.rejets.doublon === 6);

/* --- Planification --- */
definirExecuteur(async () => {});
enregistrerPlanification(JID_TEST, 'quotidien', '07:30');
ecrireParametreUtilisateur(JID_TEST, 'veille_en_pause', '0');
ok('cron quotidien', construireCrons(lirePlanification(JID_TEST)!)[0] === '30 7 * * *');

enregistrerPlanification(JID_TEST, 'biquotidien', '07:30');
ok(
  'cron biquotidien',
  construireCrons(lirePlanification(JID_TEST)!).join(' | ') === '30 7 * * * | 30 19 * * *',
);

enregistrerPlanification(JID_TEST, 'semaine', '08:00');
ok('cron lun-ven', construireCrons(lirePlanification(JID_TEST)!)[0] === '0 8 * * 1-5');

enregistrerPlanification(JID_TEST, 'hebdo', '09:15', 3);
ok('cron hebdo', construireCrons(lirePlanification(JID_TEST)!)[0] === '15 9 * * 3');
ok('libelle hebdo', decrire(lirePlanification(JID_TEST)!) === 'chaque mercredi a 09:15');

// Trois reconfigurations successives : une seule tache doit rester active.
enregistrerPlanification(JID_TEST, 'quotidien', '07:30');
appliquer(JID_TEST);
appliquer(JID_TEST);
appliquer(JID_TEST);
ok(
  'une seule tache apres 3 reconfigurations',
  nombreTachesActives(JID_TEST) === 1,
  String(nombreTachesActives(JID_TEST)),
);

enregistrerPlanification(JID_TEST, 'biquotidien', '07:30');
appliquer(JID_TEST);
ok('deux taches en biquotidien', nombreTachesActives(JID_TEST) === 2, String(nombreTachesActives(JID_TEST)));

ecrireParametreUtilisateur(JID_TEST, 'veille_en_pause', '1');
appliquer(JID_TEST);
ok('pause : aucune tache', nombreTachesActives(JID_TEST) === 0);
ok('pause : aucune echeance', prochaineEcheance(lirePlanification(JID_TEST)) === null);

ecrireParametreUtilisateur(JID_TEST, 'veille_en_pause', '0');
enregistrerPlanification(JID_TEST, 'hebdo', '09:15', 3);
appliquer(JID_TEST);
const prochaine = prochaineEcheance(lirePlanification(JID_TEST));
ok('echeance hebdo calculee', prochaine !== null && prochaine.getTime() > Date.now());
console.log('     prochaine echeance :', prochaine ? dateHeure(prochaine) : 'n/a');

arreterTaches(JID_TEST);
ok('taches detruites', nombreTachesActives(JID_TEST) === 0);

/* --- Anonymisation --- */
const cv = `Jean OUEDRAOGO
jean.ouedraogo@gmail.com
+226 70 12 34 56
https://www.linkedin.com/in/jeanouedraogo
15 rue de la Paix, Ouagadougou
Ne le 12/03/1990

EXPERIENCE
2019 - 2023 : Charge de suivi-evaluation, Croix-Rouge
2015 - 2019 : Assistant de projet`;
const anonyme = anonymiser(cv);
ok('email retire', !anonyme.texte.includes('@gmail.com'));
ok('telephone retire', !/70 12 34 56/.test(anonyme.texte));
ok('linkedin retire', !anonyme.texte.toLowerCase().includes('linkedin'));
ok('adresse retiree', !anonyme.texte.includes('rue de la Paix'));
ok('annees conservees', anonyme.texte.includes('2019 - 2023'), anonyme.texte);
ok('competences conservees', anonyme.texte.includes('suivi-evaluation'));

/* --- Extraction : cas de rejet --- */
const rejetType = await extraireCV(Buffer.from('coucou').toString('base64'), 'image/jpeg', 'cv.jpg');
ok('rejet type non supporte', !rejetType.ok && rejetType.motif === 'type');

const gros = await extraireCV(Buffer.alloc(6 * 1024 * 1024).toString('base64'), 'application/pdf', 'cv.pdf');
ok('rejet taille', !gros.ok && gros.motif === 'taille');

/* --- Formatage --- */
journaliserIA({
  jid: JID_TEST,
  operation: 'scoring',
  modele: 'test',
  tokensEntree: 1000,
  tokensSortie: 200,
  succes: true,
});
const stats = statistiques(JID_TEST);
ok('journal IA comptabilise', stats.tokensEntreeMois >= 1000 && stats.coutEstimeUSD > 0);

const digest = messageOffre({
  ...offres[0]!,
  hash: 'x',
  score: 87,
  raison: 'Correspond a ton experience en suivi-evaluation.',
});
ok('message offre complet', /Score : 87\/100/.test(digest) && digest.includes('https://exemple.org/a'));
console.log('\n--- en-tete ---\n' + enTeteDigest(6));
console.log('\n--- offre ---\n' + digest);
console.log('\n--- aucune offre ---\n' + messageAucuneOffre({ examinees: 34, aucuneCollecte: false }));
console.log('\n--- echec technique ---\n' + messageEchecTechnique('reliefweb : HTTP 503'));


/* --- Commandes simples --- */
await traiterTexte(JID_TEST, '!lieu Ouagadougou, Remote');
ok('!lieu applique', lireParametreUtilisateur(JID_TEST, 'lieux_acceptes') === 'Ouagadougou,Remote');

await traiterTexte(JID_TEST, '!pause');
ok('!pause enregistree', lireParametreUtilisateur(JID_TEST, 'veille_en_pause') === '1');

/* --- Parcours frequence --- */
await traiterTexte(JID_TEST, '!frequence');
ok('attente frequence posee', lireAttente(JID_TEST)?.attente === 'frequence');

await traiterTexte(JID_TEST, '9');
ok('choix invalide : on reste en attente', lireAttente(JID_TEST)?.attente === 'frequence');

await traiterTexte(JID_TEST, '1');
ok('attente heure posee', lireAttente(JID_TEST)?.attente === 'heure');

await traiterTexte(JID_TEST, 'n importe quoi');
ok('heure invalide : on redemande', lireAttente(JID_TEST)?.attente === 'heure');

await traiterTexte(JID_TEST, '7h30');
ok('attente levee apres heure valide', lireAttente(JID_TEST) === null);
ok(
  'planification enregistree',
  decrire(lirePlanification(JID_TEST)!) === 'chaque jour a 07:30',
  JSON.stringify(lirePlanification(JID_TEST)),
);
ok('configuration = reprise de la veille', lireParametreUtilisateur(JID_TEST, 'veille_en_pause') === '0');

/* --- Repli apres deux heures invalides --- */
await traiterTexte(JID_TEST, '!frequence');
await traiterTexte(JID_TEST, '2');
await traiterTexte(JID_TEST, 'bidule');
await traiterTexte(JID_TEST, 'encore bidule');
ok(
  'repli applique apres 2 echecs',
  lirePlanification(JID_TEST)?.heure === '08:00',
  JSON.stringify(lirePlanification(JID_TEST)),
);
ok('attente levee apres repli', lireAttente(JID_TEST) === null);

/* --- Une commande connue leve l'attente --- */
await traiterTexte(JID_TEST, '!frequence');
await traiterTexte(JID_TEST, '!planning');
ok('commande connue leve l attente', lireAttente(JID_TEST) === null);

/* --- Jour hebdomadaire --- */
await traiterTexte(JID_TEST, '!frequence');
await traiterTexte(JID_TEST, '3');
ok('attente jour posee', lireAttente(JID_TEST)?.attente === 'jour_hebdo');
await traiterTexte(JID_TEST, '5');
ok('attente heure apres jour', lireAttente(JID_TEST)?.attente === 'heure');
await traiterTexte(JID_TEST, '18:00');
ok(
  'hebdo vendredi 18:00',
  decrire(lirePlanification(JID_TEST)!) === 'chaque vendredi a 18:00',
  JSON.stringify(lirePlanification(JID_TEST)),
);

/* --- Commande inconnue --- */
await traiterTexte(JID_TEST, '!inconnue');
ok('commande inconnue toleree', true);

arreterTaches(JID_TEST);

/* --- Connecteur ReliefWeb en conditions reelles --- */
// Depend d'un acces reseau et d'un appname approuve : un echec ici n'invalide
// pas le reste de la verification, il est signale comme un avertissement.
ecrireParametreUtilisateur(JID_TEST, 'veille_en_pause', '1');
try {
  const offresReliefWeb = await reliefweb.chercher(profil);
  ok('ReliefWeb repond', offresReliefWeb.length > 0, `${offresReliefWeb.length} offres`);
  if (offresReliefWeb[0]) {
    const o = offresReliefWeb[0];
    console.log('     exemple :', o.titre, '|', o.entreprise, '|', o.lieu, '|', o.date_publication);
    ok('champs obligatoires presents', Boolean(o.url && o.titre && o.date_publication && o.id_source));
    ok('description tronquee', o.description.length <= 2000);
  }
} catch (erreur) {
  const message = (erreur as Error).message;
  const appnameNonApprouve = message.includes('403');
  console.log(
    `WARN ReliefWeb inutilisable :: ${message}` +
      (appnameNonApprouve
        ? '\n     -> demande un appname approuve : https://apidoc.reliefweb.int/parameters#appname'
        : ''),
  );
}

console.log('\nTermine.');
process.exit(process.exitCode ?? 0);
