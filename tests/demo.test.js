import test from 'node:test';
import assert from 'node:assert/strict';
import { Demo, ETATS, annonceDemo, traduireRefus } from '../js/demo.js';

/** Une démo connectée, prête à partir. */
function connectee() {
  const d = new Demo();
  d.liaison(true);
  return d;
}

test('carte cachée : sans « demo » dans la ligne modes, la démo ne s\'annonce pas', () => {
  assert.equal(annonceDemo(['manuel', 'aller', 'autotest']), false);
  assert.equal(annonceDemo([]), false);
  assert.equal(annonceDemo(['manuel', 'demo']), true);
});

test('démo : on ne lance rien sans liaison', () => {
  const d = new Demo();
  assert.equal(d.vue().lancable, false);
  assert.equal(d.demarrer(), false);
  assert.equal(d.vue().etat, ETATS.PRET);
});

test('démo : le déroulé heureux (vérification, en cours, finie)', () => {
  const d = connectee();
  assert.equal(d.vue().lancable, true);
  assert.equal(d.demarrer(), true);
  assert.equal(d.vue().etat, ETATS.VERIFICATION);
  assert.equal(d.vue().lancable, false);
  assert.equal(d.ligne('Mode démo : je vérifie que la place est libre'), true);
  assert.equal(d.vue().etat, ETATS.VERIFICATION);
  d.ligne('demo : place libre, objet à 0.44 m');
  const enCours = d.vue();
  assert.equal(enCours.etat, ETATS.EN_COURS);
  assert.equal(enCours.enCours, true);
  assert.equal(enCours.detail, 'Objet à 0,44 m.');
  assert.equal(enCours.duree, null);
  d.ligne('evt demo finie : 121 s, 10.7 m');
  const fin = d.vue();
  assert.equal(fin.etat, ETATS.FINIE);
  assert.equal(fin.libelle, 'Terminée');
  assert.equal(fin.duree, '121 s');
  assert.equal(fin.distance, '10,7 m');
  assert.equal(fin.lancable, true);
  assert.equal(fin.enCours, false);
});

test('démo : refus « pas d\'objet devant »', () => {
  const d = connectee();
  d.demarrer();
  d.ligne("err demo : pas d'objet devant (à poser entre 35 et 75 cm)");
  assert.equal(d.vue().etat, ETATS.REFUSEE);
  assert.match(d.vue().phrase, /pas d'objet devant le rover/);
  assert.match(d.vue().phrase, /35 et 75 cm/);
});

test('démo : refus « objet trop près » garde la distance', () => {
  const phrase = traduireRefus('objet trop près (0.24 m), à poser entre 35 et 75 cm devant');
  assert.match(phrase, /trop près \(0,24 m\)/);
  assert.match(phrase, /35 et 75 cm/);
});

test('démo : refus « obstacle à droite » garde les deux distances', () => {
  const phrase = traduireRefus('obstacle à 0.35 m à droite (il manque 0.38 m)');
  assert.match(phrase, /0,38 m/);
  assert.match(phrase, /0,35 m à droite/);
});

test('démo : refus « c\'est un mur »', () => {
  const d = connectee();
  d.demarrer();
  d.ligne("err demo : devant, c'est un mur et pas un objet");
  assert.equal(d.vue().etat, ETATS.REFUSEE);
  assert.match(d.vue().phrase, /un mur et non un objet/);
});

test('démo : refus inconnu, le texte du rover est repris tel quel', () => {
  assert.match(traduireRefus('quelque chose de nouveau'), /quelque chose de nouveau$/);
});

test('démo : arrêt de sécurité annoncé par le rover', () => {
  const d = connectee();
  d.demarrer();
  d.ligne('demo : place libre, objet à 0.50 m');
  d.ligne('evt demo arrêtée : obstacle proche');
  const v = d.vue();
  assert.equal(v.etat, ETATS.ARRETEE);
  assert.equal(v.detail, 'Raison : obstacle proche');
  assert.equal(v.lancable, true);
});

test('démo : déconnexion pendant la démo, on le dit', () => {
  const d = connectee();
  d.demarrer();
  d.ligne('demo : place libre, objet à 0.50 m');
  assert.equal(d.liaison(false), true);
  const v = d.vue();
  assert.equal(v.etat, ETATS.ARRETEE);
  assert.match(v.phrase, /Liaison perdue/);
  assert.match(v.detail, /arrêt d'urgence/);
  assert.equal(v.lancable, false);
});

test('démo : déconnexion hors démo ne change rien', () => {
  const d = connectee();
  assert.equal(d.liaison(false), false);
  assert.equal(d.vue().etat, ETATS.PRET);
});

test('démo : STOP (arrêt d\'urgence) pendant une démo', () => {
  const d = connectee();
  d.demarrer();
  assert.equal(d.arreter(), true);
  assert.equal(d.vue().etat, ETATS.ARRETEE);
  assert.equal(d.vue().enCours, false);
  // hors démo, le STOP ne fait rien
  const calme = connectee();
  assert.equal(calme.arreter(), false);
  assert.equal(calme.vue().etat, ETATS.PRET);
});

test('démo : une seule démo à la fois', () => {
  const d = connectee();
  d.demarrer();
  assert.equal(d.demarrer(), false);
});

test('démo : une ligne sans rapport ne change rien', () => {
  const d = connectee();
  assert.equal(d.ligne('info version=rust100-0.1'), false);
  assert.equal(d.ligne('evt en route'), false);
  assert.equal(d.vue().etat, ETATS.PRET);
});

test('démo : reinitialiser repart de « prête » et oublie la liaison', () => {
  const d = connectee();
  d.demarrer();
  d.reinitialiser();
  assert.equal(d.vue().etat, ETATS.PRET);
  assert.equal(d.vue().lancable, false);
});
