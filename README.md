# RoverOS : télécommande web

Application web pour piloter un rover à roues Mecanum depuis un téléphone (ou un ordinateur) :
manettes tactiles, carte en direct du sonar, comportements autonomes, tableau de bord, réglages.
C'est un site **statique** : aucun outil de compilation, aucune dépendance chargée depuis internet
(la police Geist est dans le dossier, sous licence OFL).

## L'ouvrir

- En ligne : ouvrez l'adresse de la page dans **Chrome sur Android**. Le bouton « Partage » affiche un QR code pour la passer à quelqu'un d'autre.
- Installable : menu de Chrome, « Installer l'application » (ou le bouton de l'écran Partage). Une fois ouverte, elle fonctionne **sans connexion internet**.
- Sans rover : choisissez **Démo**. Un faux rover vit dans la page (pièce avec murs et obstacles, sonar, carte qui se remplit, tous les comportements) et parle le même protocole que le vrai.
- Raccourcis d'adresse : `?demo` lance la démo ; `?sim=ws://hôte:8765/ws` se connecte au simulateur sur PC.

## Se connecter

| Mode | Usage |
|---|---|
| Bluetooth | le vrai rover (service UART Nordic, ou `Rover-XXXX`). Reconnexion automatique. |
| WebSocket | le simulateur sur PC (`ws://hôte:8765/ws`) |
| Démo | rien à brancher (choix du firmware Rust ou MicroPython) |

À la connexion, l'application détecte la famille du firmware (`rust`, `micropython`, `demo`, `inconnu`) depuis `info` et `modes`, et adapte l'écran aux capacités disponibles (modes autonomes, sauvegarde en flash et réglages d'usine, changement de nom, diagnostic matériel étendu, essai de liaison sur 50 trames par écho `0x12` ou `PING`).

Le protocole (trames binaires, commandes texte) est décrit dans `PROTOCOLE.md` du projet RoverOS ; `js/protocole.js` le code et le décode.
L'application n'envoie jamais plus de 25 trames par seconde.

## Compatibilité

| Navigateur | Bluetooth | Démo / WebSocket |
|---|---|---|
| Chrome sur Android | oui | oui |
| Chrome ou Edge sur ordinateur | oui | oui |
| Safari et Chrome sur iPhone, Firefox | non (pas de Web Bluetooth) | oui |

Le WebSocket depuis une page en `https` n'accepte que `ws://localhost` ou `wss://` : pour parler à un simulateur du réseau local, ouvrez la page en `http` en local (voir plus bas).

## Piloter

- **Deux zones tactiles** : posez le pouce n'importe où, la manette apparaît dessous. Gauche : déplacement. Droite : rotation. Un bouton **Stop** (freinage normal) et la vitesse maximale (25, 50, 75, 100 %) restent sous le pouce.
- **Arrêt d'urgence** : toujours visible. Un toucher suffit à tout arrêter ; il reste verrouillé jusqu'à ce qu'on **maintienne** le bouton 1 seconde.
- **Incliner** : pilotage en penchant le téléphone (tant qu'un doigt reste posé). Calibration du neutre et zone morte dans les réglages.
- **Carte** : pincer pour zoomer, glisser pour déplacer, toucher un point pour y envoyer le rover.
- **Clavier (PC)** : flèches ou ZQSD pour avancer, A et E pour tourner, Espace pour Stop, Échap pour l'arrêt d'urgence.
- Réglages de confort : mode gaucher, vibrations, écran qui reste allumé, disposition télécommande ou carte, plein écran.

## Lancer en local

```sh
python -m http.server 8000      # ou tout autre serveur de fichiers
# puis ouvrir http://localhost:8000/
```

Le service worker et le Bluetooth demandent `https` ou `localhost`.

## Tests

```sh
node --test tests/              # protocole, file d'envoi (25 trames/s), faux rover, QR code
node outils/generer-icones.mjs  # régénère les icônes SVG et PNG
```

## Organisation

```
index.html            la page
css/style.css         tout le style (css/polices : Geist)
js/protocole.js       codage et décodage des trames (pur, testé)
js/transport*.js      Bluetooth, WebSocket, Démo : même interface (envoyer, événements trame et etat)
js/faux-rover.js      le rover simulé de la démo
js/carte.js           la carte en direct (canvas)
js/manettes.js        manettes flottantes, clavier, envoi à 20 Hz
js/inclinaison.js     pilotage à l'inclinaison
js/bord.js            tableau de bord et radar
js/reglages.js        paramètres du rover et console
js/qr.js              générateur de QR code
js/app.js             le chef d'orchestre
js/firmware.js        détection du firmware et capacités
sw.js, manifest.webmanifest, icones/   installation et hors ligne
```

Pour publier une nouvelle version, changez `VERSION` dans `sw.js` : les téléphones renouvellent leur cache à la visite suivante.

## Crédits

Police [Geist](https://github.com/vercel/geist-font), licence SIL OFL 1.1 (`css/polices/OFL-Geist.txt`).
La direction visuelle suit les principes de [unslop](https://github.com/heydamir/unslop) (Damir Sokolovsky, CC BY 4.0) : une rampe de gris unique, un seul accent, pas de dégradé ni de lueur, grille de 4 px, une seule courbe d'animation.
