// Tests v9 : détection du firmware, diagnostic étendu et champs inconnus,
// réglages Rust (nom, sauvegarde, usine), qualité de liaison et faux rover double firmware.

import test from 'node:test';
import assert from 'node:assert/strict';
import { detecterFirmware, libelleFirmware, FAMILLES } from '../js/firmware.js';
import { analyserLigne, decoder, decoderOrdre, encoderEcho, encoderEchoRetour, encoderTexte, encoderManette } from '../js/protocole.js';
import { diagnosticMateriel, alerteMateriel, aDiagnosticEtendu } from '../js/materiel.js';
import { validerNomRover } from '../js/reglages.js';
import { calculerQualiteLiaison, EssaiQualiteLiaison } from '../js/latence.js';
import { FauxRover } from '../js/faux-rover.js';

// ---------- 1. Détection du firmware et capacités ----------

test('firmware : détection du firmware Rust et capacités attendues', () => {
  const info = analyserLigne('info version=rust100-0.1 nom=LODILABIDON cellule=0.05 v_max=0.45 w_max=2.5').valeurs;
  const modes = analyserLigne('modes manuel').modes;
  const p = detecterFirmware(info, modes);
  assert.equal(p.famille, FAMILLES.RUST);
  assert.equal(p.version, 'rust100-0.1');
  assert.equal(p.nom, 'LODILABIDON');
  assert.equal(p.capacites.manette, true);
  assert.equal(p.capacites.etat, true);
  assert.equal(p.capacites.carte, true);
  assert.equal(p.capacites.sauverParams, true);
  assert.equal(p.capacites.reglagesUsine, true);
  assert.equal(p.capacites.changementNom, true);
  assert.equal(p.capacites.diagnosticEtendu, true);
  assert.equal(p.capacites.bancEcho, true);
  assert.equal(p.capacites.majSansFil, false);
  assert.equal(p.capacites.calibrationAuto, false);
  assert.deepEqual(p.capacites.modes, ['manuel']);
  assert.match(libelleFirmware(p), /Rust.*rust100-0\.1/);
});

test('firmware : la liste des modes reçue fait foi (ex. Rust futur avec calibrer ou aller)', () => {
  const info = analyserLigne('info version=rust100-0.2 nom=LODILABIDON cellule=0.05').valeurs;
  const p = detecterFirmware(info, ['manuel', 'aller', 'course', 'calibrer']);
  assert.deepEqual(p.capacites.modes, ['manuel', 'aller', 'course', 'calibrer']);
  assert.equal(p.capacites.calibrationAuto, true);
});

test('firmware : détection du firmware MicroPython et capacités attendues', () => {
  const info = analyserLigne('info version=0.1.1 nom=Rover-4538 cellule=0.05 v_max=0.45 w_max=2.5').valeurs;
  const modes = analyserLigne('modes manuel,base,autotest,calibrer,chien,danse,explorer,glisse,aller,slalom,mur,carre,patrouille,course').modes;
  const p = detecterFirmware(info, modes);
  assert.equal(p.famille, FAMILLES.MICROPYTHON);
  assert.equal(p.version, '0.1.1');
  assert.equal(p.capacites.majSansFil, true);
  assert.equal(p.capacites.calibrationAuto, true);
  assert.equal(p.capacites.changementNom, true);
  assert.equal(p.capacites.sauverParams, false);
  assert.equal(p.capacites.reglagesUsine, false);
  assert.equal(p.capacites.diagnosticEtendu, false);
  assert.equal(p.capacites.bancEcho, false);
  assert.ok(p.capacites.modes.includes('patrouille'));
});

test('firmware : un firmware inconnu ne casse rien et offre les capacités minimales', () => {
  const vide = detecterFirmware({}, []);
  assert.equal(vide.famille, FAMILLES.INCONNU);
  assert.equal(vide.capacites.manette, true);
  assert.equal(vide.capacites.etat, true);
  assert.equal(vide.capacites.carte, true);
  assert.equal(vide.capacites.sauverParams, false);
  assert.equal(vide.capacites.bancEcho, false);
  assert.deepEqual(vide.capacites.modes, ['manuel']);

  const exotique = detecterFirmware({ version: 'custom-9' }, ['manuel', 'calibrer'], { bancEcho: true, diagnosticEtendu: true });
  assert.equal(exotique.famille, FAMILLES.INCONNU);
  assert.equal(exotique.capacites.calibrationAuto, true);
  assert.equal(exotique.capacites.bancEcho, true);
  assert.equal(exotique.capacites.diagnosticEtendu, true);
});

// ---------- 2. Protocole écho 0x12/0x92 et lignes étendues/inconnues ----------

test('protocole : trame d\'écho de banc 0x12 -> 0x92 renvoie la charge utile telle quelle', () => {
  const charge = Uint8Array.of(3, 42, 0xaa, 0x55);
  const req = encoderEcho(charge);
  assert.equal(req[0], 0x12);
  assert.deepEqual(decoderOrdre(req), { type: 'echo', donnees: charge });
  const rep = encoderEchoRetour(charge);
  assert.equal(rep[0], 0x92);
  assert.deepEqual(decoder(rep), { type: 'echo', donnees: charge });
});

test('protocole : acquisition, profil, nav et champs inconnus sont décodés et conservés', () => {
  const acq = analyserLigne('acquisition bus=0 bus_max=0 age=3972 extra=12');
  assert.equal(acq.genre, 'acquisition');
  assert.deepEqual(acq.valeurs, { bus: 0, bus_max: 0, age: 3972, extra: 12 });

  const p1 = analyserLigne('profil boucle max=540 moy=210 n=1200');
  assert.equal(p1.genre, 'profil');
  assert.equal(p1.section, 'boucle');
  assert.deepEqual(p1.valeurs, { max: 540, moy: 210, n: 1200 });

  const p2 = analyserLigne('profil depassements gt2ms=1 gt5ms=0');
  assert.equal(p2.genre, 'profil');
  assert.equal(p2.section, 'depassements');
  assert.deepEqual(p2.valeurs, { gt2ms: 1, gt5ms: 0 });

  const nav = analyserLigne('nav cible_x=1.20 cible_y=-0.50 etat=approche');
  assert.equal(nav.genre, 'autre');
  assert.equal(nav.mot, 'nav');
  assert.deepEqual(nav.valeurs, { cible_x: 1.2, cible_y: -0.5, etat: 'approche' });
});

// ---------- 3. Diagnostic étendu (Rust) et seuils d'alerte ----------

test('diagnostic étendu : lecture des lignes Rust (piles, code_ram, acquisition) et champs inconnus', () => {
  const mat = analyserLigne('materiel cycles=73120 calcul=240 calcul_max=328 duree_max=340 retards=0 err_driver=0 err_centrale=0 mem=148400 pile0=6388 pile1=1756 code_ram=55252 bus_max=0 capteur_x=7').valeurs;
  const acq = analyserLigne('acquisition bus=0 bus_max=0 age=3972').valeurs;
  assert.equal(aDiagnosticEtendu(mat, acq), true);
  assert.equal(alerteMateriel(mat), false);

  const d = diagnosticMateriel(mat, acq);
  assert.equal(d.alerte, false);
  assert.equal(d.niveau, 'ok');
  assert.deepEqual(d.inconnus, { capteur_x: 7 });
  const libelles = d.details.map((x) => `${x.libelle}: ${x.valeur}`).join(' | ');
  assert.match(libelles, /240 µs/);
  assert.match(libelles, /340 µs/);
  assert.match(libelles, /6 Ko \/ 2 Ko/);
  assert.match(libelles, /54 Ko/);
  assert.match(libelles, /3.*972 µs/);
  assert.match(libelles, /capteur_x: 7/);
});

test('diagnostic étendu : alerte si cycle > 2 ms ou retards > 0', () => {
  const cycleLong = analyserLigne('materiel calcul=500 calcul_max=900 duree_max=2150 retards=0 err_driver=0 err_centrale=0 mem=148400').valeurs;
  assert.equal(alerteMateriel(cycleLong), true);
  assert.equal(diagnosticMateriel(cycleLong).alerte, true);

  const avecRetard = analyserLigne('materiel calcul=240 calcul_max=300 duree_max=340 retards=2 err_driver=0 err_centrale=0 mem=148400').valeurs;
  assert.equal(alerteMateriel(avecRetard), true);
  assert.equal(diagnosticMateriel(avecRetard).niveau, 'alerte');
});

// ---------- 4. Validation des réglages (nom du rover) ----------

test('réglages : contrôle de saisie du nom du rover (20 ASCII sans espace ou « - »)', () => {
  assert.deepEqual(validerNomRover('LODILABIDON'), { valide: true, nom: 'LODILABIDON', commande: 'nom LODILABIDON' });
  assert.deepEqual(validerNomRover('-'), { valide: true, nom: '-', commande: 'nom -' });
  assert.equal(validerNomRover('A'.repeat(20)).valide, true);
  assert.equal(validerNomRover('').valide, false);
  assert.equal(validerNomRover('A'.repeat(21)).valide, false);
  assert.equal(validerNomRover('Rover 1').valide, false);
  assert.equal(validerNomRover('Élodie').valide, false);
});

// ---------- 5. Qualité de la liaison ----------

test('qualité liaison : calcul médiane et pertes, et essai complet écho / PING', async () => {
  const q1 = calculerQualiteLiaison([10, 30, 20, 40, 25], 5);
  assert.equal(q1.medianeMs, 25);
  assert.equal(q1.pertes, 0);
  assert.equal(q1.tauxPertesPct, 0);

  const q2 = calculerQualiteLiaison([12, 16, 20, 24], 50);
  assert.equal(q2.medianeMs, 18);
  assert.equal(q2.pertes, 46);
  assert.equal(q2.tauxPertesPct, 92);

  assert.equal(calculerQualiteLiaison([], 50).medianeMs, null);

  let t = 1000;
  let essai;
  const finiEcho = await new Promise((resolve) => {
    essai = new EssaiQualiteLiaison({
      envoyer: (trame) => {
        if (trame[2] === 1) return; // simule 1 perte sur la 2e trame
        t += 15;
        queueMicrotask(() => essai.surEcho(trame.slice(1)));
      },
      maintenant: () => t,
      surFin: resolve,
    });
    essai.demarrer({ mode: 'echo', total: 3, intervalleMs: 10, delaiFinMs: 30 });
  });
  assert.equal(finiEcho.mode, 'echo');
  assert.equal(finiEcho.envoyees, 3);
  assert.equal(finiEcho.recues, 2);
  assert.equal(finiEcho.pertes, 1);

  const finiPing = await new Promise((resolve) => {
    let p;
    p = new EssaiQualiteLiaison({
      envoyer: (trame) => {
        t += 10;
        queueMicrotask(() => p.surPong(trame[1]));
      },
      maintenant: () => t,
      surFin: resolve,
    });
    p.demarrer({ mode: 'ping', total: 4, intervalleMs: 5, delaiFinMs: 30 });
  });
  assert.equal(finiPing.mode, 'ping');
  assert.equal(finiPing.recues, 4);
  assert.equal(finiPing.pertes, 0);
});

// ---------- 6. Faux rover double firmware ----------

function creerFauxRover(firmware) {
  const textes = [];
  const bruts = [];
  const rover = new FauxRover({
    firmware,
    sortie: (trame) => {
      const m = decoder(trame);
      bruts.push(m);
      if (m?.type === 'texte') textes.push(m.texte);
    },
  });
  return { rover, textes, bruts };
}

test('faux rover : joue le firmware Rust (info, modes, materiel+acquisition, sauver/usine, nom, écho 0x12)', () => {
  const { rover, textes, bruts } = creerFauxRover('rust');
  rover.accueillir();

  const ligneInfo = textes.find((t) => t.startsWith('info '));
  const ligneModes = textes.find((t) => t.startsWith('modes '));
  assert.match(ligneInfo, /version=rust100-0\.1/);
  assert.match(ligneInfo, /nom=LODILABIDON/);
  assert.equal(ligneModes, 'modes manuel');

  rover.recevoir(encoderTexte('materiel'));
  assert.ok(textes.some((t) => t.startsWith('materiel ') && t.includes('pile0=6388') && t.includes('code_ram=55252')));
  assert.ok(textes.some((t) => t === 'acquisition bus=0 bus_max=0 age=3972'));

  // params sauver (inchangés -> modifiés -> en mouvement)
  rover.recevoir(encoderTexte('params sauver'));
  assert.ok(textes.includes('evt paramètres inchangés'));
  rover.recevoir(encoderTexte('param v_max 0.6'));
  rover.recevoir(encoderTexte('params sauver'));
  assert.ok(textes.includes('evt paramètres enregistrés'));

  // en mouvement : refusé
  rover.recevoir(encoderManette(0, 100, 0));
  rover.pas(0.1);
  rover.recevoir(encoderTexte('params sauver'));
  assert.ok(textes.includes('err params : rover en mouvement'));

  // usine
  rover.recevoir(encoderTexte('params usine'));
  assert.ok(textes.includes("evt paramètres d'usine restaurés"));
  assert.equal(rover.params.v_max.v, 0.5);

  // nom + maj indisponible + echo 0x12 -> 0x92
  rover.recevoir(encoderTexte('nom MONROVER'));
  assert.ok(textes.includes('evt nom enregistré : MONROVER (au prochain démarrage)'));
  rover.recevoir(encoderTexte('nom -'));
  assert.ok(textes.includes('evt nom enregistré : LODILABIDON (au prochain démarrage)'));
  rover.recevoir(encoderTexte('maj'));
  assert.ok(textes.includes('err mise à jour sans fil : indisponible'));

  rover.recevoir(encoderEcho(Uint8Array.of(9, 77)));
  assert.ok(bruts.some((m) => m?.type === 'echo' && m.donnees[0] === 9 && m.donnees[1] === 77));
});

test('faux rover : joue le firmware MicroPython (info, modes, materiel, nom, profil)', () => {
  const { rover, textes, bruts } = creerFauxRover('micropython');
  rover.accueillir();

  const ligneInfo = textes.find((t) => t.startsWith('info '));
  const ligneModes = textes.find((t) => t.startsWith('modes '));
  assert.match(ligneInfo, /version=0\.1\.1/);
  assert.match(ligneInfo, /nom=Rover-4538/);
  assert.equal(ligneModes, 'modes manuel,base,autotest,calibrer,chien,danse,explorer,glisse,aller,slalom,mur,carre,patrouille,course');

  rover.recevoir(encoderTexte('materiel'));
  const mat = textes.find((t) => t.startsWith('materiel '));
  assert.ok(mat && mat.includes('mem=71728') && !mat.includes('pile0'));

  rover.recevoir(encoderTexte('nom Rover-9999'));
  assert.ok(textes.includes('evt nom enregistré : Rover-9999 (au prochain démarrage)'));

  rover.recevoir(encoderTexte('profil'));
  assert.ok(textes.some((t) => t.startsWith('profil boucle')));

  // MicroPython ne répond pas à l'écho 0x12
  const avant = bruts.length;
  rover.recevoir(encoderEcho(Uint8Array.of(1, 2)));
  assert.equal(bruts.slice(avant).some((m) => m?.type === 'echo'), false);
});
