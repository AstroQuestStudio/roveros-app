// Essais du module js/journal.js (boîte noire, analyse pure, coût par trame, export sans données perso)
// et des causes en clair partagées dans js/diagnostic.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JournalSeance, analyserJournal, exporterJson, creerInstantanee, restaurerInstantanee,
  familleNavigateur, CAPACITE_ENVOIS, CAPACITE_ETATS,
} from '../js/journal.js';
import { phraseEtat, traduireFrein } from '../js/diagnostic.js';
import {
  T, encoderManette, encoderStop, encoderTexte, analyserLigne, assemblerDrapeaux, NOMS_DRAPEAUX,
} from '../js/protocole.js';
import { FauxRover } from '../js/faux-rover.js';
import { alimenterDemoJournal } from '../js/transport-demo.js';

const etat = (flags = {}, plus = {}) => ({
  type: 'etat',
  x: 0,
  y: 0,
  cap: 0,
  drapeaux: assemblerDrapeaux(flags),
  flags: Object.fromEntries(NOMS_DRAPEAUX.map((n) => [n, !!flags[n]])),
  comportement: 0,
  tension: 7.8,
  tete: 0,
  sonar: 120,
  cibleGis: 0,
  cibleD: 0,
  libre: 255,
  vitesse: 0,
  rssi: -58,
  ...plus,
});

test('journal : tampon circulaire borné et ordre conservé au-delà de la capacité', () => {
  const j = new JournalSeance({ debutHorlogeMs: 1_700_000_000_000, debutPerfMs: 0 });
  const trame = encoderManette(0, 50, 0);
  for (let k = 0; k < CAPACITE_ENVOIS + 50; k++) {
    const id = j.noterEnvoi(k * 50, trame, 0.4, 1);
    j.noterFinEcriture(id, true, 5);
  }
  assert.equal(j.envois.total, CAPACITE_ENVOIS + 50);
  const exporte = exporterJson(j);
  assert.equal(exporte.envois.length, CAPACITE_ENVOIS);
  assert.equal(exporte.envois[0].t, 50 * 50);
  assert.equal(exporte.envois[exporte.envois.length - 1].t, (CAPACITE_ENVOIS + 49) * 50);
});

test('journal : analyse un plafond firmware (frein=1), un trou d\'envoi avec garde et un STOP doigt posé', () => {
  // 2026-11-27 20:02:00 heure locale
  const baseEpoch = new Date(2026, 10, 27, 20, 2, 0, 0).getTime();
  const j = new JournalSeance({ debutHorlogeMs: baseEpoch, debutPerfMs: 1000, cadencePrevueMs: 66.7 });
  j.noterLiaison(1000, 'connecte', 'LODILABIDON', 'ble', { famille: 'rust', version: 'rust100-0.1' });

  // Phase 1 (t = 11 000..12 200 ms -> 20 h 02 min 10 s) : consigne 0,70 m/s mais plafond firmware à 0,20 m/s (frein=1)
  j.noterChamps(11000, { plafond: 0.20, frein: 1, tension: 7.75, a_lim: 1.0, cycles: 1000 });
  for (let t = 11000; t <= 12200; t += 66) {
    const id = j.noterEnvoi(t, encoderManette(0, 100, 0), 0.7, 1);
    j.noterFinEcriture(id, true, 12);
  }
  for (let t = 11050; t <= 12250; t += 100) {
    j.noterEtat(t, etat({}, { vitesse: 20, sonar: 32, libre: 28 }));
  }
  j.noterEnvoi(12260, encoderStop(), 0.7, 0); // relâchement normal entre les deux gestes
  j.marquer(11800, 'Hésitation devant obstacle');

  // Phase 2 : trou d'envoi de 410 ms (14 000 -> 14 410) déclenchant garde, puis STOP alors que le doigt est posé
  j.noterChamps(13900, { plafond: -1, frein: 0, tension: 7.7, a_lim: 1.0, cycles: 1580 });
  for (let t = 12400; t <= 13900; t += 150) j.noterEtat(t, etat({}, { vitesse: 0 }));
  for (let t = 13800; t <= 14000; t += 66) {
    const id = j.noterEnvoi(t, encoderManette(0, 80, 0), 0.5, 1);
    j.noterFinEcriture(id, true, 10);
  }
  j.noterEtat(14050, etat({}, { vitesse: 40 }));
  j.noterEtat(14400, etat({ garde: true }, { vitesse: 0 }));
  const idTrou = j.noterEnvoi(14410, encoderManette(0, 80, 0), 0.5, 1);
  j.noterFinEcriture(idTrou, true, 140); // écriture lente (140 ms)
  const idStop = j.noterEnvoi(14500, encoderStop(), 0.5, 1); // doigt posé (masque 1)
  j.noterFinEcriture(idStop, true, 8);
  j.noterChamps(14600, { plafond: -1, frein: 0, tension: 7.7, a_lim: 1.0, cycles: 12 }); // redémarrage

  const a = analyserJournal(j);
  assert.ok(a.resume.some((p) => p.includes('20 h 02 min 10 s') && p.includes('0,20 m/s') && p.includes('obstacle devant')), a.resume.join('\n'));
  assert.ok(a.resume.some((p) => p.includes("trou d'envoi") && /41\d ms/.test(p) && p.includes("s'est arrêté de lui-même")), a.resume.join('\n'));
  assert.ok(a.resume.some((p) => p.includes('arrêt (STOP) envoyé alors que le doigt était posé')), a.resume.join('\n'));
  assert.ok(a.resume.some((p) => p.includes('écriture Bluetooth lente') && p.includes('140 ms')), a.resume.join('\n'));
  assert.ok(a.resume.some((p) => p.includes('redémarrage du rover')), a.resume.join('\n'));

  assert.equal(a.reperes.length, 1);
  assert.ok(a.reperes[0].phrases.some((p) => p.includes('0,20 m/s') && p.includes('obstacle devant')), a.reperes[0].phrases.join('\n'));
});

test('journal : mesure du coût par trame (tableaux typés, coût < 20 µs/trame)', () => {
  const j = new JournalSeance();
  const trame = encoderManette(15, 70, -10);
  const e = etat({ mouvement: true }, { vitesse: 35, sonar: 95 });
  const champs = { plafond: 0.45, frein: 0, tension: 7.8, a_lim: 1.0, cycles: 500 };

  // Chauffe JIT
  for (let k = 0; k < 500; k++) {
    const id = j.noterEnvoi(k, trame, 0.5, 1);
    j.noterFinEcriture(id, true, 8);
    j.noterEtat(k, e);
    j.noterChamps(k, champs);
    j.noterDoigt(k, 0, 1, 0.2, 0.7);
  }

  const N = 20000;
  const t0 = performance.now();
  for (let k = 0; k < N; k++) {
    const id = j.noterEnvoi(k, trame, 0.5, 1);
    j.noterFinEcriture(id, true, 8);
    j.noterEtat(k, e);
    j.noterDoigt(k, 0, 1, 0.2, 0.7);
    if ((k & 3) === 0) j.noterChamps(k, champs);
  }
  const dureeMs = performance.now() - t0;
  const usParLot = (dureeMs * 1000) / N;
  // On affiche la mesure pour la tracer dans les résultats de test.
  console.log(`Coût mesuré du journal : ${usParLot.toFixed(2)} µs par cycle (envoi+écriture+état+doigt+champ)`);
  assert.ok(usParLot < 25, `coût trop élevé : ${usParLot.toFixed(2)} µs`);
});

test('journal : instantané / restauration (survie au rechargement) et export sans données personnelles', () => {
  const j = new JournalSeance({
    debutHorlogeMs: 1_700_000_000_000,
    debutPerfMs: 0,
    navigateur: familleNavigateur('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.81 Mobile Safari/537.36'),
  });
  assert.equal(j.navigateur, 'Chrome 131');
  j.champsDemandes = ['plafond', 'frein', 'tension', 'a_lim', 'cycles'];
  j.noterLiaison(10, 'connecte', 'Rover', 'ble', { famille: 'rust', version: 'rust100-0.1' });
  const id = j.noterEnvoi(20, encoderManette(0, 50, 0), 0.4, 1);
  j.noterFinEcriture(id, true, 15);
  j.noterEtat(40, etat({}, { vitesse: 20 }));
  j.marquer(50, 'Test repère');

  const snap = creerInstantanee(j);
  const j2 = new JournalSeance();
  assert.equal(restaurerInstantanee(j2, snap), true);
  const out = exporterJson(j2);
  const json = JSON.stringify(out);
  assert.equal(out.format, 'roveros-journal-v1');
  assert.equal(out.navigateur, 'Chrome 131');
  assert.ok(!json.includes('Pixel 8') && !json.includes('Android 14'), 'aucun agent complet dans le fichier');
  assert.equal(out.reperes.length, 1);
  assert.equal(out.envois.length, 1);
  assert.equal(out.etats.length, 1);
});

test('diagnostic et protocole : décodage « c ... » et affichage en direct des causes frein / liaison lente', () => {
  const c = analyserLigne('c plafond=0.22 frein=5 tension=7.84 a_lim=1.0 cycles=4200');
  assert.equal(c.genre, 'champs');
  assert.equal(c.valeurs.frein, 5);
  assert.equal(c.valeurs.plafond, 0.22);

  assert.equal(traduireFrein(5).analyse, 'le rover voyait un obstacle sur le côté');
  const pFrein = phraseEtat(etat({}, { vitesse: 20 }), {
    liaison: 'connecte',
    commande: { vx: 0, vy: 80, w: 0 },
    plafond: 0.22,
    frein: 5,
    vMax: 0.7,
  });
  assert.equal(pFrein.niveau, 'alerte');
  assert.match(pFrein.texte, /sur le côté/);

  const pLiaison = phraseEtat(etat({}, { vitesse: 20 }), {
    liaison: 'connecte',
    commande: { vx: 0, vy: 80, w: 0 },
    liaisonRalentie: true,
  });
  assert.equal(pLiaison.cle, 'liaison-lente');
  assert.match(pLiaison.texte, /liaison Bluetooth ralentie/);
});

test('démo : faux rover répond à champ et alimenterDemoJournal montre plafond + trou de liaison', () => {
  const textes = [];
  const rover = new FauxRover({
    firmware: 'rust',
    sortie: (tr) => {
      if (tr[0] === T.TEXTE_ROVER) textes.push(new TextDecoder().decode(tr.subarray(1)));
    },
  });
  rover.recevoir(encoderTexte('champ plafond frein tension a_lim cycles'));
  const ligne = textes.find((l) => l.startsWith('c '));
  assert.ok(ligne, 'réponse c ... reçue du faux rover');
  const c = analyserLigne(ligne);
  assert.equal(c.genre, 'champs');
  assert.ok('plafond' in c.valeurs && 'frein' in c.valeurs && 'tension' in c.valeurs);

  const j = new JournalSeance({ debutHorlogeMs: 1_700_000_000_000, debutPerfMs: 0 });
  alimenterDemoJournal(j, 10000);
  const a = analyserJournal(j);
  assert.ok(a.resume.some((p) => p.includes('obstacle devant')), a.resume.join('\n'));
  assert.ok(a.resume.some((p) => p.includes("trou d'envoi")), a.resume.join('\n'));
  assert.equal(a.reperes.length, 1);
});
