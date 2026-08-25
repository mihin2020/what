# whatsapp-veille

Assistant de veille emploi pilote depuis WhatsApp : il analyse un CV envoye en
piece jointe, interroge plusieurs sources d'offres, evalue leur adequation au
profil et envoie un digest a la frequence choisie par l'utilisateur.

- Processus unique Node.js, sans serveur HTTP entrant.
- Persistance SQLite locale, sans ORM.
- Analyse et scoring via l'API DeepSeek (SDK compatible `openai`).
- Multi-utilisateur (section 6.9) : n'importe qui ecrivant au numero du bot
  obtient son propre profil, sa propre planification et son propre historique
  d'offres — ouvert a tous, sans liste blanche ni quota (voir § 10, risques
  de cout assumes). Le bot n'ecrit jamais a un tiers autre que l'expediteur
  d'un message.

---

## 1. Prerequis

| Element | Version |
|---|---|
| Node.js | 22 LTS ou superieur |
| npm | 10+ |

Le module `node:sqlite` est encore derriere un drapeau sur Node 22 : tous les
scripts npm et la configuration pm2 passent deja `--experimental-sqlite`.
Si votre environnement ne le supporte pas, installez le repli :

```bash
npm install better-sqlite3
```

## 2. Installation

```bash
npm install
cp .env.example .env      # puis renseigner les valeurs
```

Variables indispensables au demarrage :

| Variable | Role |
|---|---|
| `NUMERO_AUTORISE` | numero WhatsApp du proprietaire (celui appaire au bot), au format `226XXXXXXXX@c.us` — pas une restriction d'acces : voir § "Multi-utilisateur" |
| `DEEPSEEK_API_KEY` | cle de l'API DeepSeek |

Sources d'offres — etat verifie le 15 aout 2026 :

| Source | Ce qu'il faut | Sans cela |
|---|---|---|
| ReliefWeb | un `appname` **approuve** par ReliefWeb (gratuit, sur demande : <https://apidoc.reliefweb.int/parameters#appname>) | HTTP 403 a chaque requete |
| Adzuna | `ADZUNA_APP_ID` + `ADZUNA_APP_KEY` (gratuites : <https://developer.adzuna.com/>) | source declaree inactive |

> L'API ReliefWeb v1 a ete decommissionnee (HTTP 410) : le connecteur utilise la
> v2, qui refuse tout `appname` non approuve. Tant que l'approbation n'est pas
> obtenue, la source echoue proprement et le cycle continue avec les autres.
> Si aucune source n'est utilisable, chaque echeance produit un message d'alerte
> technique — jamais un silence.

Le processus refuse de demarrer si la configuration est invalide, en indiquant
precisement quelle variable corriger.

## 3. Lancement

```bash
npm run dev     # developpement, rechargement a chaud
npm start       # execution simple via tsx
```

Verification hors ligne (aucun appel a WhatsApp ni a DeepSeek) :

```bash
npm run typecheck
npm run verifier
```

`npm run verifier` ([tools/verification.ts](tools/verification.ts)) rejoue 51
controles : deduplication, prefiltre, destruction des taches cron a chaque
reconfiguration, restitution du reglage, parcours conversationnel complet
(frequence, jour, heure, saisie invalide, valeur de repli), anonymisation,
rejets d'extraction, journal des tokens et rendu des trois familles de messages.
Il ecrit dans `data/veille.sqlite` : a lancer sur une base de test.

Au premier lancement, un QR code s'affiche dans le terminal.
Sur le telephone : **WhatsApp > Parametres > Appareils lies > Lier un appareil**.

La session est ensuite conservee dans `data/session/` : les redemarrages
suivants ne redemandent pas de QR code.

## 4. Utilisation

1. Envoyer son CV au bot (PDF ou DOCX, 5 Mo maximum).
2. Le bot confirme le profil extrait, puis propose de choisir une frequence.
3. Repondre par un chiffre (1 a 4), puis donner une heure (`07:30`).
4. La veille est active ; le bot confirme le reglage et la prochaine echeance.

### Commandes

| Commande | Effet |
|---|---|
| *(piece jointe)* | analyse du CV et enregistrement du profil |
| `!aide` | liste des commandes |
| `!profil` | affiche le profil enregistre |
| `!veille` | declenche immediatement un cycle de veille |
| `!frequence` | reconfigure la frequence et l'heure des envois |
| `!planning` | reglage actuel et prochaine echeance |
| `!pause` / `!reprendre` | suspend / reactive les envois automatiques |
| `!lieu <zones>` | zones geographiques acceptees (`!lieu tout` pour ne plus filtrer) |
| `!sources` | sources disponibles et etat du dernier cycle |
| `!stats` | offres traitees, envoyees, tokens et cout IA du mois |

Toute commande inconnue renvoie vers `!aide`. Toute commande recoit une reponse,
y compris en cas d'erreur.

### Ce qui arrive a chaque echeance

Le bot envoie **toujours** un message, meme sans resultat :

| Situation | Message |
|---|---|
| Offres examinees | en-tete + un message par offre, avec son score — aucun filtrage par seuil : c'est a l'utilisateur de juger |
| Aucune offre collectee | « aucune offre pertinente », avec mention explicite |
| Scoring IA en echec sur tout ce qui a ete examine | « aucune offre pertinente », avec le nombre d'annonces examinees |
| Toutes les sources en echec | alerte technique, visuellement distincte (⚠️) |

## 5. Architecture

```
src/
  index.ts          point d'entree, cablage, filets de securite
  config.ts         chargement et validation de l'environnement
  logger.ts         journalisation console + fichier rotatif
  whatsapp.ts       client WhatsApp, filtre expediteur, envoi temporise
  commandes.ts      routage des commandes et parcours conversationnel
  planification.ts  frequence, expressions cron, taches dynamiques
  veille.ts         orchestration d'un cycle complet
  formatage.ts      mise en forme des messages
  cv/               extraction, anonymisation, analyse du CV
  ia/               wrapper DeepSeek (retry, backoff, JSON) et prompts
  sources/          contrat Source + connecteurs (ReliefWeb, Adzuna, Himalayas,
                    Jobicy, Arbeitnow, africarrieres.com)
  matching/         prefiltre heuristique puis scoring IA par lots
  db/               schema SQLite et acces aux donnees
```

Deux etages de matching pour contenir le cout :

1. **Prefiltre heuristique** (sans IA) : doublons, anciennete, correspondance de
   mots-cles sur le titre, zone geographique.
2. **Scoring IA** : lots de 25 offres, un appel par lot, 100 offres scorees au
   maximum par cycle. Pas de filtrage par seuil : toutes les offres scorees sont
   envoyees (triees par score, limitees a `MAX_OFFRES_DIGEST`) — l'utilisateur
   juge lui-meme avec le score affiche sur chaque offre.

## 6. Donnees et vie privee

- Le texte du CV est **anonymise avant tout envoi** a DeepSeek : email,
  telephone, URL de profils, adresse postale, date de naissance sont retires.
  Les competences, experiences et formations sont conservees.
- Aucune donnee personnelle du CV n'est ecrite dans les journaux.
- `data/session/` contient une session WhatsApp active : ne jamais la versionner
  ni la copier hors du serveur (`chmod 700`).
- `.env`, `data/` et `logs/` sont exclus du depot.

## 7. Base de donnees

Fichier unique `data/veille.sqlite`, tables : `profil`, `offres`, `parametres`,
`etat_conversation`, `journal_ia`.

**Regle importante** : une valeur presente dans `parametres` prime toujours sur
la variable d'environnement correspondante. Les variables d'environnement ne
servent qu'a amorcer la base au premier lancement. `frequence` et `heure` ne
sont jamais amorcees : elles resultent d'un choix explicite de l'utilisateur.

Les offres de plus de 90 jours sont purgees automatiquement chaque dimanche a 03:00.

Inspecter la base :

```bash
sqlite3 data/veille.sqlite "SELECT cle, valeur FROM parametres;"
```

## 8. Deploiement

Voir [DEPLOIEMENT.md](DEPLOIEMENT.md) pour la procedure VPS complete (Ubuntu
22.04, pm2, demarrage au boot).

## 9. Ajouter une source d'offres

Voir [docs/AJOUT_SOURCE.md](docs/AJOUT_SOURCE.md). Un fichier a creer, une ligne
a ajouter dans `src/sources/index.ts`, rien d'autre.

## 10. Points d'attention

- **Conformite** : `@whiskeysockets/baileys` est une bibliotheque non
  officielle, et l'automatisation d'un compte WhatsApp personnel est contraire
  aux conditions d'utilisation de la plateforme.
- **Acces ouvert, sans quota (choix assume)** : n'importe qui connaissant le
  numero du bot peut l'utiliser pleinement — profil, analyse de CV, recherche
  d'offres — sans liste blanche ni limite. Chaque analyse de CV et chaque
  cycle de recherche declenchent des appels DeepSeek factures sur la cle API
  du proprietaire : un usage massif ou malveillant par des tiers n'est pas
  plafonne. Le bot n'ecrit en revanche jamais qu'a l'expediteur d'un message
  (jamais a un tiers non sollicite).
- **Modeles DeepSeek** : `deepseek-chat` et `deepseek-reasoner` ont ete retires
  le 24 juillet 2026. Utiliser `deepseek-v4-flash` (defaut) ou `deepseek-v4-pro`.
  Une tarification heures pleines / heures creuses est en vigueur depuis le
  16 aout 2026 : verifier la grille officielle et ajuster
  `PRIX_ENTREE_USD_PAR_M` / `PRIX_SORTIE_USD_PAR_M`, qui ne servent qu'a
  l'estimation affichee par `!stats`.
- **Endpoints des sources** : ReliefWeb, Adzuna, Himalayas, Jobicy et Arbeitnow
  font evoluer leurs API. Verifier la documentation officielle avant de
  modifier un connecteur.
- **Source scrapee (africarrieres.com)** : contrairement aux sources API, une
  derive de structure HTML (redesign du site) casse silencieusement
  l'extraction sans que la source ne remonte d'erreur HTTP. A surveiller
  separement (ex. `!sources`, ou un `brut: 0` inhabituel dans les journaux).
- **Version de @whiskeysockets/baileys** : la verrouiller en production et
  tester toute montee de version, une evolution du protocole WhatsApp pouvant
  necessiter une mise a jour de la bibliotheque.
