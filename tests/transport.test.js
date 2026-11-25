// Tests de la file d'envoi (jamais plus de 25 trames par seconde), du faux rover et du QR code.
// Lancer :  node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { Transport, INTERVALLE_MIN_MS } from '../js/transport.js';
import { FauxRover, MODES } from '../js/faux-rover.js';
import { creerQr, qrVersTexte } from '../js/qr.js';
import {
  decoder, encoderManette, encoderTexte, encoderUrgence, encoderPing, appliquerCarte, TAILLE_CARTE, T,
} from '../js/protocole.js';

/** Un transport de test : il note l'heure de chaque écriture. */
class TransportTest extends Transport {
  constructor() { super('test'); this.ecritures = []; }
  async _ecrire(trame) { this.ecritures.push({ t: performance.now(), type: trame[0], trame }); }
}

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

test('file d\'envoi : jamais plus de 25 trames par seconde', async () => {
  const t = new TransportTest();
  t._changerEtat('connecte');
  for (let i = 0; i < 40; i++) t.envoyer(encoderTexte(`param a ${i}`)); // 40 trames d'un coup
  await attendre(1100);
  const e = t.ecritures;
  assert.ok(e.length >= 24 && e.length <= 27, `trames écrites en 1,1 s : ${e.length}`);
  // fenêtre glissante de 1 s : jamais plus de 25 écritures
  for (let i = 0; i + 25 < e.length; i++) assert.ok(e[i + 25].t - e[i].t >= 1000 - 15, 'plus de 25 trames dans 1 s');
  assert.ok(INTERVALLE_MIN_MS * 25 >= 1000);
});

test("file d'envoi : les MANETTE se remplacent, l'urgence passe devant", async () => {
  const t = new TransportTest();
  t._changerEtat('connecte');
  t.envoyer(encoderTexte('a'));
  t.envoyer(encoderTexte('b'));
  for (let i = 0; i < 10; i++) t.envoyer(encoderManette(i, 0, 0));
  t.envoyer(encoderUrgence(true));
  await attendre(400);
  const types = t.ecritures.map((x) => x.type);
  assert.equal(types.filter((x) => x === T.MANETTE).length, 1, 'une seule MANETTE (la plus récente)');
  assert.equal(t.ecritures.find((x) => x.type === T.MANETTE).trame[1], 9);
  assert.ok(types.indexOf(T.URGENCE) <= 1, "l'urgence part avant les textes en attente");
});

test("file d'envoi : rien n'est envoyé hors connexion", () => {
  const t = new TransportTest();
  assert.equal(t.envoyer(encoderManette(1, 1, 1)), false);
});

// ---------- Faux rover ----------

function nouveauRover() {
  const recu = { etat: 0, points: 0, carte: 0, chemin: 0, texte: [], pong: 0, derniereEtat: null };
  const grille = new Uint8Array(TAILLE_CARTE * TAILLE_CARTE);
  const rover = new FauxRover({
    sortie: (trame) => {
      const m = decoder(trame);
      assert.ok(m && m.type !== 'inconnu', 'le faux rover n\'émet que des trames valides');
      if (m.type === 'etat') { recu.etat++; recu.derniereEtat = m; }
      else if (m.type === 'points') recu.points++;
      else if (m.type === 'carte') { recu.carte++; appliquerCarte(grille, m); }
      else if (m.type === 'chemin') recu.chemin++;
      else if (m.type === 'texte') recu.texte.push(m.texte);
      else if (m.type === 'pong') recu.pong++;
    },
  });
  return { rover, recu, grille };
}
const faire = (rover, secondes) => { for (let i = 0; i < secondes * 20; i++) rover.pas(0.05); };

test('faux rover : cadences des trames et réponse au PING', () => {
  const { rover, recu } = nouveauRover();
  rover.accueillir();
  rover.recevoir(encoderPing(5));
  faire(rover, 10);
  assert.ok(recu.etat >= 95 && recu.etat <= 101, `ÉTAT ~10 Hz : ${recu.etat}`);
  assert.ok(recu.carte >= 38 && recu.carte <= 42, `CARTE 4 Hz : ${recu.carte}`);
  assert.equal(recu.pong, 1);
  assert.ok(recu.texte.some((l) => l.startsWith('modes ')));
  assert.ok(recu.texte.some((l) => l.startsWith('p v_max ')));
  assert.ok(recu.texte.some((l) => l.startsWith('info ')));
});

test('faux rover : la manette fait avancer, le chien de garde arrête après 0,4 s', () => {
  const { rover, recu } = nouveauRover();
  for (let i = 0; i < 10; i++) { rover.recevoir(encoderManette(0, 100, 0)); faire(rover, 0.1); }
  const y1 = rover.y;
  assert.ok(y1 > 0.15, `le rover avance : y = ${y1}`);
  faire(rover, 1.5); // plus aucune trame
  assert.ok(Math.hypot(rover.vxb, rover.vyb) < 0.01, 'le rover s\'est arrêté seul');
  assert.equal(recu.derniereEtat.flags.garde, true);
});

test('faux rover : urgence verrouillée = ordres refusés jusqu\'au déverrouillage', () => {
  const { rover, recu } = nouveauRover();
  rover.recevoir(encoderUrgence(true));
  rover.recevoir(encoderManette(0, 100, 0));
  faire(rover, 1);
  assert.equal(rover.y, 0);
  assert.ok(recu.texte.some((l) => l.startsWith('err ')), 'une erreur explique le refus');
  assert.equal(recu.derniereEtat.flags.urgence, true);
  rover.recevoir(encoderUrgence(false));
  rover.recevoir(encoderManette(0, 100, 0));
  faire(rover, 0.3);
  assert.ok(rover.y > 0);
});

test('faux rover : explorer remplit la carte puis annonce la fin', () => {
  const { rover, recu, grille } = nouveauRover();
  rover.recevoir(encoderTexte('mode explorer'));
  faire(rover, 150);
  const connues = grille.reduce((a, v) => a + (v ? 1 : 0), 0);
  assert.ok(connues > 1500, `cases connues : ${connues}`);
  assert.ok(grille.some((v) => v === 2), 'des obstacles ont été vus');
  assert.ok(recu.texte.includes('evt exploration terminée'), recu.texte.slice(-4).join(' | '));
});

test('faux rover : aller (toucher la carte) mène le rover au point demandé', () => {
  const { rover, recu } = nouveauRover();
  faire(rover, 25); // on laisse le sonar voir un peu
  rover.recevoir(encoderTexte('mode base'));
  faire(rover, 1);
  rover.recevoir(Uint8Array.of(0x05, 0xc8, 0x00, 0x2c, 0x01)); // x = 200 mm, y = 300 mm
  faire(rover, 20);
  assert.ok(Math.hypot(rover.x - 0.2, rover.y - 0.3) < 0.12, `position : ${rover.x}, ${rover.y}`);
  assert.ok(recu.texte.includes('evt arrivé'));
  assert.ok(recu.chemin >= 1, 'un CHEMIN a été publié');
});

test('faux rover : tous les modes se lancent et se terminent sans erreur', () => {
  const { rover, recu } = nouveauRover();
  faire(rover, 20);
  for (const m of MODES.filter((n) => n !== 'manuel')) {
    rover.recevoir(encoderTexte(`mode ${m}`));
    faire(rover, 60);
    assert.ok(Number.isFinite(rover.x) && Number.isFinite(rover.y) && Number.isFinite(rover.cap), `position finie après ${m}`);
  }
  assert.ok(!recu.texte.some((l) => l.startsWith('err mode inconnu')));
  // un mode inconnu et une commande inconnue donnent une erreur, sans planter
  rover.recevoir(encoderTexte('mode truc'));
  rover.recevoir(encoderTexte('zzz'));
  assert.ok(recu.texte.filter((l) => l.startsWith('err ')).length >= 2);
});

test('faux rover : param, recaler, trame inconnue', () => {
  const { rover, recu } = nouveauRover();
  rover.recevoir(encoderTexte('param v_max 0.8'));
  assert.equal(rover.params.v_max.v, 0.8);
  rover.recevoir(encoderTexte('param v_max 99')); // au-dessus du maximum : écrêté
  assert.equal(rover.params.v_max.v, 1.0);
  rover.recevoir(encoderTexte('param inconnu 1'));
  assert.ok(recu.texte.some((l) => l.startsWith('err paramètre inconnu')));
  rover.recevoir(Uint8Array.of(0x7f, 1, 2, 3)); // type inconnu : ignoré
  for (let i = 0; i < 10; i++) { rover.recevoir(encoderManette(0, 100, 0)); faire(rover, 0.1); }
  rover.recevoir(encoderTexte('recaler'));
  assert.equal(rover.x, 0); assert.equal(rover.y, 0); assert.equal(rover.cap, 0);
});

// ---------- QR code ----------

test('QR code : tailles de grille et motifs de repérage', () => {
  const qr = creerQr('https://exemple.org/roveros/', 'M');
  assert.equal(qr.taille, 17 + 4 * qr.version);
  assert.ok(qr.version >= 2 && qr.version <= 3);
  // les trois repères : coin 7×7 plein sur le bord
  for (const [x0, y0] of [[0, 0], [qr.taille - 7, 0], [0, qr.taille - 7]]) {
    for (let i = 0; i < 7; i++) {
      assert.ok(qr.module(x0 + i, y0) && qr.module(x0 + i, y0 + 6) && qr.module(x0, y0 + i) && qr.module(x0 + 6, y0 + i));
    }
    assert.ok(qr.module(x0 + 3, y0 + 3));
    assert.ok(!qr.module(x0 + 1, y0 + 1));
  }
  assert.equal(qrVersTexte(qr).split('\n').length, qr.taille);
  assert.throws(() => creerQr('x'.repeat(400)), /trop long/);
});
