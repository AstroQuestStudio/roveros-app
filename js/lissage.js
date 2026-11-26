// lissage.js — afficher le rover « à la cadence de l'écran » alors que le rover n'envoie son état que 8 à 20 fois par seconde.
//
// Principe : on affiche avec un retard d'une trame et on interpole entre les deux dernières trames reçues.
// Si une trame tarde, on prolonge le mouvement avec la vitesse mesurée entre ces deux trames, mais au plus
// pendant `extrapolationMax` ms : si les trames s'arrêtent, le rover affiché s'immobilise au lieu de dériver.
// Le cap et l'angle de la tête sont interpolés par le plus court chemin (359° -> 0° ne fait pas un tour complet).

/** Ramène un angle en degrés dans [−180 ; 180[. */
export const normaliser180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

/** Écart signé le plus court pour aller de l'angle a à l'angle b (degrés). */
export const ecartAngle = (a, b) => normaliser180(b - a);

const limiter = (v, a, b) => Math.min(b, Math.max(a, v));

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
    this.prec = null; // avant-dernière trame : { x, y, cap, tete } et son heure tp
    this.tp = 0;
    this.dern = null; // dernière trame
    this.td = 0; // heure d'arrivée de la dernière trame
    this.intervalle = 100; // durée moyenne entre deux trames (ms)
    this.sortie = null; // dernière valeur rendue par lire()
    this.tLecture = 0;
  }

  /** Une trame ÉTAT est arrivée à l'heure t (ms). etat : { x, y (m), cap, tete (degrés) }. */
  pousser(etat, t) {
    const e = { x: etat.x, y: etat.y, cap: etat.cap, tete: etat.tete ?? 0 };
    if (!this.dern) { this.dern = e; this.td = t; return; }
    const dt = t - this.td;
    if (dt < 4) { this.dern = e; return; } // deux trames collées : la plus récente remplace l'autre
    if (dt > this.pauseMax || Math.hypot(e.x - this.dern.x, e.y - this.dern.y) > this.sautMax) {
      this.reinitialiser();
      this.dern = e; this.td = t;
      return;
    }
    this.prec = this.dern; this.tp = this.td;
    this.dern = e; this.td = t;
    // Une ou plusieurs trames perdues ne doivent pas allonger le retard : on mesure la cadence « normale ».
    const manquees = Math.max(1, Math.round(dt / this.intervalle));
    this.intervalle = limiter(this.intervalle * 0.7 + (dt / manquees) * 0.3, 30, 250);
  }

  /** Position à afficher à l'heure `maintenant` (ms), ou null si aucune trame n'est arrivée. */
  lire(maintenant) {
    if (!this.dern) return null;
    if (!this.prec) return { ...this.dern, mode: 'fige' };
    const duree = this.td - this.tp;
    const affichage = maintenant - this.intervalle; // on affiche une trame en arrière
    let u = (affichage - this.tp) / duree;
    let mode = 'interpole';
    if (u < 0) { u = 0; mode = 'retard'; }
    const uMax = 1 + this.extrapolationMax / duree;
    if (u > 1) mode = u > uMax ? 'fige' : 'extrapole';
    u = Math.min(u, uMax);
    const a = this.prec; const b = this.dern;
    const cible = {
      x: a.x + (b.x - a.x) * u,
      y: a.y + (b.y - a.y) * u,
      cap: normaliser180(a.cap + ecartAngle(a.cap, b.cap) * u),
      tete: normaliser180(a.tete + ecartAngle(a.tete, b.tete) * u),
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
      const rot = (ecart, ref) => lim(ecart, Math.abs(ecartAngle(a[ref], b[ref])) * marge + 0.3);
      cible.cap = normaliser180(s0.cap + rot(ecartAngle(s0.cap, cible.cap), 'cap'));
      cible.tete = normaliser180(s0.tete + rot(ecartAngle(s0.tete, cible.tete), 'tete'));
    }
    this.sortie = { x: cible.x, y: cible.y, cap: cible.cap, tete: cible.tete };
    return { ...cible, mode };
  }

  /** Vrai tant que des trames arrivent : il faut continuer à redessiner à chaque image. */
  actif(maintenant) {
    return !!this.dern && maintenant - this.td < this.pauseMax;
  }
}
