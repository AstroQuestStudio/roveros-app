// Essais prouvant les défauts du chemin doigt -> trame (manettes.js et transport.js).
// Chaque essai échoue avant correction et passe après.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Pilote, Manette, courbeManette, ZONE_MORTE_MANETTE } from '../js/manettes.js';
import { Transport } from '../js/transport.js';
import { T, encoderManette, encoderTexte } from '../js/protocole.js';

function banc(pasMs = 10) {
  let maintenant = 1000;
  const sorties = [];
  const pilote = new Pilote((trame) => { sorties.push({ t: maintenant, trame }); return true; }, { horloge: () => maintenant, minuterie: false });
  return {
    pilote, sorties,
    get t() { return maintenant; },
    avancer(ms, pas = pasMs) {
      const n = Math.round(ms / pas);
      for (let i = 0; i < n; i++) { maintenant += pas; pilote._tic(maintenant); }
    },
    pousser(nom, valeur) { pilote.sources[nom] = valeur; pilote.signaler(); },
  };
}

test('défaut 1 : inverser la manette (avant -> arrière) n\'envoie aucun STOP au passage par zéro du lissage', () => {
  const b = banc(10);
  b.pousser('joystick', { x: 0, y: 0.05 });
  b.avancer(600);
  const avant = b.sorties.length;
  // Inversion douce sans lâcher le doigt : le lissage traverse 0 (Math.round === 0) alors que la consigne demandée est non nulle (−2 %).
  b.pousser('joystick', { x: 0, y: -0.02 });
  b.avancer(400);
  const apres = b.sorties.slice(avant);
  const stops = apres.filter((s) => s.trame[0] === T.STOP);
  assert.equal(stops.length, 0, `aucun STOP attendu lors d'un changement de sens, reçu ${stops.length}`);
});

test('défaut 2 : passer brièvement dans la zone morte avec le doigt posé n\'envoie pas de STOP et lisse la descente', () => {
  const b = banc(10);
  b.pilote.definirContact?.('joystick', true);
  assert.equal(typeof b.pilote.definirContact, 'function', 'Pilote doit suivre si le doigt est encore posé');
  b.pousser('joystick', { x: 0, y: 0.8 });
  b.avancer(600);
  const avant = b.sorties.length;
  // Le pouce passe 40 ms par le centre avant de repartir en arrière.
  b.pousser('joystick', { x: 0, y: 0 });
  b.avancer(20);
  // La consigne lissée ne doit pas chuter brutalement à 0 en 20 ms quand le doigt est toujours posé.
  assert.ok(b.pilote.sortie.vy > 10, `consigne tombée trop vite à ${b.pilote.sortie.vy} % avec le doigt posé`);
  b.avancer(20);
  b.pousser('joystick', { x: 0, y: -0.8 });
  b.avancer(300);
  const stops = b.sorties.slice(avant).filter((s) => s.trame[0] === T.STOP);
  assert.equal(stops.length, 0, 'aucun STOP tant que le doigt reste posé pendant un bref passage au centre');
});

test('défaut 3 : cadence moyenne à 15 Hz sans dérive malgré une minuterie à 10 ms ou irrégulière', () => {
  const b = banc(10);
  b.pousser('joystick', { x: 0, y: 0.6 });
  b.avancer(1000);
  const debut = b.sorties.length;
  // Tics irréguliers (66 ms puis 10 ms) qui faisaient glisser la phase avec _tEnvoi = maintenant.
  const t0 = b.t;
  for (let i = 0; i < 45; i++) {
    b.avancer(66, 66);
    b.avancer(10, 10);
  }
  const dureeS = (b.t - t0) / 1000;
  const manettes = b.sorties.slice(debut).filter((s) => s.trame[0] === T.MANETTE);
  const freqReelle = manettes.length / dureeS;
  assert.ok(freqReelle >= 14.7 && freqReelle <= 15.3, `cadence réelle ${freqReelle.toFixed(2)} Hz attendue proche de 15 Hz`);
});

test('défaut 4 : relâchement détecté en multipoint même si setPointerCapture échoue ou si un second doigt touche', () => {
  // Simule un DOM minimal avec window global temporaire.
  const ecouteursWin = new Map();
  const winAvant = globalThis.window;
  globalThis.window = {
    addEventListener(type, fn) {
      if (!ecouteursWin.has(type)) ecouteursWin.set(type, new Set());
      ecouteursWin.get(type).add(fn);
    },
    removeEventListener(type, fn) { ecouteursWin.get(type)?.delete(fn); },
  };
  const emettreWin = (type, ev) => { for (const fn of ecouteursWin.get(type) ?? []) fn(ev); };

  try {
    const ecouteursZone = new Map();
    const classes = new Set();
    const pouce = { style: {} };
    const racine = { offsetWidth: 100, style: {}, querySelector: () => pouce };
    const zone = {
      style: {},
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 200 }),
      setPointerCapture() { throw new Error('capture refusée'); },
      releasePointerCapture() {},
      addEventListener(type, fn) {
        if (!ecouteursZone.has(type)) ecouteursZone.set(type, new Set());
        ecouteursZone.get(type).add(fn);
      },
    };
    const emettreZone = (type, ev) => { for (const fn of ecouteursZone.get(type) ?? []) fn(ev); };

    const changements = [];
    let relaches = 0;
    const m = new Manette(zone, racine, {
      surChangement: (x, y) => changements.push({ x, y }),
      surRelache: () => relaches++,
    });

    // Doigt 1 appuie et glisse vers le haut.
    emettreZone('pointerdown', { pointerId: 1, clientX: 100, clientY: 100, preventDefault() {} });
    emettreZone('pointermove', { pointerId: 1, clientX: 100, clientY: 70 });
    assert.ok(m.y > 0.2, 'manette active après appui');

    // Doigt 2 appuie sur la même zone (multipoint) : doit empêcher le geste navigateur (preventDefault).
    let def2 = false;
    emettreZone('pointerdown', { pointerId: 2, clientX: 120, clientY: 120, preventDefault() { def2 = true; } });
    assert.equal(def2, true, 'preventDefault appelé même pour un second doigt sur la zone');

    // Doigt 1 sort de la zone (capture ayant échoué) et se lève ailleurs : pointerup arrive sur window.
    emettreWin('pointerup', { pointerId: 1, clientX: 250, clientY: 50 });
    assert.equal(m.x, 0);
    assert.equal(m.y, 0);
    assert.equal(relaches, 1, 'relâchement détecté même hors zone sans capture');
  } finally {
    globalThis.window = winAvant;
  }
});

test('défaut 5 : sortie immédiate de la zone morte sans trou de commande à 0 %', () => {
  const c = courbeManette(0, ZONE_MORTE_MANETTE + 0.005, { aideAxes: false });
  assert.ok(Math.round(c.y * 100) >= 1, `juste après la zone morte, commande = ${Math.round(c.y * 100)} % (attendu >= 1 %)`);
});

test('défaut 6 : les consignes MANETTE ne sont pas affamées ni périmées derrière une rafale de TEXTE lors d\'une écriture lente', async () => {
  const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
  class BleLent extends Transport {
    constructor() { super('test'); this.ecrites = []; }
    async _ecrire(trame) {
      await attendre(75);
      this.ecrites.push({ t: performance.now(), trame });
    }
  }
  const t = new BleLent();
  t._changerEtat('connecte');
  // 4 commandes texte (comme commandesVitesse) partent en rafale, puis une consigne MANETTE arrive.
  for (let i = 0; i < 4; i++) t.envoyer(encoderTexte(`param p${i} 1`));
  await attendre(10);
  t.envoyer(encoderManette(0, 65, 0));
  await attendre(320);
  const idxManette = t.ecrites.findIndex((e) => e.trame[0] === T.MANETTE);
  assert.ok(idxManette >= 0, 'la trame MANETTE a bien été écrite (pas jetée comme périmée)');
  assert.ok(idxManette <= 1, `la trame MANETTE ne doit pas attendre 4 textes (index ${idxManette})`);
});
