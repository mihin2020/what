# Deploiement sur VPS — whatsapp-veille

Procedure complete, de la machine nue au service actif, sur **Ubuntu 22.04 LTS**
(2 vCPU / 2 Go de RAM minimum : Hetzner CX22, Contabo VPS S ou equivalent).

Duree indicative : 30 minutes.

---

## 1. Preparer le serveur

Connexion en root, puis creation d'un utilisateur dedie (ne jamais faire tourner
le bot en root : la surface d'attaque est inutilement large en cas de
compromission).

```bash
adduser veille
usermod -aG sudo veille
su - veille
```

Mise a jour et outils de base :

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git ca-certificates sqlite3
```

## 2. Installer Node.js 22 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v      # doit afficher v22.x
```

## 3. Installer le projet

Le client WhatsApp (`@whiskeysockets/baileys`) parle le protocole directement :
aucun navigateur, aucune dependance systeme supplementaire a installer.

```bash
cd ~
git clone <URL_DU_DEPOT> whatsapp-veille
cd whatsapp-veille
npm install --omit=dev --no-audit --no-fund
npm install tsx typescript          # requis a l'execution (pas de build)
```

## 4. Configurer

```bash
cp .env.example .env
nano .env
```

A renseigner imperativement :

```
NUMERO_AUTORISE=226XXXXXXXX@c.us
DEEPSEEK_API_KEY=sk-...
```

Acces aux sources d'offres (a demander en amont, les deux sont gratuits) :

- **ReliefWeb** : l'API v2 refuse tout `appname` non approuve (HTTP 403).
  Demander l'approbation sur <https://apidoc.reliefweb.int/parameters#appname>,
  puis renseigner `RELIEFWEB_APPNAME`.
- **Adzuna** : creer une application sur <https://developer.adzuna.com/> et
  renseigner `ADZUNA_APP_ID` / `ADZUNA_APP_KEY`.

Sans aucune source utilisable, le service demarre normalement mais chaque
echeance produit un message d'alerte technique.

Puis proteger les secrets et les volumes :

```bash
chmod 600 .env
mkdir -p data/session logs
chmod 700 data data/session
```

> `data/session/` contient une session WhatsApp active : quiconque la copie
> obtient l'acces au compte. Elle ne doit jamais etre versionnee, sauvegardee
> sur un stockage tiers, ni sortir du serveur.

## 5. Premier lancement et appairage

L'appairage doit se faire depuis un terminal interactif, avant de passer la
main a pm2 :

```bash
npm start
```

Sur le telephone : **WhatsApp > Parametres > Appareils lies > Lier un appareil**.
Par defaut, un QR code s'affiche a scanner (egalement ecrit en image dans
`data/qr.png` si le terminal est trop etroit pour l'afficher lisiblement).
Avec `APPAIRAGE_PAR_CODE=true` dans `.env`, un code a 8 caracteres s'affiche a
la place : le saisir via *Lier avec le numero de telephone*. Attendre la ligne
`Client WhatsApp pret`, verifier la reception du message d'accueil, puis
arreter avec `Ctrl+C`.

La session est desormais dans `data/session/` : plus aucun scan ne sera demande.

## 6. Superviser avec pm2

```bash
sudo npm install -g pm2
pm2 start ecosystem.config.js
pm2 logs whatsapp-veille        # verifier le demarrage
```

Demarrage automatique au boot :

```bash
pm2 startup systemd          # executer la commande affichee (avec sudo)
pm2 save
```

Commandes utiles :

```bash
pm2 status
pm2 restart whatsapp-veille
pm2 stop whatsapp-veille
pm2 logs whatsapp-veille --lines 100
pm2 monit
```

La configuration fournie redemarre le processus automatiquement en cas de crash
et au-dela de 1 Go de memoire, avec des journaux separes dans `logs/`.

## 7. Verifications de recette

| Verification | Commande / geste | Attendu |
|---|---|---|
| Service actif | `pm2 status` | statut `online` |
| Redemarrage apres crash | `pm2 list` puis `kill -9 <pid>` | pm2 relance sans scan de QR |
| Redemarrage au boot | `sudo reboot` | service `online` au retour |
| Planification restauree | `pm2 logs` apres reboot | ligne `Planification restauree` |
| Commandes | envoyer `!aide`, `!planning`, `!veille` | reponse a chaque fois |
| Filtre expediteur | ecrire depuis un autre numero | aucune reponse |
| Memoire | `pm2 monit` | moins de 200 Mo |

## 8. Sauvegarde

A sauvegarder : `data/veille.sqlite` et `.env`.
A **ne pas** sauvegarder hors du serveur : `data/session/`.

```bash
sqlite3 data/veille.sqlite ".backup '/home/veille/sauvegardes/veille-$(date +%F).sqlite'"
```

Exemple de sauvegarde quotidienne (crontab de l'utilisateur `veille`) :

```
15 2 * * * mkdir -p ~/sauvegardes && sqlite3 ~/whatsapp-veille/data/veille.sqlite ".backup '/home/veille/sauvegardes/veille-$(date +\%F).sqlite'" && find ~/sauvegardes -name 'veille-*.sqlite' -mtime +30 -delete
```

## 9. Mise a jour

```bash
cd ~/whatsapp-veille
pm2 stop whatsapp-veille
git pull
npm install --omit=dev --no-audit --no-fund
pm2 restart whatsapp-veille
pm2 logs whatsapp-veille
```

> Verrouiller la version de `@whiskeysockets/baileys` en production. Une
> evolution du protocole WhatsApp peut necessiter une mise a jour de la
> bibliotheque : tester toute montee de version avant de la deployer.

## 10. Depannage

| Symptome | Cause probable | Correctif |
|---|---|---|
| QR code / code d'appairage redemande a chaque demarrage | `data/session/` non persistant ou mal permissionne | verifier `chmod 700 data/session` et le `cwd` de pm2 |
| `Cannot find module 'node:sqlite'` | drapeau absent | verifier `node_args: '--experimental-sqlite'` dans `ecosystem.config.js`, ou installer `better-sqlite3` |
| Aucun digest a l'heure prevue | veille en pause, ou aucune frequence choisie | envoyer `!planning`, puis `!reprendre` ou `!frequence` |
| Message d'alerte technique quotidien | sources injoignables (reseau, quota, API modifiee) | `pm2 logs`, puis `!sources` |
| `logged out` dans les journaux | appareil delie cote WhatsApp (session revoquee) | supprimer `data/session/` puis relancer pour reappairer |
| Rien ne se passe a l'envoi d'un message | message envoye dans un groupe, une newsletter, ou vers un statut (non pris en charge) | verifier qu'il s'agit bien d'un chat individuel (1:1) avec le numero du bot |
