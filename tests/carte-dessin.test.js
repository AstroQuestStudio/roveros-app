// Test de fumée du dessin de la carte : tous les éléments (cartes par tuiles, rover, sonar, trace, échos, chemin, cible,
// points de patrouille, marqueur, échelle) se dessinent sans exception, avec un faux contexte 2D.
// (Une méthode de dessin disparue lors d'une retouche faisait planter chaque image : le rover n'était plus dessiné.)

import test from 'node:test';
import assert from 'node:assert/strict';

// ---- un navigateur minimal, juste de quoi construire la vue ----
const appels = {};
const faux = (nom) => new Proxy(function () {}, {
  get: (c, p) => { if (p === 'then') return undefined; return faux(`${nom}.${String(p)}`); },
  apply: () => { appels[nom] = (appels[nom] ?? 0) + 1; return faux(`${nom}()`); },
  set: () => true,
});
const ctx = new Proxy({}, {
  get: (c, p) => (p === 'canvas' ? undefined : (...a) => { appels[p] = (appels[p] ?? 0) + 1; return p.startsWith('create') ? { addColorStop() {} } : undefined; }),
  set: () => true,
});
globalThis.Path2D = class { moveTo() {} lineTo() {} closePath() {} rect() {} };
globalThis.ResizeObserver = class { observe() {} };
globalThis.window = { devicePixelRatio: 1 };
globalThis.document = { hidden: false, createElement: () => ({ getContext: () => ctx }) };
globalThis.requestAnimationFrame = () => 0;
globalThis.performance ??= { now: () => Date.now() };

const { VueCarte } = await import('../js/carte.js');
const { encoderCarte, decoder, encoderEtat } = await import('../js/protocole.js');

function canvas() {
  return { style: {}, getContext: () => ctx, addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 700 }), setPointerCapture() {}, width: 0, height: 0 };
}

test('la carte dessine tous ses éléments sans exception (rover, sonar, trace, échos, patrouille, tuiles...)', () => {
  const v = new VueCarte(canvas());
  v.redimensionner();
  v.lissage = false;
  // une carte : quelques lignes libres et un mur
  const ligne = (valeurs) => { const l = new Uint8Array(64); for (const [i, x] of Object.entries(valeurs)) l[i] = x; return l; };
  for (let l = 20; l < 44; l++) v.appliquerCarte(decoder(encoderCarte(l, [ligne(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [10 + i, i === 39 ? 2 : 1])))])));
  v.ajouterPoints([{ gisement: 0, distance: 800, x: 500, y: 800, t: 0 }]);
  assert.ok(v.majEtat(decoder(encoderEtat({ x: 100, y: 200, cap: 30, tete: 20, sonar: 80, drapeaux: 0, cibleD: 50, cibleGis: 10 }))));
  v.definirChemin([{ x: 100, y: 300 }, { x: 400, y: 600 }]);
  v.poserMarqueur(1, 1);
  v.etapes = [{ x: 0.5, y: 0.5 }, { x: -0.5, y: 0.5 }, { x: 0, y: -0.5 }];
  v.trace.ajouter(0, 0); v.trace.ajouter(0.1, 0.1); v.trace.ajouter(0.2, 0.3);
  for (const immobile of [false, true]) { v.immobile = immobile; v.dessiner(); }
  v.veille = true; v.dessiner(); // en veille : plus de faisceau, mais tout le reste
  v.couches = { carte: false, trace: false, echos: false, chemin: false, base: false }; v.dessiner();
  assert.ok(appels.fill > 10, 'des formes ont été remplies');
  assert.ok(appels.roundRect >= 6, 'le rover (châssis, 4 roues, ...) a été dessiné');
  assert.ok(appels.arc > 5, 'les cercles (capteur, points de patrouille, échos...) ont été dessinés');
});

test('une trame d\'état à un repère inconnu est refusée sans exception, et un cap saturé garde le dernier cap fiable', () => {
  const v = new VueCarte(canvas());
  v.redimensionner();
  v.lissage = false;
  assert.ok(v.majEtat(decoder(encoderEtat({ x: 0, y: 0, cap: 42 }))));
  const sature = decoder(encoderEtat({ x: 0, y: 0, cap: 0 }));
  sature.cap = 327.67; sature.capSature = true;
  assert.ok(v.majEtat(sature));
  assert.ok(Math.abs(v.rover.cap - (42 * Math.PI) / 180) < 1e-9, 'le cap affiché reste celui d\'avant la saturation');
  assert.equal(v.capSature, true);
  v.repere.appliquer({ ox: -32, oy: -32, version: 2, cellule: 50 });
  const inconnue = decoder(encoderEtat({ x: 0, y: 0, cap: 0, versionOrigine: 200 }));
  assert.equal(v.majEtat(inconnue), false);
  v.dessiner();
});
