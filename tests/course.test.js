import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Course, Records, ETATS, enTrame, cleDistance, stockageLocal, positionRejeu, couleurVitesse, CLE_RECORDS, MAX_TRACE,
} from '../js/course.js';

const proche = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `attendu ${b}, obtenu ${a}`);

/** Joue une liste de vitesses (m/s), un état toutes les 50 ms à partir de t0, en allant droit devant. */
function jouer(c, vitesses, t0 = 0, pas = 50) {
  let x = 0;
  vitesses.forEach((v, i) => {
    const t = t0 + i * pas;
    c.mesurer({ x, y: 0, v, arrive: false }, t);
    x += v * pas / 1000;
  });
  return t0 + vitesses.length * pas;
}

/** Stockage fictif en mémoire, comme localStorage. */
function stockageMemoire() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _m: m,
  };
}

const stockageHS = {
  getItem() { throw new Error('acces refuse'); },
  setItem() { throw new Error('quota'); },
  removeItem() { throw new Error('acces refuse'); },
};

test('course : temps, moyenne, pointe et distance exacts sur une trace fabriquée', () => {
  const c = new Course();
  c.lancer(3, 1000);
  assert.equal(c.etat, ETATS.EN_COURSE);
  // départ réel à t = 1 550 ms : premier état au-dessus de 0,02 m/s
  for (let t = 1000; t < 1550; t += 50) c.mesurer({ x: 0, y: 0, v: 0, arrive: false }, t);
  assert.equal(c.tDepart, null);
  // roulage à 1 m/s pendant 3 s : x = 0 → 3 m
  const v = [];
  for (let k = 0; k <= 60; k++) v.push(1);
  jouer(c, v, 1550);
  c.ligne('evt arrivé', 4550);
  assert.equal(c.etat, ETATS.ARRIVE);
  proche(c.temps, 3.0);
  proche(c.moyenne, 1.0);
  proche(c.pointe, 1.0);
  proche(c.distance, 3.0, 1e-6); // 61 états espacés de 5 cm : la somme des déplacements redonne 3 m
  assert.equal(c.ralentissements, 0);
  assert.equal(c.trace[0].t, 0);
  assert.ok(c.trace.at(-1).t >= 3.0 - 1e-9);
});

test('course : le temps part du départ réel, pas du lancement', () => {
  const c = new Course();
  c.lancer(1, 1000);
  for (let t = 1000; t < 2500; t += 50) c.mesurer({ x: 0, y: 0, v: 0, arrive: false }, t);
  // départ à 2 500 ms, 0,5 m/s, arrivée 2 s plus tard sur 1 m
  const vitesses = Array(41).fill(0.5); // le 41e état tombe sur x = 1 m, à t = 4 500 ms
  jouer(c, vitesses, 2500);
  c.ligne('evt arrivé', 4500);
  proche(c.temps, 2.0);
  proche(c.moyenne, 0.5, 1e-6);
});

test('course : l’arrivée annoncée par le drapeau « arrive » (après un passage à faux)', () => {
  const c = new Course();
  c.lancer(1, 0);
  c.mesurer({ x: 0, y: 0, v: 0.5, arrive: true }, 100); // drapeau encore levé d'une course précédente : ignoré
  assert.equal(c.etat, ETATS.EN_COURSE);
  c.mesurer({ x: 0.2, y: 0, v: 0.5, arrive: false }, 200);
  c.mesurer({ x: 1, y: 0, v: 0.5, arrive: true }, 1000);
  assert.equal(c.etat, ETATS.ARRIVE);
  proche(c.temps, 0.9);
});

test('course : la ligne « objectif abandonné » avant le départ réel ne coupe pas la course', () => {
  const c = new Course();
  c.lancer(2, 0);
  c.ligne('evt objectif abandonné', 10);
  assert.equal(c.etat, ETATS.EN_COURSE);
  c.mesurer({ x: 0, y: 0, v: 0.6, arrive: false }, 100);
  c.ligne('evt objectif abandonné', 200);
  assert.equal(c.etat, ETATS.ABANDON);
  assert.equal(c.temps, null);
});

test('course : abandon par STOP, la durée s’arrête', () => {
  const c = new Course();
  c.lancer(3, 0);
  c.mesurer({ x: 0, y: 0, v: 0.5, arrive: false }, 1000);
  c.mesurer({ x: 0.5, y: 0, v: 0.5, arrive: false }, 2000);
  c.arreter(2500);
  assert.equal(c.etat, ETATS.ABANDON);
  assert.equal(c.raison, 'arrêt (STOP)');
  assert.equal(c.temps, null);
  assert.equal(c.duree(9999), 1.5);
  c.ligne('evt arrivé', 3000); // trop tard : la course est finie
  assert.equal(c.etat, ETATS.ABANDON);
});

test('course : déconnexion en course, le chrono ne reste pas ouvert', () => {
  const c = new Course();
  c.lancer(3, 0);
  c.mesurer({ x: 0, y: 0, v: 0.5, arrive: false }, 500);
  c.deconnexion(1500);
  assert.equal(c.etat, ETATS.ABANDON);
  assert.equal(c.raison, 'liaison perdue');
  assert.equal(c.duree(5000), 1.0);
});

test('course : une commande « mode » autre que la course arrête la course, pas « mode course » ni « infos »', () => {
  const c = new Course();
  c.lancer(3, 0);
  c.commande('infos', 10);
  assert.equal(c.etat, ETATS.EN_COURSE);
  c.commande('mode course 4', 20);
  assert.equal(c.etat, ETATS.EN_COURSE);
  c.commande('mode chien', 30);
  assert.equal(c.etat, ETATS.ABANDON);
});

test('course : une erreur du rover pendant la course l’abandonne', () => {
  const c = new Course();
  c.lancer(3, 0);
  c.mesurer({ x: 0, y: 0, v: 0.5, arrive: false }, 100);
  c.ligne('err pas de chemin vers ce point', 300);
  assert.equal(c.etat, ETATS.ABANDON);
  assert.match(c.raison, /pas de chemin/);
});

test('course : les ralentissements (sous 30 % de la pointe plus de 0,3 s) sont comptés une fois chacun', () => {
  const c = new Course();
  c.lancer(5, 0);
  const vitesses = [
    ...Array(5).fill(1), // pointe 1 m/s
    ...Array(10).fill(0.1), // 0,5 s sous le seuil : 1 ralentissement
    ...Array(10).fill(1),
    ...Array(4).fill(0.1), // 0,2 s : trop court
    ...Array(5).fill(1),
  ];
  // le premier état sert de départ réel : 0,02 m/s dépassé dès le premier état
  jouer(c, vitesses, 100);
  assert.equal(c.ralentissements, 1);
  proche(c.pointe, 1);
});

test('course : la trace est échantillonnée à 10 Hz au plus et bornée', () => {
  const c = new Course();
  c.lancer(100, 0);
  c.mesurer({ x: 0, y: 0, v: 1, arrive: false }, 0); // départ
  // 20 Hz pendant 2 s : environ 20 points à 10 Hz, pas 40
  for (let t = 50; t <= 2000; t += 50) c.mesurer({ x: t / 1000, y: 0, v: 1, arrive: false }, t);
  assert.ok(c.trace.length <= 22, `trop de points : ${c.trace.length}`);
  // plus de 3 000 échantillons à 10 Hz (plus de 400 s de course) : la trace reste bornée
  const d = new Course();
  d.lancer(1000, 0);
  for (let t = 0; t <= 400000; t += 100) d.mesurer({ x: t / 1000, y: 0, v: 1, arrive: false }, t);
  assert.equal(d.trace.length, MAX_TRACE);
});

test('course : enTrame convertit mm et cm/s en m et m/s', () => {
  const e = enTrame({ x: 1500, y: -250, vitesse: 40, flags: { arrive: true } });
  assert.deepEqual(e, { x: 1.5, y: -0.25, v: 0.4, arrive: true });
});

test('records : clé au demi-mètre, cinq meilleurs temps triés, dates gardées, rang du record', () => {
  assert.equal(cleDistance(3), '3');
  assert.equal(cleDistance(3.2), '3');
  assert.equal(cleDistance(3.3), '3.5');
  const r = new Records(stockageMemoire());
  assert.equal(r.enregistrer(3, 5.0, 1), 0);
  assert.equal(r.enregistrer(3, 6.0, 2), 1);
  assert.equal(r.enregistrer(3, 4.0, 3), 0);
  r.enregistrer(3, 7.0, 4);
  r.enregistrer(3, 8.0, 5);
  assert.equal(r.enregistrer(3, 9.0, 6), -1, 'un sixième temps plus lent n’entre pas');
  const liste = r.classement(3);
  assert.deepEqual(liste.map((x) => x.temps), [4.0, 5.0, 6.0, 7.0, 8.0]);
  assert.deepEqual(liste[1], { temps: 5.0, date: 1 });
  assert.equal(r.classement(4).length, 0, 'une autre distance a ses propres records');
  assert.equal(r.meilleur(3).temps, 4.0);
});

test('records : persistés et relus, données corrompues ignorées', () => {
  const s = stockageMemoire();
  new Records(s).enregistrer(2, 3.3, 10);
  assert.equal(new Records(s).meilleur(2).temps, 3.3);
  s.setItem(CLE_RECORDS, '{pas du json');
  assert.deepEqual(new Records(s).classement(2), []);
  s.setItem(CLE_RECORDS, JSON.stringify({ 2: [{ temps: 'x', date: 1 }, { temps: 4, date: 2 }, null] }));
  assert.deepEqual(new Records(s).classement(2), [{ temps: 4, date: 2 }]);
});

test('records : effacer vide les records', () => {
  const s = stockageMemoire();
  const r = new Records(s);
  r.enregistrer(3, 4, 1);
  r.effacer();
  assert.deepEqual(r.classement(3), []);
  assert.deepEqual(new Records(s).classement(3), []);
});

test('records : localStorage indisponible, le jeu marche quand même', () => {
  const r = new Records(stockageHS);
  assert.equal(r.enregistrer(3, 4.2, 1), 0);
  assert.equal(r.meilleur(3).temps, 4.2);
  r.effacer();
  assert.equal(r.meilleur(3), null);
  // et sans stockage du tout
  assert.equal(new Records(null).enregistrer(3, 4, 1), 0);
  // accès à localStorage qui lève une exception
  const global = { get localStorage() { throw new Error('bloqué'); } };
  assert.equal(stockageLocal(global), null);
  assert.equal(stockageLocal({}), null);
});

test('rejeu : position interpolée sur la trace, bornes respectées', () => {
  const trace = [{ t: 0, x: 0, y: 0, v: 0 }, { t: 1, x: 1, y: 0, v: 1 }, { t: 2, x: 1, y: 2, v: 2 }];
  proche(positionRejeu(trace, 0.5).x, 0.5);
  proche(positionRejeu(trace, 1.5).y, 1);
  proche(positionRejeu(trace, 1.5).v, 1.5);
  assert.equal(positionRejeu(trace, -3).x, 0);
  assert.equal(positionRejeu(trace, 99).y, 2);
  assert.equal(positionRejeu([], 1), null);
});

test('rejeu : couleur de la vitesse, du lent à la pointe', () => {
  assert.equal(couleurVitesse(0, 1), 'rgb(29, 233, 198)');
  assert.equal(couleurVitesse(1, 1), 'rgb(255, 179, 71)');
  assert.equal(couleurVitesse(5, 1), 'rgb(255, 179, 71)');
  assert.equal(couleurVitesse(0.5, 0), 'rgb(29, 233, 198)');
});
