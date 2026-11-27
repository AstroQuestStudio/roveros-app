// Tests des figures Mecanum (js/figures.js) : orbite, pivot, diagonale, carré, huit, rampes,
// et conduite sur le Pilote (arrêt au relâchement, liaison, manette prioritaire).
// Lancer :  node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enveloppe, RAMPE_S, figureOrbite, figurePivot, figureDiagonale, figureCarre, figureHuit,
  creerFigure, ConduiteFigure, COINS,
} from '../js/figures.js';
import { Pilote } from '../js/manettes.js';
import { encoderStop } from '../js/protocole.js';

const VMAX = 0.45; // m/s, comme la ligne « info » du rover
const WMAX = 2.5; // rad/s

/** Pour cent -> unités physiques : m/s pour vx et vy, rad/s pour w. */
const versUnites = (c) => ({ vx: (c.vx * VMAX) / 100, vy: (c.vy * VMAX) / 100, w: (c.w * WMAX) / 100 });

/**
 * Intègre une figure sans rampe sur [t0, t0 + duree] (pas dt). Repère : cap horaire depuis +y.
 * Renvoie la position monde et le cap final.
 */
function integrer(fig, t0, duree, dt = 0.001) {
  let x = 0;
  let y = 0;
  let cap = 0;
  for (let t = t0; t < t0 + duree - 1e-9; t += dt) {
    const c = versUnites(fig.commande(t));
    const avant = [Math.sin(cap), Math.cos(cap)]; // avant du rover dans le repère monde
    const droite = [Math.cos(cap), -Math.sin(cap)]; // droite du rover
    x += (c.vy * avant[0] + c.vx * droite[0]) * dt;
    y += (c.vy * avant[1] + c.vx * droite[1]) * dt;
    cap += c.w * dt;
  }
  return { x, y, cap };
}

/** Vitesse d'un point (px, py) du corps dans son repère, en m/s : V = (vx + w·py, vy − w·px). */
function vitessePoint(c, px, py) {
  const u = versUnites(c);
  return { x: u.vx + u.w * py, y: u.vy - u.w * px };
}

test('enveloppe : rampe de 0,3 s au départ et à la fin d’une figure bornée', () => {
  assert.equal(RAMPE_S, 0.3);
  assert.equal(enveloppe(0), 0);
  assert.ok(Math.abs(enveloppe(0.15) - 0.5) < 1e-9);
  assert.equal(enveloppe(0.3), 1);
  assert.equal(enveloppe(100), 1); // figure tenue : pas de rampe de fin
  assert.ok(Math.abs(enveloppe(9.85, 10) - 0.5) < 1e-9);
  assert.equal(enveloppe(10, 10), 0);
  assert.equal(enveloppe(-1), 0);
});

test('figure avec durée : la commande est nulle après la fin et ramp à la sortie', () => {
  const f = figureDiagonale({ vMax: VMAX, direction: 'avant-droite', vitesse: 1, duree: 4 });
  assert.equal(f.commande(4).vx, 0);
  assert.ok(f.commande(3.99).vy < 0.05 * f.commande(1).vy, "quasi nulle à la fin");
  const milieu = f.commande(3.85); // à la moitié de la rampe de fin
  assert.ok(Math.abs(milieu.vx - 0.5 * f.commande(1).vx) < 1e-6);
});

test('orbite : le rapport v/w vaut R, sens inversé selon le choix, aucun pourcentage au-delà de 100', () => {
  for (const R of [0.3, 0.6, 1.0, 1.5]) {
    for (const sens of ['horaire', 'antihoraire']) {
      for (const vitesse of [0.2, 0.6, 1]) {
        const f = figureOrbite({ vMax: VMAX, wMax: WMAX, rayon: R, sens, vitesse });
        const c = f.commande(5);
        const u = versUnites(c);
        assert.ok(Math.abs(Math.abs(u.vx) / Math.abs(u.w) - R) < 1e-3 * R, `R=${R} ${sens} v=${vitesse}`);
        assert.ok(Math.abs(c.vy) < 1e-9, 'pas d’avance ni de recul');
        for (const k of ['vx', 'vy', 'w']) assert.ok(Math.abs(c[k]) <= 100, `${k}=${c[k]}`);
        // le centre (0, R) reste immobile dans le repère du rover : le nez garde le cap sur le centre
        const centre = vitessePoint(c, 0, R);
        assert.ok(Math.hypot(centre.x, centre.y) < 1e-6, 'le centre de l’orbite reste fixe');
      }
    }
  }
  const h = versUnites(figureOrbite({ vMax: VMAX, wMax: WMAX, rayon: 0.6, sens: 'horaire' }).commande(5));
  const a = versUnites(figureOrbite({ vMax: VMAX, wMax: WMAX, rayon: 0.6, sens: 'antihoraire' }).commande(5));
  assert.ok(h.w > 0 && a.w < 0, 'le sens horaire est une rotation positive (horaire)');
  assert.ok(h.vx < 0 && a.vx > 0, 'horaire : le centre est à droite du mouvement, qui va vers la gauche');
  assert.ok(Math.abs(h.w + a.w) < 1e-12 && Math.abs(h.vx + a.vx) < 1e-12, 'les deux sens sont symétriques');
});

test('orbite : la vitesse est limitée par w_max quand R·w_max est petit', () => {
  const f = figureOrbite({ vMax: VMAX, wMax: 0.5, rayon: 0.3, vitesse: 1 });
  const c = f.commande(5);
  assert.ok(Math.abs(c.w) <= 100 && Math.abs(c.vx) <= 100);
  assert.ok(Math.abs(Math.abs(versUnites(c).vx) - 0.3 * 0.5) < 1e-9, 'v = R·w_max quand c’est le plus contraignant');
});

test('pivot : le coin choisi reste immobile à 1 % près, pour tous les coins et les deux sens', () => {
  for (const coin of Object.keys(COINS)) {
    for (const sens of ['horaire', 'antihoraire']) {
      const f = figurePivot({ vMax: VMAX, wMax: WMAX, coin, sens, vitesse: 1, demiLongueur: 0.09, demiLargeur: 0.08 });
      const c = f.commande(3);
      const [sx, sy] = COINS[coin];
      const v = vitessePoint(c, sx * 0.08, sy * 0.09);
      assert.ok(Math.hypot(v.x, v.y) < 0.01 * VMAX, `${coin} ${sens} : ${Math.hypot(v.x, v.y)}`);
      for (const k of ['vx', 'vy', 'w']) assert.ok(Math.abs(c[k]) <= 100 + 1e-9, `${coin} ${k}=${c[k]}`);
    }
  }
});

test('pivot : sens horaire autour du coin avant-gauche, le centre part vers l’arrière-gauche', () => {
  const c = figurePivot({ vMax: VMAX, wMax: WMAX, coin: 'avant-gauche', sens: 'horaire' }).commande(3);
  assert.ok(c.w > 0, 'rotation horaire');
  assert.ok(c.vx < 0 && c.vy < 0, 'le centre (à droite et derrière le coin) recule et part à gauche');
});

test('diagonale : quatre directions pures, vitesse = vitesse · v_max, sans rotation', () => {
  const attendu = { 'avant-droite': [1, 1], 'avant-gauche': [-1, 1], 'arriere-droite': [1, -1], 'arriere-gauche': [-1, -1] };
  for (const [direction, [sx, sy]] of Object.entries(attendu)) {
    const c = figureDiagonale({ vMax: VMAX, direction, vitesse: 0.6 }).commande(4);
    assert.equal(c.w, 0);
    assert.ok(Math.sign(c.vx) === sx && Math.sign(c.vy) === sy, direction);
    const u = versUnites(c);
    assert.ok(Math.abs(Math.hypot(u.vx, u.vy) - 0.6 * VMAX) < 1e-9, 'la vitesse du centre vaut vitesse · v_max');
  }
});

test('carré : retour au point de départ en intégrant les consignes, orientation conservée', () => {
  const f = figureCarre({ vMax: VMAX, cote: 0.6, vitesse: 0.5 });
  const T = f.periode;
  const p = integrer(f, 0.3, T); // une période complète, après la rampe de départ
  assert.ok(Math.hypot(p.x, p.y) < 1e-3, `écart ${Math.hypot(p.x, p.y)} m`);
  assert.ok(Math.abs(p.cap) < 1e-12, 'le rover ne tourne pas');
  const premier = f.commande(0.5);
  assert.ok(premier.vy > 0 && premier.vx === 0, 'premier côté vers l’avant');
  // un côté dure cote / v : 4 côtés = la période
  assert.ok(Math.abs(f.periode - (4 * 0.6) / (0.5 * VMAX)) < 1e-9);
});

test('huit : boucle fermée, deux cercles de sens contraires, nez dans le sens de la marche', () => {
  const f = figureHuit({ vMax: VMAX, wMax: WMAX, rayon: 0.6, vitesse: 0.7 });
  const demi = f.periode / 2;
  const premier = f.commande(demi * 0.25 + 0.5);
  const second = f.commande(demi * 1.25 + 0.5);
  assert.ok(premier.vy > 0 && premier.w > 0, 'premier cercle : avance et rotation horaire');
  assert.ok(second.vy > 0 && second.w < 0, 'second cercle : avance et rotation antihoraire');
  const p = integrer(f, 0.3, f.periode);
  assert.ok(Math.hypot(p.x, p.y) < 2e-3, `boucle fermée, écart ${Math.hypot(p.x, p.y)} m`);
  assert.ok(Math.abs(p.cap) < 1e-6, 'même cap à la fin');
  for (const t of [0.5, 3, 7, 11]) {
    const c = f.commande(t);
    assert.ok(Math.abs(c.vy) <= 100 && Math.abs(c.w) <= 100);
  }
});

test('creerFigure : nom inconnu refusé, toutes les figures connues construites', () => {
  for (const nom of ['orbite', 'pivot', 'diagonale', 'carre', 'huit']) {
    const f = creerFigure(nom, { vMax: VMAX, wMax: WMAX });
    assert.equal(f.nom, nom);
    assert.ok(f.commande(1));
  }
  assert.throws(() => creerFigure('spirale', {}));
});

/** Un pilote à horloge manuelle : les trames envoyées sont notées. */
function banc() {
  const trames = [];
  let t = 0;
  const pilote = new Pilote((trame) => { trames.push(trame); return true; }, { horloge: () => t, minuterie: false });
  const conduite = new ConduiteFigure(pilote, { horloge: () => t, minuterie: false });
  return {
    trames,
    pilote,
    conduite,
    avance(ms) { t += ms; conduite.tick(t); pilote._tic(t); },
    maintenant: () => t,
  };
}

test('conduite : la figure passe par la source figure du Pilote et s’arrête au relâchement', () => {
  const b = banc();
  assert.ok(b.conduite.demarrer('orbite', { vMax: VMAX, wMax: WMAX, rayon: 0.6, vitesse: 0.5 }));
  for (let i = 0; i < 100; i++) b.avance(10);
  assert.ok(b.trames.length > 0, 'des trames partent pendant la figure');
  const manette = b.trames.at(-1);
  assert.notEqual(manette[0], encoderStop()[0], 'pas de STOP pendant la figure');
  b.conduite.arreter();
  const dernier = b.trames.at(-1);
  assert.deepEqual([...dernier], [...encoderStop()], 'STOP tout de suite au relâchement');
  assert.equal(b.pilote.contacts.has('figure'), false);
  assert.equal(b.conduite.actif, false);
  // puis le silence : plus aucune trame de marche
  const n = b.trames.length;
  for (let i = 0; i < 20; i++) b.avance(10);
  assert.ok(b.trames.length - n <= 3, 'au plus les répétitions de STOP');
});

test('conduite : sans liaison, la figure ne se joue pas ; si la liaison tombe, elle s’arrête', () => {
  let connecte = false;
  const t = { v: 0 };
  const pilote = new Pilote(() => true, { horloge: () => t.v, minuterie: false });
  const conduite = new ConduiteFigure(pilote, { horloge: () => t.v, minuterie: false, estConnecte: () => connecte });
  assert.equal(conduite.demarrer('carre', { vMax: VMAX, cote: 0.5 }), false);
  connecte = true;
  assert.equal(conduite.demarrer('carre', { vMax: VMAX, cote: 0.5 }), true);
  connecte = false;
  conduite.tick(100);
  assert.equal(conduite.actif, false);
  assert.equal(pilote.sources.figure.x, 0);
});

test('conduite : une manette touchée arrête la figure (elle reste prioritaire)', () => {
  const b = banc();
  b.conduite.demarrer('huit', { vMax: VMAX, wMax: WMAX, rayon: 0.6 });
  b.avance(200);
  b.pilote.definirContact('joystick', true); // on pose le doigt sur la manette
  b.avance(50);
  assert.equal(b.conduite.actif, false, 'la figure s’arrête');
  assert.equal(b.pilote.contacts.has('figure'), false);
  assert.equal(b.conduite.demarrer('huit', { vMax: VMAX, wMax: WMAX }), false, 'pas de départ avec une manette posée');
});

test('conduite : le Pilote coupé (liaison, Stop) arrête la figure au prochain pas', () => {
  const b = banc();
  b.conduite.demarrer('diagonale', { vMax: VMAX, direction: 'arriere-gauche', vitesse: 0.4 });
  b.avance(100);
  b.pilote.toutArreter();
  b.conduite.tick(b.maintenant() + 50);
  assert.equal(b.conduite.actif, false);
});
