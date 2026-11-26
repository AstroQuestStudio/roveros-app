// repere.js — le repère de la carte sans limite (voir docs/CARTE_SANS_LIMITE.md du dépôt roveros).
//
// Le rover garde une grille de 64 × 64 cases qui GLISSE avec lui. Son origine (ox, oy), en cases entières du monde,
// est annoncée par la trame ORIGINE (0x86). Les positions des trames ÉTAT, POINTS et CHEMIN sont envoyées en
// millimètres RELATIVES au centre de la fenêtre (case origine + 32) ; ALLER est reçue de la même façon.
// L'application, elle, travaille en coordonnées ABSOLUES (mètres, repère du départ) : la carte globale, la trace, la base.
//
// Tant qu'aucune trame ORIGINE n'est reçue (rover non mis à jour), l'origine est (−32, −32) : le centre est (0, 0) et
// tout se lit comme avant.

export const DEMI_FENETRE = 32; // la fenêtre fait 64 cases : son centre est à 32 cases de l'origine
export const PORTEE_ALLER_MAX = 30; // m : « aller ici » au-delà est refusé

export class Repere {
  constructor() { this.reinitialiser(); }

  /** Retour au repère de départ (connexion, recalage : la position actuelle redevient l'origine). */
  reinitialiser() {
    this.ox = -DEMI_FENETRE; this.oy = -DEMI_FENETRE;
    this.version = 0;
    this.cellule = 0.05; // m
    this.recu = false; // une trame ORIGINE est-elle arrivée ?
    this.anciens = new Map(); // version -> { ox, oy } : les trames déjà en route lors d'un décalage restent lisibles
  }

  /** Taille d'une case en mètres (ligne « info cellule=… »). N'écrase pas celle d'une trame ORIGINE. */
  definirCellule(m) { if (!this.recu && m > 0.005 && m < 1) this.cellule = m; }

  /**
   * Une trame ORIGINE est arrivée. Renvoie { change, decalageCases: { dx, dy } } : de combien de cases la fenêtre
   * a glissé depuis l'origine précédente (0, 0 la première fois).
   */
  appliquer({ ox, oy, version, cellule }) {
    const avant = { ox: this.ox, oy: this.oy, version: this.version };
    const premiere = !this.recu;
    this.anciens.set(avant.version, { ox: avant.ox, oy: avant.oy });
    while (this.anciens.size > 4) this.anciens.delete(this.anciens.keys().next().value);
    this.ox = ox; this.oy = oy; this.version = version; this.recu = true;
    if (cellule > 0) this.cellule = cellule / 1000;
    const change = !premiere && (ox !== avant.ox || oy !== avant.oy);
    const dx = premiere ? 0 : ox - avant.ox; const dy = premiere ? 0 : oy - avant.oy;
    // un décalage normal est de 16 cases ; plus d'une demi-fenêtre d'un coup, c'est un recalage ou une longue absence
    const saut = !premiere && Math.max(Math.abs(dx), Math.abs(dy)) > DEMI_FENETRE;
    if (saut) this.anciens.clear();
    return { change, saut, decalageCases: { dx, dy } };
  }

  /** Centre de la fenêtre courante, en mètres absolus. */
  centre(origine = this) {
    return { x: (origine.ox + DEMI_FENETRE) * this.cellule, y: (origine.oy + DEMI_FENETRE) * this.cellule };
  }

  /** L'origine qui correspond à une version annoncée par une trame ÉTAT (undefined = rover sans carte sans limite). */
  origineDe(version) {
    if (!this.recu || version === undefined || version === this.version) return this;
    return this.anciens.get(version) ?? null;
  }

  /** Position reçue (mm relatifs au centre de la fenêtre) -> mètres absolus ; null si le repère de la trame est inconnu. */
  absolu(xMm, yMm, version) {
    if (version !== undefined && this.recu && (version & 1)) return null; // version impaire : la fenêtre est en train de glisser
    const o = this.origineDe(version);
    if (!o) return null;
    const c = this.centre(o);
    return { x: c.x + xMm / 1000, y: c.y + yMm / 1000 };
  }

  /** Position absolue (m) -> millimètres relatifs au centre courant, pour ALLER ; null si elle est à plus de 30 m. */
  relatif(x, y) {
    const c = this.centre();
    const dx = x - c.x; const dy = y - c.y;
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) > PORTEE_ALLER_MAX) return null;
    return { xMm: Math.round(dx * 1000), yMm: Math.round(dy * 1000) };
  }
}
