// Tests de la carte sans limite : repère (origine glissante, versions), carte globale rangée par tuiles,
// décodage des trames ORIGINE et ÉTAT à 20 octets.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Repere, PORTEE_ALLER_MAX } from '../js/repere.js';
import { CarteGlobale, TUILE } from '../js/carte-globale.js';
import { decoder, encoderOrigine, encoderEtat, encoderCarte } from '../js/protocole.js';

const proche = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const ligne = (valeurs = {}) => { const l = new Uint8Array(64); for (const [i, v] of Object.entries(valeurs)) l[i] = v; return l; };

// ---------- Trames ----------

test('ORIGINE (0x86) : ox, oy en cases signées, version, cellule en mm', () => {
  const t = encoderOrigine({ ox: -48, oy: 1000, version: 6, cellule: 50 });
  assert.equal(t.length, 12);
  assert.deepEqual(decoder(t), { type: 'origine', ox: -48, oy: 1000, version: 6, cellule: 50 });
  assert.equal(decoder(Uint8Array.of(0x86, 1, 2)), null, 'trame tronquée refusée');
});

test('ÉTAT : le vingtième octet donne la version de l\'origine ; à 19 octets, rien (rover non mis à jour)', () => {
  assert.equal(decoder(encoderEtat({ x: 1, y: 2, versionOrigine: 14 })).versionOrigine, 14);
  assert.equal(decoder(encoderEtat({ x: 1, y: 2 })).versionOrigine, undefined);
  assert.equal(encoderEtat({}).length, 19);
  assert.equal(encoderEtat({ versionOrigine: 2 }).length, 20);
});

// ---------- Repère ----------

test('repère : sans trame ORIGINE, tout se lit comme avant (origine −32, −32, centre en 0, 0)', () => {
  const r = new Repere();
  assert.deepEqual(r.centre(), { x: 0, y: 0 });
  assert.deepEqual(r.absolu(1000, -2500), { x: 1, y: -2.5 });
  assert.deepEqual(r.relatif(1, -2.5), { xMm: 1000, yMm: -2500 });
  assert.deepEqual(r.absolu(1000, -2500, undefined), { x: 1, y: -2.5 });
});

test('repère : la fenêtre glisse — le même point absolu se lit avec le nouveau centre', () => {
  const r = new Repere();
  r.appliquer({ ox: -32, oy: -32, version: 0, cellule: 50 });
  const glisse = r.appliquer({ ox: -16, oy: -48, version: 2, cellule: 50 }); // +16 cases en x, −16 en y
  assert.deepEqual(glisse, { change: true, decalageCases: { dx: 16, dy: -16 } });
  const c = r.centre();
  proche(c.x, 0.8); proche(c.y, -0.8);
  // un rover à 10 cm à droite du nouveau centre est à x = 0,9 m dans le monde
  const p = r.absolu(100, 0, 2);
  proche(p.x, 0.9); proche(p.y, -0.8);
  // et « aller ici » en (0,9 ; −0,8) part en millimètres relatifs au nouveau centre
  assert.deepEqual(r.relatif(0.9, -0.8), { xMm: 100, yMm: 0 });
});

test('repère : une trame ÉTAT encore à l\'ancienne version se lit avec l\'ancienne origine ; version inconnue ou impaire = ignorée', () => {
  const r = new Repere();
  r.appliquer({ ox: -32, oy: -32, version: 0, cellule: 50 });
  r.appliquer({ ox: -16, oy: -32, version: 2, cellule: 50 });
  proche(r.absolu(100, 0, 0).x, 0.1, 1e-9); // ancienne origine : centre en 0
  proche(r.absolu(100, 0, 2).x, 0.9, 1e-9); // nouvelle origine : centre en 0,8
  assert.equal(r.absolu(100, 0, 200), null, 'version inconnue : on ne mélange pas deux repères');
  assert.equal(r.absolu(100, 0, 3), null, 'version impaire : la fenêtre glisse');
});

test('repère : la taille de case vient de la trame ORIGINE (60 mm pour le rover de la démo)', () => {
  const r = new Repere();
  r.appliquer({ ox: -32, oy: -32, version: 0, cellule: 60 });
  proche(r.cellule, 0.06);
  r.appliquer({ ox: -16, oy: -32, version: 2, cellule: 60 });
  proche(r.centre().x, 16 * 0.06);
  r.definirCellule(0.05); // la ligne « info » ne contredit pas la trame ORIGINE
  proche(r.cellule, 0.06);
});

test('repère : « aller ici » refusé à plus de 30 m du centre de la fenêtre, accepté en deçà', () => {
  const r = new Repere();
  assert.equal(PORTEE_ALLER_MAX, 30);
  assert.notEqual(r.relatif(20, 20), null); // 28,3 m
  assert.equal(r.relatif(25, 25), null); // 35,4 m
  r.appliquer({ ox: 400 - 32, oy: -32, version: 2, cellule: 50 }); // centre à x = 20 m
  assert.equal(r.relatif(25, 35), null, 'toujours trop loin du centre (35 m)');
  assert.deepEqual(r.relatif(40, 0), { xMm: 20000, yMm: 0 });
  assert.equal(r.relatif(0, 0).xMm, -20000, 'la base, à 20 m du centre, reste joignable');
});

test('repère : retour au départ (recalage) remet l\'origine en −32, −32', () => {
  const r = new Repere();
  r.appliquer({ ox: 100, oy: 50, version: 8, cellule: 60 });
  r.reinitialiser();
  assert.equal(r.recu, false);
  assert.deepEqual(r.centre(), { x: 0, y: 0 });
});

// ---------- Carte globale ----------

test('carte globale : une ligne reçue est rangée à sa place absolue (origine de départ)', () => {
  const g = new CarteGlobale();
  const o = { ox: -32, oy: -32 };
  g.ranger({ ligne: 40, lignes: [ligne({ 10: 2, 11: 1 })] }, o);
  assert.equal(g.valeur(-22, 8), 2);
  assert.equal(g.valeur(-21, 8), 1);
  assert.equal(g.valeur(-22, 9), 0);
  assert.equal(g.compter(), 2);
});

test('carte globale : des lignes isolées, dans le désordre, ne s\'écrasent pas', () => {
  const g = new CarteGlobale();
  const o = { ox: -32, oy: -32 };
  g.ranger({ ligne: 63, lignes: [ligne({ 0: 2 })] }, o);
  g.ranger({ ligne: 5, lignes: [ligne({ 63: 1 })] }, o);
  g.ranger({ ligne: 32, lignes: [ligne({ 32: 2 }), ligne({ 32: 1 })] }, o);
  assert.equal(g.valeur(-32, 31), 2);
  assert.equal(g.valeur(31, -27), 1);
  assert.equal(g.valeur(0, 0), 2);
  assert.equal(g.valeur(0, 1), 1);
});

test('carte globale : changement d\'origine ENTRE DEUX TRAMES — le même obstacle reste au même endroit, la mémoire reste', () => {
  const g = new CarteGlobale();
  // origine de départ : un obstacle devant, un mur derrière (au bord gauche)
  g.ranger({ ligne: 40, lignes: [ligne({ 40: 2 })] }, { ox: -32, oy: -32 }); // absolu (8, 8)
  g.ranger({ ligne: 10, lignes: [ligne({ 0: 2, 1: 2 })] }, { ox: -32, oy: -32 }); // absolu (-32,-22), (-31,-22)
  // la fenêtre glisse de 16 cases vers la droite : l'obstacle est maintenant à la colonne 24
  const o2 = { ox: -16, oy: -32 };
  const changees = g.ranger({ ligne: 40, lignes: [ligne({ 24: 2 })] }, o2);
  assert.equal(changees, 0, 'le même obstacle, lu avec la nouvelle origine, ne change rien');
  assert.equal(g.valeur(8, 8), 2);
  // le mur resté derrière est oublié du rover mais gardé par l'application
  assert.equal(g.valeur(-32, -22), 2);
  assert.equal(g.valeur(-31, -22), 2);
  // une nouvelle case, devant le rover, au-delà de l'ancienne fenêtre (colonne 60 -> absolu 44)
  g.ranger({ ligne: 40, lignes: [ligne({ 24: 2, 60: 1 })] }, o2);
  assert.equal(g.valeur(44, 8), 1);
  // une trame lue avec la MAUVAISE origine (l'ancienne) poserait l'obstacle 16 cases plus loin : c'est ce qu'on évite
  const faux = new CarteGlobale();
  faux.ranger({ ligne: 40, lignes: [ligne({ 24: 2 })] }, { ox: -32, oy: -32 });
  assert.equal(faux.valeur(8, 8), 0);
  assert.equal(faux.valeur(-8, 8), 2);
});

test('carte globale : un obstacle qui disparaît (case réécrite libre ou inconnue) disparaît aussi de l\'écran', () => {
  const g = new CarteGlobale();
  const o = { ox: -32, oy: -32 };
  g.ranger({ ligne: 40, lignes: [ligne({ 5: 2 })] }, o);
  assert.equal(g.valeur(-27, 8), 2);
  assert.equal(g.ranger({ ligne: 40, lignes: [ligne({ 5: 1 })] }, o), 1);
  assert.equal(g.valeur(-27, 8), 1);
  assert.equal(g.ranger({ ligne: 40, lignes: [ligne()] }, o), 1);
  assert.equal(g.valeur(-27, 8), 0);
});

test('carte globale : elle grandit à mesure — 120 m de couloir, par tuiles, coordonnées négatives comprises', () => {
  const g = new CarteGlobale();
  for (let pas = -40; pas <= 40; pas++) { // la fenêtre avance de 3 m à chaque pas
    const o = { ox: -32 + pas * 60, oy: -32 };
    g.ranger({ ligne: 32, lignes: [ligne({ 0: 2, 1: 2, 31: 1, 63: 2 })] }, o);
  }
  assert.ok(g.tuiles.size >= 70, `${g.tuiles.size} tuiles`);
  assert.equal(g.valeur(-32 + 40 * 60, 0), 2); // 120 m plus loin
  assert.equal(g.valeur(-32 - 40 * 60, 0), 2); // et 120 m en arrière
  assert.equal(g.valeur(-2, 0), 0);
  const e = g.etendue;
  assert.ok(e.maxCx - e.minCx > 4800, 'plus de 240 m de large');
  // les tuiles de zéros ne sont jamais créées
  const vide = new CarteGlobale();
  vide.ranger({ ligne: 0, lignes: [ligne(), ligne()] }, { ox: 500, oy: 500 });
  assert.equal(vide.tuiles.size, 0);
  assert.equal(vide.etendue, null);
});

test('carte globale : tuiles voisines — un changement au bord salit aussi la tuile d\'à côté (pour que le contour suive)', () => {
  const g = new CarteGlobale();
  const o = { ox: 0, oy: 0 }; // cases 0..63 = tuile (0,0)
  g.ranger({ ligne: 10, lignes: [ligne({ 63: 2 })] }, o);
  g.ranger({ ligne: 10, lignes: [ligne({ 0: 2 })] }, { ox: 64, oy: 0 }); // case 64 : tuile (1,0)
  for (const t of g.tuiles.values()) t.sale = false;
  g.ranger({ ligne: 10, lignes: [ligne({ 0: 1 })] }, { ox: 64, oy: 0 }); // on change la case du bord gauche de la tuile (1,0)
  assert.equal(g.tuile(1, 0).sale, true);
  assert.equal(g.tuile(0, 0).sale, true, 'la tuile voisine doit recalculer son contour');
});

test('carte globale : effacer vide tout (carte raz, rover reposé)', () => {
  const g = new CarteGlobale();
  g.ranger({ ligne: 3, lignes: [ligne({ 1: 2, 2: 2 })] }, { ox: -32, oy: -32 });
  assert.equal(g.compter(), 2);
  g.effacer();
  assert.equal(g.compter(), 0);
  assert.equal(g.tuiles.size, 0);
  assert.equal(g.etendue, null);
});

test('carte globale : des trames CARTE décodées, rangées avec l\'origine reçue juste avant', () => {
  const r = new Repere(); const g = new CarteGlobale();
  const trame = (l, valeurs) => decoder(encoderCarte(l, [ligne(valeurs)]));
  g.ranger(trame(32, { 32: 2 }), r); // origine de départ : absolu (0, 0)
  r.appliquer(decoder(encoderOrigine({ ox: -32 + 32, oy: -32, version: 2, cellule: 50 })));
  g.ranger(trame(32, { 0: 2 }), r); // colonne 0 de la nouvelle fenêtre = absolu x = 0 : même case
  assert.equal(g.compter(), 1);
  assert.equal(g.valeur(0, 0), 2);
  assert.equal(TUILE, 64);
});
