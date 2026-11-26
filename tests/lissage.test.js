import test from 'node:test';
import assert from 'node:assert/strict';
import { Lisseur, ecartAngle, normaliser180 } from '../js/lissage.js';

const proche = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

/** Un rover qui avance de 0,3 m/s à cap constant ; une trame toutes les `periode` ms. */
function simuler(periode, duree, { perdues = [], vitesse = 0.3 } = {}) {
  const l = new Lisseur();
  const vus = []; // ce que l'écran affiche à 60 images par seconde
  let n = 0;
  for (let t = 0; t <= duree; t += 1000 / 60) {
    while ((n + 1) * periode <= t) {
      n++;
      if (!perdues.includes(n)) l.pousser({ x: 0, y: vitesse * (n * periode) / 1000, cap: 0, tete: 0 }, n * periode);
    }
    const a = l.lire(t);
    if (a) vus.push({ t, y: a.y, mode: a.mode });
  }
  return vus;
}

test('lissage : aucune position avant la première trame, puis la trame elle-même', () => {
  const l = new Lisseur();
  assert.equal(l.lire(0), null);
  l.pousser({ x: 1, y: 2, cap: 30, tete: 5 }, 100);
  assert.deepEqual(l.lire(150), { x: 1, y: 2, cap: 30, tete: 5, mode: 'fige' });
});

test('lissage : interpolation entre deux trames, avec une trame de retard', () => {
  const l = new Lisseur();
  l.pousser({ x: 0, y: 0, cap: 0, tete: 0 }, 0);
  l.pousser({ x: 0, y: 0.1, cap: 10, tete: 0 }, 100); // intervalle mesuré ≈ 100 ms
  // à t = 150, on affiche l'instant 150 − (intervalle ≈ 100 + gigue ≈ 10) = 40 : un peu avant le milieu du segment
  const a = l.lire(150);
  assert.equal(a.mode, 'interpole');
  assert.ok(a.y > 0.03 && a.y < 0.06, `y = ${a.y}`);
  assert.ok(a.cap > 3 && a.cap < 6);
});

test('lissage : à 10 Hz, l\'affichage à 60 images/s avance par petits pas réguliers, sans téléportation', () => {
  const vus = simuler(100, 3000);
  const pas = vus.slice(1).map((v, i) => v.y - vus[i].y).filter((d, i) => vus[i + 1].t > 700); // après la mise en route
  const attendu = 0.3 / 60;
  assert.ok(Math.max(...pas) < attendu * 1.3, `pas max ${Math.max(...pas)} m (attendu ${attendu})`);
  assert.ok(Math.min(...pas) > attendu * 0.7, `pas min ${Math.min(...pas)} m`);
  // sans lissage, le rover afficherait un pas de 3 cm toutes les 100 ms (6 fois plus grand)
  assert.ok(0.3 * 0.1 > Math.max(...pas) * 5);
});

test('lissage : une trame perdue ne crée pas de saut visible', () => {
  const vus = simuler(100, 3000, { perdues: [12, 13] }); // 200 ms sans trame
  const pas = vus.slice(1).map((v, i) => v.y - vus[i].y).filter((d, i) => vus[i + 1].t > 400);
  const attendu = 0.3 / 60;
  assert.ok(Math.max(...pas) < 0.014, `pas max ${Math.max(...pas)} m (rattrapage borné à 2,5 fois la vitesse ; sans lissage : 6 cm d un coup)`);
  assert.ok(vus.some((v) => v.mode === 'extrapole'), 'l\'extrapolation a pris le relais');
});

test('lissage : si les trames s\'arrêtent, l\'extrapolation est bornée à 150 ms puis le rover s\'immobilise', () => {
  const l = new Lisseur();
  for (let i = 0; i <= 5; i++) l.pousser({ x: 0, y: 0.03 * i, cap: 0, tete: 0 }, i * 100); // 0,3 m/s
  const dern = 0.15; // dernière trame : y = 0,15
  const a1 = l.lire(500 + 400); // 400 ms plus tard
  const a2 = l.lire(500 + 5000); // 5 s plus tard
  proche(a1.y, a2.y, 1e-9);
  assert.equal(a2.mode, 'fige');
  assert.ok(a2.y - dern <= 0.3 * 0.150 + 1e-9, `dérive ${a2.y - dern} m`);
  assert.equal(l.actif(500 + 5000), false);
  assert.equal(l.actif(500 + 200), true);
});

test('lissage : le cap passe de 359° à 0° par le plus court chemin', () => {
  assert.equal(ecartAngle(359, 1), 2);
  assert.equal(ecartAngle(1, 359), -2);
  assert.equal(ecartAngle(170, -170), 20);
  proche(normaliser180(270), -90);
  const l = new Lisseur();
  l.pousser({ x: 0, y: 0, cap: 170, tete: 0 }, 0);
  l.pousser({ x: 0, y: 0, cap: -170, tete: 0 }, 100); // +20° en passant par 180°
  const vus = [];
  for (let t = 100; t <= 200; t += 5) vus.push(l.lire(t).cap);
  for (const c of vus) assert.ok(Math.abs(c) > 168, `cap ${c} : le rover ne doit jamais repasser par 0°`);
  const pas = vus.slice(1).map((c, i) => Math.abs(ecartAngle(vus[i], c)));
  assert.ok(Math.max(...pas) < 3, `saut de cap ${Math.max(...pas)}°`);
});

test('lissage : l\'angle de la tête (faisceau du sonar) est lissé aussi', () => {
  const l = new Lisseur();
  l.pousser({ x: 0, y: 0, cap: 0, tete: -40 }, 0);
  l.pousser({ x: 0, y: 0, cap: 0, tete: -20 }, 100);
  const a = l.lire(150);
  assert.ok(a.tete > -35 && a.tete < -25, `tête ${a.tete}`);
});

test('lissage : un rover reposé ou recalé (saut de position) n\'est pas « glissé » à travers la carte', () => {
  const l = new Lisseur();
  l.pousser({ x: 2, y: 3, cap: 40, tete: 0 }, 0);
  l.pousser({ x: 2.02, y: 3.02, cap: 40, tete: 0 }, 100);
  l.pousser({ x: 0, y: 0, cap: 0, tete: 0 }, 200); // position remise à zéro
  const a = l.lire(205);
  assert.equal(a.x, 0); assert.equal(a.y, 0); assert.equal(a.cap, 0);
  // et après une longue pause, on repart de la trame reçue
  l.pousser({ x: 0.1, y: 0.1, cap: 0, tete: 0 }, 5000);
  assert.equal(l.lire(5001).x, 0.1);
});

test('lissage : l\'intervalle s\'adapte (20 Hz = retard de 50 ms) et deux trames collées ne divisent pas par zéro', () => {
  const l = new Lisseur();
  for (let i = 0; i < 30; i++) l.pousser({ x: 0, y: i * 0.015, cap: 0, tete: 0 }, i * 50);
  assert.ok(l.intervalle > 45 && l.intervalle < 55, `intervalle ${l.intervalle}`);
  l.pousser({ x: 0, y: 0.5, cap: 0, tete: 0 }, 29 * 50 + 1);
  const a = l.lire(1600);
  assert.ok(Number.isFinite(a.y));
});
