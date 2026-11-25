// qr.js — générateur de QR code, sans aucune dépendance ni appel réseau.
//
// Il suit la norme ISO 18004 pour les versions 1 à 10 (jusqu'à 213 octets au niveau M), en mode
// « octets » (UTF-8), ce qui suffit largement pour l'adresse d'une page web.
// Étapes : données -> correction d'erreurs Reed-Solomon -> placement dans la grille -> masque.
//
// Utilisation :
//   const qr = creerQr('https://exemple.org/', 'M');   // { taille, module(x, y) }
//   dessinerQr(canvas, qr);                            // dessine sur un <canvas>

// ---------- Tables de la norme (versions 1 à 10) ----------
// Niveaux de correction : L (7 %), M (15 %), Q (25 %), H (30 %).
const NIVEAUX = { L: 0, M: 1, Q: 2, H: 3 };
const BITS_FORMAT = { L: 1, M: 0, Q: 3, H: 2 }; // codage du niveau dans l'information de format
// Octets de correction par bloc, puis nombre de blocs, par niveau (L, M, Q, H) et par version 1..10.
const OCTETS_CORRECTION = [
  [7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  [10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  [13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  [17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
];
const NB_BLOCS = [
  [1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  [1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  [1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  [1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
];
const VERSION_MAX = 10;

// ---------- Arithmétique dans le corps de Galois GF(256) ----------

/** Multiplication dans GF(256) modulo x^8 + x^4 + x^3 + x^2 + 1 (0x11D). */
function multiplier(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

/** Polynôme générateur de Reed-Solomon de degré `d` (sans le terme de plus haut degré). */
function diviseurRS(d) {
  const r = new Array(d).fill(0);
  r[d - 1] = 1;
  let racine = 1;
  for (let i = 0; i < d; i++) {
    for (let j = 0; j < d; j++) {
      r[j] = multiplier(r[j], racine);
      if (j + 1 < d) r[j] ^= r[j + 1];
    }
    racine = multiplier(racine, 2);
  }
  return r;
}

/** Reste de la division des données par le polynôme générateur = octets de correction. */
function resteRS(donnees, diviseur) {
  const r = new Array(diviseur.length).fill(0);
  for (const b of donnees) {
    const facteur = b ^ r.shift();
    r.push(0);
    diviseur.forEach((c, i) => { r[i] ^= multiplier(c, facteur); });
  }
  return r;
}

// ---------- Capacités ----------

/** Nombre de modules de données (hors motifs de repérage) pour une version. */
function modulesDeDonnees(version) {
  let n = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const na = Math.floor(version / 7) + 2;
    n -= (25 * na - 10) * na - 55;
    if (version >= 7) n -= 36;
  }
  return n;
}

function octetsDeDonnees(version, niveau) {
  const i = NIVEAUX[niveau];
  return Math.floor(modulesDeDonnees(version) / 8) - OCTETS_CORRECTION[i][version - 1] * NB_BLOCS[i][version - 1];
}

/** Positions des motifs d'alignement (en x et en y) pour une version. */
function positionsAlignement(version, taille) {
  if (version === 1) return [];
  const n = Math.floor(version / 7) + 2;
  const pas = Math.ceil((version * 4 + 4) / (n * 2 - 2)) * 2;
  const r = [6];
  for (let pos = taille - 7; r.length < n; pos -= pas) r.splice(1, 0, pos);
  return r;
}

// ---------- Construction ----------

/**
 * Crée un QR code. Lève une erreur si le texte est trop long pour la version 10.
 * Renvoie { taille, version, module(x, y) } où module() dit si le carré (x, y) est noir.
 */
export function creerQr(texte, niveau = 'M') {
  const octets = new TextEncoder().encode(String(texte));
  const ni = NIVEAUX[niveau];
  if (ni === undefined) throw new Error('niveau de correction inconnu');

  // 1. Plus petite version qui contient le texte (mode octets : 4 bits de mode + compteur + données).
  let version = 1;
  for (; version <= VERSION_MAX; version++) {
    const bitsCompteur = version <= 9 ? 8 : 16;
    if (4 + bitsCompteur + 8 * octets.length <= 8 * octetsDeDonnees(version, niveau)) break;
  }
  if (version > VERSION_MAX) throw new Error('Texte trop long pour le QR code');
  const taille = 17 + 4 * version;

  // 2. Flux de bits : mode octets (0100), longueur, données, terminateur, bourrage.
  const bits = [];
  const poser = (valeur, n) => { for (let i = n - 1; i >= 0; i--) bits.push((valeur >>> i) & 1); };
  poser(0b0100, 4);
  poser(octets.length, version <= 9 ? 8 : 16);
  octets.forEach((b) => poser(b, 8));
  const capaciteBits = 8 * octetsDeDonnees(version, niveau);
  poser(0, Math.min(4, capaciteBits - bits.length));
  poser(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capaciteBits; pad ^= 0xec ^ 0x11) poser(pad, 8);
  const donnees = [];
  for (let i = 0; i < bits.length; i += 8) {
    let o = 0;
    for (let j = 0; j < 8; j++) o = (o << 1) | bits[i + j];
    donnees.push(o);
  }

  // 3. Correction d'erreurs par blocs, puis entrelacement des octets des blocs.
  const nbBlocs = NB_BLOCS[ni][version - 1];
  const longCorr = OCTETS_CORRECTION[ni][version - 1];
  const total = Math.floor(modulesDeDonnees(version) / 8);
  const blocsCourts = nbBlocs - (total % nbBlocs);
  const longCourt = Math.floor(total / nbBlocs);
  const diviseur = diviseurRS(longCorr);
  const blocs = [];
  for (let i = 0, k = 0; i < nbBlocs; i++) {
    const dat = donnees.slice(k, k + longCourt - longCorr + (i < blocsCourts ? 0 : 1));
    k += dat.length;
    const corr = resteRS(dat, diviseur);
    if (i < blocsCourts) dat.push(0); // case vide, ignorée à l'entrelacement
    blocs.push(dat.concat(corr));
  }
  const message = [];
  for (let i = 0; i < blocs[0].length; i++) {
    blocs.forEach((bloc, j) => { if (i !== longCourt - longCorr || j >= blocsCourts) message.push(bloc[i]); });
  }

  // 4. Grille : motifs fixes (repères, alignement, temporisation) puis données en zigzag.
  const modules = Array.from({ length: taille }, () => new Array(taille).fill(false));
  const fonction = Array.from({ length: taille }, () => new Array(taille).fill(false));
  const fixer = (x, y, noir) => { modules[y][x] = noir; fonction[y][x] = true; };

  for (let i = 0; i < taille; i++) { fixer(6, i, i % 2 === 0); fixer(i, 6, i % 2 === 0); } // lignes de temporisation
  const repere = (cx, cy) => { // grand carré de repérage 7×7 entouré d'un liseré clair
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx; const y = cy + dy;
        if (x >= 0 && x < taille && y >= 0 && y < taille) fixer(x, y, d !== 2 && d !== 4);
      }
    }
  };
  repere(3, 3); repere(taille - 4, 3); repere(3, taille - 4);
  const align = positionsAlignement(version, taille);
  align.forEach((ax, i) => align.forEach((ay, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) fixer(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));

  const bit = (v, i) => ((v >>> i) & 1) !== 0;
  const formats = (masque) => {
    const data = (BITS_FORMAT[niveau] << 3) | masque;
    let reste = data;
    for (let i = 0; i < 10; i++) reste = (reste << 1) ^ ((reste >>> 9) * 0x537);
    const f = ((data << 10) | reste) ^ 0x5412;
    for (let i = 0; i <= 5; i++) fixer(8, i, bit(f, i));
    fixer(8, 7, bit(f, 6)); fixer(8, 8, bit(f, 7)); fixer(7, 8, bit(f, 8));
    for (let i = 9; i < 15; i++) fixer(14 - i, 8, bit(f, i));
    for (let i = 0; i < 8; i++) fixer(taille - 1 - i, 8, bit(f, i));
    for (let i = 8; i < 15; i++) fixer(8, taille - 15 + i, bit(f, i));
    fixer(8, taille - 8, true); // module sombre fixe
  };
  formats(0); // réserve la place
  if (version >= 7) {
    let reste = version;
    for (let i = 0; i < 12; i++) reste = (reste << 1) ^ ((reste >>> 11) * 0x1f25);
    const v = (version << 12) | reste;
    for (let i = 0; i < 18; i++) {
      const noir = bit(v, i);
      const a = taille - 11 + (i % 3); const b = Math.floor(i / 3);
      fixer(a, b, noir); fixer(b, a, noir);
    }
  }

  let k = 0; // zigzag par colonnes de deux modules, de droite à gauche
  for (let droite = taille - 1; droite >= 1; droite -= 2) {
    if (droite === 6) droite = 5;
    for (let v = 0; v < taille; v++) {
      for (let j = 0; j < 2; j++) {
        const x = droite - j;
        const y = ((droite + 1) & 2) === 0 ? taille - 1 - v : v;
        if (!fonction[y][x] && k < message.length * 8) {
          modules[y][x] = bit(message[k >>> 3], 7 - (k & 7));
          k++;
        }
      }
    }
  }

  // 5. Choix du masque qui donne la grille la plus lisible (plus petite pénalité).
  const conditions = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const appliquer = (m) => {
    for (let y = 0; y < taille; y++) for (let x = 0; x < taille; x++) if (!fonction[y][x] && conditions[m](x, y)) modules[y][x] = !modules[y][x];
  };
  let meilleur = 0; let meilleurScore = Infinity;
  for (let m = 0; m < 8; m++) {
    appliquer(m); formats(m);
    const s = penalite(modules, taille);
    if (s < meilleurScore) { meilleurScore = s; meilleur = m; }
    appliquer(m); // on annule
  }
  appliquer(meilleur); formats(meilleur);

  return { taille, version, module: (x, y) => x >= 0 && y >= 0 && x < taille && y < taille && modules[y][x] };
}

/** Pénalités de la norme : longues suites, blocs 2×2, motifs de repérage, déséquilibre noir/blanc. */
function penalite(m, n) {
  let p = 0;
  const lignes = [];
  for (let y = 0; y < n; y++) lignes.push(m[y]);
  for (let x = 0; x < n; x++) lignes.push(m.map((l) => l[x]));
  for (const l of lignes) {
    let serie = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && l[i] === l[i - 1]) serie++;
      else { if (serie >= 5) p += serie - 2; serie = 1; }
    }
    const chaine = l.map((b) => (b ? '1' : '0')).join('');
    for (const motif of ['00001011101', '10111010000']) {
      for (let i = chaine.indexOf(motif); i >= 0; i = chaine.indexOf(motif, i + 1)) p += 40;
    }
  }
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
  }
  let noirs = 0;
  m.forEach((l) => l.forEach((b) => { if (b) noirs++; }));
  p += Math.floor(Math.abs((noirs * 20) / (n * n) - 10)) * 10; // écart à 50 % par tranches de 5 %
  return p;
}

// ---------- Dessin ----------

/**
 * Dessine le QR code sur un canvas : noir sur blanc avec 4 modules de marge (norme),
 * agrandi par un nombre entier de pixels pour des bords nets.
 */
export function dessinerQr(canvas, qr, tailleCible = 280) {
  const marge = 4;
  const total = qr.taille + 2 * marge;
  const echelle = Math.max(1, Math.floor(tailleCible / total));
  canvas.width = canvas.height = total * echelle;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000000';
  for (let y = 0; y < qr.taille; y++) {
    for (let x = 0; x < qr.taille; x++) if (qr.module(x, y)) ctx.fillRect((x + marge) * echelle, (y + marge) * echelle, echelle, echelle);
  }
}

/** Version texte (pour les tests) : une chaîne de '0' et '1' par ligne. */
export function qrVersTexte(qr) {
  const lignes = [];
  for (let y = 0; y < qr.taille; y++) {
    let l = '';
    for (let x = 0; x < qr.taille; x++) l += qr.module(x, y) ? '1' : '0';
    lignes.push(l);
  }
  return lignes.join('\n');
}
