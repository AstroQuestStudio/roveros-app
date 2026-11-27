// figures.js — figures de conduite pour le rover à quatre roues Mecanum. Logique pure, sans DOM.
//
// Repère de l'application : x vers la droite, y vers l'avant, w positif = rotation HORAIRE vue d'en haut
// (comme la manette de rotation et la touche E). Pour un corps rigide, le point (x, y) du rover se déplace
// à (vx + w·y, vy − w·x) dans son propre repère.
//
// Chaque figure est une fonction du temps : commande(t) rend { vx, vy, w } en POURCENT (−100…100),
// comme les trames MANETTE. 100 % de vx ou vy = v_max (m/s), 100 % de w = w_max (rad/s).

export const RAMPE_S = 0.3; // rampe douce au départ et à la fin, pour ne pas brutaliser les moteurs
export const BORNES = { rayon: [0.3, 1.5], cote: [0.3, 1.0], vitesse: [0.2, 1.0] };
export const NOMS_FIGURES = { orbite: 'Orbite', pivot: 'Pivot', diagonale: 'Diagonale', carre: 'Carré', huit: 'Huit' };

const limiter = (v, a, b) => Math.min(b, Math.max(a, v));
const pour100 = (v, max) => (max > 0 ? (100 * v) / max : 0);
const borner = (v, [a, b]) => limiter(Number(v) || a, a, b);

/** Enveloppe 0…1 : rampe au départ et, si la figure a une durée finie, rampe de fin. */
export function enveloppe(t, duree = Infinity, rampe = RAMPE_S) {
  if (t < 0 || t >= duree) return 0;
  if (!(rampe > 0)) return 1;
  let k = Math.min(1, t / rampe);
  if (Number.isFinite(duree)) k = Math.min(k, (duree - t) / rampe);
  return limiter(k, 0, 1);
}

/** Habille une fonction de base (sans enveloppe) : enveloppe, bornage à ±100, durée. */
function figure(nom, base, periode, duree = Infinity) {
  return {
    nom,
    periode, // secondes pour un tour complet de la figure (Infinity si constante)
    duree,
    commande(t) {
      const k = enveloppe(t, duree);
      if (k === 0) return { vx: 0, vy: 0, w: 0 };
      const b = base(t);
      return {
        vx: limiter(k * b.vx, -100, 100),
        vy: limiter(k * b.vy, -100, 100),
        w: limiter(k * b.w, -100, 100),
      };
    },
  };
}

/**
 * Orbite : le rover glisse à v autour d'un point situé devant lui, à la distance R, et tourne pour
 * garder son nez vers ce point. Le centre (0, R) doit rester immobile dans le repère du rover :
 * vx + w·R = 0 et vy = 0, donc w = ±v/R et vx = −w·R.
 *   horaire : vx = −v, w = +v/R ; antihoraire : vx = +v, w = −v/R.
 *   v = vitesse · min(v_max, R·w_max) : ni vx ni w ne dépassent 100 %.
 */
export function figureOrbite({ vMax, wMax, rayon = 0.6, sens = 'horaire', vitesse = 1, duree } = {}) {
  const R = borner(rayon, BORNES.rayon);
  const v = borner(vitesse, BORNES.vitesse) * Math.min(vMax, R * wMax);
  const w = (sens === 'antihoraire' ? -1 : 1) * (v / R);
  return figure('orbite', () => ({ vx: pour100(-w * R, vMax), vy: 0, w: pour100(w, wMax) }), (2 * Math.PI * R) / v, duree);
}

/** Coins de rotation : [signe de x, signe de y]. */
export const COINS = {
  'avant-gauche': [-1, 1],
  'avant-droit': [1, 1],
  'arriere-gauche': [-1, -1],
  'arriere-droit': [1, -1],
};

/**
 * Pivot sur un coin : rotation w autour du point P = (px, py), décalé du centre du rover.
 * Le centre se déplace à (vx, vy) = (−w·py, +w·px) pour que P reste immobile (vérifié dans les essais).
 *   w = ±vitesse · min(w_max, v_max / max(demi-largeur, demi-longueur)) : vx et vy restent dans v_max.
 */
export function figurePivot({
  vMax, wMax, coin = 'avant-gauche', demiLongueur = 0.09, demiLargeur = 0.08, sens = 'horaire', vitesse = 1, duree,
} = {}) {
  const [sx, sy] = COINS[coin] ?? COINS['avant-gauche'];
  const px = sx * demiLargeur;
  const py = sy * demiLongueur;
  const wLimite = Math.min(wMax, vMax / Math.max(demiLargeur, demiLongueur));
  const w = (sens === 'antihoraire' ? -1 : 1) * borner(vitesse, BORNES.vitesse) * wLimite;
  const vx = -w * py;
  const vy = w * px;
  return figure('pivot', () => ({ vx: pour100(vx, vMax), vy: pour100(vy, vMax), w: pour100(w, wMax) }), (2 * Math.PI) / Math.abs(w), duree);
}

/** Directions de la diagonale : [signe de x, signe de y]. */
export const DIRECTIONS = {
  'avant-droite': [1, 1],
  'avant-gauche': [-1, 1],
  'arriere-droite': [1, -1],
  'arriere-gauche': [-1, -1],
};

/** Diagonale pure, sans tourner : la vitesse du centre vaut vitesse · v_max (chaque axe vaut v/√2). */
export function figureDiagonale({ vMax, direction = 'avant-droite', vitesse = 1, duree } = {}) {
  const [sx, sy] = DIRECTIONS[direction] ?? DIRECTIONS['avant-droite'];
  const a = borner(vitesse, BORNES.vitesse) * vMax / Math.SQRT2;
  return figure('diagonale', () => ({ vx: sx * pour100(a, vMax), vy: sy * pour100(a, vMax), w: 0 }), Infinity, duree);
}

/** Côtés du carré dans l'ordre : avant, droite, arrière, gauche. Le rover garde son orientation. */
const COTES = [[0, 1], [1, 0], [0, -1], [-1, 0]];

/** Carré sans tourner : quatre côtés de longueur `cote` parcourus à vitesse · v_max. */
export function figureCarre({ vMax, cote = 0.6, vitesse = 1, duree } = {}) {
  const v = borner(vitesse, BORNES.vitesse) * vMax;
  const T = borner(cote, BORNES.cote) / v; // durée d'un côté
  const periode = 4 * T;
  return figure('carre', (t) => {
    const [dx, dy] = COTES[Math.floor((t % periode) / T) % 4];
    return { vx: dx * pour100(v, vMax), vy: dy * pour100(v, vMax), w: 0 };
  }, periode, duree);
}

/**
 * Huit : deux cercles de rayon R parcourus l'un après l'autre, nez dans le sens de la marche.
 * Premier cercle horaire (vy = v, w = +v/R), second antihoraire (w = −v/R).
 */
export function figureHuit({ vMax, wMax, rayon = 0.6, vitesse = 1, duree } = {}) {
  const R = borner(rayon, BORNES.rayon);
  const v = borner(vitesse, BORNES.vitesse) * Math.min(vMax, R * wMax);
  const w = v / R;
  const demiTour = (2 * Math.PI * R) / v; // durée d'un cercle complet
  return figure('huit', (t) => {
    const sgn = Math.floor((t % (2 * demiTour)) / demiTour) === 0 ? 1 : -1;
    return { vx: 0, vy: pour100(v, vMax), w: sgn * pour100(w, wMax) };
  }, 2 * demiTour, duree);
}

/** Fabrique une figure par son nom : options = { vMax, wMax, ... } (voir chaque constructeur). */
export const FIGURES = { orbite: figureOrbite, pivot: figurePivot, diagonale: figureDiagonale, carre: figureCarre, huit: figureHuit };

export function creerFigure(nom, options) {
  const fabrique = FIGURES[nom];
  if (!fabrique) throw new Error(`figure inconnue : ${nom}`);
  return fabrique(options);
}

const MANETTES = ['joystick', 'rotation', 'clavier', 'inclinaison'];

/**
 * Joue une figure sur le Pilote, comme une source : la source `figure` du Pilote reçoit la commande
 * à chaque pas, et le doigt « posé » sur `figure` fait envoyer les trames à cadence fixe.
 * La figure s'arrête (consigne nulle puis STOP, comme un relâchement) dès que la liaison tombe, qu'une
 * manette est touchée (elle reste prioritaire) ou qu'on arrête explicitement.
 */
export class ConduiteFigure {
  /**
   * @param {object} pilote      une instance de Pilote (sources, contacts, maj, definirContact)
   * @param {object} options     horloge : () => ms ; estConnecte : () => bool ; pas : ms entre deux mises à jour
   */
  constructor(pilote, { horloge = () => performance.now(), estConnecte = () => true, pas = 50, minuterie = true } = {}) {
    this.pilote = pilote;
    this.horloge = horloge;
    this.estConnecte = estConnecte;
    this.pas = pas;
    this.minuterie = minuterie;
    this.figure = null;
    this._t0 = 0;
    this._horloge = null;
  }

  get actif() { return this.figure !== null; }

  /** Lance une figure. Renvoie false (et ne joue rien) sans liaison ou si une manette est déjà touchée. */
  demarrer(nom, options) {
    this.arreter();
    if (!this.estConnecte() || this._manetteTouchee()) return false;
    this.figure = creerFigure(nom, options);
    this._t0 = this.horloge();
    this.pilote.definirContact('figure', true);
    if (this.minuterie) this._horloge = setInterval(() => this.tick(), this.pas);
    this.tick();
    return true;
  }

  _manetteTouchee() {
    return MANETTES.some((n) => this.pilote.contacts.has(n));
  }

  /** Met à jour la consigne de la figure (appelé par la minuterie, ou à la main dans les essais). */
  tick(maintenant = this.horloge()) {
    if (!this.figure) return;
    if (!this.estConnecte() || this._manetteTouchee() || !this.pilote.contacts.has('figure')) { this.arreter(); return; }
    const c = this.figure.commande((maintenant - this._t0) / 1000);
    this.pilote.maj('figure', { x: c.vx / 100, y: c.vy / 100, w: c.w / 100 });
  }

  /** Arrête la figure : consigne nulle, puis le Pilote envoie STOP tout de suite (pas de lissage). */
  arreter() {
    if (!this.figure) return;
    clearInterval(this._horloge);
    this._horloge = null;
    this.figure = null;
    this.pilote.sources.figure = { x: 0, y: 0, w: 0 };
    this.pilote.definirContact('figure', false);
  }
}
