// trace.js — la trace du trajet : l'historique des positions que le rover annonce.
// Bornée en mémoire (2 000 points par défaut), un point tous les 2 cm au plus.

export class Trace {
  /**
   * @param {object} o  max : nombre maximal de points gardés (les plus anciens sont oubliés)
   *                    espacement : distance minimale (m) entre deux points
   */
  constructor({ max = 2000, espacement = 0.02 } = {}) {
    this.max = max;
    this.espacement = espacement;
    this.points = [];
  }

  /** Ajoute la position (m) si elle est à `espacement` du dernier point. Renvoie true si elle a été gardée. */
  ajouter(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const dernier = this.points[this.points.length - 1];
    if (dernier && Math.hypot(x - dernier.x, y - dernier.y) < this.espacement) return false;
    this.points.push({ x, y });
    if (this.points.length > this.max) this.points.splice(0, this.points.length - this.max);
    return true;
  }

  /** Efface tout (rover reposé, « Je suis à la base »). */
  effacer() { this.points = []; }

  get longueur() { return this.points.length; }
}
