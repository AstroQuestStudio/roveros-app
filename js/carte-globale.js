// carte-globale.js — la carte de l'application : une carte « sans limite » rangée par tuiles de 64 × 64 cases.
//
// Chaque ligne reçue du rover (trame CARTE) est rangée à sa PLACE ABSOLUE : la case de colonne i de la ligne l d'une
// trame se trouve, dans le monde, à la case (ox + i, oy + l) — (ox, oy) étant l'origine de la fenêtre du rover à cet
// instant. La carte grandit à mesure (une tuile n'existe que si une case connue y a été écrite), sur des dizaines
// de mètres. Elle n'est qu'un affichage : le rover n'en dépend jamais.
//
// Une case écrite « inconnue » (0) EFFACE : c'est ainsi que « carte raz » et les obstacles qui disparaissent se voient.
// Ce que le rover a oublié en glissant (hors de sa fenêtre) n'est plus renvoyé : l'application le garde.

export const TUILE = 64;

const mod = (a, n) => ((a % n) + n) % n;
const cle = (tx, ty) => `${tx},${ty}`;

export class CarteGlobale {
  constructor() {
    this.tuiles = new Map(); // « tx,ty » -> { tx, ty, v: Uint8Array, t: Uint8Array, sale: boolean, formes: object | null }
    this.reinitialiserEtendue();
    this.version = 0; // augmente à chaque modification (pour savoir s'il faut redessiner)
  }

  reinitialiserEtendue() { this.minCx = Infinity; this.maxCx = -Infinity; this.minCy = Infinity; this.maxCy = -Infinity; }

  /** Vide toute la carte (carte raz, rover reposé, nouvelle connexion). */
  effacer() { this.tuiles.clear(); this.reinitialiserEtendue(); this.version++; }

  tuile(tx, ty, creer = false) {
    const k = cle(tx, ty);
    let t = this.tuiles.get(k);
    if (!t && creer) {
      t = { tx, ty, v: new Uint8Array(TUILE * TUILE), t: new Uint8Array(TUILE * TUILE), sale: true, formes: null };
      this.tuiles.set(k, t);
    }
    return t;
  }

  /** Valeur d'une case absolue (0 = inconnue si personne n'y a jamais écrit). */
  valeur(cx, cy) {
    const t = this.tuiles.get(cle(Math.floor(cx / TUILE), Math.floor(cy / TUILE)));
    return t ? t.v[mod(cy, TUILE) * TUILE + mod(cx, TUILE)] : 0;
  }

  _salir(tx, ty) { const t = this.tuiles.get(cle(tx, ty)); if (t) t.sale = true; }

  /**
   * Range les lignes d'une trame CARTE décodée { ligne, lignes } à leur place absolue.
   * @param {object} origine  { ox, oy } : l'origine de la fenêtre du rover pour cette trame
   * @returns {number} nombre de cases qui ont changé
   */
  ranger(msg, origine) {
    let changees = 0;
    msg.lignes.forEach((cases, k) => {
      const cy = origine.oy + msg.ligne + k;
      const ty = Math.floor(cy / TUILE); const ly = mod(cy, TUILE);
      for (let i = 0; i < TUILE; i++) {
        const cx = origine.ox + i;
        const tx = Math.floor(cx / TUILE); const lx = mod(cx, TUILE);
        const val = cases[i];
        let t = this.tuiles.get(cle(tx, ty));
        if (!t) { if (val === 0) continue; t = this.tuile(tx, ty, true); }
        const idx = ly * TUILE + lx;
        if (t.v[idx] === val) continue;
        t.v[idx] = val;
        changees++;
        t.sale = true;
        // une case au bord d'une tuile change aussi le contour des tuiles voisines
        if (lx === 0) this._salir(tx - 1, ty); else if (lx === TUILE - 1) this._salir(tx + 1, ty);
        if (ly === 0) this._salir(tx, ty - 1); else if (ly === TUILE - 1) this._salir(tx, ty + 1);
        if (val !== 0) {
          if (cx < this.minCx) this.minCx = cx; if (cx > this.maxCx) this.maxCx = cx;
          if (cy < this.minCy) this.minCy = cy; if (cy > this.maxCy) this.maxCy = cy;
        }
      }
    });
    if (changees) this.version++;
    return changees;
  }

  /** Note qu'un écho du sonar est tombé dans cette case (face d'obstacle « touchée »). Renvoie true si c'est nouveau. */
  marquerTouche(cx, cy) {
    const t = this.tuile(Math.floor(cx / TUILE), Math.floor(cy / TUILE), true);
    const idx = mod(cy, TUILE) * TUILE + mod(cx, TUILE);
    if (t.t[idx]) return false;
    t.t[idx] = 1; t.sale = true;
    return true;
  }

  /** Étendue des cases connues, en cases absolues : { minCx, maxCx, minCy, maxCy } ou null si la carte est vide. */
  get etendue() {
    if (this.minCx > this.maxCx) return null;
    return { minCx: this.minCx, maxCx: this.maxCx, minCy: this.minCy, maxCy: this.maxCy };
  }

  /** Nombre de cases connues (non nulles). */
  compter() {
    let n = 0;
    for (const t of this.tuiles.values()) for (const v of t.v) if (v) n++;
    return n;
  }
}
