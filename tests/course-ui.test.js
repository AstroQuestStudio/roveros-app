import test from 'node:test';
import assert from 'node:assert/strict';
import { CourseJeu, formaterSecondes, formaterVitesse, formaterDistance, texteEcart } from '../js/course-ui.js';
import { Records, ETATS } from '../js/course.js';

// Hors navigateur : l'animation et le document sont simulés, la logique de course est la vraie.
globalThis.requestAnimationFrame ??= () => 0;
globalThis.cancelAnimationFrame ??= () => {};

const proche = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `attendu ${b}, obtenu ${a}`);

/** Document sans aucun élément : la carte ne dessine rien, mais la machine tourne. */
function faussePage() {
  return {
    getElementById: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ textContent: '', classList: { add() {} } }),
  };
}

function memoire() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

/** Un état du rover, en unités de la trame (mm, cm/s). */
const etat = (x, vitesse, arrive = false) => ({ x, y: 0, vitesse, flags: { arrive } });

test('une course arrivée : temps mesuré du départ réel, record enregistré', () => {
  const records = new Records(memoire());
  const ui = new CourseJeu(faussePage(), records);
  ui.lancer(3, 1000);
  ui.etat(etat(0, 0), 1000); // à l'arrêt, drapeau « arrive » à faux : il a été vu retomber
  ui.etat(etat(100, 100), 1100); // premier mouvement réel : le chrono part ici
  for (let i = 2; i <= 30; i++) ui.etat(etat(i * 100, 100), 1000 + i * 100);
  ui.etat(etat(3000, 0, true), 4100);
  assert.equal(ui.derniere.etat, ETATS.ARRIVE);
  proche(ui.derniere.temps, 3.0);
  assert.equal(ui.derniere.rang, 0);
  proche(records.meilleur(3).temps, 3.0);
});

test('l’arrivée annoncée par le rover (ligne « evt arrivé ») termine aussi la course', () => {
  const ui = new CourseJeu(faussePage(), new Records(memoire()));
  ui.lancer(3, 1000);
  ui.etat(etat(100, 100), 1100);
  ui.ligne('evt arrivé', 2100);
  assert.equal(ui.derniere.etat, ETATS.ARRIVE);
  proche(ui.derniere.temps, 1.0);
});

test('STOP pendant la course : abandon, aucun temps enregistré', () => {
  const records = new Records(memoire());
  const ui = new CourseJeu(faussePage(), records);
  ui.lancer(3, 1000);
  ui.etat(etat(100, 100), 1100);
  ui.arreter(1500);
  assert.equal(ui.derniere.etat, ETATS.ABANDON);
  assert.equal(ui.derniere.raison, 'arrêt (STOP)');
  assert.equal(records.meilleur(3), null);
});

test('hors course, états, lignes et arrêts sont sans effet', () => {
  const ui = new CourseJeu(faussePage(), new Records(memoire()));
  ui.etat(etat(100, 100), 1100);
  ui.ligne('evt arrivé', 1200);
  ui.arreter(1300);
  ui.deconnexion(1400);
  ui.commande('mode course 4', 1500);
  assert.equal(ui.derniere, null);
  assert.equal(ui.jeu.enCours, false);
});

test('une autre commande de mode pendant la course l’arrête', () => {
  const ui = new CourseJeu(faussePage(), new Records(memoire()));
  ui.lancer(3, 1000);
  ui.commande('mode course 4', 1050); // la course elle-même ne compte pas
  assert.equal(ui.jeu.enCours, true);
  ui.commande('mode explorer', 1100);
  assert.equal(ui.derniere.etat, ETATS.ABANDON);
});

test('formats : virgule décimale, un chiffre pour le temps, deux pour la vitesse', () => {
  assert.equal(formaterSecondes(12.34), '12,3 s');
  assert.equal(formaterSecondes(0), '0,0 s');
  assert.equal(formaterVitesse(0.5), '0,50 m/s');
  assert.equal(formaterDistance(3), '3,0 m');
  assert.equal(formaterDistance(0.5), '0,5 m');
});

test('écart au record : premier temps, nouveau record, ou retard', () => {
  assert.equal(texteEcart({ temps: 3.2, meilleurAvant: null, rang: 0 }), 'premier temps à cette distance');
  assert.equal(texteEcart({ temps: 2.5, meilleurAvant: { temps: 3.0 }, rang: 0 }), '0,5 s de mieux que l’ancien record');
  assert.equal(texteEcart({ temps: 4.2, meilleurAvant: { temps: 3.0 }, rang: -1 }), '+1,2 s par rapport au record');
});
