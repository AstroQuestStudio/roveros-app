// app.js — le chef d'orchestre : il relie les transports, la carte, les manettes, les réglages
// et l'interface. Lisez-le de haut en bas : chaque section porte un titre.

import {
  decoder, analyserLigne, encoderTexte, encoderPing, encoderAller, encoderUrgence, encoderStop, NOMS_DRAPEAUX, DRAPEAUX_FR,
} from './protocole.js';
import { TransportBle, bluetoothDisponible } from './transport-ble.js';
import { TransportWs, normaliserUrlWs } from './transport-ws.js';
import { TransportDemo } from './transport-demo.js';
import { VueCarte } from './carte.js';
import { Manette, Clavier, Pilote } from './manettes.js';
import { Inclinaison } from './inclinaison.js';
import { Reglages } from './reglages.js';
import { TableauDeBord, niveauBatterie, barresSignal } from './bord.js';
import { creerQr, dessinerQr } from './qr.js';
import { icone, MODES_FR, libelleMode } from './icones.js';
import { poserTexte, poserDonnee } from './utile.js';

const $ = (sel, racine = document) => racine.querySelector(sel);
const $$ = (sel, racine = document) => [...racine.querySelectorAll(sel)];
const stocker = (cle, valeur) => { try { localStorage.setItem(`roveros.${cle}`, valeur); } catch { /* stockage indisponible */ } };
const lire = (cle) => { try { return localStorage.getItem(`roveros.${cle}`); } catch { return null; } };

// ============================================================================
// 1. État global de l'application
// ============================================================================

const S = {
  transport: null,
  modes: [], // noms des comportements, dans l'ordre des indices de la trame ÉTAT
  info: {},
  etat: null, // dernière trame ÉTAT décodée
  urgence: { actif: false, essais: 0 },
  ping: { n: 0, envoyes: new Map(), ms: null, dernierPong: 0 },
  journal: [],
  cote: 0.5,
  vue: 'pilotage',
  nonLus: 0,
};

// ============================================================================
// 2. Icônes (injectées dans les éléments portant data-icone)
// ============================================================================

function injecterIcones() {
  $$('[data-icone]').forEach((el) => {
    const taille = el.classList.contains('choix-ico') ? 24 : el.closest('.onglets') ? 22 : 18;
    el.innerHTML = icone(el.dataset.icone, taille);
  });
  const parId = { 'btn-journal': 'journal', 'btn-recentrer': 'recentrer', 'btn-zoom-plus': 'plus', 'btn-zoom-moins': 'moins', 'btn-dispo': 'dispo', 'cx-fermer': 'fermer', 'jr-fermer': 'fermer' };
  for (const [id, nom] of Object.entries(parId)) $(`#${id}`).insertAdjacentHTML('afterbegin', icone(nom, 22));
  $('#entete-batt-ico').innerHTML = icone('batterie', 18);
}
injecterIcones();

// ============================================================================
// 3. Notifications et journal
// ============================================================================

/**
 * Note un message dans le journal. genre : 'evt' (événement du rover), 'err' (erreur), 'app' (l'application).
 * Les événements et erreurs du rover s'affichent aussi en notification discrète.
 */
function noter(genre, texte, { toast = genre !== 'app' } = {}) {
  S.journal.push({ t: new Date(), genre, texte });
  if (S.journal.length > 300) S.journal.shift();
  if (toast) afficherToast(genre, texte);
  if (genre === 'err' || genre === 'evt') {
    if ($('#dlg-journal').open) rendreJournal();
    else { S.nonLus++; const p = $('#journal-pastille'); p.hidden = false; p.classList.toggle('erreur', genre === 'err' || p.classList.contains('erreur')); }
  }
}

function afficherToast(genre, texte) {
  const zone = $('#toasts');
  while (zone.childElementCount >= 3) zone.firstElementChild.remove();
  const el = document.createElement('div');
  el.className = `toast ${genre}`;
  el.innerHTML = `${icone(genre === 'err' ? 'alerte' : 'info', 18)}<span></span>`;
  $('span', el).textContent = texte;
  zone.append(el);
  const duree = genre === 'err' ? 6500 : 3800;
  setTimeout(() => { el.classList.add('sortie'); setTimeout(() => el.remove(), 350); }, duree);
}

function rendreJournal() {
  const liste = $('#journal-liste');
  liste.textContent = '';
  for (const e of [...S.journal].reverse()) {
    const li = document.createElement('li');
    li.className = e.genre;
    const h = document.createElement('span'); h.className = 'heure'; h.textContent = e.t.toLocaleTimeString('fr-FR');
    const t = document.createElement('span'); t.textContent = e.texte;
    li.append(h, t);
    liste.append(li);
  }
  $('#journal-vide').hidden = S.journal.length > 0;
}

$('#btn-journal').addEventListener('click', () => {
  S.nonLus = 0; $('#journal-pastille').hidden = true; $('#journal-pastille').classList.remove('erreur');
  rendreJournal(); ouvrirFeuille($('#dlg-journal'));
});
$('#jr-fermer').addEventListener('click', () => fermerFeuilles());
$('#jr-effacer').addEventListener('click', () => { S.journal.length = 0; rendreJournal(); });

// -- Fenêtres (feuilles) : non modales pour que l'arrêt d'urgence reste utilisable --
function ouvrirFeuille(d) {
  fermerFeuilles();
  d.show();
  $('#voile').hidden = false;
}
function fermerFeuilles() {
  $$('dialog[open]').forEach((d) => d.close());
  $('#voile').hidden = true;
}
$('#voile').addEventListener('click', fermerFeuilles);

// ============================================================================
// 4. Carte, tableau de bord, réglages
// ============================================================================

const carte = new VueCarte($('#carte'), { surToucher: allerAuPoint });
const bord = new TableauDeBord($('#vue-bord'));
const reglages = new Reglages({
  liste: $('#param-liste'), recherche: $('#param-recherche'), vide: $('#param-vide'),
  console: $('#console'), saisie: $('#console-texte'), envoyerTexte,
});

$('#btn-recentrer').addEventListener('click', () => carte.recentrer());
$('#btn-zoom-plus').addEventListener('click', () => carte.zoomer(1.4));
$('#btn-zoom-moins').addEventListener('click', () => carte.zoomer(1 / 1.4));
// En paysage, les manettes et réglages recouvrent le bas de la carte : on remonte le rover.
const paysage = window.matchMedia('(orientation: landscape)');
const regleDecalage = () => { carte.decalage = paysage.matches ? 0.16 : 0; };
regleDecalage(); paysage.addEventListener('change', regleDecalage);
carte.addEventListener('vue', (ev) => $('#btn-recentrer').classList.toggle('actif', ev.detail.suivre));

/** Toucher un point de la carte : marqueur + trame ALLER. */
function allerAuPoint(x, y) {
  if (S.urgence.actif) { afficherToast('err', "Arrêt d'urgence actif : déverrouillez-le pour bouger"); return; }
  if (!S.transport?.connecte) { afficherToast('err', 'Pas de liaison avec le rover'); return; }
  carte.poserMarqueur(x, y);
  S.transport.envoyer(encoderAller(Math.round(x * 1000), Math.round(y * 1000)));
  noter('app', `Aller vers (${x.toFixed(2)} ; ${y.toFixed(2)}) m`, { toast: false });
}

// ============================================================================
// 5. Envoi de commandes
// ============================================================================

/** Envoie une commande texte (« mode chien », « param v_max 0.4 »…). */
function envoyerTexte(texte, { silencieux = false } = {}) {
  if (!S.transport?.connecte) { afficherToast('err', 'Pas de liaison avec le rover'); return false; }
  const bloquee = S.urgence.actif && !/^(infos|params)$/.test(texte);
  if (bloquee) { afficherToast('err', "Arrêt d'urgence actif : commande refusée"); return false; }
  S.transport.envoyer(encoderTexte(texte));
  if (!silencieux) reglages.ecrireConsole(texte, 'sortant');
  // Quelques commandes changent aussi l'affichage local tout de suite.
  if (texte === 'recaler' || texte === 'carte raz') { carte.effacerCarte(); if (texte === 'recaler') carte.reinitialiserTrajet(); }
  return true;
}

const pilote = new Pilote((trame) => S.transport?.envoyer(trame) ?? false);

// ============================================================================
// 6. Liaison : connexion, état, PING
// ============================================================================

const LIBELLES_ETAT = { deconnecte: 'Hors ligne', connexion: 'Connexion…', connecte: 'Connecté', reconnexion: 'Reconnexion…', erreur: 'Liaison perdue' };

function utiliserTransport(transport) {
  if (S.transport) { S.transport.deconnecter(); }
  S.transport = transport;
  S.modes = []; S.info = {}; S.etat = null;
  reglages.vider();
  carte.effacerCarte(); carte.reinitialiserTrajet(); carte.rover.ok = false;
  rendreModes();
  transport.addEventListener('etat', (ev) => { if (S.transport === transport) surEtatLiaison(transport, ev.detail); });
  transport.addEventListener('trame', (ev) => { if (S.transport === transport) surTrame(ev.detail); });
  transport.connecter();
}

function nomLiaison(t) {
  if (t.nom === 'demo') return 'Démo';
  if (t.nom === 'ws') return 'Simulateur';
  return t.nomAppareil || 'Rover';
}

function surEtatLiaison(t, { etat, message }) {
  const puce = $('#btn-liaison');
  puce.dataset.etat = etat;
  $('#liaison-texte').textContent = etat === 'connecte' ? nomLiaison(t) : LIBELLES_ETAT[etat];
  $('#liaison-detail').textContent = etat === 'connecte' ? 'Liaison établie' : (message || (etat === 'deconnecte' ? 'Touchez pour vous connecter' : ''));
  $('#carte-vide').hidden = etat === 'connecte' || carte.rover.ok;
  if (etat !== 'connecte') {
    pilote.toutArreter();
    $('#liaison-signal').dataset.barres = '0';
    S.ping.ms = null;
  }
  if (etat === 'erreur') noter('err', message || 'Liaison perdue');
  else if (etat !== 'connexion') noter('app', `Liaison : ${LIBELLES_ETAT[etat].toLowerCase()}${message && etat !== 'deconnecte' ? ` (${message})` : ''}`, { toast: false });
  majVerrouEcran();
  if (etat === 'connecte') {
    noter('app', `Connecté : ${nomLiaison(t)}`, { toast: false });
    afficherToast('evt', `Connecté : ${nomLiaison(t)}`);
    // Au départ on demande tout : identité + comportements, puis les paramètres.
    setTimeout(() => { if (S.transport === t && t.connecte) { t.envoyer(encoderTexte('infos')); t.envoyer(encoderTexte('params')); } }, 250);
    setTimeout(() => { if (S.transport === t && t.connecte) t.envoyer(encoderTexte(`vitesse ${PREF.vitesse}`)); }, 500);
    if (S.urgence.actif) envoyerUrgence(true); // l'urgence verrouillée survit à une reconnexion
  }
}

setInterval(() => {
  const t = S.transport;
  if (!t?.connecte) return;
  S.ping.n = (S.ping.n + 1) & 255;
  S.ping.envoyes.set(S.ping.n, performance.now());
  if (S.ping.envoyes.size > 16) S.ping.envoyes.delete(S.ping.envoyes.keys().next().value);
  t.envoyer(encoderPing(S.ping.n));
  if (S.ping.dernierPong && performance.now() - S.ping.dernierPong > 5000) afficherDetailLiaison('sans réponse du rover');
}, 2000);

function afficherDetailLiaison(forcer) {
  const e = S.etat;
  const morceaux = [];
  if (S.ping.ms !== null) morceaux.push(`${Math.round(S.ping.ms)} ms`);
  if (e?.rssi) morceaux.push(`${e.rssi} dBm`);
  poserTexte($('#liaison-detail'), forcer ?? (morceaux.join(' · ') || 'Liaison établie'));
}

// ============================================================================
// 7. Réception des trames
// ============================================================================

function surTrame(octets) {
  const m = decoder(octets); // ne lève jamais d'exception ; null si illisible
  if (!m) return;
  switch (m.type) {
    case 'etat': surEtat(m); break;
    case 'points': carte.ajouterPoints(m.points); bord.ajouterPoints(m.points); break;
    case 'carte': carte.appliquerCarte(m); break;
    case 'chemin': carte.definirChemin(m.points); break;
    case 'texte': surLigne(m.texte); break;
    case 'pong': {
      const t0 = S.ping.envoyes.get(m.n);
      if (t0 !== undefined) {
        S.ping.envoyes.delete(m.n);
        const ms = performance.now() - t0;
        S.ping.ms = S.ping.ms === null ? ms : S.ping.ms * 0.6 + ms * 0.4;
        S.ping.dernierPong = performance.now();
        afficherDetailLiaison();
      }
      break;
    }
    default: break; // type inconnu : on l'ignore sans bruit
  }
}

function surEtat(e) {
  const precedent = S.etat;
  S.etat = e;
  carte.majEtat(e);
  $('#carte-vide').hidden = true;
  if (S.vue === 'bord') bord.majEtat(e, S.modes);
  poserDonnee($('#liaison-signal'), 'barres', barresSignal(e.rssi));
  if (!precedent || Math.abs((precedent.tension) - e.tension) >= 0.1 || precedent.flags.batterie !== e.flags.batterie) majBatterieEntete(e);
  const nomMode = e.comportement === 0 && !carte.chemin.length ? 'Manuel' : (S.modes[e.comportement] ? libelleMode(S.modes[e.comportement]) : e.comportement === 0 ? 'En route' : `Mode ${e.comportement}`);
  const jeton = $('#info-mode');
  poserTexte(jeton, e.flags.urgence ? "Arrêt d'urgence" : nomMode);
  jeton.classList.toggle('actif', e.comportement !== 0);
  poserTexte($('#info-pos'), `${(e.x / 1000).toFixed(2).replace('.', ',')} ; ${(e.y / 1000).toFixed(2).replace('.', ',')} m`);
  surfaceModeActif(e);
  majAlerte(e, precedent);
  if (e.flags.arrive && !(precedent?.flags.arrive)) carte.retirerMarqueur();
  confirmerUrgence(e);
  afficherDetailLiaison();
}

/** Le problème le plus grave du moment, bien visible sur la carte (on regarde le rover, pas l'écran). */
const GRAVITE = { danger: 0, alerte: 1 };
function majAlerte(e, precedent) {
  let pire = null;
  for (const nom of NOMS_DRAPEAUX) {
    const d = DRAPEAUX_FR[nom];
    if (!e.flags[nom] || nom === 'urgence' || !(d.gravite in GRAVITE)) continue;
    if (!pire || GRAVITE[d.gravite] < GRAVITE[DRAPEAUX_FR[pire].gravite]) pire = nom;
  }
  const jeton = $('#info-alerte');
  jeton.hidden = !pire;
  if (pire) {
    poserTexte(jeton, DRAPEAUX_FR[pire].texte);
    jeton.classList.toggle('ambre', DRAPEAUX_FR[pire].gravite === 'alerte');
    if (!precedent || !precedent.flags[pire]) vibrer(DRAPEAUX_FR[pire].gravite === 'danger' ? [60, 40, 60] : 30);
  }
}

function majBatterieEntete(e) {
  const pct = niveauBatterie(e.tension);
  const bloc = $('#entete-batt');
  bloc.hidden = false;
  poserDonnee(bloc, 'niveau', e.flags.batterie || pct < 15 ? 'bas' : pct < 35 ? 'moyen' : 'bon');
  poserTexte($('#entete-batt-v'), `${e.tension.toFixed(1).replace('.', ',')} V`);
}

function surLigne(texte) {
  const l = analyserLigne(texte);
  if (l.genre !== 'param') reglages.ecrireConsole(texte, 'entrant', l.genre);
  switch (l.genre) {
    case 'info':
      Object.assign(S.info, l.valeurs);
      if (typeof l.valeurs.cellule === 'number') carte.definirCellule(l.valeurs.cellule);
      break;
    case 'modes': S.modes = l.modes; rendreModes(); break;
    case 'param': reglages.majParam(l); break;
    case 'evt': noter('evt', l.message); break;
    case 'err': noter('err', l.message); break;
    case 'calib': noter('evt', `Calibration : ${Object.entries(l.valeurs).map(([k, v]) => `${k} = ${v}`).join(', ')}`); break;
    default: break;
  }
}

// ============================================================================
// 8. Comportements (boutons générés depuis la ligne « modes … »)
// ============================================================================

function rendreModes() {
  const grille = $('#modes-grille');
  grille.textContent = '';
  const noms = S.modes.filter((n) => n !== 'manuel');
  $('#modes-vide').hidden = noms.length > 0;
  $('#modes-cote').hidden = !noms.some((n) => n === 'carre' || n === 'glisse');
  for (const nom of noms) {
    const connu = MODES_FR[nom];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `mode${nom === 'arret' ? ' arret' : ''}`;
    b.dataset.mode = nom;
    b.innerHTML = `${icone(connu?.icone ?? 'generique', 24)}<span class="mode-nom"></span><span class="mode-aide"></span>`;
    $('.mode-nom', b).textContent = libelleMode(nom);
    $('.mode-aide', b).textContent = connu?.aide ?? 'Comportement du rover';
    b.addEventListener('click', () => {
      const arg = nom === 'carre' || nom === 'glisse' ? ` ${S.cote}` : '';
      if (envoyerTexte(`mode ${nom}${arg}`)) {
        vibrer(15);
        if (nom !== 'arret') afficherToast('evt', `${libelleMode(nom)} lancé`);
      }
    });
    grille.append(b);
  }
  if (S.etat) surfaceModeActif(S.etat);
}

/** Met en évidence le bouton du comportement en cours. */
function surfaceModeActif(e) {
  const nom = S.modes[e.comportement];
  $$('#modes-grille .mode').forEach((b) => b.classList.toggle('actif', e.comportement !== 0 && b.dataset.mode === nom));
}

$('#btn-modes-infos').addEventListener('click', () => envoyerTexte('infos'));
$('#cote').addEventListener('input', (ev) => {
  S.cote = Number(ev.target.value);
  $('#cote-val').textContent = `${S.cote.toFixed(1).replace('.', ',')} m`;
});

// ============================================================================
// 9. Arrêt d'urgence (toujours visible, verrouillé tant qu'on ne le libère pas volontairement)
// ============================================================================

const bouton = $('#urgence');
let minuterieMaintien = null;
let boucleConfirmation = null;

function envoyerUrgence(actif) {
  const t = S.transport;
  if (!t?.connecte) return;
  if (actif) t.viderFile();
  t.envoyer(encoderUrgence(actif), { priorite: true });
  if (actif) t.envoyer(encoderStop(), { priorite: true }); // le protocole demande 0x03 01 puis 0x02
}

function declencherUrgence() {
  if (S.urgence.actif) return;
  S.urgence.actif = true;
  S.urgence.essais = 0;
  pilote.bloque = true;
  pilote.toutArreter();
  manetteXY.relacher(); manetteRot.relacher();
  envoyerUrgence(true);
  majUrgenceUI();
  noter('err', "Arrêt d'urgence déclenché");
  vibrer([140, 60, 140], true); // l'arrêt d'urgence vibre toujours, même si les vibrations sont coupées
  // Tant que le rover ne confirme pas, on répète l'ordre (une trame peut se perdre).
  clearInterval(boucleConfirmation);
  boucleConfirmation = setInterval(() => confirmerUrgence(S.etat, true), 500);
}

function liberer() {
  S.urgence.actif = false;
  pilote.bloque = false;
  clearInterval(boucleConfirmation);
  envoyerUrgence(false);
  majUrgenceUI();
  noter('evt', "Arrêt d'urgence déverrouillé");
}

/** Compare notre état avec ce que dit le rover, et corrige. */
function confirmerUrgence(e, depuisBoucle = false) {
  if (!e) return;
  const rover = e.flags.urgence;
  if (S.urgence.actif && !rover && S.transport?.connecte) {
    if (depuisBoucle && S.urgence.essais++ < 20) envoyerUrgence(true);
  } else if (!S.urgence.actif && rover && !depuisBoucle) {
    // Le rover est en urgence sans que nous l'ayons demandé (bouton physique, autre téléphone) : on s'aligne.
    S.urgence.actif = true; pilote.bloque = true; pilote.toutArreter();
    manetteXY.relacher(); manetteRot.relacher();
    majUrgenceUI();
    noter('err', "Le rover est en arrêt d'urgence");
  } else if (S.urgence.actif && rover) clearInterval(boucleConfirmation);
}

function majUrgenceUI() {
  const verrou = S.urgence.actif;
  bouton.dataset.etat = verrou ? 'verrouille' : 'libre';
  $('#urgence-titre').textContent = verrou ? 'Urgence active' : "Arrêt d'urgence";
  $('#urgence-sous').textContent = verrou ? 'Maintenir 1 s pour déverrouiller' : 'Toucher pour tout arrêter';
  $('.urgence-ico', bouton).innerHTML = icone(verrou ? 'cadenas' : 'urgence', 38);
  bouton.setAttribute('aria-label', verrou ? "Arrêt d'urgence actif. Maintenir appuyé pour déverrouiller." : "Arrêt d'urgence");
}

bouton.addEventListener('pointerdown', (ev) => {
  ev.preventDefault();
  if (!S.urgence.actif) { declencherUrgence(); return; } // réaction immédiate dès le toucher
  try { bouton.setPointerCapture(ev.pointerId); } catch { /* pointeur déjà relâché */ }
  bouton.classList.add('maintien');
  minuterieMaintien = setTimeout(() => { bouton.classList.remove('maintien'); liberer(); }, 1100);
});
const finMaintien = () => { clearTimeout(minuterieMaintien); bouton.classList.remove('maintien'); };
bouton.addEventListener('pointerup', finMaintien);
bouton.addEventListener('pointercancel', finMaintien);
bouton.addEventListener('lostpointercapture', finMaintien);
bouton.addEventListener('contextmenu', (ev) => ev.preventDefault());
// Accessibilité : un « clic » qui ne vient pas d'un doigt (lecteur d'écran, clavier) déclenche aussi l'arrêt.
bouton.addEventListener('click', (ev) => { if (!S.urgence.actif) declencherUrgence(); else ev.preventDefault(); });
// Au clavier, déverrouiller demande aussi de maintenir Entrée ou Espace pendant 1,1 s.
bouton.addEventListener('keydown', (ev) => {
  if ((ev.key === 'Enter' || ev.key === ' ') && S.urgence.actif && !ev.repeat) {
    ev.preventDefault(); bouton.classList.add('maintien');
    minuterieMaintien = setTimeout(() => { bouton.classList.remove('maintien'); liberer(); }, 1100);
  }
});
bouton.addEventListener('keyup', finMaintien);
majUrgenceUI();

// ============================================================================
// 10. Pilotage : manettes, clavier, inclinaison, vitesse, repère
// ============================================================================

// -- Préférences mémorisées (confort de la télécommande) --
const PREF = {
  commande: lire('commande') !== '0', // disposition « télécommande » (grandes zones, carte réduite)
  gaucher: lire('gaucher') === '1', // manettes inversées
  vibrations: lire('vibr') !== '0',
  ecran: lire('ecran') !== '0', // garder l'écran allumé tant qu'on est connecté
  vitesse: Number(lire('vitesse')) || 50,
};

/** Retour tactile : une courte vibration (si le téléphone et les préférences le permettent). */
function vibrer(motif, force = false) {
  if (!(PREF.vibrations || force) || !navigator.vibrate) return;
  // Chrome refuse (et le dit dans la console) tant que l'utilisateur n'a pas touché la page.
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
  try { navigator.vibrate(motif); } catch { /* non autorisé : tant pis */ }
}

function lierInterrupteur(id, cle, memo, surChangement) {
  const bouton = $(`#${id}`);
  const dessiner = () => bouton.setAttribute('aria-checked', String(PREF[cle]));
  dessiner();
  bouton.addEventListener('click', () => {
    PREF[cle] = !PREF[cle];
    stocker(memo, cle === 'gaucher' ? (PREF[cle] ? '1' : '0') : (PREF[cle] ? '1' : '0'));
    dessiner(); surChangement?.();
  });
  return dessiner;
}

function appliquerAffichage() {
  const app = $('#app');
  app.dataset.dispo = PREF.commande ? 'commande' : 'carte';
  app.dataset.gaucher = PREF.gaucher ? '1' : '0';
}
const dessinerCommande = lierInterrupteur('sw-commande', 'commande', 'commande', appliquerAffichage);
lierInterrupteur('sw-gaucher', 'gaucher', 'gaucher', appliquerAffichage);
lierInterrupteur('sw-vibr', 'vibrations', 'vibr', () => vibrer(20));
lierInterrupteur('sw-ecran', 'ecran', 'ecran', () => majVerrouEcran());
appliquerAffichage();

$('#btn-dispo').addEventListener('click', () => {
  PREF.commande = !PREF.commande;
  stocker('commande', PREF.commande ? '1' : '0');
  dessinerCommande(); appliquerAffichage();
  afficherToast('evt', PREF.commande ? 'Disposition télécommande' : 'Disposition carte');
});

// -- Manettes flottantes --
const manetteXY = new Manette($('#zone-xy'), $('#manette-xy'), {
  surChangement: (x, y) => { pilote.sources.joystick = { x, y }; },
  surAppui: () => vibrer(8),
});
const manetteRot = new Manette($('#zone-rot'), $('#manette-rot'), {
  axes: 'x',
  surChangement: (x) => { pilote.sources.rotation = { x }; },
  surAppui: () => vibrer(8),
});
new Clavier((x, y, w) => { pilote.sources.clavier = { x, y, w }; });

$$('#seg-repere button').forEach((b) => b.addEventListener('click', () => {
  $$('#seg-repere button').forEach((o) => o.classList.toggle('actif', o === b));
  pilote.monde = b.dataset.monde === '1';
  vibrer(10);
}));

/** Stop : freinage normal (pas l'arrêt d'urgence). Coupe aussi tout comportement autonome. */
$('#btn-stop').addEventListener('click', () => {
  pilote.toutArreter(); manetteXY.relacher(); manetteRot.relacher();
  if (!S.urgence.actif && S.transport?.connecte) S.transport.envoyer(encoderStop(), { priorite: true });
  vibrer(15);
});

// -- Vitesse maximale : boutons rapides sur l'écran de pilotage, curseur fin dans les réglages --
let envoiVitesse = null;
function regleVitesse(v, envoyer = true) {
  PREF.vitesse = v; stocker('vitesse', String(v));
  $('#vitesse').value = v;
  poserTexte($('#vitesse-val'), `${v} %`);
  $$('#seg-vitesse button').forEach((b) => b.classList.toggle('actif', Number(b.dataset.v) === v));
  if (!envoyer) return;
  clearTimeout(envoiVitesse);
  envoiVitesse = setTimeout(() => envoyerTexte(`vitesse ${v}`, { silencieux: true }), 200);
}
$$('#seg-vitesse button').forEach((b) => b.addEventListener('click', () => { regleVitesse(Number(b.dataset.v)); vibrer(10); }));
$('#vitesse').addEventListener('input', (ev) => regleVitesse(Number(ev.target.value)));
regleVitesse(PREF.vitesse, false);

// -- Inclinaison --
const incl = new Inclinaison();
const padIncl = $('#manette-incl');
const zoneXY = $('#zone-xy');
$('#incl-zone').value = incl.zoneMorteDeg; $('#incl-plein').value = incl.pleinDeg;
$('#incl-zone-val').textContent = `${incl.zoneMorteDeg}°`; $('#incl-plein-val').textContent = `${incl.pleinDeg}°`;

function majInclinaison() {
  const v = incl.valeurs();
  pilote.sources.inclinaison = { x: v.x, y: v.y };
  // Le point ambre montre l'inclinaison même quand le doigt n'est pas posé.
  const { droite, avant } = incl.ecarts();
  const r = padIncl.clientWidth * 0.3;
  const px = Math.max(-1, Math.min(1, droite / incl.pleinDeg)) * r;
  const py = -Math.max(-1, Math.min(1, avant / incl.pleinDeg)) * r;
  $('#incl-point').style.transform = `translate(${px}px, ${py}px)`;
}
incl.addEventListener('angle', majInclinaison);

// En mode inclinaison, toute la zone de gauche sert de « poignée » : tant qu'un doigt y reste, l'inclinaison commande.
zoneXY.addEventListener('pointerdown', (ev) => {
  if (!incl.actif) return;
  ev.preventDefault();
  try { zoneXY.setPointerCapture(ev.pointerId); } catch { /* pointeur déjà relâché */ }
  zoneXY.classList.add('active');
  incl.maintenu = true; majInclinaison(); vibrer(8);
});
const lacherPad = () => {
  if (!incl.maintenu) return;
  incl.maintenu = false; zoneXY.classList.remove('active'); pilote.sources.inclinaison = { x: 0, y: 0 };
};
zoneXY.addEventListener('pointerup', lacherPad);
zoneXY.addEventListener('pointercancel', lacherPad);
zoneXY.addEventListener('lostpointercapture', lacherPad);

async function basculerInclinaison() {
  const bascule = $('#btn-incliner');
  if (!incl.actif) {
    bascule.disabled = true;
    const r = await incl.activer(); // peut demander une permission
    bascule.disabled = false;
    if (!r.ok) { afficherToast('err', r.message); return; }
    incl.calibrer();
  } else { incl.desactiver(); lacherPad(); }
  const actif = incl.actif;
  bascule.setAttribute('aria-pressed', String(actif));
  padIncl.hidden = !actif;
  $('#manette-xy').hidden = actif;
  manetteXY.desactive = actif;
  poserTexte($('#aide-xy'), actif ? 'Gardez le doigt posé et inclinez' : 'Glissez pour avancer');
  $('#incl-etat').textContent = actif ? 'Active : gardez un doigt posé et inclinez' : 'Inactive';
  if (!actif) pilote.sources.inclinaison = { x: 0, y: 0 };
}
$('#btn-incliner').addEventListener('click', basculerInclinaison);
$('#btn-neutre').addEventListener('click', () => {
  if (!incl.actif) { afficherToast('err', "Activez d'abord l'inclinaison dans l'écran Pilotage"); return; }
  if (incl.calibrer()) afficherToast('evt', 'Neutre enregistré : la position actuelle devient le point zéro');
});
$('#incl-zone').addEventListener('input', (ev) => { incl.zoneMorteDeg = Number(ev.target.value); $('#incl-zone-val').textContent = `${incl.zoneMorteDeg}°`; incl.enregistrerReglages(); });
$('#incl-plein').addEventListener('input', (ev) => { incl.pleinDeg = Number(ev.target.value); $('#incl-plein-val').textContent = `${incl.pleinDeg}°`; incl.enregistrerReglages(); });

// -- Écran allumé, plein écran, menu contextuel --
let verrouEcran = null;
async function majVerrouEcran() {
  const veut = PREF.ecran && S.transport?.connecte && !document.hidden;
  try {
    if (veut && !verrouEcran && navigator.wakeLock) {
      verrouEcran = await navigator.wakeLock.request('screen');
      verrouEcran.addEventListener('release', () => { verrouEcran = null; });
    } else if (!veut && verrouEcran) { await verrouEcran.release(); verrouEcran = null; }
  } catch { /* refusé par le navigateur : tant pis */ }
}
const pleinEcran = $('#btn-plein-ecran');
if (!document.documentElement.requestFullscreen) pleinEcran.hidden = true;
pleinEcran.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => afficherToast('err', 'Plein écran refusé par le navigateur'));
});
document.addEventListener('contextmenu', (ev) => { if (!ev.target.closest('input, textarea, .console, .journal')) ev.preventDefault(); });

// -- Touches de sécurité --
window.addEventListener('keydown', (ev) => {
  const champ = ev.target?.tagName === 'INPUT' || ev.target?.tagName === 'TEXTAREA';
  if (ev.key === 'Escape') { if ($('dialog[open]')) fermerFeuilles(); else declencherUrgence(); }
  if (ev.key === ' ' && !champ && !ev.repeat && ev.target?.tagName !== 'BUTTON') { ev.preventDefault(); if (!S.urgence.actif) S.transport?.envoyer(encoderStop()); }
});

// Quand l'application passe en arrière-plan, on lâche tout : le rover s'arrête.
document.addEventListener('visibilitychange', () => {
  majVerrouEcran();
  if (document.hidden) { pilote.toutArreter(); manetteXY.relacher(); manetteRot.relacher(); if (S.transport?.connecte && !S.urgence.actif) S.transport.envoyer(encoderStop()); }
});

// ============================================================================
// 11. Réglages : commandes rapides, radar
// ============================================================================

$$('[data-cmd]').forEach((b) => b.addEventListener('click', () => {
  const ok = envoyerTexte(b.dataset.cmd);
  if (ok && b.dataset.cmd === 'recaler') afficherToast('evt', 'Nouvelle origine : la carte repart de zéro');
}));
$$('#seg-radar button').forEach((b) => b.addEventListener('click', () => {
  if (envoyerTexte(`radar ${b.dataset.radar}`)) $$('#seg-radar button').forEach((o) => o.classList.toggle('actif', o === b));
}));

// ============================================================================
// 12. Navigation entre les écrans
// ============================================================================

function allerA(nom) {
  S.vue = nom;
  $('#app').dataset.vue = nom;
  $$('.vue').forEach((v) => v.classList.toggle('actif', v.id === `vue-${nom}`));
  $$('.onglets button').forEach((b) => {
    const actif = b.dataset.vue === nom;
    b.classList.toggle('actif', actif);
    if (actif) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  if (nom === 'pilotage') { carte.demarrer(); carte.redimensionner(); } else { carte.arreter(); manetteXY.relacher(); manetteRot.relacher(); }
  if (nom === 'bord') { bord.demarrer(); if (S.etat) bord.majEtat(S.etat, S.modes); } else bord.arreter();
  if (nom === 'partage') montrerPartage();
  if (nom === 'reglages' && S.transport?.connecte && reglages.params.size === 0) envoyerTexte('params', { silencieux: true });
}
$$('.onglets button').forEach((b) => b.addEventListener('click', () => allerA(b.dataset.vue)));

// ============================================================================
// 13. Partage : QR code, copier, installer
// ============================================================================

function adressePage() { return `${location.origin}${location.pathname}`; }

function montrerPartage() {
  const adresse = adressePage();
  $('#qr-adresse').textContent = adresse;
  try {
    dessinerQr($('#qr-canvas'), creerQr(adresse, 'M'), 560);
  } catch {
    $('#qr-canvas').getContext('2d').clearRect(0, 0, 10, 10);
    $('#qr-adresse').textContent = `${adresse} (adresse trop longue pour un QR code)`;
  }
  const local = /^(localhost|127\.|\[::1\])/.test(location.hostname) || location.protocol === 'file:';
  $('#partage-hors-ligne').textContent = local
    ? "Cette adresse ne fonctionne que sur cet appareil. Une fois la page publiée, le code mènera à l'adresse publique."
    : 'Une fois la page ouverte, elle fonctionne aussi sans connexion internet.';
  $('#btn-partager').hidden = !navigator.share;
}

$('#btn-copier').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(adressePage()); afficherToast('evt', 'Adresse copiée'); }
  catch { afficherToast('err', "Copie impossible : sélectionnez l'adresse à la main"); }
});
$('#btn-partager').addEventListener('click', () => navigator.share?.({ title: 'RoverOS', url: adressePage() }).catch(() => {}));

let invitationInstallation = null;
window.addEventListener('beforeinstallprompt', (ev) => { ev.preventDefault(); invitationInstallation = ev; $('#btn-installer').hidden = false; });
$('#btn-installer').addEventListener('click', async () => {
  if (!invitationInstallation) return;
  invitationInstallation.prompt();
  await invitationInstallation.userChoice.catch(() => {});
  invitationInstallation = null; $('#btn-installer').hidden = true;
});
window.addEventListener('appinstalled', () => { $('#btn-installer').hidden = true; afficherToast('evt', 'Application installée'); });

// ============================================================================
// 14. Fenêtre de connexion
// ============================================================================

const dlg = $('#dlg-connexion');
function ouvrirConnexion() {
  const sansBle = !bluetoothDisponible();
  $('#cx-sans-ble').hidden = !sansBle;
  $('#cx-ble').disabled = sansBle;
  $('#cx-deconnecter').hidden = !(S.transport && S.transport.etat !== 'deconnecte');
  $('#cx-ws-note').hidden = !(location.protocol === 'https:' && !/^(localhost|127\.)/.test(location.hostname));
  if (!dlg.open) ouvrirFeuille(dlg);
}
$('#btn-liaison').addEventListener('click', ouvrirConnexion);
$('#btn-vide-connecter').addEventListener('click', ouvrirConnexion);
$('#cx-fermer').addEventListener('click', fermerFeuilles);

$('#cx-ble').addEventListener('click', () => {
  fermerFeuilles();
  utiliserTransport(new TransportBle()); // doit partir directement du geste de l'utilisateur
});
$('#cx-ws-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const url = normaliserUrlWs($('#cx-ws').value);
  if (!url) { afficherToast('err', "Adresse invalide. Exemple : 192.168.1.20 ou ws://localhost:8765/ws"); return; }
  stocker('ws', $('#cx-ws').value.trim());
  fermerFeuilles();
  utiliserTransport(new TransportWs(url));
});
$('#cx-demo').addEventListener('click', () => { fermerFeuilles(); utiliserTransport(new TransportDemo()); });
$('#cx-deconnecter').addEventListener('click', () => { fermerFeuilles(); S.transport?.deconnecter(); });

// ============================================================================
// 15. Démarrage
// ============================================================================

const parametres = new URLSearchParams(location.search);
const simUrl = parametres.get('sim');
$('#cx-ws').value = simUrl ?? lire('ws') ?? '';

allerA('pilotage');
carte.redimensionner();

if (simUrl) {
  const url = normaliserUrlWs(simUrl);
  if (url) utiliserTransport(new TransportWs(url)); else afficherToast('err', `Adresse « ${simUrl} » invalide`);
} else if (parametres.has('demo')) {
  utiliserTransport(new TransportDemo());
} else {
  setTimeout(ouvrirConnexion, 350); // première visite : on propose tout de suite de se connecter
}

// Fonctionnement hors ligne : le service worker garde les fichiers en cache.
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// Pour les curieux : l'objet est accessible depuis la console du navigateur (window.roveros).
window.roveros = { S, carte, pilote, reglages };
