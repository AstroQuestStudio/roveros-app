// Tests du codage / décodage du protocole. Lancer :  node --test tests/
// Les trames « rover -> téléphone » sont construites OCTET PAR OCTET à la main, d'après PROTOCOLE.md,
// pour ne pas dépendre de nos propres encodeurs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decoder, decoderOrdre, encoderManette, encoderStop, encoderUrgence, encoderAller, encoderTexte, encoderPing,
  encoderEtat, encoderPoints, encoderCarte, encoderChemin, encoderTexteRover, assemblerDrapeaux,
  appliquerCarte, analyserLigne, TAILLE_CARTE, NOMS_DRAPEAUX, BLE,
} from '../js/protocole.js';

const octets = (...v) => Uint8Array.from(v);

// ---------- Téléphone -> rover ----------

test('MANETTE : octets signés en complément à deux, options bit 0 = repère du monde', () => {
  assert.deepEqual([...encoderManette(100, -100, 0, false)], [0x01, 100, 156, 0, 0]);
  assert.deepEqual([...encoderManette(-1, 50, -50, true)], [0x01, 255, 50, 206, 1]);
  assert.deepEqual([...encoderManette(0, 0, 0)], [0x01, 0, 0, 0, 0]);
  // valeurs hors plage : écrêtées à ±100 ; décimales arrondies
  assert.deepEqual([...encoderManette(250, -250, 33.6, false)], [0x01, 100, 156, 34, 0]);
});

test('STOP, URGENCE, PING', () => {
  assert.deepEqual([...encoderStop()], [0x02]);
  assert.deepEqual([...encoderUrgence(true)], [0x03, 1]);
  assert.deepEqual([...encoderUrgence(false)], [0x03, 0]);
  assert.deepEqual([...encoderPing(7)], [0x11, 7]);
  assert.deepEqual([...encoderPing(257)], [0x11, 1]);
});

test('ALLER : x et y en mm, entiers 16 bits signés petit-boutistes', () => {
  assert.deepEqual([...encoderAller(1000, -500)], [0x05, 0xe8, 0x03, 0x0c, 0xfe]);
  assert.deepEqual([...encoderAller(0, 0)], [0x05, 0, 0, 0, 0]);
  assert.deepEqual([...encoderAller(40000, -40000)], [0x05, 0xff, 0x7f, 0x00, 0x80]); // écrêtage
});

test('TEXTE : UTF-8', () => {
  assert.deepEqual([...encoderTexte('mode chien')], [0x10, ...Buffer.from('mode chien')]);
  assert.deepEqual([...encoderTexte('é')], [0x10, 0xc3, 0xa9]);
});

test("l'identifiant du service UART Nordic est bien celui du protocole", () => {
  assert.equal(BLE.service, '6e400001-b5a3-f393-e0a9-e50e24dcca9e');
  assert.equal(BLE.ecriture, '6e400002-b5a3-f393-e0a9-e50e24dcca9e');
  assert.equal(BLE.notification, '6e400003-b5a3-f393-e0a9-e50e24dcca9e');
});

test('decoderOrdre relit nos propres ordres (utilisé par le faux rover)', () => {
  assert.deepEqual(decoderOrdre(encoderManette(-20, 80, 5, true)), { type: 'manette', vx: -20, vy: 80, w: 5, monde: true });
  assert.deepEqual(decoderOrdre(encoderAller(-1234, 4321)), { type: 'aller', x: -1234, y: 4321 });
  assert.deepEqual(decoderOrdre(encoderTexte('infos')), { type: 'texte', texte: 'infos' });
  assert.deepEqual(decoderOrdre(encoderUrgence(true)), { type: 'urgence', actif: true });
});

// ---------- Rover -> téléphone ----------

test('ÉTAT : 19 octets construits à la main', () => {
  // drapeaux : obstacle (bit 2) + gyro_ok (bit 10) + mouvement (bit 14) + souleve (bit 16) = 0x014404
  const trame = octets(
    0x81,
    0xe8, 0x03, // x = 1000 mm
    0x0c, 0xfe, // y = -500 mm
    0x58, 0x1b, // cap = 7000 centièmes = 70,00°
    0x04, 0x44, 0x01, // drapeaux u24 = 0x014404
    3, // comportement
    81, // tension = 8,1 V
    0xe2, // tête = -30°
    120, // sonar = 120 cm
    0x0a, // cible_gis = +10°
    75, // cible_d = 75 cm
    255, // libre = non regardée
    42, // vitesse = 42 cm/s
    0xc4, // rssi = -60 dBm
  );
  assert.equal(trame.length, 19);
  const e = decoder(trame);
  assert.equal(e.type, 'etat');
  assert.equal(e.x, 1000); assert.equal(e.y, -500);
  assert.equal(e.cap, 70);
  assert.equal(e.drapeaux, 0x014404);
  assert.equal(e.flags.obstacle, true); assert.equal(e.flags.gyro_ok, true);
  assert.equal(e.flags.mouvement, true); assert.equal(e.flags.souleve, true);
  assert.equal(e.flags.urgence, false); assert.equal(e.flags.batterie, false);
  assert.equal(e.comportement, 3);
  assert.equal(e.tension, 8.1);
  assert.equal(e.tete, -30);
  assert.equal(e.sonar, 120);
  assert.equal(e.cibleGis, 10); assert.equal(e.cibleD, 75);
  assert.equal(e.libre, 255);
  assert.equal(e.vitesse, 42);
  assert.equal(e.rssi, -60);
});

test('ÉTAT : valeurs extrêmes et les 17 drapeaux levés', () => {
  // x = -32768, y = 32767, cap = -18000 (0xb9b0), drapeaux = 0x01ffff, tête = -128, cible_gis = -128
  const t = octets(0x81, 0x00, 0x80, 0xff, 0x7f, 0xb0, 0xb9, 0xff, 0xff, 0x01, 0, 0, 0x80, 0, 0x80, 0, 0, 0, 0x00);
  const e = decoder(t);
  assert.equal(e.x, -32768); assert.equal(e.y, 32767);
  assert.equal(e.cap, -180);
  assert.equal(e.drapeaux, 0x01ffff);
  assert.ok(NOMS_DRAPEAUX.every((n) => e.flags[n] === true), 'les 17 drapeaux sont levés');
  assert.equal(NOMS_DRAPEAUX.length, 17);
  assert.equal(e.tete, -128); assert.equal(e.cibleGis, -128); assert.equal(e.rssi, 0);
});

test('ÉTAT : un bit de drapeau isolé tombe sur le bon nom', () => {
  NOMS_DRAPEAUX.forEach((nom, bit) => {
    const d = 1 << bit;
    const t = octets(0x81, 0, 0, 0, 0, 0, 0, d & 0xff, (d >> 8) & 0xff, (d >> 16) & 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    const e = decoder(t);
    assert.deepEqual(NOMS_DRAPEAUX.filter((n) => e.flags[n]), [nom]);
  });
});

test('ÉTAT : aller-retour avec encoderEtat', () => {
  const flags = { urgence: true, obstacle: true, patine: true, aveugle: true };
  const t = encoderEtat({ x: -1234, y: 4321, cap: -45.5, drapeaux: assemblerDrapeaux(flags), comportement: 5, tension: 7.4, tete: 45, sonar: 99, cibleGis: -7, cibleD: 200, libre: 30, vitesse: 18, rssi: -72 });
  assert.equal(t.length, 19);
  const e = decoder(t);
  assert.equal(e.x, -1234); assert.equal(e.y, 4321); assert.equal(e.cap, -45.5);
  assert.deepEqual(NOMS_DRAPEAUX.filter((n) => e.flags[n]), ['urgence', 'obstacle', 'patine', 'aveugle']);
  assert.equal(e.tension, 7.4); assert.equal(e.rssi, -72); assert.equal(e.cibleGis, -7);
});

test('POINTS : échos de 10 octets (gisement×10, distance, x, y, t)', () => {
  const trame = octets(
    0x82,
    // écho 1 : gisement -450 (= -45,0°), distance 1500 mm, x = 1060, y = 1060, t = 1000 ms
    0x3e, 0xfe, 0xdc, 0x05, 0x24, 0x04, 0x24, 0x04, 0xe8, 0x03,
    // écho 2 : gisement 100 (= 10,0°), distance 0 (pas d'écho), x = 0, y = 2550, t = 1100 ms
    0x64, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf6, 0x09, 0x4c, 0x04,
  );
  const m = decoder(trame);
  assert.equal(m.type, 'points');
  assert.equal(m.points.length, 2);
  assert.deepEqual(m.points[0], { gisement: -45, distance: 1500, x: 1060, y: 1060, t: 1000 });
  assert.deepEqual(m.points[1], { gisement: 10, distance: 0, x: 0, y: 2550, t: 1100 });
});

test('POINTS : un morceau incomplet à la fin est ignoré', () => {
  const t = encoderPoints([{ gisement: 5, distance: 300, x: 1, y: 2, t: 3 }, { gisement: 6, distance: 400, x: 4, y: 5, t: 6 }]);
  assert.equal(decoder(t.subarray(0, 15)).points.length, 1);
  assert.equal(decoder(octets(0x82)).points.length, 0);
});

test("CARTE : 2 bits par case, case i dans les bits 2·(i mod 4) de l'octet i/4", () => {
  // ligne 5, 1 ligne : cases 0..3 = 1,2,0,1 -> octet 0 = 1 | 2<<2 | 0<<4 | 1<<6 = 0x49 ; case 63 = 2 -> octet 15 = 2<<6 = 0x80
  const donnees = new Array(16).fill(0);
  donnees[0] = 0x49; donnees[15] = 0x80;
  const m = decoder(octets(0x83, 5, 1, ...donnees));
  assert.equal(m.type, 'carte'); assert.equal(m.ligne, 5); assert.equal(m.nombre, 1);
  assert.deepEqual([...m.lignes[0].subarray(0, 5)], [1, 2, 0, 1, 0]);
  assert.equal(m.lignes[0][63], 2);
  assert.equal(m.lignes[0][62], 0);
  // application dans la grille 64×64 : ligne 5, colonne 1 = occupé
  const grille = new Uint8Array(TAILLE_CARTE * TAILLE_CARTE);
  assert.equal(appliquerCarte(grille, m), 4);
  assert.equal(grille[5 * 64 + 1], 2);
  assert.equal(grille[5 * 64 + 0], 1);
  assert.equal(grille[5 * 64 + 63], 2);
});

test('CARTE : plusieurs lignes, borne à la ligne 63, trame tronquée', () => {
  const lignes = [0, 1, 2].map((k) => Uint8Array.from({ length: 64 }, (_, i) => (i + k) % 3));
  const t = encoderCarte(10, lignes);
  const m = decoder(t);
  assert.equal(m.nombre, 3);
  assert.deepEqual([...m.lignes[2]], [...lignes[2]]);
  assert.equal(decoder(t.subarray(0, 3 + 16 * 2 + 5)).nombre, 2); // la 3e ligne est incomplète : ignorée
  assert.equal(decoder(octets(0x83, 70, 1, ...new Array(16).fill(0))), null); // ligne hors carte
  const bord = decoder(octets(0x83, 63, 4, ...new Array(64).fill(0)));
  assert.equal(bord.nombre, 1); // ne dépasse pas la ligne 63
});

test('CHEMIN : n points (x, y) en mm ; n = 0 = plus de chemin', () => {
  const m = decoder(octets(0x84, 2, 0xe8, 0x03, 0x0c, 0xfe, 0x00, 0x00, 0xd0, 0x07));
  assert.deepEqual(m.points, [{ x: 1000, y: -500 }, { x: 0, y: 2000 }]);
  assert.deepEqual(decoder(octets(0x84, 0)).points, []);
  // n annonce 3 points mais il n'y en a que 2 dans la trame : on n'invente rien
  assert.equal(decoder(octets(0x84, 3, 1, 0, 2, 0, 3, 0, 4, 0)).points.length, 2);
  assert.deepEqual(decoder(encoderChemin([{ x: -1, y: -2 }])).points, [{ x: -1, y: -2 }]);
});

test('TEXTE rover et PONG', () => {
  assert.deepEqual(decoder(octets(0x85, ...Buffer.from('evt arrivé\n'))), { type: 'texte', texte: 'evt arrivé' });
  assert.deepEqual(decoder(encoderTexteRover('modes manuel,chien')), { type: 'texte', texte: 'modes manuel,chien' });
  assert.deepEqual(decoder(octets(0x91, 42)), { type: 'pong', n: 42 });
  assert.equal(decoder(octets(0x91)), null);
});

test('lignes de texte : info, modes, p, evt, err, calib', () => {
  assert.deepEqual(analyserLigne('info version=1.2 nom=Rover-1A2B cellule=0.05 v_max=0.5 w_max=2.4').valeurs,
    { version: 1.2, nom: 'Rover-1A2B', cellule: 0.05, v_max: 0.5, w_max: 2.4 });
  assert.deepEqual(analyserLigne('modes manuel,chien,explorer,arret').modes, ['manuel', 'chien', 'explorer', 'arret']);
  assert.deepEqual(analyserLigne('p v_max 0.5 0.1 1'), { genre: 'param', nom: 'v_max', valeur: 0.5, min: 0.1, max: 1, texte: 'p v_max 0.5 0.1 1' });
  assert.equal(analyserLigne('p sans_valeur').genre, 'autre');
  assert.equal(analyserLigne('p x abc 1 2').genre, 'autre');
  assert.deepEqual({ ...analyserLigne('evt obstacle : je contourne') }, { genre: 'evt', message: 'obstacle : je contourne', texte: 'evt obstacle : je contourne' });
  assert.equal(analyserLigne('err roue bloquée').genre, 'err');
  assert.equal(analyserLigne('calib gyro=0.01').valeurs.gyro, 0.01);
  assert.equal(analyserLigne('').genre, 'autre');
  assert.equal(analyserLigne(undefined).genre, 'autre');
});

// ---------- Robustesse ----------

test("décodage défensif : rien ne lève d'exception", () => {
  assert.equal(decoder(new Uint8Array(0)), null);
  assert.equal(decoder(null), null);
  assert.equal(decoder(undefined), null);
  assert.equal(decoder(octets(0x81, 1, 2, 3)), null); // ÉTAT tronqué
  assert.deepEqual(decoder(octets(0xee, 1, 2)), { type: 'inconnu', code: 0xee, longueur: 3 });
  assert.equal(decoder(octets(0x83)), null);
  assert.equal(decoder(octets(0x84)), null);
  // octets au hasard : jamais d'exception
  let s = 1;
  for (let i = 0; i < 2000; i++) {
    const n = (s = (s * 1103515245 + 12345) & 0x7fffffff) % 40;
    const t = Uint8Array.from({ length: n }, () => (s = (s * 1103515245 + 12345) & 0x7fffffff) & 0xff);
    assert.doesNotThrow(() => decoder(t));
  }
  // un DataView ou un ArrayBuffer sont acceptés
  assert.equal(decoder(new DataView(encoderStop().buffer)).type, 'inconnu');
  assert.deepEqual(decoder(octets(0x91, 9).buffer), { type: 'pong', n: 9 });
});
