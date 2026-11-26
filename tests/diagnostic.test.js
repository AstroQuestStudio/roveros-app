// Tests de la ligne d'état en clair, des notifications sans rafale et de l'état des sécurités obstacles.

import test from 'node:test';
import assert from 'node:assert/strict';
import { phraseEtat, Diagnostic, Limiteur, etatSecurites, directionMot } from '../js/diagnostic.js';
import { NOMS_DRAPEAUX, DRAPEAUX_FR } from '../js/protocole.js';

const etat = (flags = {}, plus = {}) => ({
  flags: Object.fromEntries(NOMS_DRAPEAUX.map((n) => [n, !!flags[n]])), libre: 255, vitesse: 0, sonar: 0, ...plus,
});
const ctx = (plus = {}) => ({ liaison: 'connecte', commande: { vx: 0, vy: 0, w: 0 }, ...plus });

test('phrases : obstacle avec distance libre et direction', () => {
  const avant = phraseEtat(etat({ obstacle: true }, { libre: 14 }), ctx({ commande: { vx: 0, vy: 60, w: 0 } }));
  assert.equal(avant.texte, 'Obstacle à 14 cm devant');
  const arriere = phraseEtat(etat({ obstacle: true }, { libre: 9 }), ctx({ commande: { vx: 0, vy: -60, w: 0 } }));
  assert.equal(arriere.texte, 'Obstacle à 9 cm derrière');
  assert.equal(phraseEtat(etat({ obstacle: true }), ctx()).texte, 'Arrêté : obstacle devant', 'distance inconnue (255)');
});

test('phrases : aveugle, soulevé (pris en main), garde, urgence, batterie…', () => {
  assert.equal(phraseEtat(etat({ aveugle: true }), ctx({ commande: { vx: 0, vy: -50, w: 0 } })).texte, 'Ralenti : il ne voit pas derrière lui');
  assert.equal(phraseEtat(etat({ aveugle: true }), ctx({ commande: { vx: -50, vy: 0, w: 0 } })).texte, 'Ralenti : il ne voit pas son côté gauche');
  assert.match(phraseEtat(etat({ souleve: true }), ctx()).texte, /Pris en main/);
  assert.match(phraseEtat(etat({ choc: true }), ctx()).texte, /Contact/);
  assert.match(phraseEtat(etat({ urgence: true }), ctx()).texte, /Arrêt d'urgence/);
  assert.match(phraseEtat(etat({ batterie: true }), ctx()).texte, /Batterie faible/);
  assert.equal(phraseEtat(etat({ garde: true }), ctx({ commande: { vx: 0, vy: 50, w: 0 } })).texte, "Plus d'ordre reçu : arrêté (liaison coupée ?)");
  // « garde » sans que l'utilisateur pousse : c'est juste l'arrêt normal après le relâchement
  assert.equal(phraseEtat(etat({ garde: true }), ctx()).cle, 'pret');
});

test('phrases : hors liaison et au repos', () => {
  assert.equal(phraseEtat(null, { liaison: 'deconnecte' }).texte, 'Pas de rover connecté');
  assert.equal(phraseEtat(null, ctx()).cle, 'attente');
  assert.equal(phraseEtat(etat(), ctx()).niveau, 'ok');
  assert.equal(phraseEtat(etat({ mouvement: true }), ctx()).texte, 'En mouvement');
  assert.equal(phraseEtat(etat(), ctx({ mode: 'Retour à la base' })).texte, 'Retour à la base en cours');
});

test('le libellé du drapeau « souleve » dit : pris en main ou roues sans prise', () => {
  assert.match(DRAPEAUX_FR.souleve.texte, /main/i);
  assert.match(DRAPEAUX_FR.souleve.texte, /roues sans prise/i);
});

test('direction : par défaut devant, sinon selon la commande', () => {
  assert.equal(directionMot(null).devant, 'devant');
  assert.equal(directionMot({ vx: 80, vy: 10 }).devant, 'à droite');
  assert.equal(directionMot({ vx: 0, vy: -80 }).cle, 'arriere');
});

test('ligne : un drapeau qui ne dure qu\'une trame ne change rien et ne prévient personne', () => {
  const d = new Diagnostic();
  let t = 0;
  const pas = (e) => d.traiter(e, ctx(), (t += 125));
  pas(etat());
  pas(etat());
  const annonces = [];
  const lignes = [];
  for (let i = 0; i < 10; i++) {
    const r = pas(etat(i % 5 === 2 ? { driver_ko: true } : {}));
    lignes.push(r.ligne.cle);
    if (r.annonce) annonces.push(r.annonce);
  }
  assert.ok(lignes.every((c) => c === 'pret'), `ligne : ${lignes}`);
  assert.equal(annonces.length, 0);
});

test('ligne : un drapeau qui dure prévient une fois, puis plus pendant 5 s, puis de nouveau', () => {
  const d = new Diagnostic();
  let t = 1000;
  const annonces = [];
  const pas = (e) => { const r = d.traiter(e, ctx(), t); t += 125; if (r.annonce) annonces.push({ t, ...r.annonce }); return r; };
  for (let i = 0; i < 3; i++) pas(etat());
  for (let i = 0; i < 20; i++) pas(etat({ driver_ko: true })); // 2,5 s
  assert.equal(annonces.length, 1, 'une seule notification');
  assert.equal(d.ligne.cle, 'driver_ko');
  // il disparaît puis revient 1 s plus tard : même message, dans les 5 s -> silence
  for (let i = 0; i < 8; i++) pas(etat());
  for (let i = 0; i < 10; i++) pas(etat({ driver_ko: true }));
  assert.equal(annonces.length, 1, 'pas de seconde notification identique en moins de 5 s');
  // après 5 s : à nouveau permis
  for (let i = 0; i < 40; i++) pas(etat());
  for (let i = 0; i < 10; i++) pas(etat({ driver_ko: true }));
  assert.equal(annonces.length, 2);
});

test('ligne : le même message en rafale (drapeau qui clignote) ne fait jamais deux notifications en 5 s', () => {
  const d = new Diagnostic();
  let t = 0;
  let n = 0;
  for (let i = 0; i < 400; i++) { // 50 s de clignotement : 4 trames allumées, 2 éteintes
    const r = d.traiter(etat(i % 6 < 4 ? { driver_ko: true } : {}), ctx(), (t += 125));
    if (r.annonce) n++;
  }
  assert.ok(n <= 50_000 / 5000, `${n} notifications en 50 s`);
  assert.ok(n >= 1);
});

test('ligne : la distance de l\'obstacle se met à jour sans attendre', () => {
  const d = new Diagnostic();
  const c = ctx({ commande: { vx: 0, vy: 50, w: 0 } });
  let t = 0;
  for (let i = 0; i < 4; i++) d.traiter(etat({ obstacle: true }, { libre: 20 }), c, (t += 125));
  assert.equal(d.ligne.texte, 'Obstacle à 20 cm devant');
  const r = d.traiter(etat({ obstacle: true }, { libre: 14 }), c, (t += 125));
  assert.equal(r.ligne.texte, 'Obstacle à 14 cm devant');
});

test('limiteur : 5 s entre deux messages identiques, messages différents indépendants', () => {
  const l = new Limiteur(5000);
  assert.equal(l.autoriser('a', 0), true);
  assert.equal(l.autoriser('a', 4999), false);
  assert.equal(l.autoriser('b', 100), true);
  assert.equal(l.autoriser('a', 5000), true);
});

test('sécurités : état lu dans les paramètres réels du rover', () => {
  const p = (reflexe, carte) => new Map([['reflexe', { valeur: reflexe }], ['carte_on', { valeur: carte }]]);
  assert.equal(etatSecurites(p(1, 1)), 'actives');
  assert.equal(etatSecurites(p(0, 0)), 'coupees');
  assert.equal(etatSecurites(p(0, 1)), 'partielles');
  assert.equal(etatSecurites(new Map()), 'inconnu');
});
