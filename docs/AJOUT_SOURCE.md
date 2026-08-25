# Ajouter une source d'offres

Le systeme est concu pour qu'une nouvelle source se resume a **un fichier a
creer** et **une ligne a ajouter**. Aucun autre module n'a besoin d'etre
modifie : ni le prefiltre, ni le scoring, ni le formatage, ni la base.

---

## 1. Le contrat

Defini dans [`src/sources/types.ts`](../src/sources/types.ts) :

```ts
interface Offre {
  id_source: string;        // identifiant natif chez la source
  source: string;           // nom court de la source
  titre: string;
  entreprise: string | null;
  lieu: string | null;
  pays: string | null;
  description: string;      // texte brut, tronque a 2000 caracteres
  url: string;
  date_publication: string; // ISO 8601
  teletravail: boolean | null;
  contrat: string | null;
}

interface Source {
  nom: string;
  actif: boolean;
  chercher(profil: Profil): Promise<Offre[]>;
}
```

Le champ `url` est structurant : c'est lui qui sert de cle de deduplication
(SHA-256 de l'URL normalisee). Une source qui renvoie des URL instables
(parametres de session, identifiants de tracking) produira des doublons —
completer alors `normaliserUrl()` dans `src/db/repository.ts`.

## 2. Les regles a respecter

| Regle | Pourquoi |
|---|---|
| Ne jamais laisser une exception remonter au-dela du connecteur… | …ou plutot : la laisser remonter telle quelle. Le registre la capture deja (`collecter()` dans `sources/index.ts`) et neutralise la source pour ce cycle sans casser les autres. |
| Timeout de 20 s par requete | utiliser `requeteJSON()`, qui l'applique |
| User-Agent explicite | fourni par `requeteJSON()` |
| Une seule passe par cycle | pas de pagination profonde : 50 resultats suffisent |
| 2 s entre deux requetes vers la meme source | voir `adzuna.ts` |
| Source scrapee (hors API) | respecter `robots.txt`, une passe par jour maximum |
| `actif: false` si une cle manque | le cycle continue avec les autres sources |
| Description tronquee | utiliser `texteBrut()` : nettoie le HTML et coupe a 2000 caracteres |

## 3. Squelette de connecteur

`src/sources/jooble.ts` :

```ts
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { Profil } from '../cv/analyse.js';
import {
  dateISO,
  detecteTeletravail,
  requeteJSON,
  texteBrut,
  type Offre,
  type Source,
} from './types.js';

const NOM = 'jooble';
const ENDPOINT = 'https://jooble.org/api';

interface ReponseJooble {
  jobs?: {
    id?: number;
    title?: string;
    company?: string;
    location?: string;
    snippet?: string;
    link?: string;
    updated?: string;
    type?: string;
  }[];
}

async function chercher(profil: Profil): Promise<Offre[]> {
  const reponse = await requeteJSON<ReponseJooble>(
    NOM,
    `${ENDPOINT}/${config.JOOBLE_CLE}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keywords: profil.mots_cles_recherche.slice(0, 5).join(' '),
        location: 'Burkina Faso',
      }),
    },
  );

  const jobs = reponse.jobs ?? [];
  logger.info('Source interrogee', { source: NOM, brut: jobs.length });

  return jobs
    .filter((j) => j.link)
    .map((j): Offre => {
      const description = texteBrut(j.snippet);
      return {
        id_source: String(j.id ?? j.link),
        source: NOM,
        titre: j.title?.trim() || 'Offre sans titre',
        entreprise: j.company ?? null,
        lieu: j.location ?? null,
        pays: null,
        description,
        url: j.link as string,
        date_publication: dateISO(j.updated),
        teletravail: detecteTeletravail(j.title, description, j.location),
        contrat: j.type ?? null,
      };
    });
}

export const jooble: Source = {
  nom: NOM,
  actif: Boolean(config.JOOBLE_CLE),
  chercher,
};
```

## 3bis. Squelette d'une source scrapee (cadence quotidienne)

Sans API, deux contraintes s'ajoutent au squelette ci-dessus : parser du HTML
(pas de `requeteJSON()`, utiliser `requeteHTML()` puis un parseur comme
`cheerio`), et respecter le maximum d'une passe par jour de la regle §2 — ce
qui ne va pas de soi, puisque `collecter()` appelle `chercher()` a **chaque**
cycle. La solution retenue (voir `src/sources/africarrieres.ts`) : la source
se gate elle-meme, via la table `parametres` deja exposee par
`lireParametre`/`ecrireParametre` (`src/db/repository.ts`) — aucune migration,
aucun changement ailleurs dans le pipeline.

```ts
import * as cheerio from 'cheerio';
import { ecrireParametre, lireParametre } from '../db/repository.js';
import type { Profil } from '../cv/analyse.js';
import { requeteHTML, texteBrut, type Offre, type Source } from './types.js';

const NOM = 'exemple-scrape';
const DELAI_ENTRE_SCRAPES_MS = 24 * 3600 * 1000;

/** Pose l'horodatage AVANT la requete : au plus une tentative par jour,
 *  meme si le scrape echoue ensuite (evite de marteler un site en panne). */
function autoriseAScraperAujourdhui(): boolean {
  const cle = `dernier_scrape_${NOM}`;
  const dernier = lireParametre(cle);
  if (dernier && Date.now() - new Date(dernier).getTime() < DELAI_ENTRE_SCRAPES_MS) {
    return false;
  }
  ecrireParametre(cle, new Date().toISOString());
  return true;
}

async function chercher(profil: Profil): Promise<Offre[]> {
  if (!autoriseAScraperAujourdhui()) return []; // deja scrape aujourd'hui

  const html = await requeteHTML(NOM, 'https://exemple.com/emplois');
  const $ = cheerio.load(html);
  const offres: Offre[] = [];

  $('.carte-offre').each((_i, el) => {
    const $el = $(el);
    const href = $el.find('a').attr('href');
    const titre = $el.find('h3').text().trim();
    if (!href || !titre) return; // carte incomplete, on l'ignore plutot que deviner

    offres.push({
      id_source: href,
      source: NOM,
      titre,
      entreprise: $el.find('.entreprise').text().trim() || null,
      lieu: $el.find('.lieu').text().trim() || null,
      pays: profil.pays,
      description: texteBrut(''), // souvent absent du listing ; eviter une requete par offre
      url: href,
      date_publication: new Date().toISOString(), // parser la vraie date du site, voir note ci-dessous
      teletravail: null,
      contrat: null,
    });
  });

  return offres;
}

export const exempleScrape: Source = { nom: NOM, actif: true, chercher };
```

**A ne jamais sauter** : parser la vraie date de publication par offre, pas
juste `new Date()` (la date du scrape). Un site local affiche souvent des
dates relatives en francais (« il y a 2 jours ») ou un format local — chaque
site a sa propre syntaxe, donc son propre petit parseur (voir
`dateRelativeVersISO()` dans `africarrieres.ts` pour un exemple, specifique a
son format anglais `"X hours ago"`). Sans ca, `MAX_ANCIENNETE_JOURS` ne peut
pas filtrer correctement, et le prefiltre traite tout comme "publie a
l'instant".

Avant d'ecrire le moindre code : verifier `robots.txt` (chemins de
listing/recherche autorises), les mentions legales/CGU (clause anti-scraping
= disqualifiant), et que la page est rendue cote serveur (vue source HTML
brute, pas le DOM rendu — une SPA en JS pur n'est pas exploitable sans
navigateur headless, hors scope). Si un site echoue a l'une de ces
verifications, ne pas livrer de connecteur pour lui plutot que forcer un
scraper fragile ou limite legalement.

## 4. Enregistrer la source

Dans [`src/sources/index.ts`](../src/sources/index.ts) :

```ts
import { jooble } from './jooble.js';

export const SOURCES: Source[] = [reliefweb, adzuna, jooble];
```

## 5. Si la source demande une cle

1. Ajouter la variable dans `.env.example`, avec un commentaire.
2. La declarer dans le schema Zod de `src/config.ts` :

```ts
JOOBLE_CLE: z.string().optional().default(''),
```

3. Refleter l'absence de cle dans `actif`.

La commande `!sources` affichera automatiquement la nouvelle source et son etat.

## 6. Verifier

```bash
npm run typecheck
npm start
```

Puis, depuis WhatsApp, `!veille` et `!sources`. Cote journaux, chaque source
produit une ligne `Source interrogee` avec le nombre d'offres brutes ; le
recapitulatif du cycle (`Cycle de veille termine`) detaille ensuite les rejets
du prefiltre et le nombre d'offres envoyees.

Une source qui renvoie systematiquement 0 offre est presque toujours un
probleme de requete (mots-cles trop specifiques) ou de filtre de date : baisser
temporairement `MAX_ANCIENNETE_JOURS` ou journaliser la requete construite pour
le verifier.
