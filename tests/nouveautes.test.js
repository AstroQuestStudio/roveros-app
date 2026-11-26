// Tests : patrouille par points, semi-veille, ligne de diagnostic du matériel, trames de mise à jour ignorées,
// et carte reçue « par différences » (quelques lignes seulement, dans le désordre).

import test from 'node:test';
import assert from 'node:assert/strict';
import { commandePatrouille, Patrouille, MAX_POINTS } from '../js/patrouille.js';
import { phraseMateriel, materielInquietant } from '../js/materiel.js';
import { phraseEtat } from '../js/diagnostic.js';
import { FauxRover } from '../js/faux-rover.js';
import {
  analyserLigne, decoder, encoderTexte, encoderCarte, appliquerCarte, TAILLE_CARTE, NOMS_DRAPEAUX,
} from '../js/protocole.js';

// ---------- Patrouille ----------

test('patrouille : la commande a des mètres à 2 décimales avec un point, jamais « -0.00 »', () => {
  assert.equal(commandePatrouille([{ x: 1, y: 2.5 }, { x: -0.004, y: 0.126 }]), 'mode patrouille 1.00 2.50 0.00 0.13');
  assert.equal(commandePatrouille([]), null);
  assert.equal(commandePatrouille([{ x: NaN, y: 1 }]), null);
});

test('patrouille : 6 points au plus, numérotés dans l\'ordre ; il en faut 2 pour lancer', () => {
  const p = new Patrouille();
  assert.equal(p.lancable, false);
  for (let i = 0; i < 9; i++) p.ajouter(i, i * 2);
  assert.equal(p.points.length, MAX_POINTS);
  assert.equal(p.pleine, true);
  assert.equal(p.ajouter(1, 1), false);
  assert.equal(p.commande().split(" ").length, 2 + 2 * MAX_POINTS);
  p.annulerDernier();
  assert.equal(p.points.length, 5);
  p.effacer();
  assert.equal(p.commande(), null);
  p.ajouter(0, 0);
  assert.equal(p.commande(), null, 'un seul point : pas de patrouille');
  p.ajouter(1, 1);
  assert.equal(p.commande(), 'mode patrouille 0.00 0.00 1.00 1.00');
});

const faire = (rover, s) => { for (let i = 0; i < s * 20; i++) rover.pas(0.05); };
function nouveau() {
  const textes = [];
  const rover = new FauxRover({ sortie: (t) => { const m = decoder(t); if (m?.type === 'texte') textes.push(m.texte); } });
  return { rover, textes };
}

test('faux rover : la patrouille enchaîne les points en boucle', () => {
  const { rover, textes } = nouveau();
  faire(rover, 25); // le sonar regarde un peu
  rover.recevoir(encoderTexte('mode patrouille 0.3 0.3 -0.4 0.3'));
  faire(rover, 60);
  const atteints = textes.filter((t) => /^evt point \d atteint/.test(t));
  assert.ok(atteints.length >= 3, `points atteints : ${atteints.join(' | ')}`);
  assert.deepEqual(atteints.slice(0, 3), ['evt point 1 atteint', 'evt point 2 atteint', 'evt point 1 atteint']);
  assert.equal(rover.mode, 'patrouille', 'le mode continue');
});

test('faux rover : patrouille sans point = erreur claire, la manette reprend la main', () => {
  const { rover, textes } = nouveau();
  rover.recevoir(encoderTexte('mode patrouille'));
  assert.ok(textes.some((t) => t.startsWith('err patrouille')));
  rover.recevoir(encoderTexte('mode patrouille 0.3 0.3 -0.4 0.3'));
  faire(rover, 2);
  rover.recevoir(Uint8Array.of(0x01, 0, 50, 0, 0)); // MANETTE : annule le comportement
  assert.equal(rover.mode, 'manuel');
});

// ---------- Semi-veille ----------

test('faux rover : veille après le délai, réveil à la moindre manette ; veille 0 = jamais', () => {
  const { rover, textes } = nouveau();
  rover.recevoir(encoderTexte('veille 5'));
  faire(rover, 4);
  assert.ok(!textes.includes('evt veille : tête et moteurs au repos'), 'pas encore');
  faire(rover, 3);
  assert.ok(textes.includes('evt veille : tête et moteurs au repos'));
  rover.recevoir(Uint8Array.of(0x01, 0, 40, 0, 0));
  assert.ok(textes.includes('evt réveil'));
  const { rover: r2, textes: t2 } = nouveau();
  r2.recevoir(encoderTexte('veille 0'));
  faire(r2, 120);
  assert.ok(!t2.some((t) => t.startsWith('evt veille :')), 'jamais');
});

test('veille : la pastille d\'état dit « En veille » (sobrement) au lieu de « Prêt à rouler », jusqu\'au réveil', () => {
  const e = { flags: Object.fromEntries(NOMS_DRAPEAUX.map((n) => [n, false])), libre: 255, vitesse: 0 };
  assert.equal(phraseEtat(e, { liaison: 'connecte' }).texte, 'Prêt à rouler');
  const v = phraseEtat(e, { liaison: 'connecte', veille: true });
  assert.equal(v.texte, 'En veille');
  assert.equal(v.niveau, 'neutre');
  // un vrai problème passe avant la veille
  e.flags.batterie = true;
  assert.equal(phraseEtat(e, { liaison: 'connecte', veille: true }).cle, 'batterie');
});

// ---------- Matériel ----------

test('matériel : la ligne est lisible (ms avec virgule, aucun retard, mémoire en Ko)', () => {
  const l = analyserLigne('materiel cycles=1234 calcul=700 calcul_max=2000 duree_max=2300 retards=0 err_driver=0 err_centrale=0 mem=73728');
  assert.equal(l.genre, 'materiel');
  assert.equal(phraseMateriel(l.valeurs), 'calcul 0,7 ms, au pire 2,0 ms, aucun retard, mémoire libre 72 Ko');
  assert.equal(materielInquietant(l.valeurs), false);
});

test('matériel : retards et erreurs sont dits en clair, champs manquants ignorés', () => {
  const v = analyserLigne('materiel calcul=1500 retards=3 err_driver=1 err_centrale=2 mem=51200').valeurs;
  assert.equal(phraseMateriel(v), 'calcul 1,5 ms, 3 retards, 1 erreur du pilote des moteurs, 2 erreurs de la centrale inertielle, mémoire libre 50 Ko');
  assert.equal(materielInquietant(v), true);
  assert.equal(phraseMateriel({ calcul: 700 }), 'calcul 0,7 ms');
  assert.equal(phraseMateriel(null), '');
});

test('faux rover : répond à « materiel »', () => {
  const { rover, textes } = nouveau();
  rover.recevoir(encoderTexte('materiel'));
  const l = textes.find((t) => t.startsWith('materiel '));
  assert.ok(l && phraseMateriel(analyserLigne(l).valeurs).includes('aucun retard'));
});

// ---------- Mise à jour du firmware : ignorée ----------

test('trames de type 0xA0 (mise à jour du firmware) : ignorées sans erreur', () => {
  assert.deepEqual(decoder(Uint8Array.of(0xa0, 1, 2, 3, 4)), { type: 'maj' });
  assert.deepEqual(decoder(Uint8Array.of(0xa0)), { type: 'maj' });
  assert.equal(decoder(Uint8Array.of(0xa0, 255, 255)).type, 'maj');
});

// ---------- Carte « par différences » ----------

const ligneDe = (v) => new Uint8Array(TAILLE_CARTE).fill(v);

test('carte par différences : quelques lignes seulement, dans n\'importe quel ordre', () => {
  const grille = new Uint8Array(TAILLE_CARTE * TAILLE_CARTE);
  // une trame avec 2 lignes tout en bas, puis une ligne isolée plus haut, puis la 63e, puis une ligne déjà reçue
  const recevoir = (ligne, lignes) => appliquerCarte(grille, decoder(encoderCarte(ligne, lignes)));
  assert.ok(recevoir(60, [ligneDe(1), ligneDe(2)]) > 0);
  assert.ok(recevoir(5, [ligneDe(2)]) > 0);
  assert.ok(recevoir(63, [ligneDe(1)]) > 0);
  assert.equal(grille[60 * TAILLE_CARTE], 1);
  assert.equal(grille[61 * TAILLE_CARTE + 10], 2);
  assert.equal(grille[5 * TAILLE_CARTE + 63], 2);
  assert.equal(grille[63 * TAILLE_CARTE], 1);
  assert.equal(grille[0], 0, 'les lignes jamais reçues restent inconnues');
  assert.equal(recevoir(5, [ligneDe(2)]), 0, 'une ligne inchangée ne change rien');
  // la ligne 5 repasse à « inconnu » : la carte se vide ligne par ligne
  assert.ok(recevoir(5, [ligneDe(0)]) > 0);
  assert.equal(grille[5 * TAILLE_CARTE + 63], 0);
});

test('carte par différences : trames tronquées ou hors limites refusées sans casser la grille', () => {
  const grille = new Uint8Array(TAILLE_CARTE * TAILLE_CARTE);
  const trame = encoderCarte(62, [ligneDe(1), ligneDe(1), ligneDe(1)]); // 3 lignes à partir de 62 : la 3e déborde
  const m = decoder(trame);
  assert.equal(m.lignes.length, 2, 'seules les lignes 62 et 63 sont lues');
  appliquerCarte(grille, m);
  assert.equal(grille.length, TAILLE_CARTE * TAILLE_CARTE);
  assert.equal(decoder(Uint8Array.of(0x83, 70, 1)), null, 'ligne hors carte');
  assert.equal(decoder(Uint8Array.of(0x83, 3, 2, 1, 2, 3)), null, 'trame sans ligne complète');
});

test('faux rover : « carte raz » vide la carte et seules les lignes changées repartent', () => {
  const grille = new Uint8Array(TAILLE_CARTE * TAILLE_CARTE);
  const rover = new FauxRover({ sortie: (t) => { const m = decoder(t); if (m?.type === 'carte') appliquerCarte(grille, m); } });
  faire(rover, 60);
  const avant = grille.filter((v) => v !== 0).length;
  assert.ok(avant > 800, 'la carte se remplit : ' + avant);
  rover.recevoir(encoderTexte('carte raz'));
  assert.ok(rover.carte.every((v) => v === 0));
  for (let i = 0; i < 8; i++) rover.envoyerCarte(); // la carte du rover est vide : les 8 envois de 8 lignes la renvoient en entier
  const apres = grille.filter((v) => v !== 0).length;
  assert.equal(apres, 0, `la carte reçue se vide bien : ${avant} -> ${apres} cases connues`);
});
