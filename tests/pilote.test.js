// Tests du pilotage : cadence des trames MANETTE, arrêt au relâchement, silence au repos,
// lissage, courbe de la manette, et file d'envoi (une écriture à la fois, pas de trame périmée).
// Lancer :  node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { Pilote, courbeManette, ZONE_MORTE_MANETTE } from '../js/manettes.js';
import { Transport, AGE_MAX_MANETTE_MS } from '../js/transport.js';
import { T, encoderManette, encoderStop, encoderUrgence, encoderTexte } from '../js/protocole.js';

/** Un pilote à horloge manuelle : on fait avancer le temps par pas de 5 ms et on note ce qui part. */
function banc() {
  let maintenant = 1000;
  const sorties = [];
  const pilote = new Pilote((trame) => { sorties.push({ t: maintenant, trame }); return true; }, { horloge: () => maintenant, minuterie: false });
  return {
    pilote, sorties,
    get t() { return maintenant; },
    avancer(ms) { for (let i = 0; i < ms / 10; i++) { maintenant += 10; pilote._tic(maintenant); } },
    pousser(nom, valeur) { pilote.sources[nom] = valeur; pilote.signaler(); },
  };
}
const manettes = (sorties) => sorties.filter((s) => s.trame[0] === T.MANETTE);
const stops = (sorties) => sorties.filter((s) => s.trame[0] === T.STOP);
const octetSigne = (v) => (v > 127 ? v - 256 : v);

test('pilote : doigt posé et immobile = une trame à cadence fixe (~15 Hz), même sans changement', () => {
  const b = banc();
  b.pousser('joystick', { x: 0, y: 0.6 });
  b.avancer(1500); // le lissage a fini sa montée
  const avant = b.sorties.length;
  b.avancer(3000);
  const m = manettes(b.sorties.slice(avant));
  assert.ok(m.length >= 41 && m.length <= 46, `trames en 3 s : ${m.length} (15 Hz visés, 14,3 Hz au pas de 10 ms)`);
  const ecarts = m.slice(1).map((x, i) => x.t - m[i].t);
  assert.ok(Math.min(...ecarts) >= 60, `écart minimal ${Math.min(...ecarts)} ms`);
  assert.ok(Math.max(...ecarts) <= 75, `écart maximal ${Math.max(...ecarts)} ms`);
  assert.ok(m.every((x) => octetSigne(x.trame[2]) === 60), 'la valeur reste 60 %');
});

test('pilote : un changement part tout de suite, sans attendre le battement', () => {
  const b = banc();
  b.pousser('joystick', { x: 0, y: 0.2 });
  b.avancer(1000);
  const n = manettes(b.sorties).length;
  b.pousser('joystick', { x: 0, y: 1 });
  b.avancer(60); // moins d'un battement
  const nouvelles = manettes(b.sorties).slice(n);
  assert.ok(nouvelles.length >= 1, 'une trame est partie dans les 60 ms');
  assert.ok(nouvelles[0].t - (b.t - 60) <= 10, 'et dans le premier tic');
});

test('pilote : rien du tout quand on ne touche à rien (aucune trame 0,0,0 en boucle)', () => {
  const b = banc();
  b.avancer(5000);
  assert.equal(b.sorties.length, 0);
  b.pousser('joystick', { x: 0, y: 0 }); // un doigt posé dans la zone morte ne dit rien non plus
  b.avancer(2000);
  assert.equal(b.sorties.length, 0);
});

test('pilote : au relâchement, STOP × 3 espacés, aucune trame MANETTE à zéro, puis le silence', () => {
  const b = banc();
  b.pousser('joystick', { x: 0, y: 0.8 });
  b.avancer(800);
  const n = b.sorties.length;
  b.pousser('joystick', { x: 0, y: 0 });
  assert.equal(b.pilote.sortie.vy, 0, 'le zéro est immédiat (pas de lissage à l\'arrêt)');
  b.avancer(2000);
  const apres = b.sorties.slice(n);
  assert.equal(stops(apres).length, 3);
  assert.equal(manettes(apres).length, 0, 'pas de MANETTE après le relâchement');
  const t = stops(apres).map((s) => s.t);
  assert.ok(t[1] - t[0] >= 60 && t[2] - t[1] >= 60);
  assert.ok(t[0] - (b.t - 2000) <= 15, 'le premier STOP part tout de suite');
  assert.deepEqual([...apres[0].trame], [...encoderStop()]);
  assert.equal(b.sorties.length - n, 3, 'puis plus rien');
});

test('pilote : un nouveau geste annule les STOP encore à venir', () => {
  const b = banc();
  b.pousser('joystick', { x: 0, y: 0.8 });
  b.avancer(500);
  b.pousser('joystick', { x: 0, y: 0 });
  b.avancer(20);
  b.pousser('joystick', { x: 0, y: 0.8 });
  const n = stops(b.sorties).length;
  b.avancer(500);
  assert.equal(stops(b.sorties).length, n, 'aucun STOP derrière le nouvel ordre de marche');
});

test("pilote : lissage — la montée est progressive, l'arrêt est immédiat", () => {
  const b = banc();
  b.pousser('joystick', { x: 0, y: 1 });
  b.avancer(600);
  const valeurs = manettes(b.sorties).map((s) => octetSigne(s.trame[2]));
  assert.ok(valeurs[0] < 60, `première trame ${valeurs[0]} : pas de saut à 100 d'un coup`);
  assert.ok(valeurs.every((v, i) => i === 0 || v >= valeurs[i - 1]), 'montée monotone');
  assert.equal(valeurs[valeurs.length - 1], 100);
  // le tremblement du pouce (±3 %) ne fait pas d'à-coups
  const b2 = banc();
  b2.pousser('joystick', { x: 0, y: 0.6 });
  b2.avancer(800);
  const n = b2.sorties.length;
  for (let i = 0; i < 60; i++) { b2.pousser('joystick', { x: 0, y: 0.6 + (i % 2 ? 0.03 : -0.03) }); b2.avancer(16); }
  const v = manettes(b2.sorties.slice(n)).map((s) => octetSigne(s.trame[2]));
  assert.ok(Math.max(...v) - Math.min(...v) <= 3, `étendue ${Math.max(...v) - Math.min(...v)} points`);
});

test("pilote : verrouillé (arrêt d'urgence), il n'envoie plus rien", () => {
  const b = banc();
  b.pilote.bloque = true;
  b.pousser('joystick', { x: 0, y: 1 });
  b.avancer(1000);
  b.pousser('joystick', { x: 0, y: 0 });
  b.avancer(500);
  assert.equal(b.sorties.length, 0);
});

test('pilote : le clavier et la manette se cumulent, le repère monde est transmis', () => {
  const b = banc();
  b.pilote.monde = true;
  b.pousser('clavier', { x: 1, y: 0, w: 0 });
  b.avancer(1500);
  const t = manettes(b.sorties).pop().trame;
  assert.deepEqual([...t], [...encoderManette(100, 0, 0, true)]);
});

// ---------- Courbe de la manette ----------

test('courbe : zone morte au centre, pleine course à 1, progressivité', () => {
  assert.deepEqual(courbeManette(ZONE_MORTE_MANETTE * 0.9, 0), { x: 0, y: 0 });
  assert.equal(courbeManette(0, 1).y, 1);
  assert.ok(courbeManette(0, 0.3).y < 0.15, `30 % de course = ${courbeManette(0, 0.3).y}`);
  assert.ok(courbeManette(0, 0.55).y < 0.4);
  let precedent = 0;
  for (let m = 0; m <= 1.0001; m += 0.01) { // croissante, sans saut
    const y = courbeManette(0, Math.min(m, 1), { aideAxes: false }).y;
    assert.ok(y >= precedent - 1e-9 && y - precedent < 0.05, `saut à ${m}: ${precedent} -> ${y}`);
    precedent = y;
  }
});

test('courbe : un léger écart latéral en poussant tout droit est effacé, la diagonale reste', () => {
  assert.equal(courbeManette(0.06, 0.7).x, 0);
  const diag = courbeManette(0.5, 0.5);
  assert.ok(Math.abs(diag.x - diag.y) < 1e-9 && diag.x > 0.2);
  assert.ok(courbeManette(0.06, 0.7, { aideAxes: false }).x > 0, "sans l'aide, l'écart reste");
  // continuité de l'aide : en balayant l'angle, la sortie ne saute jamais
  let avant = courbeManette(0, 0.8);
  for (let a = 0; a <= 60; a += 0.5) {
    const r = (a * Math.PI) / 180;
    const c = courbeManette(0.8 * Math.sin(r), 0.8 * Math.cos(r));
    assert.ok(Math.hypot(c.x - avant.x, c.y - avant.y) < 0.04, `saut à ${a}°`);
    avant = c;
  }
});

// ---------- File d'envoi ----------

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

/** Écriture lente façon Bluetooth ; refuse (comme Chrome) toute écriture lancée pendant une autre. */
class BleLent extends Transport {
  constructor(latence) { super('test'); this.latence = latence; this.enCours = false; this.chevauchements = 0; this.ecrites = []; }
  async _ecrire(trame) {
    if (this.enCours) { this.chevauchements++; throw new Error('GATT operation already in progress'); }
    this.enCours = true;
    await attendre(this.latence);
    this.enCours = false;
    this.ecrites.push({ t: performance.now(), trame });
  }
}

test("file d'envoi : jamais deux écritures en même temps, même quand l'écriture dure plus de 41 ms", async () => {
  const t = new BleLent(80);
  t._changerEtat('connecte');
  const debut = performance.now();
  while (performance.now() - debut < 800) { t.envoyer(encoderManette(0, 50, 0)); await attendre(10); }
  await attendre(200);
  assert.equal(t.chevauchements, 0);
  assert.ok(t.ecrites.length >= 4, `écrites : ${t.ecrites.length}`);
  assert.ok(t.fileMax <= 1, `file max ${t.fileMax} : une seule consigne en attente`);
  assert.ok(t.jetees > 20, `${t.jetees} consignes remplacées avant d'être écrites`);
  const types = new Set(t.ecrites.map((e) => e.trame[0]));
  assert.deepEqual([...types], [T.MANETTE]);
});

test('file d\'envoi : on ne garde que la DERNIÈRE consigne pendant une écriture en cours', async () => {
  const t = new BleLent(100);
  t._changerEtat('connecte');
  t.envoyer(encoderManette(0, 10, 0));
  await attendre(60); // la première est partie, l'écriture dure
  for (const v of [20, 30, 40, 50]) t.envoyer(encoderManette(0, v, 0));
  await attendre(400);
  assert.deepEqual(t.ecrites.map((e) => e.trame[2]), [10, 50]);
});

test('file d\'envoi : STOP efface toute consigne de marche encore en attente', async () => {
  const t = new BleLent(100);
  t._changerEtat('connecte');
  t.envoyer(encoderManette(0, 10, 0));
  await attendre(60);
  t.envoyer(encoderManette(0, 90, 0)); // en attente
  t.envoyer(encoderStop());
  await attendre(400);
  assert.deepEqual(t.ecrites.map((e) => e.trame[0]), [T.MANETTE, T.STOP]);
  t.envoyer(encoderManette(0, 70, 0));
  t.envoyer(encoderUrgence(true));
  await attendre(300);
  assert.equal(t.ecrites.filter((e) => e.trame[0] === T.MANETTE && e.trame[2] === 70).length, 0);
});

test('file d\'envoi : une consigne MANETTE périmée est jetée au lieu d\'être rejouée', async () => {
  const t = new BleLent(5);
  t._changerEtat('connecte');
  t.envoyer(encoderTexte('infos'));
  t.envoyer(encoderManette(0, 33, 0));
  // On gèle la pompe pendant plus que l'âge maximal, comme si la liaison avait calé.
  t._file.find((e) => e.cle === 'manette').t -= AGE_MAX_MANETTE_MS + 50;
  await attendre(250);
  assert.ok(!t.ecrites.some((e) => e.trame[0] === T.MANETTE), 'la vieille consigne n\'est pas partie');
  assert.ok(t.ecrites.some((e) => e.trame[0] === T.TEXTE), 'les autres trames passent');
});

// ---------- Repère : le rover par défaut, jamais le monde ----------

test('repère : par défaut la trame MANETTE a le bit « monde » à 0 (joystick, rotation, clavier, inclinaison)', () => {
  const b = banc();
  assert.equal(b.pilote.monde, false);
  for (const [nom, valeur] of [
    ['joystick', { x: 0.3, y: 0.9 }], ['rotation', { x: 0.8 }], ['clavier', { x: 0, y: 1, w: 0 }], ['inclinaison', { x: 0.2, y: 0.7 }],
  ]) {
    const n = b.sorties.length;
    b.pousser(nom, valeur);
    b.avancer(600);
    const trames = manettes(b.sorties.slice(n));
    assert.ok(trames.length > 0, `${nom} : des trames sont parties`);
    assert.ok(trames.every((x) => x.trame[4] === 0), `${nom} : bit monde = 0`);
    b.pilote.toutArreter(); b.pilote.signaler(); b.avancer(400);
  }
  b.pilote.monde = true; // option explicite
  b.pousser('joystick', { x: 0, y: 1 });
  b.avancer(300);
  assert.equal(manettes(b.sorties).pop().trame[4], 1);
});

test("file d'envoi : cinq écritures de suite en échec sont signalées (les commandes ne partent plus), puis le retour à la normale", async () => {
  class Capricieux extends Transport {
    constructor() { super('test'); this.panne = true; }
    async _ecrire() { if (this.panne) throw new Error('GATT operation failed'); }
  }
  const t = new Capricieux();
  t._changerEtat('connecte');
  const evenements = [];
  t.addEventListener('ecriture', (ev) => evenements.push(ev.detail.ok));
  for (let i = 0; i < 8; i++) { t.envoyer(encoderTexte(`a${i}`)); await attendre(60); }
  assert.deepEqual(evenements, [false], 'signalé une seule fois, au cinquième échec');
  t.panne = false;
  t.envoyer(encoderTexte('b')); await attendre(80);
  assert.deepEqual(evenements, [false, true]);
});
