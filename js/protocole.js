// protocole.js — codage et décodage des trames RoverOS (version 1).
//
// Ce module est PUR : pas de page web, pas de Bluetooth, pas de minuterie.
// Il peut donc être testé avec Node (voir tests/protocole.test.js).
// Le contrat complet est décrit dans PROTOCOLE.md : une trame = 1 octet de type
// + une charge utile, entiers en petit-boutiste (octet de poids faible d'abord).

// ---------- Constantes ----------

/** Services et caractéristiques « UART Nordic » du Bluetooth. */
export const BLE = {
  service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  ecriture: '6e400002-b5a3-f393-e0a9-e50e24dcca9e', // téléphone -> rover
  notification: '6e400003-b5a3-f393-e0a9-e50e24dcca9e', // rover -> téléphone
};

/** Types de trames. */
export const T = {
  // téléphone -> rover
  MANETTE: 0x01,
  STOP: 0x02,
  URGENCE: 0x03,
  ALLER: 0x05,
  TEXTE: 0x10,
  PING: 0x11,
  ECHO: 0x12,
  // rover -> téléphone
  ETAT: 0x81,
  POINTS: 0x82,
  CARTE: 0x83,
  CHEMIN: 0x84,
  TEXTE_ROVER: 0x85,
  PONG: 0x91,
  ECHO_RETOUR: 0x92,
  // mise à jour du firmware (0x20..0x23 -> 0xA0)
  MAJ_DEBUT: 0x20,
  MAJ_BLOC: 0x21,
  MAJ_FIN: 0x22,
  MAJ_INSTALLER: 0x23,
  MAJ: 0xA0,
  // carte sans limite : origine de la fenêtre glissante de la carte (voir docs/CARTE_SANS_LIMITE.md du dépôt roveros)
  ORIGINE: 0x86,
};

/** La carte fait 64 × 64 cases. */
export const TAILLE_CARTE = 64;
export const CASE_INCONNUE = 0;
export const CASE_LIBRE = 1;
export const CASE_OCCUPEE = 2;
export const CASE_POSSIBLE = 3; // prolongement incertain d'un obstacle (si le rover l'envoie)

/** Les 18 drapeaux de la trame ÉTAT : numéro de bit -> nom. */
export const NOMS_DRAPEAUX = [
  'urgence', 'garde', 'obstacle', 'laisse', 'blocage', 'patine', 'batterie', 'driver_ko',
  'imu_ko', 'arrive', 'gyro_ok', 'aveugle', 'sature', 'retard', 'mouvement', 'cible', 'souleve',
  'choc',
];

/**
 * Traduction des drapeaux en clair.
 * gravite : 'danger' (rouge), 'alerte' (ambre), 'info' (neutre), 'ok' (vert).
 * Les drapeaux sans intérêt pour l'utilisateur quand ils sont à 0 ne sont affichés que s'ils sont à 1.
 */
export const DRAPEAUX_FR = {
  urgence: { texte: "Arrêt d'urgence actif", gravite: 'danger' },
  garde: { texte: 'Plus aucun ordre reçu : arrêt de sécurité', gravite: 'alerte' },
  obstacle: { texte: 'Arrêté ou bridé par un obstacle', gravite: 'alerte' },
  laisse: { texte: 'Limite de zone atteinte', gravite: 'alerte' },
  blocage: { texte: 'Roue bloquée', gravite: 'danger' },
  patine: { texte: 'Patinage détecté', gravite: 'alerte' },
  batterie: { texte: 'Batterie faible', gravite: 'danger' },
  driver_ko: { texte: 'Pilote des moteurs en panne', gravite: 'danger' },
  imu_ko: { texte: 'Centrale inertielle en panne', gravite: 'danger' },
  arrive: { texte: 'Destination atteinte', gravite: 'ok' },
  gyro_ok: { texte: 'Gyroscope prêt', gravite: 'ok' },
  aveugle: { texte: 'Ralenti : la tête ne peut pas regarder de ce côté', gravite: 'alerte' },
  sature: { texte: 'Commandes saturées', gravite: 'info' },
  retard: { texte: 'Boucle de commande en retard', gravite: 'alerte' },
  mouvement: { texte: 'En mouvement', gravite: 'info' },
  cible: { texte: 'Cible suivie', gravite: 'info' },
  souleve: { texte: 'Pris en main, ou roues sans prise : cap non tenu', gravite: 'danger' },
  choc: { texte: 'Contact avec un obstacle', gravite: 'danger' },
};

// ---------- Utilitaires d'octets ----------

const limiter = (v, min, max) => Math.min(max, Math.max(min, v));
const entier = (v) => (Number.isFinite(v) ? Math.round(v) : 0);

const encodeurTexte = new TextEncoder();
const decodeurTexte = new TextDecoder('utf-8', { fatal: false });

/** Convertit n'importe quel tampon en Uint8Array (DataView, ArrayBuffer, tableau...). */
export function versOctets(donnees) {
  if (donnees instanceof Uint8Array) return donnees;
  if (donnees instanceof ArrayBuffer) return new Uint8Array(donnees);
  if (ArrayBuffer.isView(donnees)) {
    return new Uint8Array(donnees.buffer, donnees.byteOffset, donnees.byteLength);
  }
  if (Array.isArray(donnees)) return Uint8Array.from(donnees);
  return new Uint8Array(0);
}

/** Écrit un entier 16 bits signé, petit-boutiste, dans un tableau. */
function poser16(tab, pos, valeur) {
  const v = limiter(entier(valeur), -32768, 32767);
  tab[pos] = v & 0xff;
  tab[pos + 1] = (v >> 8) & 0xff;
}

// ---------- Téléphone -> rover : encodage ----------

/**
 * MANETTE : vx, vy, w en pour cent (−100…100) ; monde = true pour le repère du monde.
 * Les octets signés sont écrits en complément à deux.
 */
export function encoderManette(vx, vy, w, monde = false) {
  const c = (v) => limiter(entier(v), -100, 100) & 0xff;
  return Uint8Array.of(T.MANETTE, c(vx), c(vy), c(w), monde ? 1 : 0);
}

export const encoderStop = () => Uint8Array.of(T.STOP);

/** URGENCE : actif = true verrouille l'arrêt d'urgence, false le déverrouille. */
export const encoderUrgence = (actif) => Uint8Array.of(T.URGENCE, actif ? 1 : 0);

/** ALLER : x et y en millimètres (i16). */
export function encoderAller(xMm, yMm) {
  const t = new Uint8Array(5);
  t[0] = T.ALLER;
  poser16(t, 1, xMm);
  poser16(t, 3, yMm);
  return t;
}

/** TEXTE : une commande en UTF-8 (ex. « mode chien »). */
export function encoderTexte(texte) {
  const octets = encodeurTexte.encode(String(texte));
  const t = new Uint8Array(1 + octets.length);
  t[0] = T.TEXTE;
  t.set(octets, 1);
  return t;
}

export const encoderPing = (n) => Uint8Array.of(T.PING, n & 0xff);

/** ECHO (0x12) : trame d'écho de banc ; le rover renvoie 0x92 avec la même charge utile. */
export function encoderEcho(donnees = new Uint8Array(0)) {
  const o = versOctets(donnees);
  const t = new Uint8Array(1 + o.length);
  t[0] = T.ECHO;
  t.set(o, 1);
  return t;
}

/** MAJ_DEBUT (0x20) : taille totale du paquet (u32) + CRC-32 du paquet (u32). */
export function encoderMajDebut(taille, crc) {
  const t = new Uint8Array(9);
  const vue = new DataView(t.buffer);
  t[0] = T.MAJ_DEBUT;
  vue.setUint32(1, taille >>> 0, true);
  vue.setUint32(5, crc >>> 0, true);
  return t;
}

/** MAJ_BLOC (0x21) : position (u32) + octets du bloc. */
export function encoderMajBloc(position, donnees) {
  const o = versOctets(donnees);
  const t = new Uint8Array(5 + o.length);
  const vue = new DataView(t.buffer);
  t[0] = T.MAJ_BLOC;
  vue.setUint32(1, position >>> 0, true);
  t.set(o, 5);
  return t;
}

/** MAJ_FIN (0x22) : fin d'envoi, demande la vérification du paquet. */
export const encoderMajFin = () => Uint8Array.of(T.MAJ_FIN);

/** MAJ_INSTALLER (0x23) : lance l'installation du paquet vérifié (CRC-32 attendu). */
export function encoderMajInstaller(crc) {
  const t = new Uint8Array(5);
  const vue = new DataView(t.buffer);
  t[0] = T.MAJ_INSTALLER;
  vue.setUint32(1, crc >>> 0, true);
  return t;
}

// ---------- Rover -> téléphone : décodage ----------

/**
 * Décode UNE trame reçue. Ne lève jamais d'exception.
 * Renvoie un objet { type: 'etat' | 'points' | 'carte' | 'chemin' | 'texte' | 'pong' | 'inconnu', ... }
 * ou null si la trame est vide ou trop courte pour son type.
 */
export function decoder(donnees) {
  try {
    const o = versOctets(donnees);
    if (o.length === 0) return null;
    const vue = new DataView(o.buffer, o.byteOffset, o.byteLength);
    switch (o[0]) {
      case T.ETAT: return decoderEtat(o, vue);
      case T.POINTS: return decoderPoints(o, vue);
      case T.CARTE: return decoderCarte(o);
      case T.CHEMIN: return decoderChemin(o, vue);
      case T.TEXTE_ROVER: return { type: 'texte', texte: decodeurTexte.decode(o.subarray(1)).replace(/[\r\n]+$/, '') };
      case T.PONG: return o.length >= 2 ? { type: 'pong', n: o[1] } : null;
      case T.ECHO_RETOUR: return { type: 'echo', donnees: o.slice(1) };
      case T.ORIGINE: return decoderOrigine(o, vue);
      case T.MAJ: return o.length >= 6 ? { type: 'maj', etat: o[1], valeur: vue.getUint32(2, true) } : { type: 'maj' };
      default: return { type: 'inconnu', code: o[0], longueur: o.length };
    }
  } catch {
    return null;
  }
}

function decoderEtat(o, vue) {
  if (o.length < 19) return null; // trame tronquée : on l'ignore
  const drapeaux = o[7] | (o[8] << 8) | (o[9] << 16);
  const flags = {};
  NOMS_DRAPEAUX.forEach((nom, bit) => { flags[nom] = ((drapeaux >> bit) & 1) === 1; });
  return {
    type: 'etat',
    x: vue.getInt16(1, true), // mm
    y: vue.getInt16(3, true), // mm
    cap: vue.getInt16(5, true) / 100, // degrés, horaire + (le cœur ne le ramène pas toujours entre −180° et 180° : voir capSature)
    // le cap tient sur un entier 16 bits en centièmes de degré : au-delà de ±327,67° il SATURE et ne dit plus rien de fiable
    capSature: Math.abs(vue.getInt16(5, true)) >= 32766,
    drapeaux,
    flags,
    comportement: o[10], // indice dans la liste « modes »
    tension: o[11] / 10, // volts
    tete: vue.getInt8(12), // degrés, positif à droite
    sonar: o[13], // cm (0 = rien, 255 = 2,55 m ou plus)
    cibleGis: vue.getInt8(14),
    cibleD: o[15], // cm, 0 = pas de cible
    libre: o[16], // cm, 255 = non regardée
    vitesse: o[17], // cm/s
    rssi: vue.getInt8(18), // dBm, 0 = inconnue
    // vingtième octet (rovers à carte sans limite) : version de l'origine, pour ne pas mélanger deux repères
    versionOrigine: o.length >= 20 ? o[19] : undefined,
  };
}

/** ORIGINE (0x86) : ox i32, oy i32 (cases du monde), version u8, cellule u16 (mm), [carte u8]. */
function decoderOrigine(o, vue) {
  if (o.length < 12) return null;
  const r = { type: 'origine', ox: vue.getInt32(1, true), oy: vue.getInt32(5, true), version: o[9], cellule: vue.getUint16(10, true) };
  if (o.length >= 13) r.carte = o[12];
  return r;
}

/** Construit une trame ORIGINE (utilisée par la démo et les tests). */
export function encoderOrigine({ ox, oy, version, cellule, carte }) {
  const t = new Uint8Array(carte === undefined ? 12 : 13);
  const vue = new DataView(t.buffer);
  t[0] = T.ORIGINE;
  vue.setInt32(1, ox, true); vue.setInt32(5, oy, true);
  t[9] = version & 0xff;
  vue.setUint16(10, cellule, true);
  if (carte !== undefined) t[12] = carte & 0xff;
  return t;
}

function decoderPoints(o, vue) {
  const points = [];
  // Chaque écho occupe 10 octets, à partir de l'octet 1. Un morceau incomplet est ignoré.
  for (let pos = 1; pos + 10 <= o.length; pos += 10) {
    points.push({
      gisement: vue.getInt16(pos, true) / 10, // degrés par rapport à l'avant, positif à droite
      distance: vue.getUint16(pos + 2, true), // mm, 0 = pas d'écho
      x: vue.getInt16(pos + 4, true), // mm : point touché
      y: vue.getInt16(pos + 6, true),
      t: vue.getUint16(pos + 8, true), // ms
    });
  }
  return { type: 'points', points };
}

function decoderCarte(o) {
  if (o.length < 3) return null;
  const ligne = o[1];
  let nombre = o[2];
  // On ne lit que les lignes complètes présentes dans la trame, et pas au-delà de la ligne 63.
  nombre = Math.min(nombre, Math.floor((o.length - 3) / 16), TAILLE_CARTE - ligne);
  if (ligne >= TAILLE_CARTE || nombre <= 0) return null;
  const lignes = [];
  for (let k = 0; k < nombre; k++) {
    const cases = new Uint8Array(TAILLE_CARTE);
    const base = 3 + 16 * k;
    for (let i = 0; i < TAILLE_CARTE; i++) {
      // case i : bits 2·(i mod 4) de l'octet i/4
      cases[i] = (o[base + (i >> 2)] >> (2 * (i & 3))) & 3;
    }
    lignes.push(cases);
  }
  return { type: 'carte', ligne, nombre, lignes };
}

function decoderChemin(o, vue) {
  if (o.length < 2) return null;
  const n = Math.min(o[1], Math.floor((o.length - 2) / 4));
  const points = [];
  for (let k = 0; k < n; k++) {
    points.push({ x: vue.getInt16(2 + 4 * k, true), y: vue.getInt16(4 + 4 * k, true) });
  }
  return { type: 'chemin', points };
}

/**
 * Recopie les lignes d'une trame CARTE décodée dans une grille 64×64
 * (Uint8Array de 4096 cases, rangée par lignes : grille[ligne * 64 + colonne]).
 * Renvoie le nombre de cases dont la valeur a changé.
 */
export function appliquerCarte(grille, msg) {
  let changees = 0;
  msg.lignes.forEach((cases, k) => {
    const decalage = (msg.ligne + k) * TAILLE_CARTE;
    for (let i = 0; i < TAILLE_CARTE; i++) {
      if (grille[decalage + i] !== cases[i]) { grille[decalage + i] = cases[i]; changees++; }
    }
  });
  return changees;
}

// ---------- Lignes de texte du rover (0x85) ----------

/** Transforme « clé=valeur clé=valeur » en objet de chaînes brutes (préserve hexadécimal, binaire, zéros de tête). */
export function analyserClesBruts(texte) {
  const sortie = {};
  for (const mot of String(texte ?? '').split(/\s+/)) {
    const egal = mot.indexOf('=');
    if (egal <= 0) continue;
    sortie[mot.slice(0, egal)] = mot.slice(egal + 1);
  }
  return sortie;
}

/** Transforme « clé=valeur clé=valeur » en objet (nombres convertis quand c'est possible). */
export function analyserCles(texte) {
  const sortie = {};
  for (const mot of texte.split(/\s+/)) {
    const egal = mot.indexOf('=');
    if (egal <= 0) continue;
    const valeur = mot.slice(egal + 1);
    const nombre = Number(valeur);
    sortie[mot.slice(0, egal)] = valeur !== '' && Number.isFinite(nombre) ? nombre : valeur;
  }
  return sortie;
}

/**
 * Réassemble les lignes fragmentées par le firmware Rust en petit MTU
 * (« materiel+ … », « acquisition+ … », « liaison+ … » — rust100/src/systeme.rs:958,977,979).
 */
export class AssembleurFragments {
  constructor() {
    this._tampons = new Map();
  }

  reinitialiser() {
    this._tampons.clear();
  }

  /** Prend une ligne reçue et renvoie la ligne complète (ou réassemblée) à traiter. */
  pousser(ligne) {
    const s = String(ligne ?? '');
    for (const prefixe of ['materiel', 'acquisition', 'liaison']) {
      if (s.startsWith(`${prefixe}+ `)) {
        const avant = this._tampons.get(prefixe) ?? `${prefixe} `;
        const complet = avant + s.slice(prefixe.length + 2);
        this._tampons.set(prefixe, complet);
        return complet;
      }
      if (s.startsWith(`${prefixe} `)) {
        this._tampons.set(prefixe, s);
        return s;
      }
    }
    return s;
  }
}

/**
 * Analyse une ligne de texte envoyée par le rover.
 * Renvoie { genre, ... } avec genre ∈ info | modes | param | evt | err | calib | materiel | acquisition | liaison | maj | journal_rover | journal_fin | autre.
 */
export function analyserLigne(ligne) {
  const texte = String(ligne ?? '').trim();
  const espace = texte.search(/\s/);
  const mot = espace < 0 ? texte : texte.slice(0, espace);
  const reste = espace < 0 ? '' : texte.slice(espace + 1).trim();
  switch (mot) {
    case 'info': return { genre: 'info', valeurs: analyserCles(reste), texte };
    case 'calib': return { genre: 'calib', valeurs: analyserCles(reste), reste, texte };
    case 'materiel': return { genre: 'materiel', valeurs: analyserCles(reste), brut: analyserClesBruts(reste), texte };
    case 'acquisition': return { genre: 'acquisition', valeurs: analyserCles(reste), brut: analyserClesBruts(reste), texte };
    case 'liaison': return { genre: 'liaison', valeurs: analyserCles(reste), brut: analyserClesBruts(reste), texte };
    case 'maj': return { genre: 'maj', valeurs: analyserCles(reste), brut: analyserClesBruts(reste), reste, texte };
    case 'profil': {
      const premier = reste.split(/\s+/)[0] ?? '';
      const section = premier && !premier.includes('=') ? premier : '';
      return { genre: 'profil', section, valeurs: analyserCles(reste), texte };
    }
    case 'modes': return { genre: 'modes', modes: reste.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean), texte };
    case 'evt': return { genre: 'evt', message: reste, texte };
    case 'err': return { genre: 'err', message: reste, texte };
    case 'c': return { genre: 'champs', valeurs: analyserCles(reste), texte };
    case 'j': {
      const tokens = reste.split(/\s+/).filter(Boolean);
      if (tokens[0] === 'fin') {
        const nombre = Number(tokens[1]);
        const perdus = Number(tokens[2]);
        return {
          genre: 'journal_fin',
          nombre: Number.isFinite(nombre) ? nombre : null,
          perdus: Number.isFinite(perdus) ? perdus : 0,
          reste,
          texte,
        };
      }
      const tempsN = Number(tokens[0]);
      const tempsMs = tokens[0] !== undefined && Number.isFinite(tempsN) ? tempsN : null;
      const nom = tempsMs !== null ? (tokens[1] ?? '') : (tokens[0] ?? '');
      const debutVal = tempsMs !== null ? 2 : 1;
      const valeursTexte = tokens.slice(debutVal).join(' ');
      return {
        genre: 'journal_rover',
        tempsMs,
        nom,
        valeursTexte,
        valeurs: analyserCles(valeursTexte),
        reste,
        texte,
      };
    }
    case 'p': {
      const [nom, valeur, min, max] = reste.split(/\s+/);
      const v = Number(valeur);
      if (!nom || valeur === undefined || !Number.isFinite(v)) return { genre: 'autre', mot, reste, valeurs: analyserCles(reste), texte };
      const mn = Number(min);
      const mx = Number(max);
      return {
        genre: 'param', nom, valeur: v,
        min: Number.isFinite(mn) ? mn : null,
        max: Number.isFinite(mx) ? mx : null,
        texte,
      };
    }
    default: return { genre: 'autre', mot, reste, valeurs: analyserCles(reste), texte };
  }
}

// ---------- Rover -> téléphone : encodage (utilisé par la démo et les tests) ----------

/** Construit une trame ÉTAT de 19 octets à partir d'un objet de valeurs « physiques ». */
export function encoderEtat(e) {
  const t = new Uint8Array(e.versionOrigine === undefined ? 19 : 20);
  const vue = new DataView(t.buffer);
  t[0] = T.ETAT;
  vue.setInt16(1, limiter(entier(e.x ?? 0), -32768, 32767), true);
  vue.setInt16(3, limiter(entier(e.y ?? 0), -32768, 32767), true);
  vue.setInt16(5, limiter(entier((e.cap ?? 0) * 100), -18000, 18000), true);
  const d = (e.drapeaux ?? 0) & 0xffffff;
  t[7] = d & 0xff; t[8] = (d >> 8) & 0xff; t[9] = (d >> 16) & 0xff;
  t[10] = (e.comportement ?? 0) & 0xff;
  t[11] = limiter(entier((e.tension ?? 0) * 10), 0, 255);
  vue.setInt8(12, limiter(entier(e.tete ?? 0), -128, 127));
  t[13] = limiter(entier(e.sonar ?? 0), 0, 255);
  vue.setInt8(14, limiter(entier(e.cibleGis ?? 0), -128, 127));
  t[15] = limiter(entier(e.cibleD ?? 0), 0, 255);
  t[16] = limiter(entier(e.libre ?? 255), 0, 255);
  t[17] = limiter(entier(e.vitesse ?? 0), 0, 255);
  vue.setInt8(18, limiter(entier(e.rssi ?? 0), -128, 127));
  if (e.versionOrigine !== undefined) t[19] = e.versionOrigine & 0xff;
  return t;
}

/** Assemble les drapeaux (objet { nom: bool }) en entier 24 bits. */
export function assemblerDrapeaux(flags) {
  let d = 0;
  NOMS_DRAPEAUX.forEach((nom, bit) => { if (flags[nom]) d |= 1 << bit; });
  return d;
}

/** POINTS : liste de { gisement (deg), distance (mm), x, y (mm), t (ms) }. */
export function encoderPoints(points) {
  const t = new Uint8Array(1 + 10 * points.length);
  const vue = new DataView(t.buffer);
  t[0] = T.POINTS;
  points.forEach((p, k) => {
    const pos = 1 + 10 * k;
    vue.setInt16(pos, limiter(entier(p.gisement * 10), -32768, 32767), true);
    vue.setUint16(pos + 2, limiter(entier(p.distance), 0, 65535), true);
    vue.setInt16(pos + 4, limiter(entier(p.x), -32768, 32767), true);
    vue.setInt16(pos + 6, limiter(entier(p.y), -32768, 32767), true);
    vue.setUint16(pos + 8, entier(p.t) & 0xffff, true);
  });
  return t;
}

/** CARTE : `lignes` = tableau de Uint8Array(64) (valeurs 0, 1 ou 2), à partir de la ligne `ligne`. */
export function encoderCarte(ligne, lignes) {
  const t = new Uint8Array(3 + 16 * lignes.length);
  t[0] = T.CARTE;
  t[1] = ligne;
  t[2] = lignes.length;
  lignes.forEach((cases, k) => {
    for (let i = 0; i < TAILLE_CARTE; i++) {
      t[3 + 16 * k + (i >> 2)] |= (cases[i] & 3) << (2 * (i & 3));
    }
  });
  return t;
}

/** CHEMIN : liste de { x, y } en millimètres. */
export function encoderChemin(points) {
  const n = Math.min(points.length, 255);
  const t = new Uint8Array(2 + 4 * n);
  const vue = new DataView(t.buffer);
  t[0] = T.CHEMIN;
  t[1] = n;
  for (let k = 0; k < n; k++) {
    vue.setInt16(2 + 4 * k, limiter(entier(points[k].x), -32768, 32767), true);
    vue.setInt16(4 + 4 * k, limiter(entier(points[k].y), -32768, 32767), true);
  }
  return t;
}

export function encoderTexteRover(texte) {
  const octets = encodeurTexte.encode(String(texte));
  const t = new Uint8Array(1 + octets.length);
  t[0] = T.TEXTE_ROVER;
  t.set(octets, 1);
  return t;
}

export const encoderPong = (n) => Uint8Array.of(T.PONG, n & 0xff);

/** ECHO_RETOUR (0x92) : utilisé par le faux rover et les tests. */
export function encoderEchoRetour(donnees = new Uint8Array(0)) {
  const o = versOctets(donnees);
  const t = new Uint8Array(1 + o.length);
  t[0] = T.ECHO_RETOUR;
  t.set(o, 1);
  return t;
}

/** MAJ (0xA0) : utilisé par le faux rover et les tests. */
export function encoderMajRetour(etat, valeur = 0) {
  const t = new Uint8Array(6);
  const vue = new DataView(t.buffer);
  t[0] = T.MAJ;
  t[1] = etat & 0xff;
  vue.setUint32(2, valeur >>> 0, true);
  return t;
}

/** Décode une trame téléphone -> rover (utilisé par la démo : le faux rover lit nos ordres). */
export function decoderOrdre(donnees) {
  const o = versOctets(donnees);
  if (o.length === 0) return null;
  const vue = new DataView(o.buffer, o.byteOffset, o.byteLength);
  const s8 = (v) => (v > 127 ? v - 256 : v);
  switch (o[0]) {
    case T.MANETTE:
      if (o.length < 5) return null;
      return { type: 'manette', vx: s8(o[1]), vy: s8(o[2]), w: s8(o[3]), monde: (o[4] & 1) === 1 };
    case T.STOP: return { type: 'stop' };
    case T.URGENCE: return o.length >= 2 ? { type: 'urgence', actif: o[1] === 1 } : null;
    case T.ALLER:
      return o.length >= 5 ? { type: 'aller', x: vue.getInt16(1, true), y: vue.getInt16(3, true) } : null;
    case T.TEXTE: return { type: 'texte', texte: decodeurTexte.decode(o.subarray(1)).trim() };
    case T.PING: return o.length >= 2 ? { type: 'ping', n: o[1] } : null;
    case T.ECHO: return { type: 'echo', donnees: o.slice(1) };
    case T.MAJ_DEBUT:
      return o.length >= 9 ? { type: 'maj_debut', taille: vue.getUint32(1, true), crc: vue.getUint32(5, true) } : null;
    case T.MAJ_BLOC:
      return o.length >= 6 ? { type: 'maj_bloc', position: vue.getUint32(1, true), donnees: o.slice(5) } : null;
    case T.MAJ_FIN: return { type: 'maj_fin' };
    case T.MAJ_INSTALLER:
      return o.length >= 5 ? { type: 'maj_installer', crc: vue.getUint32(1, true) } : null;
    default: return { type: 'inconnu', code: o[0] };
  }
}
