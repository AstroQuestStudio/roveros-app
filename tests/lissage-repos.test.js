// Rover immobile : ce que l'écran affiche ne doit pas bouger plus que ce que le rover envoie.
// (Retour d'essai : « alors qu'il est immobile, on dirait que ça tourne tout le temps. »)

import test from 'node:test';
import assert from 'node:assert/strict';
import { Lisseur, ecartAngle } from '../js/lissage.js';
import { decoder, encoderEtat } from '../js/protocole.js';

/** Un petit générateur déterministe. */
function alea(graine = 7) { let g = graine; return () => { g = (g * 1664525 + 1013904223) >>> 0; return g / 2 ** 32; }; }

/** Rejoue des trames (t en ms, valeurs) et échantillonne l'écran à 60 Hz. */
function rejouer(trames, { fin, pas = 1000 / 60 } = {}) {
  const l = new Lisseur();
  const sorties = [];
  let i = 0;
  for (let t = 0; t <= (fin ?? trames[trames.length - 1].t + 300); t += pas) {
    while (i < trames.length && trames[i].t <= t) { const e = trames[i++]; l.pousser(e, e.t); }
    const a = l.lire(t);
    if (a) sorties.push({ t, ...a });
  }
  return sorties;
}

/** 18 trames par seconde avec une gigue d'arrivée (le Bluetooth livre par paquets) : intervalle de 20 à 120 ms. */
function trames18Hz(secondes, valeurs, g = alea(), gigueMs = 70) {
  const trames = [];
  for (let t = 0; t < secondes * 1000; t += 55.5) {
    const gigue = (g() - 0.5) * gigueMs; // ±35 ms par défaut (très mauvais cas)
    trames.push({ t: Math.max(0, t + gigue), ...valeurs(t, g) });
  }
  trames.sort((a, b) => a.t - b.t);
  return trames;
}

test('repos : valeurs constantes pendant 2 minutes -> position et cap affichés strictement constants (aucune dérive)', () => {
  const sorties = rejouer(trames18Hz(120, () => ({ x: 1.234, y: -0.5, cap: 57.3, tete: 0 })));
  for (const s of sorties) { assert.equal(s.x, 1.234); assert.equal(s.y, -0.5); assert.ok(Math.abs(s.cap - 57.3) < 1e-9, `cap ${s.cap}`); }
});

test('repos : bruit de ±0,01° sur le cap -> l\'écran ne bouge pas plus que le bruit (pas d\'amplification, pas de tour)', () => {
  const sorties = rejouer(trames18Hz(120, (t, g) => ({ x: 0, y: 0, cap: 90 + (g() - 0.5) * 0.02, tete: 0 })));
  const caps = sorties.map((s) => s.cap);
  assert.ok(Math.max(...caps) - Math.min(...caps) <= 0.0201, `étendue ${Math.max(...caps) - Math.min(...caps)}°`);
  const pas = caps.slice(1).map((c, i) => Math.abs(ecartAngle(caps[i], c)));
  assert.ok(Math.max(...pas) <= 0.0201, `pas maximal ${Math.max(...pas)}° d'une image à l'autre`);
});

test('repos : le cap autour de ±180° (bruit de part et d\'autre de la coupure) ne fait jamais un demi-tour à l\'écran', () => {
  const sorties = rejouer(trames18Hz(60, (t, g) => ({ x: 0, y: 0, cap: g() < 0.5 ? 179.995 : -179.995, tete: 0 })));
  const pas = sorties.slice(1).map((s, i) => Math.abs(ecartAngle(sorties[i].cap, s.cap)));
  assert.ok(Math.max(...pas) < 0.02, `saut de cap ${Math.max(...pas)}°`);
});

test('tête qui balaie de −56° à +56° : l\'écran ne dépasse jamais les butées (pas de dépassement à chaque demi-tour)', () => {
  const triangle = (t) => { const p = (t / 1000 / 2.5) % 1; return -56 + 112 * (p < 0.5 ? p * 2 : 2 - p * 2); }; // un aller-retour en 2,5 s
  for (const [gigue, maxPas] of [[40, 5], [70, 8]]) { // une gigue réaliste, puis un très mauvais cas (±35 ms sur 55 ms)
    const sorties = rejouer(trames18Hz(60, (t) => ({ x: 0, y: 0, cap: 0, tete: triangle(t) }), alea(), gigue));
    const tetes = sorties.map((s) => s.tete);
    assert.ok(Math.max(...tetes) <= 56.01 && Math.min(...tetes) >= -56.01, `butées ${Math.min(...tetes)} … ${Math.max(...tetes)}`);
    const pas = tetes.slice(25).map((t, i) => Math.abs(t - tetes[i + 24]));
    assert.ok(Math.max(...pas) < maxPas, `gigue ${gigue} ms : saut de la tête ${Math.max(...pas)}° d'une image à l'autre`);
  }
});

test('en veille (la tête est au repos, seul l\'état arrive) : rien ne bouge à l\'écran', () => {
  const sorties = rejouer(trames18Hz(40, () => ({ x: 0.2, y: 0.3, cap: -12, tete: 17 })));
  const tetes = new Set(sorties.slice(20).map((s) => s.tete));
  assert.equal(tetes.size, 1);
});

test('deux trames à la même heure, ou l\'onglet qui revient au premier plan après une longue pause : pas de NaN, pas de dérive', () => {
  const l = new Lisseur();
  l.pousser({ x: 0, y: 0, cap: 10, tete: 0 }, 1000);
  l.pousser({ x: 0, y: 0, cap: 10, tete: 0 }, 1000);
  l.pousser({ x: 0, y: 0, cap: 10, tete: 0 }, 1000.5);
  const a = l.lire(1100);
  assert.ok(Number.isFinite(a.cap) && a.cap === 10);
  // l'écran est resté 30 s en arrière-plan : aucune lecture, puis une trame : on repart d'elle, sans glisser depuis l'ancien état
  l.pousser({ x: 0, y: 0, cap: 10, tete: 0 }, 1055);
  l.pousser({ x: 0.5, y: 0.5, cap: 40, tete: 0 }, 31000);
  const b = l.lire(31010);
  assert.deepEqual([b.x, b.y, b.cap], [0.5, 0.5, 40]);
  // et sans nouvelles trames, l'extrapolation s'arrête : rien ne bouge après 150 ms
  const c = l.lire(33000); const d = l.lire(40000);
  assert.deepEqual([c.x, c.y, c.cap], [d.x, d.y, d.cap]);
});

test('cap saturé (±327,67°, entier 16 bits) : la trame le signale, un cap normal ne le signale pas', () => {
  // le cœur écrit « cap / DEG * 100 as i16 » : au-delà de ±327,67° la valeur est saturée à ±32 767 (ou −32 768)
  const trame = (centiemes) => { const t = encoderEtat({ cap: 0 }); new DataView(t.buffer).setInt16(5, centiemes, true); return t; };
  const sat = decoder(trame(32767));
  assert.equal(sat.cap, 327.67);
  assert.equal(sat.capSature, true);
  assert.equal(decoder(trame(-32768)).capSature, true);
  assert.equal(decoder(encoderEtat({ cap: 179.5 })).capSature, false);
  assert.equal(decoder(encoderEtat({ cap: -327.6 })).capSature, false);
});
