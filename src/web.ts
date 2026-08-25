/**
 * Interface web : panneau d'administration (section 6.9/6.10).
 *
 * Le CV s'analyse exclusivement via WhatsApp (chaque utilisateur envoie le
 * sien) : ce serveur ne fait plus d'upload de CV. Il sert a l'operateur du
 * bot a superviser l'ensemble : connexion WhatsApp (QR, deconnexion/nouvel
 * appairage), liste des utilisateurs, statistiques globales, etat des
 * sources, et cle API DeepSeek.
 *
 * SECURITE : en local liee a 127.0.0.1. En production (Render), ecoute
 * 0.0.0.0 avec HTTP Basic (ADMIN_USER / ADMIN_PASSWORD). /health reste
 * public pour les probes Render.
 */
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { config } from './config.js';
import { logger } from './logger.js';
import {
  codeAppairageActuel,
  dernierQrGenereLe,
  estLiaisonEnCours,
  estPret,
  numeroConnecte,
  deconnecterEtReinitialiser,
} from './whatsapp.js';
import {
  activiteParJour,
  ecrireParametre,
  inscriptionsParJour,
  lireParametre,
  listerUtilisateurs,
  statistiquesGlobales,
  supprimerParametre,
} from './db/repository.js';
import { etatSources } from './veille.js';
import { dateHeure } from './formatage.js';
import { LIBELLES } from './planification.js';
import { SOURCES } from './sources/index.js';

const app = express();
const CHEMIN_QR = path.join(config.chemins.data, 'qr.png');

/** Probe Render / load balancer — sans auth. */
app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

function motsDePasseEgaux(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function exigerAuthAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!config.webExposePubliquement) {
    next();
    return;
  }
  if (!config.ADMIN_USER || !config.ADMIN_PASSWORD) {
    res.status(503).send(
      'Dashboard non configure : definis ADMIN_USER et ADMIN_PASSWORD dans les variables du service.',
    );
    return;
  }
  const entete = req.headers.authorization;
  if (!entete?.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Veille admin"');
    res.status(401).send('Authentification requise');
    return;
  }
  const decode = Buffer.from(entete.slice(6), 'base64').toString('utf8');
  const sep = decode.indexOf(':');
  const user = sep >= 0 ? decode.slice(0, sep) : '';
  const pass = sep >= 0 ? decode.slice(sep + 1) : '';
  if (
    motsDePasseEgaux(user, config.ADMIN_USER) &&
    motsDePasseEgaux(pass, config.ADMIN_PASSWORD)
  ) {
    next();
    return;
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Veille admin"');
  res.status(401).send('Identifiants invalides');
}

app.use(exigerAuthAdmin);

app.get('/api/statut', (_req, res) => {
  const qrLe = dernierQrGenereLe();
  res.json({
    pret: estPret(),
    numero: numeroConnecte(),
    qrDisponible: qrLe !== null,
    qrAgeMs: qrLe ? Date.now() - qrLe : null,
    codeAppairage: codeAppairageActuel(),
    appairageParCode: config.APPAIRAGE_PAR_CODE,
    liaisonEnCours: estLiaisonEnCours(),
  });
});

app.get('/qr.png', async (_req, res) => {
  try {
    const donnees = await readFile(CHEMIN_QR);
    res.set('Cache-Control', 'no-store');
    res.type('png').send(donnees);
  } catch {
    res.status(404).json({ erreur: 'Aucun QR en attente (deja connecte, ou pas encore genere).' });
  }
});

/**
 * Deconnecte le numero appaire et efface la session locale, pour permettre
 * d'en appairer un autre. Destructif (session WhatsApp perdue) : la
 * confirmation explicite dans le corps de la requete evite un appel accidentel.
 */
app.post('/api/whatsapp/deconnecter', express.json(), async (req, res) => {
  const confirme = Boolean((req.body as { confirmer?: unknown } | undefined)?.confirmer);
  if (!confirme) {
    res.status(400).json({ erreur: 'Confirmation requise.' });
    return;
  }

  try {
    await deconnecterEtReinitialiser();
    res.json({ ok: true });
  } catch (erreur) {
    logger.error('Deconnexion WhatsApp (dashboard) en echec', erreur);
    res.status(500).json({ erreur: 'La deconnexion a echoue, verifie les journaux.' });
  }
});

/* ------------------------------------------------------------------ */
/* Utilisateurs et inscriptions                                        */
/* ------------------------------------------------------------------ */

app.get('/api/utilisateurs', (_req, res) => {
  const utilisateurs = listerUtilisateurs().map((u) => ({
    ...u,
    frequenceLibelle: u.frequence ? ((LIBELLES as Record<string, string>)[u.frequence] ?? u.frequence) : null,
    derniereActiviteTexte: u.derniereActivite ? dateHeure(new Date(u.derniereActivite)) : null,
  }));
  res.json({ utilisateurs, inscriptions: inscriptionsParJour(30) });
});

/* ------------------------------------------------------------------ */
/* Statistiques et sources                                             */
/* ------------------------------------------------------------------ */

app.get('/api/stats', (_req, res) => {
  res.json({ stats: statistiquesGlobales(), activite: activiteParJour(30) });
});

app.get('/api/sources', (_req, res) => {
  const dernierCycle = etatSources();
  const sources = SOURCES.map((s) => ({
    nom: s.nom,
    actif: s.actif,
    dernierCycle: dernierCycle.find((d) => d.nom === s.nom) ?? null,
  }));
  res.json({ sources });
});

/* ------------------------------------------------------------------ */
/* Cle API DeepSeek (surcharge en base, prime sur .env)                */
/* ------------------------------------------------------------------ */

const CLE_PARAMETRE_DEEPSEEK = 'deepseek_api_key';

function apercuCle(valeur: string): string {
  return valeur.length <= 4 ? '••••' : `••••${valeur.slice(-4)}`;
}

app.get('/api/parametres', (_req, res) => {
  const cleEnBase = lireParametre(CLE_PARAMETRE_DEEPSEEK);
  res.json({
    deepseekConfigureDepuisDashboard: cleEnBase !== null,
    deepseekApercu: apercuCle(cleEnBase ?? config.DEEPSEEK_API_KEY),
    deepseekSource: cleEnBase !== null ? 'dashboard' : 'env',
  });
});

app.post('/api/parametres', express.json(), (req, res) => {
  const corps = req.body as { deepseekApiKey?: unknown; supprimerCle?: unknown } | undefined;

  if (corps?.supprimerCle === true) {
    supprimerParametre(CLE_PARAMETRE_DEEPSEEK);
    logger.info('Cle DeepSeek supprimee depuis le dashboard (repli sur .env)');
    res.json({
      deepseekConfigureDepuisDashboard: false,
      deepseekApercu: apercuCle(config.DEEPSEEK_API_KEY),
      deepseekSource: 'env',
    });
    return;
  }

  const valeur = corps?.deepseekApiKey;
  if (typeof valeur !== 'string' || valeur.trim().length < 10) {
    res.status(400).json({ erreur: 'Cle invalide (trop courte).' });
    return;
  }

  const nettoyee = valeur.trim();
  ecrireParametre(CLE_PARAMETRE_DEEPSEEK, nettoyee);
  logger.info('Cle DeepSeek mise a jour depuis le dashboard');
  res.json({
    deepseekConfigureDepuisDashboard: true,
    deepseekApercu: apercuCle(nettoyee),
    deepseekSource: 'dashboard',
  });
});

app.get('/', (_req, res) => {
  res.type('html').send(PAGE_HTML);
});

let serveur: ReturnType<typeof app.listen> | undefined;

export function demarrerServeurWeb(): void {
  // En prod (Docker / Railway), toujours 0.0.0.0 — sinon healthcheck = "service unavailable".
  const bind =
    process.env.NODE_ENV === 'production' || config.webExposePubliquement
      ? '0.0.0.0'
      : config.WEB_BIND;
  serveur = app.listen(config.PORT, bind, () => {
    logger.info(`Interface web disponible sur http://${bind}:${config.PORT}`, {
      bind,
      port: config.PORT,
      auth: config.webExposePubliquement,
    });
  });
  serveur.on('error', (erreur) => {
    logger.error('Echec listen HTTP (healthcheck Railway echouera)', {
      bind,
      port: config.PORT,
      erreur,
    });
  });
}

export function arreterServeurWeb(): void {
  serveur?.close();
}

const PAGE_HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Veille — administration</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&family=Syne:wght@600;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --ink: #14201c;
    --ink-soft: #3d4f47;
    --mist: #e8efe9;
    --paper: #f7faf7;
    --line: #c9d6cc;
    --teal: #0f5c4c;
    --teal-deep: #0a3d34;
    --amber: #d97706;
    --amber-soft: #fef3c7;
    /* Series du graphe d'activite : validees (bande de clarte, plancher de
       chroma, separation daltonienne, contraste) contre la surface du
       panneau #f2f6f2 — ne pas remplacer par --teal / --amber, qui echouent
       la bande de clarte et le contraste. */
    --serie-offres: #0f9c7d;
    --serie-ia: #b45309;
    --serie-profils: #2a78d6;
    --ok: #157a4b;
    --ok-bg: #d8f3e4;
    --warn: #b45309;
    --warn-bg: #ffedd5;
    --bad: #b42318;
    --bad-bg: #fee4e2;
    --shadow: 0 1px 0 rgba(20, 32, 28, 0.04);
    --ease: cubic-bezier(0.22, 1, 0.36, 1);
  }

  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0;
    min-height: 100vh;
    color: var(--ink);
    font-family: "Figtree", sans-serif;
    font-size: 15px;
    line-height: 1.55;
    background:
      radial-gradient(1200px 600px at 10% -10%, #c8e0d4 0%, transparent 55%),
      radial-gradient(900px 500px at 100% 0%, #f5e6c8 0%, transparent 50%),
      linear-gradient(180deg, #eef5f0 0%, var(--paper) 40%, #e7efe9 100%);
  }
  body::before {
    content: "";
    position: fixed;
    inset: 0;
    pointer-events: none;
    opacity: 0.35;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.45'/%3E%3C/svg%3E");
    mix-blend-mode: multiply;
    z-index: 0;
  }

  .shell {
    position: relative;
    z-index: 1;
    width: min(1100px, calc(100% - 2rem));
    margin: 0 auto;
    padding: 1.75rem 0 4rem;
  }

  .top {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 1.75rem;
    animation: rise 0.7s var(--ease) both;
  }
  .brand {
    font-family: "Syne", sans-serif;
    font-weight: 800;
    font-size: clamp(2.2rem, 5vw, 3.1rem);
    letter-spacing: -0.04em;
    line-height: 0.95;
    color: var(--teal-deep);
    margin: 0;
  }
  .brand span { color: var(--amber); }
  .tagline {
    margin: 0.45rem 0 0;
    color: var(--ink-soft);
    font-size: 0.95rem;
    max-width: 28rem;
  }

  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
    padding: 0.55rem 0.9rem;
    border: 1px solid var(--line);
    background: rgba(247, 250, 247, 0.85);
    backdrop-filter: blur(8px);
    border-radius: 999px;
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--ink-soft);
    white-space: nowrap;
  }
  .status-pill .dot {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: var(--bad);
    box-shadow: 0 0 0 0 rgba(180, 35, 24, 0.35);
    animation: pulse 2s ease infinite;
  }
  .status-pill.ok .dot {
    background: var(--ok);
    box-shadow: 0 0 0 0 rgba(21, 122, 75, 0.35);
  }
  .status-pill.wait .dot { background: var(--warn); }

  .hero-link {
    display: grid;
    grid-template-columns: 1.1fr 0.9fr;
    gap: 1.5rem;
    align-items: stretch;
    margin-bottom: 1.5rem;
    animation: rise 0.8s var(--ease) 0.08s both;
  }
  @media (max-width: 820px) {
    .hero-link { grid-template-columns: 1fr; }
    .top { flex-direction: column; align-items: flex-start; }
  }

  .panel {
    background: rgba(247, 250, 247, 0.72);
    border: 1px solid var(--line);
    border-radius: 18px;
    padding: 1.35rem 1.4rem;
    box-shadow: var(--shadow);
    backdrop-filter: blur(10px);
  }
  .panel h2 {
    font-family: "Syne", sans-serif;
    font-size: 1.05rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    margin: 0 0 0.35rem;
  }
  .panel .lead {
    margin: 0 0 1rem;
    color: var(--ink-soft);
    font-size: 0.9rem;
  }

  .qr-stage {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 320px;
    text-align: center;
    background:
      linear-gradient(160deg, rgba(15, 92, 76, 0.08), transparent 55%),
      rgba(247, 250, 247, 0.85);
  }
  .qr-frame {
    position: relative;
    padding: 0.85rem;
    border-radius: 16px;
    background: #fff;
    border: 1px solid var(--line);
    animation: softGlow 3.2s ease-in-out infinite;
  }
  .qr-frame img {
    display: block;
    width: min(260px, 70vw);
    height: auto;
    border-radius: 8px;
  }
  .qr-placeholder {
    width: min(260px, 70vw);
    aspect-ratio: 1;
    display: grid;
    place-items: center;
    color: var(--ink-soft);
    font-size: 0.9rem;
    background:
      repeating-linear-gradient(-45deg, #f0f4f1, #f0f4f1 8px, #e7ece8 8px, #e7ece8 16px);
    border-radius: 8px;
  }
  .steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.75rem;
  }
  .steps li {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.75rem;
    align-items: start;
    padding: 0.7rem 0.8rem;
    border-radius: 12px;
    background: rgba(255,255,255,0.55);
    border: 1px solid transparent;
    transition: border-color 0.25s var(--ease), transform 0.25s var(--ease);
  }
  .steps li:hover { border-color: var(--line); transform: translateX(2px); }
  .steps .n {
    font-family: "Syne", sans-serif;
    font-weight: 700;
    color: var(--teal);
    font-size: 0.95rem;
    width: 1.6rem;
  }
  .steps strong { display: block; font-size: 0.92rem; }
  .steps span { color: var(--ink-soft); font-size: 0.82rem; }

  .code-box {
    margin-top: 1rem;
    padding: 0.9rem 1rem;
    border-radius: 12px;
    background: var(--amber-soft);
    border: 1px solid #fcd34d;
    font-family: "Syne", sans-serif;
    font-size: 1.6rem;
    letter-spacing: 0.18em;
    font-weight: 700;
    text-align: center;
    color: var(--teal-deep);
  }

  .actions { display: flex; flex-wrap: wrap; gap: 0.55rem; margin-top: 1rem; }
  button, .btn {
    font-family: inherit;
    font-size: 0.86rem;
    font-weight: 600;
    padding: 0.55rem 0.95rem;
    border-radius: 10px;
    border: 1px solid var(--line);
    background: #fff;
    color: var(--ink);
    cursor: pointer;
    transition: background 0.2s var(--ease), border-color 0.2s var(--ease), transform 0.15s var(--ease);
  }
  button:hover, .btn:hover { border-color: var(--teal); transform: translateY(-1px); }
  button.primary {
    background: var(--teal);
    border-color: var(--teal);
    color: #fff;
  }
  button.primary:hover { background: var(--teal-deep); }
  button.danger { color: var(--bad); border-color: #f3b0aa; }
  button:disabled { opacity: 0.55; cursor: not-allowed; transform: none; }

  .grid {
    display: grid;
    grid-template-columns: repeat(12, 1fr);
    gap: 1rem;
    margin-bottom: 1rem;
  }
  .span-4 { grid-column: span 4; }
  .span-5 { grid-column: span 5; }
  .span-7 { grid-column: span 7; }
  .span-8 { grid-column: span 8; }
  .span-12 { grid-column: span 12; }
  @media (max-width: 900px) {
    .span-4, .span-5, .span-7, .span-8 { grid-column: span 12; }
  }

  .metric {
    font-family: "Syne", sans-serif;
    font-size: 2rem;
    font-weight: 700;
    letter-spacing: -0.03em;
    color: var(--teal-deep);
    line-height: 1.1;
    margin: 0.15rem 0 0.25rem;
  }
  .meta { color: var(--ink-soft); font-size: 0.84rem; margin: 0; }
  .split {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.9rem;
    margin-top: 0.9rem;
  }
  .split h3 {
    margin: 0 0 0.25rem;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--ink-soft);
    font-weight: 700;
  }
  .split p { margin: 0.12rem 0; font-size: 0.86rem; }

  .sources { list-style: none; margin: 0.5rem 0 0; padding: 0; max-height: 220px; overflow: auto; }
  .sources li {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    padding: 0.38rem 0;
    border-bottom: 1px solid rgba(201, 214, 204, 0.55);
    font-size: 0.86rem;
  }
  .sources li:last-child { border-bottom: none; }
  .pip {
    width: 0.5rem; height: 0.5rem; border-radius: 50%; flex-shrink: 0;
    background: var(--ink-soft);
  }
  .pip.ok { background: var(--ok); }
  .pip.bad { background: var(--bad); }

  .chart {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 88px;
    margin-top: 0.85rem;
    border-bottom: 1px solid var(--line);   /* ligne de base, filet plein */
  }
  .chart i {
    flex: 1 1 0;
    min-width: 0;
    max-width: 22px;               /* marque fine : ne remplit jamais la case */
    display: block;
    margin: 0 auto;
    border-radius: 4px 4px 0 0;    /* extremite arrondie, carree a la base */
    background: none;
    transition: height 0.5s var(--ease);
  }
  .chart i.on { background: var(--serie-profils); }

  /* --- Activite : small multiples ------------------------------------- */
  /* Deux mesures d'UNITES DIFFERENTES (offres envoyees, appels IA). Jamais
     deux echelles sur un meme plot : leur alignement serait arbitraire et
     inventerait une correlation absente des donnees. Un mini-graphe par
     mesure, axe des dates partage en dessous. */
  #carte-stats { position: relative; }
  .sm-entete {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }
  .sm-bascule {
    flex-shrink: 0;
    border: 1px solid var(--line);
    background: rgba(255, 255, 255, 0.5);
    color: var(--ink-soft);
    font: inherit;
    font-size: 0.78rem;
    font-weight: 600;
    padding: 0.3rem 0.75rem;
    border-radius: 999px;
    cursor: pointer;
    transition: background 0.2s var(--ease), color 0.2s var(--ease);
  }
  .sm-bascule:hover { background: #fff; color: var(--ink); }

  .sm { margin-top: 1.15rem; }
  .sm-tete { display: flex; align-items: baseline; justify-content: space-between; gap: 0.75rem; }
  .sm-titre {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--ink-soft);
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  /* Une seule serie par mini-graphe : pas de boite de legende (le titre la
     nomme deja), l'identite passe par cette pastille A COTE du texte — le
     texte, lui, garde toujours une couleur d'encre. */
  .sm-cle { width: 0.6rem; height: 0.6rem; border-radius: 2px; flex-shrink: 0; }
  .sm-max { color: var(--ink-soft); font-size: 0.72rem; font-variant-numeric: tabular-nums; }

  .sm-plot {
    position: relative;
    height: 92px;
    padding-top: 16px;             /* reserve pour l'etiquette du pic */
    margin-top: 0.35rem;
    border-bottom: 1px solid var(--line);   /* ligne de base, filet plein */
  }
  .sm-grid {
    position: absolute;
    left: 0; right: 0; top: 16px;
    border-top: 1px solid rgba(201, 214, 204, 0.5);  /* graduation du max */
  }
  .sm-bars { display: flex; align-items: flex-end; gap: 2px; height: 100%; }
  .sm-bar {
    flex: 1 1 0;
    min-width: 0;
    height: 100%;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    padding: 0;
    border: none;
    background: none;
    cursor: default;
    border-radius: 4px;
  }
  .sm-bar i {
    position: relative;
    display: block;
    width: 100%;
    max-width: 22px;               /* marque fine : ne remplit jamais la case */
    border-radius: 4px 4px 0 0;    /* extremite arrondie, carree a la base */
    transition: height 0.5s var(--ease);
  }
  .sm-bar i.vide { height: 0; }   /* jour sans activite : aucune marque */
  .sm-bar:hover, .sm-bar:focus-visible { background: rgba(15, 92, 76, 0.07); }
  .sm-bar:hover i, .sm-bar:focus-visible i { filter: brightness(1.12); }
  .sm-bar:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; }
  .sm-val {
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    margin-bottom: 3px;
    font-size: 0.7rem;
    font-style: normal;   /* la marque est un <i> : ne pas heriter l'italique */
    font-weight: 700;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }
  .sm-axe {
    display: flex;
    justify-content: space-between;
    margin-top: 0.4rem;
    color: var(--ink-soft);
    font-size: 0.72rem;
    font-variant-numeric: tabular-nums;
  }

  .sm-tip {
    position: absolute;
    z-index: 3;
    transform: translate(-50%, -100%);
    pointer-events: none;
    background: #16211d;
    color: #f4f8f5;
    border-radius: 10px;
    padding: 0.5rem 0.65rem;
    font-size: 0.78rem;
    line-height: 1.35;
    white-space: nowrap;
    box-shadow: 0 6px 20px rgba(20, 32, 28, 0.25);
  }
  .sm-tip[hidden] { display: none; }
  .tip-date { font-weight: 700; margin-bottom: 0.25rem; }
  .tip-ligne { display: flex; align-items: center; gap: 0.4rem; }
  /* Cle en trait, pas en pave : a cette densite un carre plein est de l'encre
     de donnee qui fait le travail d'une etiquette. Pas sur la bulle sombre :
     ces deux valeurs sont les pas valides pour CETTE surface. */
  .tip-cle { width: 12px; height: 2px; border-radius: 1px; flex-shrink: 0; }
  .tip-cle.offres { background: #19a985; }
  .tip-cle.ia { background: #c9761f; }
  .tip-ligne strong { font-variant-numeric: tabular-nums; }
  .tip-nom { color: rgba(244, 248, 245, 0.7); }

  /* Vue tableau : l'equivalent lisible sans couleur ni survol. */
  .sm-table { max-height: 264px; overflow: auto; margin-top: 0.9rem; }
  .sm-table td { font-variant-numeric: tabular-nums; }

  table { width: 100%; border-collapse: collapse; font-size: 0.86rem; margin-top: 0.4rem; }
  th, td { text-align: left; padding: 0.55rem 0.45rem; border-bottom: 1px solid rgba(201,214,204,0.7); white-space: nowrap; }
  th {
    color: var(--ink-soft);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 700;
  }
  tr:last-child td { border-bottom: none; }
  .badge-mini {
    display: inline-block;
    padding: 0.12rem 0.45rem;
    border-radius: 6px;
    font-size: 0.75rem;
    font-weight: 600;
    background: var(--ok-bg);
    color: var(--ok);
  }
  .badge-mini.off { background: #eef1ef; color: var(--ink-soft); }

  #form-cle { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.7rem; }
  input[type="password"] {
    flex: 1;
    min-width: 180px;
    padding: 0.55rem 0.7rem;
    border-radius: 10px;
    border: 1px solid var(--line);
    background: #fff;
    color: var(--ink);
    font: inherit;
  }
  input[type="password"]:focus { outline: 2px solid rgba(15,92,76,0.25); border-color: var(--teal); }

  .hint {
    margin-top: 0.7rem;
    padding: 0.65rem 0.8rem;
    border-radius: 10px;
    background: var(--warn-bg);
    color: var(--warn);
    font-size: 0.82rem;
  }
  .ok-msg { color: var(--ok); font-size: 0.84rem; margin-top: 0.45rem; }
  .err-msg { color: var(--bad); font-size: 0.84rem; margin-top: 0.45rem; }

  .dash { animation: rise 0.75s var(--ease) 0.12s both; }
  .dash[hidden], .link-only[hidden] { display: none !important; }

  @keyframes rise {
    from { opacity: 0; transform: translateY(14px); }
    to { opacity: 1; transform: none; }
  }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 currentColor; }
    70% { box-shadow: 0 0 0 8px transparent; }
    100% { box-shadow: 0 0 0 0 transparent; }
  }
  @keyframes softGlow {
    0%, 100% { box-shadow: 0 0 0 0 rgba(15, 92, 76, 0.12); }
    50% { box-shadow: 0 0 0 10px rgba(15, 92, 76, 0); }
  }
</style>
</head>
<body>
<div class="shell">

  <header class="top">
    <div>
      <h1 class="brand">Veille<span>.</span></h1>
      <p class="tagline">Tableau de bord local — connexion WhatsApp, utilisateurs et sources d’offres.</p>
    </div>
    <div id="status-pill" class="status-pill wait" aria-live="polite">
      <span class="dot" aria-hidden="true"></span>
      <span id="status-text">Vérification…</span>
    </div>
  </header>

  <section class="hero-link link-only" id="zone-appairage">
    <div class="panel qr-stage">
      <div class="qr-frame" id="qr-wrap">
        <div class="qr-placeholder" id="qr-ph">Génération du QR…</div>
        <img id="qr" alt="QR code WhatsApp" hidden>
      </div>
      <p class="meta" id="msg-qr" style="margin-top:0.9rem">Le QR se renouvelle automatiquement toutes les ~20&nbsp;s.</p>
      <div id="code-box" class="code-box" hidden></div>
      <div class="actions">
        <button type="button" class="primary" id="btn-rafraichir">Actualiser le QR</button>
        <button type="button" class="danger" id="btn-reset">Réinitialiser la session</button>
      </div>
      <p class="hint" id="hint-scan">
        Scanne uniquement depuis <strong>WhatsApp → Paramètres → Appareils liés → Lier un appareil</strong>.
        N’utilise pas l’appareil photo du téléphone.
      </p>
    </div>
    <div class="panel">
      <h2>Lier WhatsApp</h2>
      <p class="lead">Sans liaison, le bot ne peut ni recevoir de CV ni envoyer d’offres.</p>
      <ol class="steps">
        <li>
          <span class="n">01</span>
          <div>
            <strong>Ouvre WhatsApp sur ton téléphone</strong>
            <span>Le même numéro que tu veux utiliser comme bot.</span>
          </div>
        </li>
        <li>
          <span class="n">02</span>
          <div>
            <strong>Appareils liés → Lier un appareil</strong>
            <span>Menu Paramètres (Android) ou Réglages (iPhone).</span>
          </div>
        </li>
        <li>
          <span class="n">03</span>
          <div>
            <strong>Scanne le QR ci-contre</strong>
            <span>Reste sur cette page jusqu’au statut « Connecté ».</span>
          </div>
        </li>
      </ol>
    </div>
  </section>

  <div class="dash" id="zone-dashboard">
    <div class="grid">
      <section class="panel span-12" id="carte-stats"></section>
      <section class="panel span-5" id="carte-sources"></section>
      <section class="panel span-7" id="carte-config"></section>
      <section class="panel span-12" id="carte-inscriptions"></section>
      <section class="panel span-12" id="carte-utilisateurs"></section>
    </div>
    <div class="actions" style="margin-top:0.25rem">
      <button type="button" class="danger" id="btn-deconnecter">Déconnecter WhatsApp</button>
    </div>
  </div>

</div>

<script>
function echapper(valeur) {
  return String(valeur).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}

function rafraichirStatut() {
  fetch('/api/statut')
    .then(function (r) { return r.json(); })
    .then(function (s) {
      var pill = document.getElementById('status-pill');
      var texte = document.getElementById('status-text');
      var zoneA = document.getElementById('zone-appairage');
      var zoneD = document.getElementById('zone-dashboard');
      var qr = document.getElementById('qr');
      var ph = document.getElementById('qr-ph');
      var msg = document.getElementById('msg-qr');
      var codeBox = document.getElementById('code-box');

      if (s.pret) {
        pill.className = 'status-pill ok';
        texte.textContent = s.numero ? 'Connecté — +' + s.numero : 'Connecté';
        zoneA.hidden = true;
        zoneD.hidden = false;
        return;
      }

      if (s.liaisonEnCours) {
        pill.className = 'status-pill wait';
        texte.textContent = 'Liaison en cours…';
        zoneA.hidden = false;
        zoneD.hidden = true;
        codeBox.hidden = true;
        qr.hidden = true;
        ph.hidden = false;
        ph.textContent = 'Finalisation…';
        msg.textContent = 'Scan accepté. WhatsApp finalise la liaison — laisse la page ouverte quelques secondes.';
        return;
      }

      pill.className = 'status-pill wait';
      texte.textContent = 'En attente de liaison';
      zoneA.hidden = false;
      zoneD.hidden = true;

      if (s.appairageParCode && s.codeAppairage) {
        codeBox.hidden = false;
        codeBox.textContent = s.codeAppairage;
        qr.hidden = true;
        ph.hidden = true;
        msg.textContent = 'Saisis ce code dans WhatsApp → Lier avec le numéro de téléphone.';
      } else if (s.qrDisponible) {
        codeBox.hidden = true;
        ph.hidden = true;
        qr.hidden = false;
        qr.src = '/qr.png?t=' + Date.now();
        var age = s.qrAgeMs != null ? Math.round(s.qrAgeMs / 1000) : null;
        msg.textContent = age != null
          ? 'QR prêt (généré il y a ' + age + ' s). Il se renouvelle tout seul.'
          : 'QR prêt. Scanne-le maintenant.';
      } else {
        codeBox.hidden = true;
        qr.hidden = true;
        ph.hidden = false;
        ph.textContent = 'Génération du QR…';
        msg.textContent = 'Connexion à WhatsApp en cours, le QR arrive dans quelques secondes.';
      }
    })
    .catch(function () {
      document.getElementById('status-text').textContent = 'Serveur injoignable';
    });
}

function resetSession() {
  if (!confirm('Effacer la session WhatsApp et générer un nouveau QR ?')) return;
  var btn = document.getElementById('btn-reset');
  var btn2 = document.getElementById('btn-deconnecter');
  if (btn) btn.disabled = true;
  if (btn2) btn2.disabled = true;
  fetch('/api/whatsapp/deconnecter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmer: true }),
  }).then(function (r) {
    if (!r.ok) { alert('La réinitialisation a échoué.'); return; }
    setTimeout(rafraichirStatut, 800);
  }).finally(function () {
    if (btn) btn.disabled = false;
    if (btn2) btn2.disabled = false;
  });
}

document.getElementById('btn-rafraichir').addEventListener('click', rafraichirStatut);
document.getElementById('btn-reset').addEventListener('click', resetSession);
document.getElementById('btn-deconnecter').addEventListener('click', resetSession);

var MOIS_COURT = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
var SERIES = [
  { cle: 'offres', libelle: 'Offres envoyées / jour', couleur: 'var(--serie-offres)', nom: 'Offres envoyées' },
  { cle: 'appelsIA', libelle: 'Appels IA / jour', couleur: 'var(--serie-ia)', nom: 'Appels IA' },
];

/** Etat local du panneau : donnees du dernier chargement + vue choisie. */
var etatActivite = { points: [], stats: null, tableau: false };

function jourCourt(iso) {
  var d = new Date(iso + 'T00:00:00Z');
  return d.getUTCDate() + ' ' + MOIS_COURT[d.getUTCMonth()];
}

/**
 * Un mini-graphe par mesure (small multiples). Chaque graphe n'a qu'une serie,
 * donc pas de boite de legende : le titre la nomme, la pastille porte la
 * couleur. Seul le pic est etiquete directement — un nombre sur chacune des
 * 30 colonnes ne se lit pas ; l'axe, le survol et le tableau portent le reste.
 */
function miniGraphe(serie, points) {
  var valeurs = points.map(function (p) { return p[serie.cle]; });
  var pic = Math.max.apply(null, valeurs.concat([0]));
  var iPic = valeurs.indexOf(pic);
  var max = Math.max(1, pic);
  var barres = points.map(function (p, i) {
    var v = p[serie.cle];
    var etiquette = (v > 0 && i === iPic) ? '<span class="sm-val">' + v + '</span>' : '';
    var marque = v > 0
      ? '<i style="height:' + Math.max(Math.round((v / max) * 100), 6) + '%;background:' + serie.couleur + '">' + etiquette + '</i>'
      : '<i class="vide"></i>';
    var titre = jourCourt(p.date) + ' : ' + p.offres + ' offre(s) envoyée(s), ' + p.appelsIA + ' appel(s) IA';
    return '<button type="button" class="sm-bar" data-i="' + i + '" tabindex="' + (i === 0 ? '0' : '-1') +
      '" aria-label="' + echapper(titre) + '">' + marque + '</button>';
  }).join('');
  return '<div class="sm">' +
    '<div class="sm-tete">' +
      '<span class="sm-titre"><span class="sm-cle" style="background:' + serie.couleur + '"></span>' + serie.libelle + '</span>' +
      '<span class="sm-max">max ' + pic + '/j</span>' +
    '</div>' +
    '<div class="sm-plot"><div class="sm-grid"></div>' +
    '<div class="sm-bars">' + barres + '</div></div>' +
  '</div>';
}

/** Axe des dates partage par les deux mini-graphes : debut, milieu, fin. */
function axeActivite(points) {
  if (!points.length) return '';
  return '<div class="sm-axe">' + [0, Math.floor((points.length - 1) / 2), points.length - 1]
    .map(function (i) { return '<span>' + echapper(jourCourt(points[i].date)) + '</span>'; })
    .join('') + '</div>';
}

/** Jumelle lisible du graphe : toutes les valeurs, sans couleur ni survol. */
function tableauActivite(points) {
  var lignes = points.map(function (p) {
    return '<tr><td>' + echapper(jourCourt(p.date)) + '</td>' +
      '<td>' + p.offres + '</td><td>' + p.appelsIA + '</td></tr>';
  }).join('');
  return '<div class="sm-table"><table><thead><tr>' +
    '<th>Jour</th><th>Offres envoyées</th><th>Appels IA</th>' +
    '</tr></thead><tbody>' + lignes + '</tbody></table></div>';
}

function peindreActivite() {
  var stats = etatActivite.stats;
  if (!stats) return;
  var points = etatActivite.points;
  var carte = document.getElementById('carte-stats');
  var col = function (titre, p) {
    return '<div><h3>' + titre + '</h3>' +
      '<p><strong>' + p.offresEnvoyees + '</strong> offre(s) envoyée(s)</p>' +
      '<p><strong>' + p.appelsIA + '</strong> appel(s) IA</p>' +
      '<p><strong>' + p.coutEstimeUSD.toFixed(3) + ' $</strong> estimé</p></div>';
  };
  var vide = points.every(function (p) { return p.offres === 0 && p.appelsIA === 0; });

  carte.innerHTML =
    '<div class="sm-entete"><div>' +
      '<h2>Activité — 30 derniers jours</h2>' +
      '<p class="metric">' + stats.nombreUtilisateurs + '</p>' +
      '<p class="meta">utilisateur(s) · ' + stats.offresEnvoyeesTotal + ' offre(s) envoyée(s) au total' +
      (vide ? ' · aucune activité sur la période' : '') + '</p>' +
    '</div>' +
    '<button type="button" class="sm-bascule" id="btn-vue-activite" aria-pressed="' + etatActivite.tableau + '">' +
      (etatActivite.tableau ? 'Voir le graphe' : 'Voir le tableau') +
    '</button></div>' +
    (etatActivite.tableau
      ? tableauActivite(points)
      : SERIES.map(function (s) { return miniGraphe(s, points); }).join('') + axeActivite(points)) +
    '<div class="split">' + col('Cette semaine', stats.semaine) + col('Ce mois-ci', stats.mois) + '</div>' +
    '<div class="sm-tip" id="tip-activite" role="status" aria-live="polite" hidden></div>';

  document.getElementById('btn-vue-activite').addEventListener('click', function () {
    etatActivite.tableau = !etatActivite.tableau;
    peindreActivite();
    document.getElementById('btn-vue-activite').focus();
  });
  if (!etatActivite.tableau) brancherGraphe(carte);
}

function cacherTipActivite() {
  var tip = document.getElementById('tip-activite');
  if (tip) tip.hidden = true;
}

/**
 * Infobulle : la valeur d'abord, le nom de la serie ensuite (le lecteur sait
 * deja quelle serie il vise, il veut le nombre). Les DEUX mesures y figurent,
 * quel que soit le mini-graphe survole. Insertion par textContent.
 */
function montrerTipActivite(bouton) {
  var p = etatActivite.points[Number(bouton.dataset.i)];
  var tip = document.getElementById('tip-activite');
  if (!p || !tip) return;
  tip.textContent = '';
  var entete = document.createElement('div');
  entete.className = 'tip-date';
  entete.textContent = jourCourt(p.date);
  tip.appendChild(entete);
  SERIES.forEach(function (s) {
    var ligne = document.createElement('div');
    ligne.className = 'tip-ligne';
    var cle = document.createElement('span');
    cle.className = 'tip-cle ' + (s.cle === 'offres' ? 'offres' : 'ia');
    var valeur = document.createElement('strong');
    valeur.textContent = String(p[s.cle]);
    var nom = document.createElement('span');
    nom.className = 'tip-nom';
    nom.textContent = s.nom;
    ligne.appendChild(cle);
    ligne.appendChild(valeur);
    ligne.appendChild(nom);
    tip.appendChild(ligne);
  });
  tip.hidden = false;

  var boite = bouton.getBoundingClientRect();
  var cadre = tip.offsetParent.getBoundingClientRect();
  var x = boite.left - cadre.left + boite.width / 2;
  var demi = tip.offsetWidth / 2;
  tip.style.left = Math.min(Math.max(x, demi + 4), cadre.width - demi - 4) + 'px';
  tip.style.top = boite.top - cadre.top - 8 + 'px';
}

function brancherGraphe(carte) {
  carte.querySelectorAll('.sm-bars').forEach(function (zone) {
    var barres = Array.prototype.slice.call(zone.querySelectorAll('.sm-bar'));

    zone.addEventListener('pointermove', function (ev) {
      var b = ev.target.closest('.sm-bar');
      if (b) montrerTipActivite(b);
    });
    zone.addEventListener('pointerleave', cacherTipActivite);
    zone.addEventListener('focusout', cacherTipActivite);
    zone.addEventListener('focusin', function (ev) {
      var b = ev.target.closest('.sm-bar');
      if (b) montrerTipActivite(b);
    });

    // Tabindex glissant : un seul arret de tabulation par graphe, les fleches
    // parcourent les jours (30 arrets consecutifs seraient impraticables).
    zone.addEventListener('keydown', function (ev) {
      var b = ev.target.closest('.sm-bar');
      if (!b) return;
      if (ev.key === 'Escape') { cacherTipActivite(); b.blur(); return; }
      var i = barres.indexOf(b);
      var cible = null;
      if (ev.key === 'ArrowRight') cible = barres[Math.min(i + 1, barres.length - 1)];
      else if (ev.key === 'ArrowLeft') cible = barres[Math.max(i - 1, 0)];
      else if (ev.key === 'Home') cible = barres[0];
      else if (ev.key === 'End') cible = barres[barres.length - 1];
      if (!cible) return;
      ev.preventDefault();
      barres.forEach(function (x) { x.tabIndex = -1; });
      cible.tabIndex = 0;
      cible.focus();
    });
  });
}

function rendreStats(stats, activite) {
  etatActivite.stats = stats;
  if (activite) etatActivite.points = activite;
  // Le tableau de bord se rafraichit toutes les 30 s : ne pas repeindre le
  // panneau pendant que l'operateur y navigue, sinon le focus clavier saute.
  var carte = document.getElementById('carte-stats');
  if (carte.contains(document.activeElement)) return;
  peindreActivite();
}

function rendreSources(sources) {
  var actives = sources.filter(function (s) { return s.actif; }).length;
  var enEchec = sources.filter(function (s) { return s.dernierCycle && !s.dernierCycle.ok; }).length;
  var liste = sources.map(function (s) {
    var etat = 'off';
    var detail = '';
    if (s.actif) {
      if (s.dernierCycle) {
        etat = s.dernierCycle.ok ? 'ok' : 'bad';
        detail = s.dernierCycle.ok ? ' — ' + s.dernierCycle.nombre + ' offre(s)' : ' — en échec';
      } else {
        etat = 'ok';
      }
    }
    return '<li><span class="pip ' + etat + '"></span>' + echapper(s.nom) + detail + '</li>';
  }).join('');
  document.getElementById('carte-sources').innerHTML =
    '<h2>Sources</h2>' +
    '<p class="metric">' + actives + '</p>' +
    '<p class="meta">active(s)' + (enEchec ? ' · ' + enEchec + ' en échec' : '') + '</p>' +
    '<ul class="sources">' + liste + '</ul>';
}

function rendreParametres(data) {
  var carte = document.getElementById('carte-config');
  var source = data.deepseekSource === 'dashboard' ? 'enregistrée ici' : 'fichier .env';
  carte.innerHTML =
    '<h2>Clé DeepSeek</h2>' +
    '<p class="meta">Actuelle : <strong>' + echapper(data.deepseekApercu) + '</strong> (' + source + ')</p>' +
    '<p class="meta">Colle une nouvelle clé pour remplacer, ou supprime celle du dashboard pour revenir au .env.</p>' +
    '<form id="form-cle">' +
    '<input type="password" id="inp-cle" placeholder="Colle ta clé sk-…" autocomplete="off" spellcheck="false">' +
    '<button type="submit" class="primary">Enregistrer</button>' +
    (data.deepseekConfigureDepuisDashboard
      ? '<button type="button" class="danger" id="btn-suppr-cle">Supprimer</button>'
      : '') +
    '</form>' +
    '<p id="msg-cle" class="meta"></p>';

  document.getElementById('form-cle').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var valeur = document.getElementById('inp-cle').value.trim();
    var msg = document.getElementById('msg-cle');
    if (!valeur) { msg.className = 'err-msg'; msg.textContent = 'Colle d’abord une clé.'; return; }
    fetch('/api/parametres', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deepseekApiKey: valeur }),
    })
      .then(function (r) { return r.json().then(function (corps) { return { ok: r.ok, corps: corps }; }); })
      .then(function (res) {
        if (!res.ok) { msg.className = 'err-msg'; msg.textContent = res.corps.erreur || 'Erreur.'; return; }
        msg.className = 'ok-msg';
        msg.textContent = 'Nouvelle clé enregistrée.';
        rendreParametres(res.corps);
      });
  });

  var btnSuppr = document.getElementById('btn-suppr-cle');
  if (btnSuppr) {
    btnSuppr.addEventListener('click', function () {
      if (!confirm('Supprimer la clé enregistrée ici ? Le bot reprendra celle du fichier .env.')) return;
      fetch('/api/parametres', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supprimerCle: true }),
      })
        .then(function (r) { return r.json().then(function (corps) { return { ok: r.ok, corps: corps }; }); })
        .then(function (res) {
          var msg = document.getElementById('msg-cle');
          if (!res.ok) { msg.className = 'err-msg'; msg.textContent = 'Suppression impossible.'; return; }
          msg.className = 'ok-msg';
          msg.textContent = 'Clé du dashboard supprimée.';
          rendreParametres(res.corps);
        });
    });
  }
}

function rendreInscriptions(points) {
  var max = Math.max(1, ...points.map(function (p) { return p.nombre; }));
  var barres = points.map(function (p) {
    var h = p.nombre > 0 ? Math.max(Math.round((p.nombre / max) * 100), 6) : 0;
    return '<i class="' + (p.nombre > 0 ? 'on' : '') + '" style="height:' + h + '%" title="' +
      echapper(jourCourt(p.date)) + ' : ' + p.nombre + ' nouveau(x) profil(s)"></i>';
  }).join('');
  var total = points.reduce(function (s, p) { return s + p.nombre; }, 0);
  document.getElementById('carte-inscriptions').innerHTML =
    '<h2>Inscriptions — 30 jours</h2>' +
    '<p class="meta">' + total + ' nouveau(x) profil(s)</p>' +
    '<div class="chart">' + barres + '</div>' + axeActivite(points);
}

function rendreUtilisateurs(utilisateurs) {
  var carte = document.getElementById('carte-utilisateurs');
  if (!utilisateurs.length) {
    carte.innerHTML = '<h2>Utilisateurs</h2><p class="meta">Aucun utilisateur pour le moment.</p>';
    return;
  }
  var lignes = utilisateurs.map(function (u) {
    return '<tr>' +
      '<td>' + echapper(u.numero) + '</td>' +
      '<td><span class="badge-mini' + (u.aProfil ? '' : ' off') + '">' + (u.aProfil ? 'Profil' : 'Sans') + '</span></td>' +
      '<td>' + (u.frequenceLibelle ? echapper(u.frequenceLibelle) : '—') + '</td>' +
      '<td>' + u.offresEnvoyees + '</td>' +
      '<td>' + u.actionsIA + '</td>' +
      '<td>' + (u.derniereActiviteTexte ? echapper(u.derniereActiviteTexte) : '—') + '</td>' +
      '</tr>';
  }).join('');
  carte.innerHTML =
    '<h2>Utilisateurs (' + utilisateurs.length + ')</h2>' +
    '<div style="overflow-x:auto"><table><thead><tr>' +
    '<th>Numéro</th><th>Profil</th><th>Fréquence</th><th>Offres</th><th>IA</th><th>Dernière activité</th>' +
    '</tr></thead><tbody>' + lignes + '</tbody></table></div>';
}

async function chargerTableauDeBord() {
  try {
    var resultats = await Promise.all([
      fetch('/api/utilisateurs').then(function (r) { return r.json(); }),
      fetch('/api/stats').then(function (r) { return r.json(); }),
      fetch('/api/sources').then(function (r) { return r.json(); }),
      fetch('/api/parametres').then(function (r) { return r.json(); }),
    ]);
    rendreUtilisateurs(resultats[0].utilisateurs);
    rendreInscriptions(resultats[0].inscriptions);
    rendreStats(resultats[1].stats, resultats[1].activite);
    rendreSources(resultats[2].sources);
    rendreParametres(resultats[3]);
  } catch (e) { /* rechargement suivant */ }
}

rafraichirStatut();
setInterval(rafraichirStatut, 2500);
chargerTableauDeBord();
setInterval(chargerTableauDeBord, 30000);
</script>
</body>
</html>`;
