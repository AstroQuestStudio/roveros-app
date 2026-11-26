// lissage.js — afficher le rover « à la cadence de l'écran » alors que le rover n'envoie son état que 8 à 20 fois par seconde.
//
// Principe : on affiche avec un retard d'environ une trame et on interpole entre les deux dernières trames reçues.
// Trois protections, ajoutées après un essai réel (« rover immobile, mais l'image bouge tout le temps ») :
//   1. Les trames ne sont pas rangées à leur heure d'arrivée (le Bluetooth livre par paquets : 2 ms puis 120 ms), mais sur une
//      frise régulière recalée doucement sur les arrivées. Sans cela, une trame arrivée 3 ms après la précédente donnait une
//      « vitesse » 30 fois trop grande.
//   2. Si une trame tarde, le mouvement est prolongé avec la vitesse mesurée, au plus 150 ms, et seulement si le déplacement
//      entre les deux trames dépasse le bruit (2 mm, 0,1°) : le bruit d'un rover à l'arrêt n'est jamais amplifié.
//   3. La tête du sonar (qui balaie entre deux butées) n'est jamais prolongée : elle ne dépasse pas ses butées au demi-tour.
// Le cap et l'angle de la tête sont interpolés par le plus court chemin (359° -> 0° ne fait pas un tour complet).

/** Ramène un angle en degrés dans [−180 ; 180[. */
export const normaliser180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

/** Écart signé le plus court pour aller de l'angle a à l'angle b (degrés). */
export const ecartAngle = (a, b) => normaliser180(b - a);

const limiter = (v, a, b) => Math.min(b, Math.max(a, v));

const BRUIT_POSITION = 0.002; // m : en dessous, deux trames voisines disent « il ne bouge pas »
const BRUIT_ANGLE = 0.1; // degrés

export class Lisseur {
  /**
   * @param {object} o  extrapolationMax : durée maximale de prolongation après la dernière trame (ms, 150)
   *                    sautMax : au-delà de ce déplacement entre deux trames (m), on ne glisse pas : le rover a été
   *                              reposé ou recalé, on saute directement à la nouvelle position
   *                    pauseMax : sans trame depuis cette durée (ms), la trame suivante repart de zéro
   */
  constructor({ extrapolationMax = 150, sautMax = 0.6, pauseMax = 700 } = {}) {
    this.extrapolationMax = extrapolationMax;
    this.sautMax = sautMax;
    this.pauseMax = pauseMax;
    this.reinitialiser();
  }

  reinitialiser() {
    this.p2 = null; this.tp2 = 0; // trame d'avant
    this.prec = null; // avant-dernière trame : { x, y, cap, tete } et son heure tp
    this.tp = 0;
    this.dern = null; // dernière trame
    this.td = 0; // heure (sur la frise régulière) de la dernière trame
    this.tArrivee = 0; // heure d'arrivée réelle de la dernière trame
    this.intervalle = 100; // durée typique entre deux trames (ms)
    this.arrivees = []; // heures d'arrivée des dernières trames
    this.gigue = 5; // écart moyen entre l'arrivée réelle et la frise (ms)
    this.sortie = null; // dernière valeur rendue par lire()
    this.tLecture = 0;
  }

  /** Une trame ÉTAT est arrivée à l'heure t (ms). etat : { x, y (m), cap, tete (degrés) }. */
  pousser(etat, t) {
    const e = { x: etat.x, y: etat.y, cap: etat.cap, tete: etat.tete ?? 0 };
    if (!this.dern) { this.dern = e; this.td = t; this.tArrivee = t; this.arrivees = [t]; return; }
    const dt = t - this.tArrivee;
    if (dt > this.pauseMax || Math.hypot(e.x - this.dern.x, e.y - this.dern.y) > this.sautMax) {
      this.reinitialiser();
      this.dern = e; this.td = t; this.tArrivee = t; this.arrivees = [t];
      return;
    }
    // Frise régulière : on avance d'un intervalle par trame (plusieurs si des trames ont été perdues) et on se recale
    // doucement sur l'heure d'arrivée réelle.
    const manquees = dt > 1.9 * this.intervalle && this.arrivees.length >= 5 ? Math.round(dt / this.intervalle) : 1; // 1,7 : au-delà, une trame au moins a été perdue
    const attendu = this.td + manquees * this.intervalle;
    const ecart = t - attendu;
    let nouveau;
    if (Math.abs(ecart) > 3 * this.intervalle) nouveau = t; // l'horloge a décroché : on se recale d'un coup
    else nouveau = attendu + 0.1 * ecart;
    nouveau = Math.max(nouveau, this.td + 0.7 * this.intervalle); // jamais deux trames quasi au même instant
    this.gigue = limiter(this.gigue * 0.9 + Math.abs(ecart) * 0.1, 5, 40);
    // La cadence : médiane des durées de 4 trames, divisées par 4. La gigue d'arrivée (±35 ms) est divisée par 4,
    // une trame perdue ne fausse que quelques valeurs, et l'estimation ne peut pas s'effondrer.
    this.arrivees.push(t);
    if (this.arrivees.length > 24) this.arrivees.shift();
    const A = this.arrivees;
    if (A.length >= 9) {
      const tri = [];
      for (let i = 4; i < A.length; i++) tri.push((A[i] - A[i - 4]) / 4);
      tri.sort((p, q) => p - q);
      this.intervalle = limiter(tri[tri.length >> 1], 30, 250);
    } else this.intervalle = limiter((A[A.length - 1] - A[0]) / Math.max(1, A.length - 1), 30, 250);
    this.p2 = this.prec; this.tp2 = this.tp; // une trame de plus d'historique : on peut afficher jusqu'à deux intervalles en arrière
    this.prec = this.dern; this.tp = this.td;
    this.dern = e; this.td = nouveau; this.tArrivee = t;
  }

  /** Position à afficher à l'heure `maintenant` (ms), ou null si aucune trame n'est arrivée. */
  lire(maintenant) {
    if (!this.dern) return null;
    if (!this.prec) return { ...this.dern, mode: 'fige' };
    const affichage = maintenant - (this.intervalle + 1.5 * this.gigue); // on affiche une trame (et la gigue) en arrière
    // le segment qui contient l'instant affiché : le dernier, ou celui d'avant quand le retard dépasse un intervalle
    let a = this.prec; let b = this.dern; let ta = this.tp; let tb = this.td;
    if (affichage < this.tp && this.p2) { a = this.p2; b = this.prec; ta = this.tp2; tb = this.tp; }
    const duree = tb - ta;
    let u = (affichage - ta) / duree;
    let mode = 'interpole';
    if (u < 0) { u = 0; mode = 'retard'; }
    const uMax = 1 + this.extrapolationMax / duree;
    if (u > 1) mode = u > uMax ? 'fige' : 'extrapole';
    u = Math.min(u, uMax);
    // On ne prolonge un mouvement que s'il dépasse le bruit : un rover à l'arrêt n'est jamais « extrapolé ».
    const bouge = Math.hypot(b.x - a.x, b.y - a.y) >= BRUIT_POSITION;
    const tourne = Math.abs(ecartAngle(a.cap, b.cap)) >= BRUIT_ANGLE;
    const up = bouge ? u : Math.min(u, 1);
    const uc = tourne ? u : Math.min(u, 1);
    const cible = {
      x: a.x + (b.x - a.x) * up,
      y: a.y + (b.y - a.y) * up,
      cap: normaliser180(a.cap + ecartAngle(a.cap, b.cap) * uc),
      // la tête du sonar balaie entre deux butées : prolonger son mouvement la ferait dépasser la butée à chaque demi-tour
      tete: normaliser180(a.tete + ecartAngle(a.tete, b.tete) * Math.min(u, 1)),
    };
    // Rattrapage progressif : si la cible a pris de l'avance (trames manquantes puis retrouvées), l'affichage
    // la rejoint à 2,5 fois la vitesse du rover au plus, au lieu de sauter d'un coup.
    const s0 = this.sortie;
    const dt = Math.min(100, Math.max(0, maintenant - this.tLecture));
    this.tLecture = maintenant;
    if (s0 && dt > 0) {
      const marge = 2.5 * dt / duree;
      const lim = (ecart, par) => Math.max(-par, Math.min(par, ecart));
      const dx = b.x - a.x; const dy = b.y - a.y; const pas = Math.hypot(dx, dy) * marge + 0.0005;
      const ex = cible.x - s0.x; const ey = cible.y - s0.y; const dist = Math.hypot(ex, ey);
      if (dist > pas) { cible.x = s0.x + (ex / dist) * pas; cible.y = s0.y + (ey / dist) * pas; }
      const rot = (ecart, ref) => lim(ecart, Math.abs(ecartAngle(a[ref], b[ref])) * marge + 0.05);
      cible.cap = normaliser180(s0.cap + rot(ecartAngle(s0.cap, cible.cap), 'cap'));
      cible.tete = normaliser180(s0.tete + rot(ecartAngle(s0.tete, cible.tete), 'tete'));
    }
    this.sortie = { x: cible.x, y: cible.y, cap: cible.cap, tete: cible.tete };
    return { ...cible, mode };
  }

  /** Vrai tant que des trames arrivent : il faut continuer à redessiner à chaque image. */
  actif(maintenant) {
    return !!this.dern && maintenant - this.tArrivee < this.pauseMax;
  }
}
