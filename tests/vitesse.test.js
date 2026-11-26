import test from 'node:test';
import assert from 'node:assert/strict';
import { commandesVitesse, rotationPour, limiterVitesse, CRANS, VITESSE_MIN, VITESSE_MAX } from '../js/vitesse.js';

test('vitesse : les crans lent / normal / rapide / max restent dans les bornes proposées', () => {
  for (const v of Object.values(CRANS)) assert.ok(v >= VITESSE_MIN && v <= VITESSE_MAX);
  assert.equal(limiterVitesse(5), 1);
  assert.equal(limiterVitesse(0.01), 0.15);
});

test('vitesse : la rotation suit de 1,5 à 4 rad/s', () => {
  assert.equal(rotationPour(0.15), 1.5);
  assert.equal(rotationPour(1), 4);
  assert.ok(rotationPour(0.4) > 1.5 && rotationPour(0.4) < rotationPour(0.7));
});

test('vitesse : v_rapide est réglé à la même valeur que v_max (sinon le rover dépasse le choix)', () => {
  const c = commandesVitesse(0.7);
  assert.deepEqual(c, ['vitesse 100', 'param v_max 0.7', 'param v_rapide 0.7', 'param w_max 3.1']);
});
