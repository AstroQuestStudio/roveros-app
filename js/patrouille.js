// patrouille.js — la patrouille par points : on touche jusqu'à 6 points sur la carte, numérotés, puis « Lancer ».
// L'application envoie « mode patrouille x1 y1 x2 y2 … » (mètres, repère de la carte, 2 décimales) ;
// le rover enchaîne les points en boucle.

export const MAX_POINTS = 6;
export const MIN_POINTS = 2;
export const PORTEE_PATROUILLE = 5.0; // rust100/src/systeme.rs:714 : |x| <= 5.0 et |y| <= 5.0

const deux = (v) => {
  const t = (Math.round(v * 100) / 100).toFixed(2);
  return t === '-0.00' ? '0.00' : t;
};

/** La commande texte à envoyer pour une liste de points { x, y } en mètres, ou null si elle est vide ou invalide. */
export function commandePatrouille(points) {
  const bons = points.filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y)).slice(0, MAX_POINTS);
  if (bons.length === 0) return null;
  return `mode patrouille ${bons.map((p) => `${deux(p.x)} ${deux(p.y)}`).join(' ')}`;
}

export class Patrouille {
  constructor() {
    this.actif = false; // le mode « toucher les points » est ouvert
    this.points = [];
  }

  /** Ajoute un point (numéroté dans l'ordre). Renvoie false si la liste est pleine. */
  ajouter(x, y) {
    if (this.points.length >= MAX_POINTS || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    this.points.push({ x, y });
    return true;
  }

  annulerDernier() { this.points.pop(); }
  effacer() { this.points = []; }

  get pleine() { return this.points.length >= MAX_POINTS; }
  get lancable() { return this.points.length >= MIN_POINTS; }
  commande() { return this.lancable ? commandePatrouille(this.points) : null; }
}
