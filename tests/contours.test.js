import test from 'node:test';
import assert from 'node:assert/strict';
import { boucles, adoucir, aire } from '../js/contours.js';

const N = 12;
const grille = (...cases) => { const g = new Uint8Array(N * N); for (const [c, l] of cases) g[l * N + c] = 2; return g; };
const pleines = (v) => v === 2;
const proche = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test('contours : une grille vide ne donne rien', () => {
  assert.deepEqual(boucles(new Uint8Array(N * N), N, pleines), []);
});

test('contours : un poteau d\'une seule case reste visible (sa boucle a 4 coins et l\'aire d\'une case)', () => {
  const b = boucles(grille([5, 5]), N, pleines);
  assert.equal(b.length, 1);
  assert.equal(b[0].length, 4);
  proche(aire(b[0]), 1);
  // après adoucissement : plus rond, mais pas effacé (au moins 80 % de sa surface)
  const lisse = adoucir(b[0], 2);
  const a = aire(lisse);
  assert.ok(a > 0.8 && a < 1, `aire lissée ${a}`);
  // et il reste exactement dans sa case (aucune bavure)
  for (const [x, y] of lisse) assert.ok(x >= 5 && x <= 6 && y >= 5 && y <= 6, `sommet hors de la case : ${x}, ${y}`);
});

test('contours : deux poteaux séparés = deux boucles ; un mur continu = une seule boucle sans coin superflu', () => {
  assert.equal(boucles(grille([2, 2], [8, 8]), N, pleines).length, 2);
  const mur = boucles(grille([2, 4], [3, 4], [4, 4], [5, 4], [6, 4]), N, pleines);
  assert.equal(mur.length, 1);
  assert.equal(mur[0].length, 4, 'un rectangle : 4 coins seulement');
  proche(aire(mur[0]), 5);
});

test('contours : un anneau a un contour extérieur et un trou qui tourne dans l\'autre sens', () => {
  const cases = [];
  for (let i = 3; i <= 7; i++) for (let j = 3; j <= 7; j++) if (i === 3 || i === 7 || j === 3 || j === 7) cases.push([i, j]);
  const b = boucles(grille(...cases), N, pleines);
  assert.equal(b.length, 2);
  const aires = b.map(aire).sort((x, y) => x - y);
  proche(aires[0], -9); // le trou 3 × 3, orienté à l'envers
  proche(aires[1], 25); // le carré extérieur 5 × 5
  proche(aires[0] + aires[1], 16); // la surface réelle : 16 cases
});

test('contours : un mur en diagonale reste d\'un seul tenant', () => {
  const b = boucles(grille([2, 2], [3, 3], [4, 4], [5, 5]), N, pleines);
  assert.equal(b.length, 1, `${b.length} morceaux`);
});

test('contours : l\'adoucissement ne déborde jamais de la surface d\'origine (rien d\'inventé) et garde sa taille à ±15 %', () => {
  const cases = [];
  for (let i = 2; i <= 9; i++) for (let j = 3; j <= 8; j++) cases.push([i, j]);
  cases.push([5, 9], [5, 10]); // une saillie
  const g = grille(...cases);
  const [b] = boucles(g, N, pleines);
  const lisse = adoucir(b, 2);
  const a0 = aire(b); const a1 = aire(lisse);
  assert.ok(a1 < a0 && a1 > a0 * 0.85, `aire ${a0} -> ${a1}`);
  // chaque sommet lissé est dans une case choisie, ou à moins de 0,3 case d'elle (les creux se comblent un peu, jamais plus)
  const distance = (x, y, c, l) => Math.hypot(Math.max(c - x, 0, x - (c + 1)), Math.max(l - y, 0, y - (l + 1)));
  for (const [x, y] of lisse) {
    let d = Infinity;
    for (const [c, l] of cases) d = Math.min(d, distance(x, y, c, l));
    assert.ok(d < 0.3, `sommet lissé à ${d.toFixed(2)} case de toute case choisie : ${x}, ${y}`);
  }
});

test('contours : une grille entièrement pleine donne un seul contour de 4 coins', () => {
  const g = new Uint8Array(N * N).fill(2);
  const b = boucles(g, N, pleines);
  assert.equal(b.length, 1);
  assert.equal(b[0].length, 4);
  proche(aire(b[0]), N * N);
});

test('contours : le prédicat choisit les cases (libres, possibles, obstacles séparément)', () => {
  const g = new Uint8Array(N * N);
  g[3 * N + 3] = 1; g[3 * N + 4] = 1; g[6 * N + 6] = 3; g[8 * N + 8] = 2;
  assert.equal(boucles(g, N, (v) => v === 1).length, 1);
  assert.equal(boucles(g, N, (v) => v === 3).length, 1);
  assert.equal(boucles(g, N, (v) => v === 2).length, 1);
  assert.equal(boucles(g, N, (v) => v !== 0).length, 4 - 1);
});
