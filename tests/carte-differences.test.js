// Tests de bout en bout : le faux rover (couloir de 12 m, fenêtre de carte glissante, carte « par différences »)
// parle à un récepteur qui fait ce que fait l'application (repère + carte globale). Ces tests auraient attrapé
// une carte qui ne suit pas : obstacle qui apparaît ou disparaît, carte raz, reconnexion, glissement de la fenêtre.

import test from 'node:test';
import assert from 'node:assert/strict';
import { FauxRover } from '../js/faux-rover.js';
import { Repere } from '../js/repere.js';
import { CarteGlobale } from '../js/carte-globale.js';
import { decoder, encoderTexte, encoderManette } from '../js/protocole.js';

/** Ce que fait l'application d'un flux de trames. */
function recepteur() {
  const repere = new Repere();
  const globale = new CarteGlobale();
  const etat = { trames: { etat: 0, carte: 0, origine: 0, ignorees: 0 }, position: null, lignes: [] };
  const appliquer = (octets) => {
    const m = decoder(octets);
    if (!m) return;
    if (m.type === 'origine') { repere.appliquer(m); etat.trames.origine++; }
    else if (m.type === 'carte') { globale.ranger(m, repere); etat.trames.carte++; etat.lignes.push([m.ligne, m.lignes.length]); }
    else if (m.type === 'etat') {
      const p = repere.absolu(m.x, m.y, m.versionOrigine);
      if (p) etat.position = p; else etat.trames.ignorees++;
      etat.trames.etat++;
    }
  };
  return { repere, globale, etat, appliquer };
}

function rover(options = {}) {
  const rec = recepteur();
  const trames = [];
  const r = new FauxRover({ sortie: (t) => { trames.push(t); rec.appliquer(t); }, ...options });
  return { r, rec, trames };
}
const faire = (r, s, manette) => { for (let i = 0; i < s * 20; i++) { if (manette && i % 2 === 0) r.recevoir(encoderManette(...manette)); r.pas(0.05); } };

/** La fenêtre du rover, comparée case par case à ce que l'application affiche. Renvoie le nombre de cases différentes. */
function ecarts(r, globale) {
  let n = 0;
  for (let l = 0; l < 64; l++) for (let c = 0; c < 64; c++) if (r.carte[l * 64 + c] !== globale.valeur(r.ox + c, r.oy + l)) n++;
  return n;
}

test('couloir de 12 m : la fenêtre glisse, la carte globale s\'agrandit et le rover reste à sa place', () => {
  const { r, rec } = rover({ fenetre: true, monde: 'couloir' });
  r.accueillir();
  r.recevoir(encoderTexte('radar balayage'));
  faire(r, 30, [0, 100, 0, 0]);
  assert.ok(r.y > 8, `le rover a avancé de ${r.y.toFixed(1)} m`);
  assert.ok(rec.etat.trames.origine >= 4, `${rec.etat.trames.origine} trames ORIGINE`);
  assert.ok(r.oy > -32, 'la fenêtre a glissé vers l\'avant');
  // la position lue par l'application est la vraie, malgré les glissements (à 2 mm près : trame en millimètres)
  assert.ok(Math.abs(rec.etat.position.y - r.y) < 0.2 && Math.abs(rec.etat.position.x - r.x) < 0.01, `lue ${rec.etat.position.y} pour ${r.y}`);
  assert.equal(rec.etat.trames.ignorees, 0, 'aucune trame ÉTAT perdue');
  // la carte globale couvre toute la longueur parcourue, avec les deux murs du couloir
  const e = rec.globale.etendue;
  assert.ok((e.maxCy - e.minCy) * 0.06 > 7, `étendue ${((e.maxCy - e.minCy) * 0.06).toFixed(1)} m`);
  // chaque tranche d'un mètre du couloir parcouru a ses deux murs (cases occupées près de x = ±0,7 m)
  let murs = 0; let tranches = 0;
  const occupeeDans = (x0, x1, y0, y1) => {
    for (let cy = Math.floor(y0 / 0.06); cy <= Math.floor(y1 / 0.06); cy++) for (let cx = Math.floor(x0 / 0.06); cx <= Math.floor(x1 / 0.06); cx++) if (rec.globale.valeur(cx, cy) === 2) return true;
    return false;
  };
  for (let y = 1; y < 7; y += 1) {
    tranches++;
    if (occupeeDans(-0.85, -0.55, y, y + 1) && occupeeDans(0.55, 0.85, y, y + 1)) murs++;
  }
  assert.ok(murs >= tranches - 1, `deux murs dans ${murs} tranches sur ${tranches}`);
  // les cases du couloir (libres) sont rangées entre les deux murs
  assert.equal(rec.globale.valeur(0, Math.floor(1 / 0.06)), 1);
});

test('couloir : le point touché très loin est joignable (relatif au centre de la fenêtre) et le rover y va', () => {
  const { r, rec } = rover({ fenetre: true, monde: 'couloir' });
  r.accueillir();
  faire(r, 30, [0, 100, 0, 0]);
  r.recevoir(encoderManette(0, 0, 0));
  faire(r, 2);
  const cible = { x: 0, y: r.y - 6 }; // 6 m en arrière, hors de la fenêtre courante
  const rel = rec.repere.relatif(cible.x, cible.y);
  assert.ok(rel, 'accepté (moins de 30 m)');
  assert.ok(Math.abs(rel.yMm) < 32767);
  assert.equal(rec.repere.relatif(0, r.y + 40), null, 'au-delà de 30 m : refusé');
  const trame = Uint8Array.of(0x05, rel.xMm & 0xff, (rel.xMm >> 8) & 0xff, rel.yMm & 0xff, (rel.yMm >> 8) & 0xff);
  r.recevoir(trame);
  assert.ok(r.but && Math.abs(r.but.y - cible.y) < 0.01, `le rover vise y = ${r.but?.y} pour ${cible.y}`);
});

test('ÉTAT lue avec la mauvaise origine (la trame ORIGINE n\'est pas encore arrivée) : ignorée, jamais mal placée', () => {
  const { r, trames } = rover({ fenetre: true, monde: 'couloir' });
  r.accueillir();
  faire(r, 12, [0, 100, 0, 0]);
  // on rejoue les trames en retardant chaque ORIGINE derrière l'ÉTAT qui la suit
  const rec = recepteur();
  const mauvaises = [];
  let enAttente = null;
  for (const t of trames) {
    const m = decoder(t);
    if (m?.type === 'origine' && rec.repere.recu && m.version !== rec.repere.version) { enAttente = t; continue; }
    if (enAttente && m?.type === 'etat') {
      const p = rec.repere.absolu(m.x, m.y, m.versionOrigine);
      if (m.versionOrigine !== rec.repere.version) mauvaises.push(p);
      rec.appliquer(enAttente); enAttente = null;
    }
    rec.appliquer(t);
  }
  assert.ok(mauvaises.length > 0, 'le scénario a bien produit des ÉTAT en avance sur leur ORIGINE');
  assert.ok(mauvaises.every((p) => p === null), 'une ÉTAT d\'une version inconnue n\'est pas posée à un mauvais endroit');
});

test('carte par différences : à la connexion toute la carte est envoyée, ensuite seulement ce qui change', () => {
  const { r, rec } = rover({ fenetre: true });
  r.recevoir(encoderTexte('radar arret'));
  r.accueillir();
  faire(r, 1.5);
  const premiers = rec.etat.lignes.length;
  assert.ok(rec.etat.lignes.reduce((n, [, k]) => n + k, 0) >= 64, 'les 64 lignes sont arrivées');
  assert.equal(ecarts(r, rec.globale), 0);
  // un rover immobile : une ligne par seconde seulement
  faire(r, 5);
  const fond = rec.etat.lignes.slice(premiers).reduce((n, [, k]) => n + k, 0);
  assert.ok(fond >= 4 && fond <= 7, `${fond} lignes de fond en 5 s`);
});

test('carte par différences : un obstacle qui apparaît puis disparaît se voit sur l\'écran, dans les deux cas', () => {
  const { r, rec } = rover({ fenetre: true });
  r.recevoir(encoderTexte('radar arret'));
  r.accueillir();
  faire(r, 2);
  assert.equal(ecarts(r, rec.globale), 0);
  const idx = 40 * 64 + 20; // un obstacle devant le rover
  r.carte[idx] = 2;
  faire(r, 0.4);
  assert.equal(rec.globale.valeur(r.ox + 20, r.oy + 40), 2, 'l\'obstacle apparaît en moins de 0,4 s');
  r.carte[idx] = 1; // il disparaît (la case redevient libre)
  faire(r, 0.4);
  assert.equal(rec.globale.valeur(r.ox + 20, r.oy + 40), 1, 'et disparaît de l\'écran');
  r.carte[idx] = 0;
  faire(r, 0.4);
  assert.equal(rec.globale.valeur(r.ox + 20, r.oy + 40), 0);
  assert.equal(ecarts(r, rec.globale), 0);
});

test('carte par différences : carte raz vide l\'écran, même avec des lignes déjà en route', () => {
  const { r, rec } = rover({ fenetre: true });
  r.accueillir();
  faire(r, 60);
  assert.ok(rec.globale.compter() > 500, 'la carte s\'est remplie');
  r.recevoir(encoderTexte('radar arret'));
  r.recevoir(encoderTexte('carte raz'));
  faire(r, 8);
  assert.equal(ecarts(r, rec.globale), 0, 'l\'écran suit la carte du rover après la raz');
  assert.equal(rec.globale.compter(), 0);
});

test('carte par différences : reconnexion en cours de route — l\'application neuve reçoit tout', () => {
  const { r, rec } = rover({ fenetre: true });
  r.recevoir(encoderTexte('radar arret'));
  r.accueillir();
  faire(r, 30);
  r.carte[30 * 64 + 30] = 2; r.carte[31 * 64 + 30] = 2;
  faire(r, 1);
  // l'application se reconnecte : elle repart d'une carte vide, le rover renvoie tout
  const neuve = recepteur();
  const sortie = r.sortie;
  r.sortie = (t) => { sortie(t); neuve.appliquer(t); };
  r.accueillir();
  faire(r, 2);
  assert.equal(ecarts(r, neuve.globale), 0, 'la carte revue après reconnexion est celle du rover');
  assert.equal(neuve.globale.valeur(r.ox + 30, r.oy + 30), 2);
});

test('rover non mis à jour (sans fenêtre) : ni ORIGINE ni vingtième octet, tout se lit comme avant', () => {
  const { r, rec, trames } = rover();
  r.accueillir();
  faire(r, 6, [0, 60, 0, 0]);
  assert.equal(rec.etat.trames.origine, 0);
  assert.ok(trames.filter((t) => t[0] === 0x81).every((t) => t.length === 19));
  assert.deepEqual(rec.repere.centre(), { x: 0, y: 0 });
  assert.ok(Math.abs(rec.etat.position.y - r.y) < 0.002);
});
