// icones.js — petites icônes au trait (grille 24×24), dessinées pour RoverOS, sans police d'icônes.
// On stocke le contenu SVG de chaque icône ; icone(nom) renvoie un <svg> prêt à insérer dans la page.

const ICONES = {
  // --- comportements du rover ---
  chien: '<circle cx="6.5" cy="10" r="1.7"/><circle cx="10.2" cy="6" r="1.7"/><circle cx="15.8" cy="6" r="1.7"/><circle cx="19.5" cy="10" r="1.7"/><path d="M12 12c-3 0-5.5 3-5.5 5.2 0 1.7 1.5 2.3 3 2 1-.2 1.6-.5 2.5-.5s1.5.3 2.5.5c1.5.3 3-.3 3-2C17.5 15 15 12 12 12z"/>',
  explorer: '<circle cx="12" cy="12" r="9"/><path d="M15.6 8.4l-2.1 5.1-5.1 2.1 2.1-5.1z"/>',
  base: '<path d="M4 11.5L12 4.5l8 7"/><path d="M6 10.5V19h12v-8.5"/><path d="M10 19v-5h4v5"/>',
  carre: '<path d="M6 19V8h12v11z"/><path d="M3.5 6.5L6 4l2.5 2.5"/><path d="M6 4v4"/>',
  glisse: '<path d="M4 8h13M13 4l4 4-4 4"/><path d="M20 16H7M11 12l-4 4 4 4"/>',
  danse: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  mur: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M3 10h18M3 15h18M9 5v5M15 10v5M9 15v4"/>',
  slalom: '<path d="M3 13c2-7 6-8 9-4s6 4 9-3"/><circle cx="6" cy="19" r="1.5"/><circle cx="12" cy="19" r="1.5"/><circle cx="18" cy="19" r="1.5"/>',
  calibrer: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/>',
  arret: '<rect x="6" y="6" width="12" height="12" rx="2.5"/>',
  manuel: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v8M8 12h8"/>',
  generique: '<circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01"/>',
  // --- navigation ---
  pilotage: '<path d="M12 3l-3 3.2h6zM12 21l-3-3.2h6zM3 12l3.2-3v6zM21 12l-3.2-3v6z"/><circle cx="12" cy="12" r="1.6"/>',
  modes: '<rect x="4" y="4" width="7" height="7" rx="1.8"/><rect x="13" y="4" width="7" height="7" rx="1.8"/><rect x="4" y="13" width="7" height="7" rx="1.8"/><rect x="13" y="13" width="7" height="7" rx="1.8"/>',
  bord: '<path d="M4.5 17a7.5 7.5 0 1 1 15 0"/><path d="M12 17l3.6-5"/><path d="M4 20h16"/>',
  reglages: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  partage: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h3v3h-3zM19 14h1M14 19h1M17.5 19.5H20M20 17v.01"/>',
  journal: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.8" cy="6" r="1"/><circle cx="4.8" cy="12" r="1"/><circle cx="4.8" cy="18" r="1"/>',
  // --- liaison ---
  bluetooth: '<path d="M7 7.5l10 9-5 4.5V3l5 4.5-10 9"/>',
  reseau: '<path d="M10 14l4-4"/><path d="M8.5 12.5l-2 2a3.2 3.2 0 0 0 4.5 4.5l2-2"/><path d="M15.5 11.5l2-2A3.2 3.2 0 0 0 13 5l-2 2"/>',
  demo: '<circle cx="12" cy="12" r="9"/><path d="M10 8.3l6 3.7-6 3.7z"/>',
  // --- actions ---
  recentrer: '<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.4"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  moins: '<path d="M5 12h14"/>',
  incliner: '<g transform="rotate(24 12 12)"><rect x="8" y="3" width="8" height="18" rx="2"/><path d="M11 18h2"/></g>',
  urgence: '<path d="M8.6 3h6.8L21 8.6v6.8L15.4 21H8.6L3 15.4V8.6z"/><path d="M12 7.5v5.5M12 16.2v.01"/>',
  cadenas: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  copier: '<rect x="8" y="8" width="11" height="12" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  envoyer: '<path d="M4 12l16-8-6 16-3-7z"/>',
  fermer: '<path d="M6 6l12 12M18 6L6 18"/>',
  recherche: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.2-4.2"/>',
  installer: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19h14"/>',
  batterie: '<rect x="3" y="8" width="16" height="9" rx="2"/><path d="M21 11v3"/>',
  radar: '<path d="M4 18a8 8 0 0 1 16 0"/><path d="M12 18l5-7"/><path d="M8 18a4 4 0 0 1 8 0"/>',
  dispo: '<rect x="4" y="4" width="16" height="7" rx="1.8"/><rect x="4" y="14" width="16" height="6" rx="1.8"/>',
  ok: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  alerte: '<path d="M12 4l9 16H3z"/><path d="M12 10v4.5M12 17.4v.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.8v.01"/>',
};

/** Renvoie le code d'une icône sous forme de <svg>. taille en pixels (CSS). */
export function icone(nom, taille = 24) {
  const contenu = ICONES[nom] ?? ICONES.generique;
  return `<svg class="ico" width="${taille}" height="${taille}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${contenu}</svg>`;
}

export const aIcone = (nom) => nom in ICONES;

/** Libellés français et icônes des comportements connus du rover. */
export const MODES_FR = {
  chien: { libelle: 'Chien', aide: 'Suit une cible à distance', icone: 'chien' },
  explorer: { libelle: 'Explorer', aide: 'Cartographie la pièce seul', icone: 'explorer' },
  base: { libelle: 'Retour base', aide: 'Revient à son point de départ', icone: 'base' },
  carre: { libelle: 'Carré', aide: 'Trace un carré en tournant', icone: 'carre' },
  glisse: { libelle: 'Glisse', aide: 'Carré sans tourner, sur le côté', icone: 'glisse' },
  danse: { libelle: 'Danse', aide: 'Petite chorégraphie', icone: 'danse' },
  mur: { libelle: 'Longer le mur', aide: 'Suit le mur à 30 cm', icone: 'mur' },
  slalom: { libelle: 'Slalom', aide: 'Avance en zigzag', icone: 'slalom' },
  calibrer: { libelle: 'Calibrer', aide: 'Étalonne le gyroscope', icone: 'calibrer' },
  arret: { libelle: 'Arrêter', aide: 'Stoppe le comportement en cours', icone: 'arret' },
  manuel: { libelle: 'Manuel', aide: 'Pilotage à la main', icone: 'manuel' },
};

/** Libellé lisible d'un comportement, même inconnu (« mon_mode » -> « Mon mode »). */
export function libelleMode(nom) {
  if (MODES_FR[nom]) return MODES_FR[nom].libelle;
  const t = String(nom).replace(/[_-]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}
