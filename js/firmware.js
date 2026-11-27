// firmware.js — détection du firmware du rover et table de capacités.
//
// À partir de la ligne « info » et de la liste « modes » (plus d'éventuelles observations
// reçues en cours de session), produit un profil { famille, version, capacites }.
// Aucune dépendance au DOM : testable directement sous Node.

export const FAMILLES = {
  RUST: 'rust',
  MICROPYTHON: 'micropython',
  DEMO: 'demo',
  INCONNU: 'inconnu',
};

export const LIBELLES_FAMILLE = {
  rust: 'Firmware Rust',
  micropython: 'Firmware MicroPython',
  demo: 'Démonstration',
  inconnu: 'Firmware inconnu',
};

/** Capacités par défaut selon la famille du firmware. */
export const CAPACITES_FAMILLE = {
  rust: {
    manette: true,
    etat: true,
    carte: true,
    majSansFil: false,
    sauverParams: true,
    reglagesUsine: true,
    calibrationAuto: false,
    changementNom: true,
    diagnosticEtendu: true,
    bancEcho: true,
  },
  micropython: {
    manette: true,
    etat: true,
    carte: true,
    majSansFil: true,
    sauverParams: false,
    reglagesUsine: false,
    calibrationAuto: true,
    changementNom: true,
    diagnosticEtendu: false,
    bancEcho: false,
  },
  demo: {
    manette: true,
    etat: true,
    carte: true,
    majSansFil: false,
    sauverParams: false,
    reglagesUsine: false,
    calibrationAuto: true,
    changementNom: false,
    diagnosticEtendu: false,
    bancEcho: false,
  },
  inconnu: {
    manette: true,
    etat: true,
    carte: true,
    majSansFil: false,
    sauverParams: false,
    reglagesUsine: false,
    calibrationAuto: false,
    changementNom: false,
    diagnosticEtendu: false,
    bancEcho: false,
  },
};

function detecterFamille(version) {
  if (!version) return FAMILLES.INCONNU;
  if (/^rust/i.test(version)) return FAMILLES.RUST;
  if (/^demo/i.test(version)) return FAMILLES.DEMO;
  if (/^\d+\.\d+(\.\d+)?([+-].*)?$/.test(version)) return FAMILLES.MICROPYTHON;
  return FAMILLES.INCONNU;
}

const drapeauInfo = (valeur) => {
  if (typeof valeur === 'boolean') return valeur;
  const n = Number(valeur);
  return Number.isFinite(n) ? n !== 0 : undefined;
};

/**
 * Construit le profil du rover à partir de :
 *   - info     : objet issu de la ligne « info ... »
 *   - modes    : tableau issu de la ligne « modes ... »
 *   - annonces : observations reçues (majIndisponible, diagnosticEtendu, bancEcho, nomIndisponible, profil)
 */
export function detecterFirmware(info = {}, modes = [], annonces = {}) {
  const inf = info && typeof info === 'object' ? info : {};
  const version = inf.version !== undefined && inf.version !== null ? String(inf.version).trim() : '';
  const nom = inf.nom !== undefined && inf.nom !== null ? String(inf.nom).trim() : '';
  const famille = detecterFamille(version);
  const base = CAPACITES_FAMILLE[famille] ?? CAPACITES_FAMILLE.inconnu;
  const listeModes = Array.isArray(modes) ? modes.filter(Boolean) : [];

  const capacites = {
    ...base,
    modes: listeModes.length > 0 ? [...listeModes] : (famille === FAMILLES.INCONNU ? ['manuel'] : []),
  };

  // La liste des modes reçue du rover fait foi pour la calibration automatique.
  if (listeModes.length > 0) {
    capacites.calibrationAuto = listeModes.includes('calibrer');
  }

  // Corrections éventuelles annoncées dans la ligne « info ».
  for (const [cleInfo, cleCap] of [
    ['maj', 'majSansFil'],
    ['echo', 'bancEcho'],
    ['sauver', 'sauverParams'],
    ['usine', 'reglagesUsine'],
  ]) {
    const b = inf[cleInfo] !== undefined ? drapeauInfo(inf[cleInfo]) : undefined;
    if (b !== undefined) capacites[cleCap] = b;
  }

  // Corrections issues des réponses du rover pendant la session.
  if (annonces?.majIndisponible) capacites.majSansFil = false;
  if (annonces?.nomIndisponible) capacites.changementNom = false;
  if (annonces?.diagnosticEtendu) capacites.diagnosticEtendu = true;
  if (annonces?.bancEcho) capacites.bancEcho = true;
  if (annonces?.profil) capacites.profil = true;

  return { famille, version, nom, capacites };
}

/** Libellé lisible du firmware pour l'en-tête et le diagnostic. */
export function libelleFirmware(profil) {
  if (!profil) return LIBELLES_FAMILLE.inconnu;
  const lib = LIBELLES_FAMILLE[profil.famille] ?? LIBELLES_FAMILLE.inconnu;
  return profil.version ? `${lib} · ${profil.version}` : lib;
}
