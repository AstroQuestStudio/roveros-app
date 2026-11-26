import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SuiviTension } from '../js/bord.js';

const etat = (tension, vitesse = 0, batterie = false) => ({ tension, vitesse, flags: { batterie } });

test('tension régulée, chute en mouvement et drapeau faible', () => {
  const suivi = new SuiviTension();
  assert.equal(suivi.actualiser(etat(6), 0), 'normal');
  assert.equal(suivi.actualiser(etat(5.5, 10), 100), 'chute');
  assert.equal(suivi.actualiser(etat(5.6, 10), 200), 'normal');
  assert.equal(suivi.actualiser(etat(6, 0, true), 300), 'faible');
  assert.equal(suivi.minimum, 5.5);
});

test('tension basse persistante à vitesse nulle et remise à zéro', () => {
  const suivi = new SuiviTension();
  assert.equal(suivi.actualiser(etat(5.5), 0), 'chute');
  assert.equal(suivi.actualiser(etat(5.5), 1000), 'chute');
  assert.equal(suivi.actualiser(etat(5.5), 2000), 'faible');
  assert.equal(suivi.actualiser(etat(6), 2100), 'normal');
  suivi.reinitialiser();
  assert.equal(suivi.minimum, null);
  assert.equal(suivi.actualiser(etat(5.4), 3000), 'chute');
  assert.equal(suivi.actualiser(etat(5.4), 5001), 'chute');
});
