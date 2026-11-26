// gabarit.js — les dimensions réelles du rover, à UN seul endroit (mètres).
// Tout ce qui dessine le rover ou en tient compte (carte, rover simulé de la démo) les lit ici.
//
//   - 25 cm de long, 20 cm de large ;
//   - le capteur à ultrasons est centré en largeur, à 3 cm en retrait du pare-chocs avant,
//     donc à 9,5 cm devant le centre du rover.

export const LONGUEUR_ROVER = 0.25;
export const LARGEUR_ROVER = 0.20;
export const RETRAIT_SONAR = 0.03;

/** Distance du capteur au centre du rover, vers l'avant : 0,095 m. */
export const SONAR_DEVANT_CENTRE = LONGUEUR_ROVER / 2 - RETRAIT_SONAR;

/** Rayon du cercle qui entoure tout le châssis (le coin du rover le plus éloigné du centre) : ~0,16 m. */
export const RAYON_CIRCONSCRIT = Math.hypot(LONGUEUR_ROVER / 2, LARGEUR_ROVER / 2);

/** Position du capteur dans le repère du monde, pour un rover en (x, y) et de cap `cap` (radians, horaire depuis +y). */
export function positionSonar(x, y, cap) {
  return { x: x + Math.sin(cap) * SONAR_DEVANT_CENTRE, y: y + Math.cos(cap) * SONAR_DEVANT_CENTRE };
}
