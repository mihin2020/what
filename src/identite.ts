/**
 * Identifiant du proprietaire (celui dont le numero est configure dans
 * NUMERO_AUTORISE), partage entre les modules qui doivent le distinguer des
 * autres utilisateurs du bot (interface web reservee au proprietaire,
 * migration des donnees mono-utilisateur historiques).
 *
 * Meme calcul que le JID de destination utilise pour l'envoi WhatsApp
 * (src/whatsapp.ts) : DOIT rester identique, sinon le profil/planification du
 * proprietaire migres semblent "perdus" au premier message apres coup (le
 * routage entrant normalise toujours vers cette meme forme @s.whatsapp.net,
 * jamais l'inverse — voir jidCanonique() dans whatsapp.ts).
 */
import { config } from './config.js';

const numeroBrut = config.NUMERO_AUTORISE.replace(/@c\.us$/, '');

export const jidProprietaire = `${numeroBrut}@s.whatsapp.net`;
