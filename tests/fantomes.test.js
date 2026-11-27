// Défauts passagers : un drapeau qui retombe vite (trou de la carte moteurs) n'est pas affiché.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filtrerDefautsPassagers, Diagnostic, DUREE_DEFAUT_PASSAGER_MS } from '../js/diagnostic.js';

test('un défaut passager de 30 ms n’est jamais affiché', () => {
  let leves = new Map();
  let r = filtrerDefautsPassagers({ driver_ko: true }, leves, 1000);
  assert.equal(r.flags.driver_ko, false);
  leves = r.leves;
  r = filtrerDefautsPassagers({ driver_ko: false }, leves, 1030);
  assert.equal(r.flags.driver_ko, false);
  assert.deepEqual(r.courts, [{ nom: 'driver_ko', duree: 30 }]);
});

test('un défaut de 800 ms est affiché à partir de 400 ms, pas avant', () => {
  let leves = new Map();
  const vus = [];
  for (let t = 1000; t <= 1800; t += 100) {
    const r = filtrerDefautsPassagers({ blocage: true }, leves, t);
    leves = r.leves;
    vus.push([t - 1000, r.flags.blocage]);
  }
  assert.equal(DUREE_DEFAUT_PASSAGER_MS, 400);
  assert.deepEqual(vus.filter(([, v]) => v).map(([t]) => t)[0], 400);
  assert.equal(vus.find(([t]) => t === 300)[1], false);
});

test("l'arrêt d'urgence, la batterie et la garde restent immédiats", () => {
  const r = filtrerDefautsPassagers({ urgence: true, batterie: true, garde: true }, new Map(), 500);
  assert.equal(r.flags.urgence, true);
  assert.equal(r.flags.batterie, true);
  assert.equal(r.flags.garde, true);
  assert.deepEqual(r.masques, []);
});

test('deux défauts qui se chevauchent sont suivis chacun pour son compte', () => {
  let leves = new Map();
  const trames = [
    [0, { driver_ko: true }], [200, { driver_ko: true, blocage: true }], [300, { blocage: true }],
    [600, { blocage: true }], [700, { blocage: true }],
  ];
  const sorties = [];
  for (const [t, f] of trames) {
    const r = filtrerDefautsPassagers(f, leves, t);
    leves = r.leves;
    sorties.push([t, r.flags.driver_ko === true, r.flags.blocage === true]);
  }
  // driver_ko est retombé à 300 ms : jamais affiché ; blocage (levé à 200) s'affiche à 600 ms
  assert.ok(sorties.every(([, dk]) => dk === false));
  assert.deepEqual(sorties.map(([t, , b]) => [t, b]), [[0, false], [200, false], [300, false], [600, true], [700, true]]);
});

test('Diagnostic.filtrer rend la trame brute si rien à retirer, et compte les défauts courts', () => {
  const d = new Diagnostic();
  const brut = { flags: { blocage: true }, x: 1 };
  assert.equal(d.filtrer(brut, 0).flags.blocage, false);
  assert.equal(d.filtrer({ flags: {}, x: 2 }, 50).flags.blocage, undefined);
  assert.equal(d.courts.get('blocage'), 1);
  const plein = { flags: { urgence: true } };
  assert.equal(d.filtrer(plein, 60), plein);
  assert.equal(d.filtrer(null, 70), null);
});

import { traduireDecrochages, diagnosticMateriel } from '../js/materiel.js';

test('sal0 et gel0 sont traduits en clair', () => {
  const r = traduireDecrochages({ sal0: '17/0/7', gel0: '0' });
  assert.deepEqual(r.phrases, ['17 décrochages de la carte moteurs, tous de moins de 50 ms, le plus long 35 ms']);
  assert.equal(r.alerte, false);
  const g = traduireDecrochages({ sal0: '4/2/12', gel0: '1' });
  assert.equal(g.phrases[0], "4 décrochages de la carte moteurs, dont 2 de plus de 50 ms : le rover s'est arrêté, le plus long 60 ms");
  assert.equal(g.phrases[1], '1 gel du bus de la carte moteurs');
  assert.equal(g.alerte, true);
});

test('sans sal0 ni gel0 (ancien firmware) : rien n’est affiché', () => {
  assert.equal(traduireDecrochages({ abrt0: '0' }), null);
  assert.equal(traduireDecrochages(null), null);
  const d = diagnosticMateriel({ calcul: 700 }, { abrt0: '0' }, [], {});
  assert.ok(!d.details.some((x) => x.cle === 'decrochages'));
});

import { lirePwmMax, commandePwmMax, PWM_MIN, PWM_MAX } from '../js/reglages.js';

test('pwm_max est lu dans les paramètres du rover, et écrit par pas de 100 dans les bornes', () => {
  const params = new Map([['pwm_max', { valeur: 2000, min: 500, max: 3600 }]]);
  assert.equal(lirePwmMax(params), 2000);
  assert.equal(lirePwmMax(new Map()), null);
  assert.equal(commandePwmMax(2000), 'param pwm_max 2000');
  assert.equal(commandePwmMax(2049), 'param pwm_max 2000');
  assert.equal(commandePwmMax(900), `param pwm_max ${PWM_MIN}`);
  assert.equal(commandePwmMax(9999), `param pwm_max ${PWM_MAX}`);
});
