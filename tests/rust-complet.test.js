// Tests complets Rust : capacités lues (pas supposées), parité commande par commande,
// mise à jour sans fil v2 (+ v1, erreurs, retour arrière garde), diagnostic raz/bus/fragments,
// journal du rover et alignement d'horloge.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decoder, analyserLigne, analyserClesBruts, AssembleurFragments,
  encoderTexte, encoderAller, encoderManette, encoderStop, encoderUrgence,
  encoderPing, encoderEcho, encoderOrigine, encoderMajRetour,
} from '../js/protocole.js';
import { detecterFirmware, FAMILLES } from '../js/firmware.js';
import {
  ETATS_MAJ, ERREURS_IMAGE, fabriquerPaquetMajV2, lireEnteteMaj,
  verifierCompatibilitePaquet, tailleBlocPourMtu, PilotageMaj, verifierApresRedemarrage,
} from '../js/maj.js';
import { traduireRaz, traduireBus, diagnosticMateriel } from '../js/materiel.js';
import { JournalSeance, exporterJson } from '../js/journal.js';
import { FauxRover } from '../js/faux-rover.js';
import { TransportDemo } from '../js/transport-demo.js';

function creerRoverRust(opts = {}) {
  const textes = [];
  const etats = [];
  const majReponses = [];
  const rover = new FauxRover({
    firmware: 'rust',
    ...opts,
    sortie: (trame) => {
      const m = decoder(trame);
      if (!m) return;
      if (m.type === 'texte') textes.push(m.texte);
      else if (m.type === 'etat') etats.push(m);
      else if (m.type === 'maj') majReponses.push(m);
    },
  });
  rover.accueillir();
  return { rover, textes, etats, majReponses };
}

function avancer(rover, secondes, pas = 0.05) {
  const n = Math.ceil(secondes / pas);
  for (let i = 0; i < n; i++) rover.pas(pas);
}

// ---------- 1. Capacités lues, jamais supposées par famille ----------

test('capacités Rust lues depuis infos/modes/maj : ancien minimal vs récent complet', () => {
  const infoRust = analyserLigne('info version=rust100-0.1 nom=LODILABIDON cellule=0.05').valeurs;

  // Rust ancien : manette seule, maj refusée (rust100/src/systeme.rs:625-642)
  const ancien = detecterFirmware(infoRust, analyserLigne('modes manuel').modes, { majIndisponible: true });
  assert.equal(ancien.famille, FAMILLES.RUST);
  assert.equal(ancien.capacites.majSansFil, false);
  assert.equal(ancien.capacites.calibrationAuto, false);
  assert.equal(ancien.capacites.journalRover, false);

  // Rust récent : modes complets (rust100/src/systeme.rs:446) et réponse maj etat=0
  const recentModes = analyserLigne('modes manuel aller course explorer base patrouille chien calibrer autotest').modes;
  const recent = detecterFirmware(infoRust, recentModes, { majDisponible: true });
  assert.equal(recent.famille, FAMILLES.RUST);
  assert.deepEqual(recent.capacites.modes, ['manuel', 'aller', 'course', 'explorer', 'base', 'patrouille', 'chien', 'calibrer', 'autotest']);
  assert.equal(recent.capacites.majSansFil, true);
  assert.equal(recent.capacites.calibrationAuto, true);
  assert.equal(recent.capacites.journalRover, true);

  // Si le firmware annonce qu'il ne connaît pas « journal », la capacité retombe à false
  const sansJournal = detecterFirmware(infoRust, recentModes, { majDisponible: true, journalIndisponible: true });
  assert.equal(sansJournal.capacites.journalRover, false);
});

// ---------- 2. Parité complète commande par commande (citations firmware) ----------

test('parité Rust : 0x05 binaire refusé, mode aller x y fonctionne (rust100/src/systeme.rs:605-609,687-693)', () => {
  const { rover, textes } = creerRoverRust();
  // Trame 0x05 binaire -> err mode indisponible (rust100/src/systeme.rs:608)
  rover.recevoir(encoderAller(500, 0));
  assert.ok(textes.includes('err mode indisponible'));

  // Texte mode aller <x> <y> (rust100/src/systeme.rs:687-693)
  rover.recevoir(encoderTexte('mode aller 0.8 0.2'));
  assert.ok(textes.some((t) => /^evt (en route|objectif|arrivé)/.test(t)));
  avancer(rover, 4);
  assert.ok(textes.includes('evt arrivé'));
});

test('parité Rust : course exige un argument (rust100/src/systeme.rs:687-697,749)', () => {
  const { rover, textes } = creerRoverRust();
  rover.recevoir(encoderTexte('mode course'));
  assert.ok(textes.includes('err mode indisponible'));
  rover.recevoir(encoderTexte('mode course 0.8'));
  assert.ok(textes.includes('evt course'));
  avancer(rover, 6);
  assert.ok(textes.includes('evt arrivé'));
});

test('parité Rust : explorer, base, patrouille (<= 5 m), chien, arret (rust100/src/systeme.rs:686,698-728)', () => {
  const { rover, textes } = creerRoverRust();

  rover.recevoir(encoderTexte('mode explorer 1'));
  avancer(rover, 6);
  assert.ok(textes.some((t) => /exploration|plus rien à découvrir/.test(t)));

  rover.recevoir(encoderTexte('mode aller 0.6 0.0'));
  avancer(rover, 3);
  rover.recevoir(encoderTexte('mode base'));
  avancer(rover, 4);
  assert.ok(textes.some((t) => /à la base|retour à la base/.test(t)));

  // Patrouille > 5 m refusée (rust100/src/systeme.rs:714)
  rover.recevoir(encoderTexte('mode patrouille 6 0 0 1'));
  assert.ok(textes.some((t) => t.startsWith('err patrouille :')));

  // Patrouille valide <= 5 m (navigateur/src/patrouille.rs:46)
  rover.recevoir(encoderTexte('mode patrouille 0.5 0 -0.5 0'));
  assert.ok(textes.includes('evt patrouille : 2 points, en boucle'));

  rover.recevoir(encoderTexte('mode chien'));
  assert.ok(textes.some((t) => /Mode chien|suivi/.test(t)));

  rover.recevoir(encoderTexte('mode arret'));
  assert.equal(rover.mode, 'manuel');
});

test('parité Rust : calibrer (étapes court/tpm/bras/lat/moteur/accel, calib sans k=v) et autotest (rust100/src/systeme.rs:729-748)', () => {
  const { rover, textes } = creerRoverRust();

  // Calibrer court (rust100/src/systeme.rs:731, navigateur/src/calibrer.rs:1147-1149)
  rover.recevoir(encoderTexte('mode calibrer court'));
  avancer(rover, 2.8);
  const calibSansKv = analyserLigne('calib pas de côté inversé : 10 / 20');
  assert.equal(calibSansKv.genre, 'calib');
  assert.equal(calibSansKv.reste, 'pas de côté inversé : 10 / 20');
  assert.ok(textes.some((t) => t.includes('calib enregistré flash')));
  assert.ok(textes.some((t) => t.includes('evt calibration finie')));

  // Étape inconnue (rust100/src/systeme.rs:739)
  rover.recevoir(encoderTexte('mode calibrer bidon'));
  assert.ok(textes.includes('err calibrer : étape inconnue'));

  // Autotest 0 et 1 (rust100/src/systeme.rs:743-747, navigateur/src/autotest.rs:101-105,245-365)
  rover.recevoir(encoderTexte('mode autotest'));
  avancer(rover, 1.5);
  assert.ok(textes.some((t) => /les roues ne bougent pas/.test(t)));
  assert.ok(textes.some((t) => /autotest : centrale : .* : OK/.test(t)));
  assert.ok(textes.includes('evt autotest : tout va bien'));

  rover.recevoir(encoderTexte('mode autotest 1'));
  avancer(rover, 2.2);
  assert.ok(textes.some((t) => /roue avant gauche : .* : OK/.test(t)));
});

test('parité Rust : zone, veille, radar, vitesse, champ, recaler, carte raz, redemarrer (rust100/src/systeme.rs:751-867)', () => {
  const { rover, textes } = creerRoverRust();

  rover.recevoir(encoderTexte('zone 1.2'));
  assert.ok(textes.includes("evt zone de 120 cm autour d'ici"));
  rover.recevoir(encoderTexte('zone 0'));
  assert.ok(textes.includes('evt zone supprimée'));

  rover.recevoir(encoderTexte('veille 60'));
  assert.ok(textes.includes('evt veille après 60 s sans ordre'));
  rover.recevoir(encoderTexte('veille 0'));
  assert.ok(textes.includes('evt veille désactivée'));

  rover.recevoir(encoderTexte('radar fixe 0 0 0'));
  rover.recevoir(encoderTexte('radar inconnu'));
  assert.ok(textes.includes('err radar : mode inconnu'));

  rover.recevoir(encoderTexte('vitesse 60'));
  assert.equal(rover.vitessePct, 60);

  rover.recevoir(encoderTexte('champ t tension frein'));
  const ligneChamp = textes.find((t) => t.startsWith('c t='));
  assert.ok(ligneChamp);
  const decChamp = analyserLigne(ligneChamp);
  assert.equal(decChamp.genre, 'champs');
  assert.equal(typeof decChamp.valeurs.t, 'number');

  rover.recevoir(encoderTexte('recaler'));
  assert.ok(textes.includes('evt position remise à zéro'));

  let aRedemarre = false;
  const r2 = new FauxRover({ firmware: 'rust', surRedemarrage: () => { aRedemarre = true; } });
  r2.recevoir(encoderTexte('redemarrer'));
  assert.equal(aRedemarre, true);

  // En mouvement, redemarrer est refusé (rust100/src/systeme.rs:862-863)
  rover.recevoir(encoderManette(0, 80, 0));
  rover.pas(0.05);
  rover.recevoir(encoderTexte('redemarrer'));
  assert.ok(textes.includes('err redemarrer : rover en mouvement'));

  // Ping / Pong et Urgence
  rover.recevoir(encoderPing(42));
  rover.recevoir(encoderUrgence(true));
  assert.equal(rover.urgence, true);
  rover.recevoir(encoderUrgence(false));
  rover.recevoir(encoderStop());
});

// ---------- 3. Mise à jour sans fil Rust (brut v2, reprise, erreurs, rollback) ----------

test('MAJ sans fil Rust : validation en-tête v2, compatibilité carte et taille bloc MTU (outils/maj_ble.py)', () => {
  // Vecteurs ARM Cortex-M0+ valides : SP en RAM (0x2004_0000), Reset en Flash Thumb (0x1000_8001 >= 0x1000_70c0)
  const image = new Uint8Array(4096);
  const dv = new DataView(image.buffer);
  dv.setUint32(0, 0x20040000, true);
  dv.setUint32(4, 0x10008001, true);
  for (let i = 8; i < image.length; i++) image[i] = (i * 13) & 0xff;

  const paquet = fabriquerPaquetMajV2(image, 'PicoW-R100-AB');
  const entete = lireEnteteMaj(paquet);
  assert.equal(entete.version, 2);
  assert.equal(entete.carte, 'PicoW-R100-AB');
  assert.equal(entete.tailleBrute, 4096);

  // Carte identique acceptée, carte différente refusée
  assert.equal(verifierCompatibilitePaquet(entete, { famille: 'rust', carteCible: 'PicoW-R100-AB' }).ok, true);
  assert.equal(verifierCompatibilitePaquet(entete, { famille: 'rust', carteCible: 'Autre-Carte' }).ok, false);
  // MicroPython refuse v2 et inversement
  assert.equal(verifierCompatibilitePaquet(entete, { famille: 'micropython' }).ok, false);
  assert.equal(tailleBlocPourMtu(185), 177);
  assert.equal(tailleBlocPourMtu(23), 15);
});

test('MAJ sans fil Rust : dialogue complet 0x20->0x23 sur FauxRover et TransportDemo avec redémarrage', async () => {
  const image = new Uint8Array(2048);
  const dv = new DataView(image.buffer);
  dv.setUint32(0, 0x20040000, true);
  dv.setUint32(4, 0x10008001, true);
  const paquet = fabriquerPaquetMajV2(image, 'PicoW-R100-AB');

  const demo = new TransportDemo({ firmware: 'rust' });
  const lignes = [];
  let pilotage;
  await new Promise((resolve) => {
    demo.addEventListener('etat', (ev) => { if (ev.detail.etat === 'connecte') resolve(); });
    demo.connecter();
  });
  pilotage = new PilotageMaj({ envoyer: (trame, opts) => demo.envoyer(trame, opts) });
  demo.addEventListener('trame', (ev) => {
    const m = decoder(ev.detail);
    if (m?.type === 'maj' && typeof m.etat === 'number') pilotage.surReponse(m);
    if (m?.type === 'texte') lignes.push(m.texte);
  });

  const progres = [];
  const entete = await pilotage.executer(paquet, {
    tailleBloc: 172,
    surProgres: (p) => progres.push(p.phase),
  });
  assert.ok(progres.includes('debut') && progres.includes('envoi') && progres.includes('verification') && progres.includes('installation'));

  // Redémarrage automatique après 0x23 puis vérification post-reconnexion
  await new Promise((r) => setTimeout(r, 850));
  demo.envoyer(encoderTexte('maj'));
  demo.envoyer(encoderTexte('materiel'));
  await new Promise((r) => setTimeout(r, 100));

  const ligneMaj = lignes.findLast((t) => t.startsWith('maj '));
  const ligneMat = lignes.findLast((t) => t.startsWith('materiel '));
  const decMaj = analyserLigne(ligneMaj);
  const decMat = analyserLigne(ligneMat);
  const verif = verifierApresRedemarrage({
    entete,
    majLigne: decMaj.valeurs,
    majBrut: decMaj.brut,
    materiel: decMat.valeurs,
    version: 'rust100-0.1',
  });
  assert.equal(verif.statut, 'ok');
  demo.deconnecter();
});

test('MAJ sans fil Rust : refus si rover en mouvement, CRC invalide, retour arrière garde (etat=3 / raz=garde)', async () => {
  const image = new Uint8Array(1024);
  new DataView(image.buffer).setUint32(0, 0x20040000, true);
  new DataView(image.buffer).setUint32(4, 0x10008001, true);
  const paquet = fabriquerPaquetMajV2(image, 'PicoW-R100-AB');
  const entete = lireEnteteMaj(paquet);

  // Refus propre si rover en mouvement
  const pMove = new PilotageMaj({ envoyer: () => true });
  await assert.rejects(
    pMove.executer(paquet, { enMouvement: () => true }),
    /Arrêtez complètement le rover/
  );

  // Décodage 0xA0 et erreur CRC
  const recuErr = decoder(encoderMajRetour(ETATS_MAJ.E_CRC, 0));
  assert.deepEqual(recuErr, { type: 'maj', etat: ETATS_MAJ.E_CRC, valeur: 0 });
  assert.equal(ERREURS_IMAGE[3].length > 0, true);

  // Rollback watchdog : etat=3 ou raz=garde (rust100/src/systeme.rs:844, redemarrage.rs)
  const majRollback = analyserLigne('maj etat=3 taille=1024 crc=00000000');
  const matRollback = analyserLigne('materiel cycles=100 calcul=50 calcul_max=80 duree_max=90 retards=0 err_driver=0 err_centrale=0 mem=150000 raz=garde');
  const verifRollback = verifierApresRedemarrage({
    entete,
    majLigne: majRollback.valeurs,
    majBrut: majRollback.brut,
    materiel: matRollback.valeurs,
    version: 'rust100-0.1',
  });
  assert.equal(verifRollback.statut, 'retour_arriere');
  assert.match(verifRollback.message, /Retour arrière automatique/);
});

// ---------- 4. Diagnostic raz=, bus I2C, fragments multi-paquets et journal de séance ----------

test('diagnostic Rust : traduction raz=, abrt/lig/rep/ech/actif, réassemblage BLE et rangement JournalSeance', () => {
  assert.match(traduireRaz('garde').libelle, /Chien de garde/);
  assert.equal(traduireRaz('garde').alerte, true);
  assert.match(traduireRaz('panique:c0:main.rs:42').libelle, /Panique.*0.*main\.rs.*42/);
  assert.match(traduireRaz('voulu', 120).libelle, /120 s/);
  assert.equal(traduireRaz('tension').alerte, false);

  // Réassemblage BLE fragments (rust100/src/systeme.rs:958,977,979)
  const asm = new AssembleurFragments();
  assert.equal(asm.pousser('acquisition bus=0 bus_max=10 '), 'acquisition bus=0 bus_max=10 ');
  const reassemble = asm.pousser('acquisition+ abrt0=1 lig0=10 rep0=5/3 ech0=2 actif0=1 abrt1=0 lig1=11 rep1=0/0 ech1=0 actif1=0');
  assert.ok(reassemble && reassemble.includes('bus_max=10') && reassemble.includes('abrt0=1') && reassemble.includes('lig0=10'));

  const mat = analyserLigne('materiel cycles=1200 calcul=180 calcul_max=300 duree_max=340 retards=0 err_driver=1 err_centrale=0 mem=148000 pile0=6400 pile1=1800 code_ram=54000 bus_max=10 marche_s=45 raz=garde');
  const acq = analyserLigne(reassemble);
  const liaison = analyserLigne('liaison m=12 s=1 u=0 a=0 t=6 p=20 e=0 maj=0 autre=0 pertes=0 rxerr=0 txpleins=1 file=0 ecart_ms=0 ordre_us=0 silence=0 conn=1 deconn=0 raison=00 int_us=15000 lat=0 sup_ms=2000 mtu=185 veille=0 pris=0 paramerr=0');

  // Bitwise I2C bus 0 : abrt0=1 = adresse non acquittée (carte moteurs muette), lig0='10' = horloge tenue (SCL basse)
  const bus0 = traduireBus(0, acq.valeurs, acq.brut);
  assert.equal(bus0.alerte, true);
  assert.match(bus0.texte, /carte moteurs muette \(adresse non acquittée\)/);
  assert.match(bus0.texte, /horloge tenue \(SCL basse\)/);
  assert.equal(bus0.reprises, 3);
  assert.equal(bus0.ech, 2);

  const diag = diagnosticMateriel(mat.valeurs, acq.valeurs, [], {
    acqBrut: acq.brut,
    liaison: liaison.valeurs,
  });
  assert.equal(diag.alerte, true);
  assert.ok(diag.details.some((d) => /redémarrage/i.test(d.libelle) && /Chien de garde/.test(d.valeur)));
  assert.ok(diag.details.some((d) => /Carte moteurs/.test(d.libelle) && /adresse non acquittée/.test(d.valeur)));

  // Rangement dans le journal de séance
  const j = new JournalSeance();
  j.noterDiagnostic(1000, diag);
  const exp = exporterJson(j);
  const evDiag = exp.evenements.filter((e) => e.genre === 'diagnostic');
  assert.equal(evDiag.length, 1);
  assert.equal(evDiag[0].alerte, true);
  assert.match(evDiag[0].resume, /redémarrage|calcul/i);
});

// ---------- 5. Journal du rover et alignement sur l'horloge ----------

test('journal du rover : décodage tolérant, stockage brut et alignement horloge via champ t', () => {
  const j = new JournalSeance({ debutPerfMs: 1000, debutHorlogeMs: 1_700_000_000_000 });
  const l1 = analyserLigne('j 12000 boot raz=tension');
  const l2 = analyserLigne('j 12540 mode nom=aller x=0.5 y=0.0');
  const fin = analyserLigne('j fin 2 0');

  assert.equal(l1.genre, 'journal_rover');
  assert.equal(l1.tempsMs, 12000);
  assert.equal(l1.nom, 'boot');
  assert.equal(fin.genre, 'journal_fin');
  assert.equal(fin.nombre, 2);
  assert.equal(fin.perdus, 0);

  // Alignement avant/après lecture de champ t : rover t=15000 ms quand performance.now() = 5000 ms => décalage = -10000 ms
  j.noterJournalRover(5100, l1.texte, l1, { lotId: 1 });
  j.noterJournalRover(5120, l2.texte, l2, { lotId: 1 });
  assert.equal(j.journalRover[0].aligne, false);

  j.alignerJournalRover(1, 5000 - 15000); // perfEstime(12000) = 12000 + (-10000) = 2000 ms -> +1000 ms depuis debutPerfMs(1000)
  assert.equal(j.journalRover[0].aligne, true);
  assert.equal(j.epochDe(j.journalRover[0].t), 1_700_000_001_000);
  assert.equal(j.epochDe(j.journalRover[1].t), 1_700_000_001_540);

  const exp = exporterJson(j);
  assert.equal(exp.journalRover.length, 2);
  assert.equal(exp.journalRover[0].ligne, 'j 12000 boot raz=tension');
  assert.equal(exp.journalRover[1].ligne, 'j 12540 mode nom=aller x=0.5 y=0.0');
});

// ---------- 6. Décodage 0x86 ORIGINE avec numéro de carte à l'octet 12 ----------

test('protocole : ORIGINE (0x86) 13 octets expose m.carte sans casser le format 12 octets', () => {
  const sansCarte = decoder(encoderOrigine({ ox: -32, oy: -32, version: 2, cellule: 50 }));
  assert.equal('carte' in sansCarte, false);
  const avecCarte = decoder(encoderOrigine({ ox: -32, oy: -32, version: 2, cellule: 50, carte: 7 }));
  assert.equal(avecCarte.carte, 7);
  assert.deepEqual(analyserClesBruts('abrt0=20 lig0=01 crc=0a0b0c0d'), {
    abrt0: '20', lig0: '01', crc: '0a0b0c0d',
  });
});
