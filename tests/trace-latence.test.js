import test from 'node:test';
import assert from 'node:assert/strict';
import { Trace } from '../js/trace.js';
import { MesureLatence } from '../js/latence.js';
import { T, decoder, encoderPong } from '../js/protocole.js';

test('trace : un point tous les 2 cm au plus', () => {
  const t = new Trace();
  assert.equal(t.ajouter(0, 0), true);
  assert.equal(t.ajouter(0.005, 0.005), false, 'trop près du dernier point');
  assert.equal(t.ajouter(0, 0.019), false);
  assert.equal(t.ajouter(0, 0.021), true);
  assert.equal(t.longueur, 2);
  // 1 m en ligne droite : environ 50 points
  const u = new Trace();
  for (let i = 0; i <= 1000; i++) u.ajouter(0, i / 1000);
  assert.ok(u.longueur >= 48 && u.longueur <= 52, `${u.longueur} points pour 1 m`);
});

test('trace : bornée à 2 000 points, les plus anciens sont oubliés', () => {
  const t = new Trace();
  for (let i = 0; i < 5000; i++) t.ajouter(i * 0.05, 0);
  assert.equal(t.longueur, 2000);
  assert.ok(Math.abs(t.points[0].x - 3000 * 0.05) < 1e-9, 'le plus ancien gardé est le 3001e');
  assert.ok(Math.abs(t.points[1999].x - 4999 * 0.05) < 1e-9);
  const p = new Trace({ max: 3 });
  for (let i = 0; i < 10; i++) p.ajouter(i, 0);
  assert.deepEqual(p.points.map((q) => q.x), [7, 8, 9]);
});

test('trace : effacement (rover reposé, « Je suis à la base »), valeurs invalides refusées', () => {
  const t = new Trace();
  for (let i = 0; i < 100; i++) t.ajouter(i, 0);
  t.effacer();
  assert.equal(t.longueur, 0);
  assert.equal(t.ajouter(NaN, 0), false);
  assert.equal(t.ajouter(0, Infinity), false);
  assert.equal(t.ajouter(0, 0), true, 'la trace repart de zéro');
});

test('latence : le PING part avec un numéro, le PONG donne le temps aller-retour', () => {
  let t = 1000;
  const envoyees = [];
  const m = new MesureLatence({ envoyer: (f) => envoyees.push(f), maintenant: () => t });
  assert.equal(m.ms, null);
  m.tic();
  assert.equal(envoyees[0][0], T.PING);
  const n = envoyees[0][1];
  t += 80;
  assert.equal(m.surPong(n), 80);
  assert.equal(m.ms, 80);
  assert.equal(m.surPong(n), null, 'un PONG déjà reçu ne compte pas deux fois');
  assert.equal(m.surPong(200), null, 'numéro inconnu ignoré');
});

test('latence : moyenne lissée, une seule trame par mesure, PONG décodé par le protocole', () => {
  let t = 0;
  let nb = 0;
  const m = new MesureLatence({ envoyer: () => { nb++; }, maintenant: () => t });
  for (const aller of [60, 60, 200, 60]) { m.tic(); t += aller; m.surPong(m._n); t += 2000 - aller; }
  assert.equal(nb, 4);
  assert.ok(m.ms > 60 && m.ms < 200, `lissée : ${m.ms}`);
  assert.equal(m.brute, 60);
  assert.deepEqual(decoder(encoderPong(7)), { type: 'pong', n: 7 });
});

test('latence : sans réponse du rover au bout de 6 s', () => {
  let t = 0;
  const m = new MesureLatence({ envoyer: () => {}, maintenant: () => t });
  assert.equal(m.sansReponse, false);
  t = 6500;
  assert.equal(m.sansReponse, true);
  m.tic(); t += 50; m.surPong(m._n);
  assert.equal(m.sansReponse, false);
  m.reinitialiser();
  assert.equal(m.ms, null);
});
