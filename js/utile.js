// utile.js — petits outils partagés.

/**
 * Écrit un texte dans un élément SEULEMENT s'il a changé.
 * Les trames d'état arrivent 10 fois par seconde : réécrire le même texte forcerait le navigateur
 * à recalculer la mise en page pour rien.
 */
export function poserTexte(el, texte) {
  const t = String(texte);
  if (el._texte !== t) { el._texte = t; el.textContent = t; }
}

/** Pareil pour un attribut data-… */
export function poserDonnee(el, cle, valeur) {
  const v = String(valeur);
  if (el.dataset[cle] !== v) el.dataset[cle] = v;
}
