// vitesse.js — le réglage de vitesse « voiture radiocommandée » : lent / normal / rapide / max.
// Le choix est une vitesse maximale en m/s ; la rotation maximale (rad/s) suit en proportion.

export const VITESSE_MIN = 0.15; // m/s
export const VITESSE_MAX = 1.0; // m/s (le rover accepte de 0,05 à 1,2)
export const ROTATION_MIN = 1.5; // rad/s pour la vitesse minimale
export const ROTATION_MAX = 4.0; // rad/s pour la vitesse maximale
export const CRANS = { lent: 0.15, normal: 0.4, rapide: 0.7, max: 1.0 };

export const limiterVitesse = (v) => Math.round(Math.min(VITESSE_MAX, Math.max(VITESSE_MIN, Number(v) || 0)) * 100) / 100;

/** Rotation maximale (rad/s) associée à une vitesse maximale (m/s), à 0,1 près. */
export function rotationPour(v) {
  const t = (limiterVitesse(v) - VITESSE_MIN) / (VITESSE_MAX - VITESSE_MIN);
  return Math.round((ROTATION_MIN + t * (ROTATION_MAX - ROTATION_MIN)) * 10) / 10;
}

/**
 * Les commandes texte à envoyer pour appliquer une vitesse choisie.
 * `vitesse 100` : c'est le paramètre v_max qui décide ; `v_rapide` (vitesse autorisée quand la voie est libre)
 * est réglé à la même valeur, sinon le rover dépasserait le choix.
 */
export function commandesVitesse(v) {
  const vit = limiterVitesse(v);
  return ['vitesse 100', `param v_max ${vit}`, `param v_rapide ${vit}`, `param w_max ${rotationPour(vit)}`];
}
