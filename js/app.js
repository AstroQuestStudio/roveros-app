// app.js — le chef d'orchestre : il relie les transports, la carte, les manettes, les réglages
// et l'interface. Lisez-le de haut en bas : chaque section porte un titre.

import {
  decoder, analyserLigne, AssembleurFragments, encoderTexte, encoderPing, encoderAller, encoderUrgence, encoderStop,
} from './protocole.js';
import { TransportBle, bluetoothDisponible } from './transport-ble.js';
import { TransportWs, normaliserUrlWs } from './transport-ws.js';
import { TransportDemo, alimenterDemoJournal } from './transport-demo.js';
import { VueCarte, formaterDistance } from './carte.js';
import { Manette, Clavier, Pilote } from './manettes.js';
import { Inclinaison } from './inclinaison.js';
import { Reglages, validerNomRover, lirePwmMax, commandePwmMax } from './reglages.js';
import { TableauDeBord, SuiviTension, barresSignal } from './bord.js';
import { creerQr, dessinerQr } from './qr.js';
import { icone, MODES_FR, libelleMode } from './icones.js';
import { poserTexte, poserDonnee } from './utile.js';
import { Diagnostic, Limiteur, etatSecurites } from './diagnostic.js';
import { commandesVitesse, limiterVitesse, rotationPour } from './vitesse.js';
import { MesureLatence, EssaiQualiteLiaison } from './latence.js';
import { normaliser180 } from './lissage.js';
import { Patrouille, MAX_POINTS, MIN_POINTS, PORTEE_PATROUILLE } from './patrouille.js';
import { initFigures } from './figures-panneau.js';
import { PORTEE_ALLER_MAX } from './repere.js';
import { diagnosticMateriel, aDiagnosticEtendu } from './materiel.js';
import { detecterFirmware, libelleFirmware } from './firmware.js';
import {
  lireEnteteMaj, verifierCompatibilitePaquet, tailleBlocPourMtu, PilotageMaj, verifierApresRedemarrage,
} from './maj.js';
import {
  JournalSeance, StockageJournal, analyserJournal, exporterJson,
  CHAMPS_RUST_DEMANDES, SOURCES_DOIGT, ACTIONS_DOIGT,
} from './journal.js';

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
  modesRecus: false,
  info: {},
  infoRecue: false,
  annonces: {},
  profil: detecterFirmware({}, []),
  materiel: null,
  acquisition: null,
  acqBrut: null,
  nav: null,
  liaison: null,
  diagDemandeSession: false,
  profils: [],
  etat: null, // dernière trame ÉTAT décodée
  champs: null, // derniers champs supplémentaires (plafond, frein…)
  champsDemandesSession: false,
  majEtatRover: null,
  majBrut: null,
  majAttenteVerif: null,
  paquetMaj: null,
  numCarteOrigine: null,
  calibEtapes: [],
  autotestResultats: [],
  distanceCourse: 3.0,
  decalagePerfMs: null,
  journalLotId: 0,
  journalReleveEnCours: false,
  liaisonRalentieJusqua: 0,
  urgence: { actif: false, essais: 0 },
  journal: [],
  cote: 0.5,
  vue: 'pilotage',
  nonLus: 0,
};
const suiviTension = new SuiviTension();
const journal = new JournalSeance();
const stockageJournal = new StockageJournal(journal);
stockageJournal.charger().then((ok) => { if (ok && $('#dlg-journal').open) rendreJournal(); });
stockageJournal.demarrer(3000);

// ============================================================================
// 2. Icônes (injectées dans les éléments portant data-icone)
// ============================================================================

function injecterIcones() {
  $$('[data-icone]').forEach((el) => {
    const taille = el.classList.contains('choix-ico') ? 24 : el.closest('.onglets, .tiroir-nav') ? 22 : 18;
    el.innerHTML = icone(el.dataset.icone, taille);
  });
  const parId = { 'btn-zoom-plus': 'plus', 'btn-zoom-moins': 'moins', 'cx-fermer': 'fermer', 'jr-fermer': 'fermer' };
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
const limiteurMessages = new Limiteur(5000); // jamais deux notifications identiques en moins de 5 s
function noter(genre, texte, { toast = genre !== 'app' } = {}) {
  const derniere = S.journal[S.journal.length - 1];
  if (derniere && derniere.genre === genre && derniere.texte === texte) {
    // Même message qui se répète : une seule ligne « ×N » dans le journal, pas de nouvelle notification.
    derniere.n = (derniere.n ?? 1) + 1; derniere.t = new Date();
    if ($('#dlg-journal').open) rendreJournal();
    return;
  }
  if (toast && !limiteurMessages.autoriser(`${genre}:${texte}`)) toast = false;
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
  if ([...zone.children].some((t) => t.textContent === texte)) return; // déjà affichée : pas de doublon à l'écran
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
  const analyse = analyserJournal(journal);
  const dureeS = Math.round(analyse.dureeMs / 1000);
  const st = analyse.stats;
  poserTexte($('#jr-stats'), st.manettes + st.etats + st.stops === 0
    ? 'Aucune trame enregistrée dans cette séance.'
    : `Séance ${dureeS} s · ${st.manettes} manettes · ${st.stops} STOP · ${st.etats} états · ${st.trousEnvoi} trous envoi · ${st.trousReception} trous réception`);

  const resumeEl = $('#jr-resume');
  resumeEl.textContent = '';
  const phrases = analyse.resume.length > 0 ? analyse.resume : ['Aucune anomalie détectée pour l’instant.'];
  for (const p of phrases) {
    const li = document.createElement('li');
    li.className = analyse.resume.length > 0 ? 'jr-bloc' : 'jr-bloc jr-neutre';
    li.textContent = p;
    resumeEl.append(li);
  }

  const repEl = $('#jr-reperes');
  repEl.textContent = '';
  if (analyse.reperes.length === 0) {
    const li = document.createElement('li');
    li.className = 'jr-bloc jr-neutre';
    li.textContent = 'Aucun repère posé. Utilisez « Marquer » sur Pilotage dès que vous sentez une hésitation.';
    repEl.append(li);
  } else {
    for (const r of [...analyse.reperes].reverse()) {
      const li = document.createElement('li');
      li.className = 'jr-bloc jr-repere';
      const tete = document.createElement('span');
      tete.className = 'jr-repere-tete';
      tete.textContent = `${r.heure} — ${r.note}`;
      li.append(tete);
      for (const ph of r.phrases) {
        const sub = document.createElement('span');
        sub.className = 'jr-repere-suite';
        sub.textContent = ph;
        li.append(sub);
      }
      repEl.append(li);
    }
  }

  $('#jr-partager').hidden = !navigator.share;
  $('#jr-demo').hidden = S.transport?.nom !== 'demo';
  $('#jr-relever').hidden = !(S.transport?.connecte && S.profil.capacites.journalRover);
  $('#jr-relever').disabled = S.journalReleveEnCours;
  rendreJournalRover();

  const liste = $('#journal-liste');
  liste.textContent = '';
  for (const e of [...S.journal].reverse()) {
    const li = document.createElement('li');
    li.className = e.genre;
    const h = document.createElement('span'); h.className = 'heure'; h.textContent = e.t.toLocaleTimeString('fr-FR');
    const t = document.createElement('span'); t.textContent = e.n > 1 ? `${e.texte}  ×${e.n}` : e.texte;
    li.append(h, t);
    liste.append(li);
  }
  $('#journal-vide').hidden = S.journal.length > 0;
}

function rendreJournalRover() {
  const bloc = $('#jr-rover-bloc');
  const lignes = journal.journalRover;
  bloc.hidden = lignes.length === 0 && !S.journalReleveEnCours;
  const liste = $('#jr-rover-liste');
  liste.textContent = '';
  for (const e of lignes.slice(-200)) {
    const li = document.createElement('li');
    li.className = 'evt';
    const h = document.createElement('span'); h.className = 'heure';
    if (e.aligne) h.textContent = new Date(journal.epochDe(e.t)).toLocaleTimeString('fr-FR');
    else if (e.tempsMs != null) h.textContent = `+${(e.tempsMs / 1000).toFixed(2).replace('.', ',')} s`;
    else h.textContent = 'rover';
    const t = document.createElement('span'); t.textContent = e.ligne;
    li.append(h, t);
    liste.append(li);
  }
}

function construireFichierJournal() {
  const contenu = JSON.stringify(exporterJson(journal), null, 2);
  const d = new Date(journal.debutHorlogeMs);
  const p2 = (n) => String(n).padStart(2, '0');
  const nom = `roveros-journal-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.json`;
  return { nom, blob: new Blob([contenu], { type: 'application/json' }) };
}

$('#btn-journal').addEventListener('click', () => {
  S.nonLus = 0; $('#journal-pastille').hidden = true; $('#journal-pastille').classList.remove('erreur');
  rendreJournal(); ouvrirFeuille($('#dlg-journal'));
});
$('#btn-journal-reglages').addEventListener('click', () => $('#btn-journal').click());
$('#jr-fermer').addEventListener('click', () => fermerFeuilles());
$('#jr-effacer').addEventListener('click', () => {
  S.journal.length = 0;
  stockageJournal.effacer().then(rendreJournal);
});
$('#jr-exporter').addEventListener('click', () => {
  const { nom, blob } = construireFichierJournal();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nom;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  afficherToast('evt', `Fichier ${nom} enregistré`);
});
$('#jr-partager').addEventListener('click', async () => {
  const { nom, blob } = construireFichierJournal();
  try {
    const fichier = new File([blob], nom, { type: 'application/json' });
    if (navigator.canShare?.({ files: [fichier] })) {
      await navigator.share({ title: 'Journal RoverOS', files: [fichier] });
      return;
    }
    await navigator.share({ title: 'Journal RoverOS', text: analyserJournal(journal).resume.join('\n') || 'Séance RoverOS' });
  } catch (err) {
    if (err?.name !== 'AbortError') afficherToast('err', 'Partage de fichier indisponible sur ce navigateur');
  }
});
$('#jr-demo').addEventListener('click', () => {
  alimenterDemoJournal(journal);
  stockageJournal.sauvegarder();
  rendreJournal();
});
$('#jr-relever').addEventListener('click', () => {
  if (!S.transport?.connecte) { afficherToast('err', 'Pas de liaison avec le rover'); return; }
  S.journalLotId += 1;
  S.journalReleveEnCours = true;
  S.decalagePerfMs = null;
  $('#jr-relever').disabled = true;
  $('#jr-rover-bloc').hidden = false;
  poserTexte($('#jr-rover-stats'), 'Relevé du journal du rover en cours…');
  if (S.profil.famille === 'rust') envoyerTexte('champ t', { silencieux: true });
  envoyerTexte('journal');
});
$('#btn-marquer').addEventListener('click', () => {
  journal.marquer(performance.now());
  stockageJournal.sauvegarder();
  vibrer(20);
  const b = $('#btn-marquer');
  b.classList.add('pose');
  setTimeout(() => b.classList.remove('pose'), 650);
  afficherToast('evt', 'Repère posé dans le journal');
  if ($('#dlg-journal').open) rendreJournal();
});

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
/** L'échelle de la carte se pose en bas à gauche, à la hauteur de la pilule d'arrêt d'urgence. */
function placerEchelle() {
  const cr = $('#carte').getBoundingClientRect();
  if (!cr.height) return;
  carte.margeBas = paysage.matches ? Math.round(Math.max(24, cr.height * 0.05)) : 40;
  carte.invalide = true;
}
window.addEventListener('resize', placerEchelle);
// En paysage, les manettes et réglages recouvrent le bas de la carte : on remonte le rover.
const paysage = window.matchMedia('(orientation: landscape)');
const regleDecalage = () => { carte.decalage = paysage.matches ? -0.12 : -0.04; }; // le rover se place au milieu de l'écran, entre la barre et les manettes
regleDecalage(); paysage.addEventListener('change', regleDecalage);
carte.addEventListener('vue', (ev) => $('#btn-recentrer').classList.toggle('actif', ev.detail.suivre));

/** Toucher un point de la carte : marqueur + trame ALLER. */
function allerAuPoint(x, y) {
  if (patrouille.actif) { // en mode patrouille, chaque toucher ajoute un point numéroté (le simple « aller ici » reste le comportement normal)
    if (S.profil.famille === 'rust' && (Math.abs(x) > PORTEE_PATROUILLE || Math.abs(y) > PORTEE_PATROUILLE)) {
      afficherToast('err', `Point hors zone : ${PORTEE_PATROUILLE} m au plus autour de la base`);
      return;
    }
    if (patrouille.ajouter(x, y)) vibrer(8); else afficherToast('err', `${MAX_POINTS} points au plus`);
    majPatrouille();
    return;
  }
  if (S.urgence.actif) { afficherToast('err', "Arrêt d'urgence actif : déverrouillez-le pour bouger"); return; }
  if (!S.transport?.connecte) { afficherToast('err', 'Pas de liaison avec le rover'); return; }
  if (S.profil.famille === 'rust') {
    if (!S.modes.includes('aller')) { afficherToast('err', 'Déplacement vers un point absent sur ce firmware'); return; }
    carte.poserMarqueur(x, y);
    S.cibleAller = { x, y, t: performance.now() };
    envoyerTexte(`mode aller ${x.toFixed(2)} ${y.toFixed(2)}`);
    noter('app', `Aller vers (${x.toFixed(2)} ; ${y.toFixed(2)}) m`, { toast: false });
    return;
  }
  const rel = carte.repere.relatif(x, y); // mm relatifs au centre de la fenêtre du rover
  if (!rel) { afficherToast('err', `Trop loin : ${PORTEE_ALLER_MAX} m au plus`); return; }
  carte.poserMarqueur(x, y);
  S.cibleAller = { x, y, t: performance.now() }; // pour afficher la distance restante tant que le rover est en route
  S.transport.envoyer(encoderAller(rel.xMm, rel.yMm));
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
const masqueDoigts = () => (pilote.contacts.has('joystick') ? 1 : 0)
  | (pilote.contacts.has('rotation') ? 2 : 0)
  | (pilote.contacts.has('inclinaison') ? 4 : 0)
  | (pilote.contacts.has('clavier') ? 8 : 0);

// ============================================================================
// 6. Liaison : connexion, état, PING
// ============================================================================

const LIBELLES_ETAT = { deconnecte: 'Hors ligne', connexion: 'Connexion…', connecte: 'Connecté', reconnexion: 'Reconnexion…', erreur: 'Liaison perdue' };
const assembleurFragments = new AssembleurFragments();
const pilotageMaj = new PilotageMaj({ envoyer: (trame, opts) => S.transport?.envoyer(trame, opts) ?? false });
let timerVerifMaj = null;

function utiliserTransport(transport) {
  if (S.transport) { S.transport.deconnecter(); }
  clearTimeout(timerVerifMaj);
  pilotageMaj.annuler();
  assembleurFragments.reinitialiser();
  S.transport = transport;
  S.modes = []; S.modesRecus = false; S.info = {}; S.infoRecue = false; S.annonces = {};
  S.materiel = null; S.acquisition = null; S.acqBrut = null; S.nav = null; S.liaison = null; S.diagDemandeSession = false;
  S.profils = []; S.etat = null; S.champs = null; S.champsDemandesSession = false;
  S.majEtatRover = null; S.majBrut = null; S.numCarteOrigine = null; S.calibEtapes = []; S.autotestResultats = [];
  S.decalagePerfMs = null; S.journalReleveEnCours = false;
  S.profil = detecterFirmware({}, []);
  essaiQualite.arreter();
  reglages.vider();
  carte.effacerCarte(); carte.reinitialiserTrajet(); carte.rover.ok = false; S.cibleAller = null; S.posAbsolue = null;
  reinitialiserRetoursReglages();
  rendreCalibJournal();
  rendreAutotest();
  afficherMateriel();
  actualiserProfil();
  rendreModes();
  transport.surEnvoi = (trame, t0) => {
    if (S.transport !== transport) return -1;
    return journal.noterEnvoi(t0, trame, PREF.vitesse, masqueDoigts());
  };
  transport.surFinEcriture = (id, ok, dureeMs) => {
    if (S.transport !== transport) return;
    journal.noterFinEcriture(id, ok, dureeMs);
    if (!ok || dureeMs >= 100) {
      S.liaisonRalentieJusqua = performance.now() + 1500;
      majLigneEtat(S.etat);
    }
  };
  transport.addEventListener('etat', (ev) => { if (S.transport === transport) surEtatLiaison(transport, ev.detail); });
  transport.addEventListener('trame', (ev) => { if (S.transport === transport) surTrame(ev.detail); });
  transport.addEventListener('ecriture', (ev) => { if (S.transport !== transport) return; S.ecritureKo = !ev.detail.ok; noter(ev.detail.ok ? 'app' : 'err', ev.detail.ok ? 'Les commandes repartent' : 'Les écritures Bluetooth échouent : le rover ne reçoit plus les commandes', { toast: false }); majLigneEtat(S.etat); });
  if (transport.nom === 'demo' && journal.envois.type.subarray(0, Math.min(journal.envois.total, journal.envois.cap)).every((tp) => tp !== 0x01)) {
    alimenterDemoJournal(journal, performance.now());
  }
  transport.connecter();
}

function nomLiaison(t) {
  if (S.info?.nom) return String(S.info.nom);
  if (t.nom === 'demo') return t.firmware === 'rust' ? 'Démo Rust' : t.firmware === 'micropython' ? 'Démo MicroPython' : 'Démo';
  if (t.nom === 'ws') return 'Simulateur';
  return t.nomAppareil || 'Rover';
}

function surEtatLiaison(t, { etat, message }) {
  const puce = $('#btn-liaison');
  puce.dataset.etat = etat;
  poserTexte($('#liaison-texte'), etat === 'connecte' ? nomLiaison(t) : LIBELLES_ETAT[etat]);
  puce.title = etat === 'connecte' ? 'Liaison établie' : (message || (etat === 'deconnecte' ? 'Touchez pour vous connecter' : ''));
  majMenuRover();
  $('#carte-vide').hidden = etat === 'connecte' || carte.rover.ok;
  if (etat !== 'connecte') {
    pilote.toutArreter();
    diagnostic.reinitialiser();
    essaiQualite.arreter();
    pilotageMaj.annuler();
    assembleurFragments.reinitialiser();
    S.veille = false; carte.veille = false; S.tEtat = 0; S.ecritureKo = false; S.champs = null; S.champsDemandesSession = false;
    S.diagDemandeSession = false; S.journalReleveEnCours = false;
    $('#liaison-signal').dataset.barres = '0';
    latence.reinitialiser();
    poserTexte($('#lat-val'), '— ms');
    poserTexte($('#bar-vitesse'), '0,00 m/s');
  } else {
    latence.reinitialiser();
    S.majEtatRover = null; S.majBrut = null; S.materiel = null; S.acquisition = null; S.acqBrut = null; S.nav = null; S.liaison = null;
  }
  journal.noterLiaison(performance.now(), etat, message, t.nom, S.profil);
  if (etat === 'erreur') noter('err', message || 'Liaison perdue');
  else if (etat !== 'connexion') noter('app', `Liaison : ${LIBELLES_ETAT[etat].toLowerCase()}${message && etat !== 'deconnecte' ? ` (${message})` : ''}`, { toast: false });
  majVerrouEcran();
  majLigneEtat(null);
  majSecurites();
  appliquerProfilUI();
  if (etat === 'connecte') {
    suiviTension.reinitialiser();
    $('#entete-batt').hidden = true;
    reinitialiserRepere(); // le repère de la carte n'est JAMAIS gardé d'une connexion à l'autre
    S.tConnexion = performance.now();
    setTimeout(majSecurites, 3600);
    S.verifSecurites = true; // les sécurités obstacles sont remises en service si on les trouve coupées
    setTimeout(() => { S.verifSecurites = false; }, 20000); // la liste des paramètres met quelques secondes à arriver
    noter('app', `Connecté : ${nomLiaison(t)}`, { toast: false });
    // Au départ on demande tout : identité + comportements, paramètres et état de mise à jour.
    setTimeout(() => {
      if (S.transport !== t || !t.connecte) return;
      t.envoyer(encoderTexte('infos'));
      t.envoyer(encoderTexte('params'));
      t.envoyer(encoderTexte('maj'));
    }, 250);
    setTimeout(() => { if (S.transport === t && t.connecte) envoyerVitesse(true); }, 500);
    if (S.majAttenteVerif) {
      clearTimeout(timerVerifMaj);
      timerVerifMaj = setTimeout(() => verifierMajApresReconnexion(true), 1800);
    }
    if (S.urgence.actif) envoyerUrgence(true); // l'urgence verrouillée survit à une reconnexion
  }
}

// Latence = temps aller-retour PING / PONG, mesuré toutes les 2 s (une seule petite trame : aucune gêne pour les commandes).
const latence = new MesureLatence({ envoyer: (trame) => S.transport?.envoyer(trame) ?? false });
setInterval(() => {
  const t = S.transport;
  if (!t?.connecte) return;
  latence.tic();
  afficherDetailLiaison();
}, 2000);

// Champs supplémentaires sur firmware Rust (plafond, frein, tension, a_lim, cycles) : seulement quand le rover bouge (ne gêne jamais la veille).
setInterval(() => {
  const t = S.transport;
  if (!t?.connecte || S.profil.famille !== 'rust' || S.veille) return;
  const bouge = pilote.sortie.vx !== 0 || pilote.sortie.vy !== 0 || pilote.sortie.w !== 0 || S.etat?.flags?.mouvement || (S.etat?.vitesse ?? 0) > 2;
  if (bouge) t.envoyer(encoderTexte(`champ ${CHAMPS_RUST_DEMANDES.join(' ')}`));
}, 250);

// Le rover se tait (état plus reçu depuis 2,5 s) : la pastille d'état le dit tout de suite.
setInterval(() => { if (S.transport?.connecte && S.etat && performance.now() - S.tEtat > 2500) majLigneEtat(S.etat); }, 500);

const barresLatence = (ms) => (ms === null ? 0 : ms < 60 ? 4 : ms < 120 ? 3 : ms < 250 ? 2 : 1);

function afficherDetailLiaison() {
  const e = S.etat;
  if (!S.transport?.connecte) return;
  const ms = latence.ms;
  poserTexte($('#lat-val'), latence.sansReponse ? 'sans réponse' : ms === null ? '— ms' : `${ms} ms`);
  $('#lat-val').title = e?.rssi ? `${e.rssi} dBm` : '';
  if (!e?.rssi) poserDonnee($('#liaison-signal'), 'barres', latence.sansReponse ? 0 : barresLatence(ms));
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
    case 'pong':
      essaiQualite.surPong(m.n);
      if (latence.surPong(m.n) !== null) afficherDetailLiaison();
      break;
    case 'echo':
      if (!S.annonces.bancEcho) { S.annonces.bancEcho = true; actualiserProfil(); }
      essaiQualite.surEcho(m.donnees);
      break;
    case 'origine':
      if (typeof m.carte === 'number') {
        if (S.numCarteOrigine !== null && m.carte !== S.numCarteOrigine) carte.effacerCarte();
        S.numCarteOrigine = m.carte;
      }
      carte.appliquerOrigine(m); // la fenêtre de carte du rover a glissé : tout reste en absolu
      break;
    case 'maj':
      if (typeof m.etat === 'number') pilotageMaj.surReponse(m);
      break;
    default: break; // type inconnu : on l'ignore sans bruit
  }
}

function surEtat(e) {
  const precedent = S.etat;
  S.etat = e;
  S.tEtat = performance.now();
  journal.noterEtat(S.tEtat, e); // le journal reçoit la trame brute : tous les drapeaux, même les passagers
  const eAffiche = diagnostic.filtrer(e, S.tEtat); // ligne d'état et liste des drapeaux : sans les défauts passagers trop courts
  carte.majEtat(e);
  $('#carte-vide').hidden = true;
  const etatTension = suiviTension.actualiser(e, S.tEtat);
  if (S.vue === 'bord') bord.majEtat(eAffiche, S.modes, carte.positionAbsolue(e) ?? undefined, suiviTension.minimum);
  if (e.rssi) poserDonnee($('#liaison-signal'), 'barres', barresSignal(e.rssi));
  majBatterieEntete(e, etatTension);
  const nomMode = e.comportement === 0 && !carte.chemin.length ? 'Manuel' : (S.modes[e.comportement] ? libelleMode(S.modes[e.comportement]) : e.comportement === 0 ? 'En route' : `Mode ${e.comportement}`);
  const jeton = $('#info-mode');
  poserTexte(jeton, e.flags.urgence ? "Arrêt d'urgence" : nomMode);
  jeton.hidden = nomMode === 'Manuel' && !e.flags.urgence; // « Manuel » n'apprend rien : on ne l'affiche pas
  jeton.classList.toggle('actif', e.comportement !== 0);
  poserTexte($('#bar-vitesse'), `${(e.vitesse / 100).toFixed(2).replace('.', ',')} m/s`);
  poserTexte($('#bar-cap'), e.capSature ? '?°' : `${Math.round(normaliser180(e.cap))}°`); // toujours entre −180° et 180°
  if (e.capSature && limiteurMessages.autoriser('cap-sature')) noter('err', "Le cap envoyé par le rover est saturé (au-delà de ±327°) : l'orientation affichée n'est plus fiable", { toast: false });
  majPosition(e, precedent);
  if (S.modes[e.comportement] === 'patrouille') S.enPatrouille = true;
  else if (S.enPatrouille && !patrouille.actif) { S.enPatrouille = false; patrouille.effacer(); majPatrouille(); } // patrouille terminée : on retire les points
  surfaceModeActif(e);
  majLigneEtat(eAffiche);
  if (e.flags.arrive && !(precedent?.flags.arrive)) carte.retirerMarqueur();
  confirmerUrgence(e);
  afficherDetailLiaison();
}

// -- Ligne d'état : « pourquoi il n'avance pas », en clair --
const diagnostic = new Diagnostic();

function contexteEtat() {
  const e = S.etat;
  const nomMode = e && e.comportement !== 0 && S.modes[e.comportement] ? libelleMode(S.modes[e.comportement]) : '';
  const maintenant = performance.now();
  const silenceMs = S.tEtat ? maintenant - S.tEtat : 0;
  const pousse = Math.abs(pilote.sortie.vx) > 5 || Math.abs(pilote.sortie.vy) > 5 || Math.abs(pilote.sortie.w) > 5;
  return {
    liaison: S.transport?.etat ?? 'deconnecte',
    commande: pilote.sortie,
    urgenceApp: S.urgence.actif,
    mode: nomMode,
    veille: S.veille,
    restant: distanceRestante(),
    silenceMs,
    ecritureKo: S.ecritureKo,
    plafond: S.champs?.plafond,
    frein: S.champs?.frein,
    vMax: PREF.vitesse,
    liaisonRalentie: maintenant < (S.liaisonRalentieJusqua ?? 0) || (pousse && silenceMs > 450),
    formaterDistance,
  };
}

/** Distance (m) entre le rover et le point touché tant qu'un « aller » est en cours, sinon null. */
function distanceRestante() {
  const c = S.cibleAller; const e = S.etat;
  if (!c || !e) return null;
  const pos = carte.positionAbsolue(e);
  if (!pos) return null;
  const d = Math.hypot(c.x - pos.x, c.y - pos.y);
  // arrivé pour de bon, repris à la manette, ou abandonné (plus de chemin, à l'arrêt depuis un moment) : on n'affiche plus rien
  const abandonne = performance.now() - c.t > 4000 && !carte.chemin.length && e.vitesse < 2 && !e.flags.mouvement;
  if ((e.flags.arrive && d < 0.3) || d < 0.12 || abandonne || pilote.sortie.vx || pilote.sortie.vy || pilote.sortie.w) { S.cibleAller = null; return null; }
  return d;
}

function afficherLigne(ligne) {
  const el = $('#ligne-etat');
  poserDonnee(el, 'niveau', ligne.niveau);
  poserTexte($('#ligne-etat-texte'), ligne.texte);
}

/** À chaque trame ÉTAT (et quand la liaison change, avec e = null). */
function majLigneEtat(e) {
  const r = diagnostic.traiter(e, contexteEtat());
  afficherLigne(r.ligne);
  if (r.annonce) {
    noter(r.annonce.niveau === 'danger' ? 'err' : 'evt', r.annonce.texte, { toast: false }); // la pastille d'état le dit déjà : journal et vibration seulement
    vibrer(r.annonce.niveau === 'danger' ? [60, 40, 60] : 30); // une seule fois : l'anti-doublon est dans le diagnostic
  }
}

// -- Position estimée par le rover, base, recalage --
const APRES_RECALAGE_MS = 30000;
let minuterieRecalage = null;

function majPosition(e, precedent) {
  const pos = carte.positionAbsolue(e);
  if (!pos) return; // trame écrite dans un repère inconnu : on garde l'affichage précédent
  const { x, y } = pos;
  const fmt = (v) => v.toFixed(2).replace('.', ',');
  const distBase = Math.hypot(x, y);
  poserTexte($('#bar-pos'), `${fmt(x)} ; ${fmt(y)} m`);
  $('.stat-cap').title = `Là où le rover croit être : ${fmt(x)} ; ${fmt(y)} m, cap ${e.capSature ? '?' : Math.round(normaliser180(e.cap))}° (base à ${fmt(distBase)} m)`;
  // Position et carte brusquement remises à zéro sans que nous l'ayons demandé : le rover a été reposé.
  const avant = S.posAbsolue;
  S.posAbsolue = pos;
  if (avant && !S.recalageVoulu) {
    const saut = Math.hypot(avant.x, avant.y);
    if (saut > 0.3 && distBase < 0.03 && Math.abs(normaliser180(e.cap)) < 3 && !e.capSature && precedent) signalerRecalage('Le rover a remis sa position à zéro');
  }
}

/** Le rover a remis sa position et sa carte à zéro (pris en main, ou recalé) : tout ce qu'on affichait est caduc. */
function signalerRecalage(message) {
  carte.effacerCarte(); carte.reinitialiserTrajet(); S.cibleAller = null; S.posAbsolue = null;
  const chip = $('#info-perdu');
  chip.hidden = false;
  poserTexte(chip, `Position remise à zéro à ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`);
  clearTimeout(minuterieRecalage);
  minuterieRecalage = setTimeout(() => { chip.hidden = true; }, APRES_RECALAGE_MS);
  if (message) noter('evt', message);
}

// Bouton « Je suis à la base » : recaler puis effacer la carte, après un second toucher de confirmation.
let minuterieBase = null;
function reinitialiserBouton() {
  clearTimeout(minuterieBase);
  $('#btn-base').classList.remove('confirmer');
}
$('#btn-base').addEventListener('click', () => {
  const b = $('#btn-base');
  if (!b.classList.contains('confirmer')) {
    b.classList.add('confirmer');
    afficherToast('evt', 'Touchez encore pour confirmer : le rover est à la base');
    minuterieBase = setTimeout(reinitialiserBouton, 4000);
    return;
  }
  reinitialiserBouton();
  if (!S.transport?.connecte) { afficherToast('err', 'Pas de liaison avec le rover'); return; }
  S.recalageVoulu = true; setTimeout(() => { S.recalageVoulu = false; }, 3000);
  envoyerTexte('recaler');
  envoyerTexte('carte raz');
  $('#info-perdu').hidden = true;
  afficherToast('evt', 'Base redéfinie ici : le rover repart de zéro');
  vibrer(20);
});

function majBatterieEntete(e, etat) {
  const bloc = $('#entete-batt');
  bloc.hidden = false;
  poserDonnee(bloc, 'niveau', etat === 'faible' ? 'bas' : etat === 'chute' ? 'moyen' : 'bon');
  poserTexte($('#entete-batt-etat'), etat);
  poserTexte($('#entete-batt-v'), `${e.tension.toFixed(1).replace('.', ',')} V`);
  bloc.title = `Tension : ${e.tension.toFixed(1).replace('.', ',')} V — ${etat} ; ouvrir le tableau de bord`;
  bloc.setAttribute('aria-label', bloc.title);
}

function noterDiagMaterielSiPret() {
  if (!S.materiel) return;
  const diag = diagnosticMateriel(S.materiel, S.acquisition, S.profils, { acqBrut: S.acqBrut, nav: S.nav, liaison: S.liaison });
  journal.noterDiagnostic(performance.now(), diag);
  return diag;
}

function surLigne(texte) {
  const texteComplet = assembleurFragments.pousser(texte);
  if (texteComplet === null) return;
  const l = analyserLigne(texteComplet);
  if (l.genre !== 'param' && l.genre !== 'champs' && l.genre !== 'journal_rover') reglages.ecrireConsole(texteComplet, 'entrant', l.genre);
  if (l.genre !== 'champs' && l.genre !== 'journal_rover') journal.noterTexte(performance.now(), texteComplet);
  switch (l.genre) {
    case 'champs':
      journal.noterChamps(performance.now(), l.valeurs);
      S.champs = l.valeurs;
      if (typeof l.valeurs.t === 'number') {
        S.decalagePerfMs = performance.now() - l.valeurs.t;
        if (S.journalLotId > 0) journal.alignerJournalRover(S.journalLotId, S.decalagePerfMs);
        if ($('#dlg-journal').open) rendreJournalRover();
      }
      majLigneEtat(S.etat);
      break;
    case 'info':
      Object.assign(S.info, l.valeurs);
      S.infoRecue = true;
      if (typeof l.valeurs.cellule === 'number') carte.definirCellule(l.valeurs.cellule);
      actualiserProfil();
      if (S.profil.famille === 'rust' && S.transport?.connecte) {
        if (!S.champsDemandesSession) {
          S.champsDemandesSession = true;
          journal.champsDemandes = [...CHAMPS_RUST_DEMANDES];
          S.transport.envoyer(encoderTexte(`champ ${CHAMPS_RUST_DEMANDES.join(' ')}`));
        }
        if (!S.diagDemandeSession) {
          S.diagDemandeSession = true;
          S.transport.envoyer(encoderTexte('materiel'));
          S.transport.envoyer(encoderTexte('liaison'));
        }
      }
      verifierMajApresReconnexion(false);
      break;
    case 'modes':
      S.modes = l.modes;
      S.modesRecus = true;
      actualiserProfil();
      rendreModes();
      break;
    case 'param': reglages.majParam(l); surParamRecu(l); break;
    case 'maj':
      S.majEtatRover = l.valeurs;
      S.majBrut = l.brut;
      if (!S.annonces.majIndisponible) S.annonces.majDisponible = true;
      actualiserProfil();
      verifierMajApresReconnexion(false);
      break;
    case 'evt':
      // veille / réveil, et l'écho d'un réglage (« v_max = 0.4 ») : dans le journal seulement, sans notification
      noter('evt', l.message, { toast: !/^(veille|r[ée]veil)/i.test(l.message) && !/^[a-z_0-9]+ = \S+$/i.test(l.message) });
      if (/^veille\b/i.test(l.message)) { S.veille = true; carte.veille = true; carte.invalide = true; majLigneEtat(S.etat); }
      else if (/^r[ée]veil/i.test(l.message)) { S.veille = false; carte.veille = false; carte.invalide = true; majLigneEtat(S.etat); }
      if (/repos[ée]|remises? à zéro/i.test(l.message)) signalerRecalage();
      else if (/carte (effacée|vidée|remise)/i.test(l.message)) carte.effacerCarte();
      if (/^(arriv[ée]|objectif abandonné|pas de passage)/i.test(l.message)) { S.cibleAller = null; carte.poserMarqueur(null); }
      if (/^param[èe]tres (enregistrés|inchangés|d'usine restaurés)/i.test(l.message)) {
        afficherRetour('#params-retour', l.message, 'ok');
        if (/usine/i.test(l.message)) setTimeout(() => envoyerTexte('params', { silencieux: true }), 200);
      }
      if (/^nom (?:enregistré\s*:|d'origine)/i.test(l.message)) afficherRetour('#rover-nom-retour', l.message, 'ok');
      if (/^autotest\s*:/i.test(l.message)) traiterLigneAutotest(l.message);
      if (/^calibration\b/i.test(l.message)) ajouterEtapeCalib(l.message);
      break;
    case 'materiel':
      S.materiel = l.valeurs;
      S.acquisition = null;
      S.acqBrut = null;
      if (aDiagnosticEtendu(l.valeurs)) { S.annonces.diagnosticEtendu = true; actualiserProfil(); }
      noterDiagMaterielSiPret();
      afficherMateriel();
      verifierMajApresReconnexion(false);
      break;
    case 'acquisition':
      S.acquisition = l.valeurs;
      S.acqBrut = l.brut;
      S.annonces.diagnosticEtendu = true;
      actualiserProfil();
      noterDiagMaterielSiPret();
      afficherMateriel();
      break;
    case 'nav':
      S.nav = l.valeurs;
      noterDiagMaterielSiPret();
      afficherMateriel();
      break;
    case 'liaison':
      S.liaison = l.valeurs;
      noterDiagMaterielSiPret();
      afficherMateriel();
      break;
    case 'profil': {
      const i = l.section ? S.profils.findIndex((p) => p.section === l.section) : -1;
      if (i >= 0) S.profils[i] = l; else S.profils.push(l);
      S.annonces.profil = true;
      actualiserProfil();
      afficherMateriel();
      break;
    }
    case 'err':
      noter('err', l.message);
      if (/mise à jour sans fil\s*:\s*indisponible|commande inconnue\s*:\s*maj\b/i.test(l.message)) {
        S.annonces.majIndisponible = true;
        actualiserProfil();
      }
      if (/commande inconnue\s*:\s*journal\b/i.test(l.message)) {
        S.annonces.journalIndisponible = true;
        S.journalReleveEnCours = false;
        actualiserProfil();
        if ($('#dlg-journal').open) rendreJournal();
      }
      if (/commande inconnue\s*:\s*params\b/i.test(l.message)) { S.annonces.sauverIndisponible = true; actualiserProfil(); }
      if (/^params\b/i.test(l.message)) afficherRetour('#params-retour', l.message, 'err');
      if (/^nom\b/i.test(l.message)) afficherRetour('#rover-nom-retour', l.message, 'err');
      if (/^(calibrer|calibration)\b/i.test(l.message)) ajouterEtapeCalib(l.message, true);
      if (/^autotest\b/i.test(l.message)) traiterLigneAutotest(l.message, true);
      if (/^(maj|mise à jour)\b/i.test(l.message)) afficherRetour('#maj-retour', l.message, 'err');
      break;
    case 'calib': {
      const paires = Object.entries(l.valeurs).map(([k, v]) => `${k} = ${v}`).join(', ');
      const texteCalib = paires || l.reste || texteComplet;
      noter('evt', `Calibration : ${texteCalib}`);
      ajouterEtapeCalib(texteCalib);
      if (/enregistré flash|calibration finie|termin/i.test(texteComplet) && S.transport?.connecte) {
        setTimeout(() => envoyerTexte('params', { silencieux: true }), 250);
      }
      break;
    }
    case 'journal_rover':
      if (!S.annonces.journalIndisponible) { S.annonces.journalDisponible = true; actualiserProfil(); }
      journal.noterJournalRover(performance.now(), l.brut ?? texteComplet, l, { lotId: S.journalLotId, decalagePerfMs: S.decalagePerfMs });
      if ($('#dlg-journal').open) rendreJournalRover();
      break;
    case 'journal_fin':
      S.journalReleveEnCours = false;
      $('#jr-relever').disabled = false;
      $('#jr-rover-bloc').hidden = false;
      poserTexte($('#jr-rover-stats'), `Relevé terminé : ${l.nombre} ligne(s)${l.perdus ? ` · ${l.perdus} perdue(s)` : ''}`);
      if ($('#dlg-journal').open) rendreJournalRover();
      break;
    default:
      if (l.mot === 'nav') {
        S.nav = l.valeurs;
        noterDiagMaterielSiPret();
        afficherMateriel();
      }
      break;
  }
}

// ============================================================================
// 8. Profil firmware & Comportements (boutons générés depuis la ligne « modes … »)
// ============================================================================

function actualiserProfil() {
  S.profil = detecterFirmware(S.info, S.modes, S.annonces);
  appliquerProfilUI();
}

function appliquerProfilUI() {
  const connecte = !!S.transport?.connecte;
  const p = S.profil;
  const cap = p.capacites;

  // En-tête : nom du rover + version du firmware
  if (connecte) poserTexte($('#liaison-texte'), nomLiaison(S.transport));
  const fwEl = $('#entete-fw');
  const libFw = libelleFirmware(p);
  fwEl.hidden = !connecte || !S.infoRecue;
  if (!fwEl.hidden) poserTexte(fwEl, p.version ? `${p.famille === 'rust' ? 'Rust' : p.famille === 'micropython' ? 'MicroPython' : p.famille === 'demo' ? 'Démo' : 'Inconnu'} ${p.version}` : libFw);
  if (connecte) $('#btn-liaison').title = S.infoRecue ? `Liaison établie · ${libFw}` : 'Liaison établie';

  // Tableau de bord : identité firmware et capacités
  $('#b-firmware-boite').hidden = !connecte;
  if (connecte) {
    poserTexte($('#b-firmware-nom'), libFw);
    poserTexte($('#b-firmware-rover'), p.nom ? `Rover : ${p.nom}` : '');
    const capsEl = $('#b-firmware-caps');
    capsEl.textContent = '';
    const puces = [
      ['Sauvegarde réglages', cap.sauverParams],
      ["Réglages d'usine", cap.reglagesUsine],
      ['Changement de nom', cap.changementNom],
      ['Calibration auto', cap.calibrationAuto],
      ['Diagnostic étendu', cap.diagnosticEtendu],
      ["Banc d'écho", cap.bancEcho],
      ['Mise à jour sans fil', cap.majSansFil],
    ];
    for (const [nom, ok] of puces) {
      const span = document.createElement('span');
      span.className = `fw-cap ${ok ? 'dispo' : 'indispo'}`;
      span.textContent = ok ? nom : `${nom} : pas sur ce firmware`;
      capsEl.append(span);
    }
  }

  // Essai qualité de la liaison
  const methode = cap.bancEcho ? "50 trames d'écho (0x12)" : '50 trames PING (0x11)';
  poserTexte($('#b-qualite-aide'), `Envoie ${methode} pour mesurer l'aller-retour médian et les pertes.`);
  $('#btn-qualite-liaison').disabled = !connecte || essaiQualite.actif;

  // Réglages : en-tête firmware, mise à jour sans fil, nom du rover, sauvegarde / usine
  $('#r-firmware-boite').hidden = !connecte;
  if (connecte) {
    poserTexte($('#r-firmware-nom'), libFw);
    poserTexte($('#r-firmware-maj'), cap.majSansFil ? 'Mise à jour sans fil : disponible (trames 0x20–0x23)' : 'Mise à jour sans fil : pas sur ce firmware');
  }
  $('#maj-badge-indispo').hidden = !connecte || cap.majSansFil;
  majAffichageMajRover();
  if ($('#dlg-journal').open) {
    $('#jr-relever').hidden = !(connecte && cap.journalRover);
    $('#jr-relever').disabled = S.journalReleveEnCours;
  }

  const nomOk = connecte && cap.changementNom;
  $('#rover-nom-saisie').disabled = !nomOk;
  $('#btn-nom-envoyer').disabled = !nomOk;
  $('#btn-nom-origine').disabled = !nomOk;
  $('#nom-badge-indispo').hidden = !connecte || cap.changementNom;

  const sauverOk = connecte && cap.sauverParams;
  const usineOk = connecte && cap.reglagesUsine;
  $('#btn-params-sauver').disabled = !sauverOk;
  $('#btn-params-usine').disabled = !usineOk;
  $('#btn-params-sauver').title = cap.sauverParams ? '' : 'Pas sur ce firmware';
  $('#btn-params-usine').title = cap.reglagesUsine ? '' : 'Pas sur ce firmware';
  $('#params-badge-indispo').hidden = !connecte || (cap.sauverParams && cap.reglagesUsine);
  if (!usineOk) fermerConfirmationUsine();
}

function rendreModes() {
  const grille = $('#modes-grille');
  grille.textContent = '';
  const noms = S.modes.filter((n) => n !== 'manuel');
  $('#modes-vide').hidden = noms.length > 0;
  if (noms.length === 0) {
    poserTexte($('#modes-vide-texte'), S.modesRecus
      ? 'Aucun comportement autonome sur ce firmware (mode manuel uniquement).'
      : 'Aucun comportement connu. La liste arrive du rover à la connexion.');
    $('#btn-modes-infos').hidden = S.modesRecus;
  }
  $('#modes-cote').hidden = !noms.some((n) => n === 'carre' || n === 'glisse');
  $('#modes-course').hidden = !noms.includes('course');
  const calibDispo = noms.includes('calibrer') || S.profil.capacites.calibrationAuto;
  $('#calib-boite').hidden = !calibDispo;
  $('#autotest-boite').hidden = !noms.includes('autotest');
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
      if (nom === 'patrouille') { ouvrirPatrouille(); return; }
      if (nom === 'aller') { allerA('carte'); afficherToast('evt', 'Touchez un point sur la carte pour y envoyer le rover'); return; }
      const arg = nom === 'carre' || nom === 'glisse' ? ` ${S.cote}` : nom === 'course' ? ` ${S.distanceCourse}` : '';
      if (envoyerTexte(`mode ${nom}${arg}`)) {
        vibrer(15);
        if (nom !== 'arret') afficherToast('evt', `${libelleMode(nom)} lancé`);
      }
    });
    grille.append(b);
  }
  const indispos = [
    ...(!noms.includes('patrouille') ? [['patrouille', 'Patrouille', 'patrouille', 'Ce rover ne propose pas la patrouille']] : []),
    ...(!noms.includes('calibrer') && !S.profil.capacites.calibrationAuto ? [['calibrer', 'Calibrer', 'calibrer', 'Calibration automatique absente de ce firmware']] : []),
  ];
  for (const [nom, lib, ico, msg] of indispos) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'mode indisponible'; b.dataset.mode = nom; b.setAttribute('aria-disabled', 'true');
    b.innerHTML = `${icone(ico, 24)}<span class="mode-nom"></span><span class="mode-aide">Pas sur ce firmware</span>`;
    $('.mode-nom', b).textContent = lib;
    b.addEventListener('click', () => afficherToast('err', msg));
    grille.append(b);
  }
  majPatrouille();
  if (S.etat) surfaceModeActif(S.etat);
}

/** Met en évidence le bouton du comportement en cours. */
function surfaceModeActif(e) {
  const nom = S.modes[e.comportement];
  $$('#modes-grille .mode').forEach((b) => b.classList.toggle('actif', e.comportement !== 0 && b.dataset.mode === nom));
  const enCalib = e.comportement !== 0 && nom === 'calibrer';
  const enTest = e.comportement !== 0 && nom === 'autotest';
  if ($('#btn-calib-stop')) $('#btn-calib-stop').disabled = !enCalib;
  if ($('#btn-calib-lancer')) $('#btn-calib-lancer').disabled = enCalib;
  if ($('#btn-autotest-court')) $('#btn-autotest-court').disabled = enTest;
  if ($('#btn-autotest-roues')) $('#btn-autotest-roues').disabled = enTest;
  if (enCalib) poserTexte($('#calib-etat'), 'En cours…');
  else if ($('#calib-etat').textContent === 'En cours…') poserTexte($('#calib-etat'), 'Terminée');
  if (enTest) poserTexte($('#autotest-etat'), 'En cours…');
  else if ($('#autotest-etat').textContent === 'En cours…') poserTexte($('#autotest-etat'), 'Terminé');
}

function ajouterEtapeCalib(texte, erreur = false) {
  S.calibEtapes.push({ texte, erreur });
  if (S.calibEtapes.length > 40) S.calibEtapes.shift();
  poserTexte($('#calib-etat'), erreur ? 'Erreur' : (/enregistré flash|finie|termin/i.test(texte) ? 'Terminée' : 'En cours…'));
  rendreCalibJournal();
}
function rendreCalibJournal() {
  const liste = $('#calib-journal');
  if (!liste) return;
  liste.textContent = '';
  liste.hidden = S.calibEtapes.length === 0;
  for (const e of S.calibEtapes) {
    const li = document.createElement('li');
    li.className = e.erreur ? 'err' : 'evt';
    li.textContent = e.texte;
    liste.append(li);
  }
}

function traiterLigneAutotest(message, erreur = false) {
  if (erreur) { poserTexte($('#autotest-etat'), message); return; }
  const corps = message.replace(/^autotest\s*:\s*/i, '').trim();
  const estDebut = /^(d[ée]marrage|fin|termin|tout va bien|je v[ée]rifie|anomalie)/i.test(corps);
  if (/^(d[ée]marrage|je v[ée]rifie)/i.test(corps)) S.autotestResultats = [];
  if (estDebut) {
    poserTexte($('#autotest-etat'), corps);
    rendreAutotest();
    return;
  }
  const idxSep = corps.lastIndexOf(':');
  const m = idxSep > 0
    ? [corps, corps.slice(0, idxSep), corps.slice(idxSep + 1)]
    : /^([^=]+?)\s*=\s*(.+)$/.exec(corps);
  const organe = m ? m[1].trim() : corps;
  const verdict = m ? m[2].trim() : '';
  const statut = /\b(ko|err|echec|défaut|bloqué)\b/i.test(verdict) ? 'ko'
    : /\b(absent|non connecté|muet|non test[ée]s?)\b/i.test(verdict) ? 'absent'
      : /\b(ok|bon|passé|réussi)\b/i.test(verdict) ? 'ok' : '';
  S.autotestResultats.push({ organe, verdict, statut });
  poserTexte($('#autotest-etat'), S.autotestResultats.some((r) => r.statut === 'ko') ? 'Anomalie détectée' : 'Vérification effectuée');
  rendreAutotest();
}
function rendreAutotest() {
  const liste = $('#autotest-liste');
  if (!liste) return;
  liste.textContent = '';
  liste.hidden = S.autotestResultats.length === 0;
  for (const r of S.autotestResultats) {
    const li = document.createElement('li');
    li.className = `autotest-item${r.statut ? ` ${r.statut}` : ''}`;
    const nom = document.createElement('span'); nom.textContent = r.organe;
    const val = document.createElement('strong'); val.className = 'chiffres'; val.textContent = r.verdict;
    li.append(nom, val);
    liste.append(li);
  }
}

$('#btn-modes-infos').addEventListener('click', () => envoyerTexte('infos'));
$('#cote').addEventListener('input', (ev) => {
  S.cote = Number(ev.target.value);
  $('#cote-val').textContent = `${S.cote.toFixed(1).replace('.', ',')} m`;
});
$('#course-dist').addEventListener('input', (ev) => {
  S.distanceCourse = Number(ev.target.value);
  $('#course-val').textContent = `${S.distanceCourse.toFixed(1).replace('.', ',')} m`;
});
$('#btn-calib-lancer').addEventListener('click', () => {
  const etape = $('#calib-etape').value;
  const cmd = etape ? `mode calibrer ${etape}` : 'mode calibrer';
  S.calibEtapes = [];
  rendreCalibJournal();
  if (envoyerTexte(cmd)) {
    poserTexte($('#calib-etat'), 'En cours…');
    $('#btn-calib-stop').disabled = false;
    afficherToast('evt', 'Calibration lancée');
    vibrer(15);
  }
});
$('#btn-calib-stop').addEventListener('click', () => {
  if (envoyerTexte('mode arret')) {
    poserTexte($('#calib-etat'), 'Arrêtée');
    $('#btn-calib-stop').disabled = true;
    $('#btn-calib-lancer').disabled = false;
  }
});
$('#btn-autotest-court').addEventListener('click', () => {
  S.autotestResultats = [];
  rendreAutotest();
  if (envoyerTexte('mode autotest')) { poserTexte($('#autotest-etat'), 'En cours…'); vibrer(15); }
});
$('#btn-autotest-roues').addEventListener('click', () => {
  S.autotestResultats = [];
  rendreAutotest();
  if (envoyerTexte('mode autotest 1')) { poserTexte($('#autotest-etat'), 'En cours…'); vibrer(15); }
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
  vitesse: Number(lire('vitesse_ms')) || 0.4, // m/s (l'ancien réglage en % est abandonné)
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
lierInterrupteur('sw-commande', 'commande', 'commande', appliquerAffichage);
lierInterrupteur('sw-gaucher', 'gaucher', 'gaucher', appliquerAffichage);
lierInterrupteur('sw-vibr', 'vibrations', 'vibr', () => vibrer(20));
lierInterrupteur('sw-ecran', 'ecran', 'ecran', () => majVerrouEcran());
appliquerAffichage();

// -- Manettes flottantes --
const manetteXY = new Manette($('#zone-xy'), $('#manette-xy'), {
  surChangement: (x, y) => pilote.maj('joystick', { x, y }),
  surAppui: () => { pilote.definirContact('joystick', true); vibrer(8); },
  surRelache: () => pilote.definirContact('joystick', false),
  surDoigt: (act, x, y) => journal.noterDoigt(performance.now(), SOURCES_DOIGT.xy, ACTIONS_DOIGT[act] ?? 1, x, y),
});
const manetteRot = new Manette($('#zone-rot'), $('#manette-rot'), {
  axes: 'x',
  surChangement: (x) => pilote.maj('rotation', { x }),
  surAppui: () => { pilote.definirContact('rotation', true); vibrer(8); },
  surRelache: () => pilote.definirContact('rotation', false),
  surDoigt: (act, x, y) => journal.noterDoigt(performance.now(), SOURCES_DOIGT.rot, ACTIONS_DOIGT[act] ?? 1, x, y),
});
new Clavier((x, y, w) => {
  pilote.definirContact('clavier', x !== 0 || y !== 0 || w !== 0);
  journal.noterDoigt(performance.now(), SOURCES_DOIGT.clavier, (x || y || w) ? 1 : 2, x, y);
  pilote.maj('clavier', { x, y, w });
});

/** Repère de la manette : le ROVER par défaut (haut = là où regarde son capteur). Jamais mémorisé. */
function choisirRepere(monde) {
  pilote.monde = monde;
  $$('#seg-repere button').forEach((o) => o.classList.toggle('actif', (o.dataset.monde === '1') === monde));
  $('#info-repere').hidden = !monde;
}
function reinitialiserRepere() { choisirRepere(false); }
$$('#seg-repere button').forEach((b) => b.addEventListener('click', () => {
  choisirRepere(b.dataset.monde === '1');
  if (pilote.monde) afficherToast('evt', 'Repère de la carte : haut de la manette = haut de la carte');
  vibrer(10);
}));
reinitialiserRepere();

/** Stop : freinage normal (pas l'arrêt d'urgence). Coupe aussi tout comportement autonome. */
$('#btn-stop').addEventListener('click', () => {
  pilote.toutArreter(); manetteXY.relacher(); manetteRot.relacher();
  if (!S.urgence.actif && S.transport?.connecte) S.transport.envoyer(encoderStop(), { priorite: true });
  vibrer(15);
});

// -- Vitesse : « lent / normal / rapide / max », comme une voiture radiocommandée --
// Le choix règle la vitesse maximale du rover en m/s (v_max) ET la vitesse qu'il s'autorise quand la voie
// est libre (v_rapide : sinon il dépasserait le choix), et la rotation (w_max) en proportion.
const texteVitesse = (v) => `${v.toFixed(2).replace('.', ',')} m/s`;

/** Envoie les paramètres de vitesse au rover : v_max, v_rapide, w_max (et 100 % : c'est v_max qui décide). */
let envoiVitesse = null;
function envoyerVitesse(maintenant = false) {
  clearTimeout(envoiVitesse);
  const envoyer = () => { for (const c of commandesVitesse(PREF.vitesse)) envoyerTexte(c, { silencieux: true }); };
  if (maintenant) envoyer(); else envoiVitesse = setTimeout(envoyer, 250);
}
function regleVitesse(v, envoyer = true) {
  v = limiterVitesse(v);
  PREF.vitesse = v; stocker('vitesse_ms', String(v));
  $('#vitesse').value = v;
  poserTexte($('#vitesse-val'), texteVitesse(v));
  poserTexte($('#vitesse-pilotage'), texteVitesse(v));
  poserTexte($('#bar-vmax'), `max ${v.toFixed(2).replace('.', ',').replace(/0$/, '')}`);
  $$('#seg-vitesse button').forEach((b) => b.classList.toggle('actif', Math.abs(Number(b.dataset.v) - v) < 0.005));
  if (envoyer) envoyerVitesse();
}
$$('#seg-vitesse button').forEach((b) => b.addEventListener('click', () => { regleVitesse(Number(b.dataset.v)); vibrer(10); }));
$('#vitesse').addEventListener('input', (ev) => regleVitesse(Number(ev.target.value)));
regleVitesse(PREF.vitesse, false);

// -- Tiroir des réglages rapides (vitesse, sécurités, couches, écrans) : fermé par défaut --
function tiroir(ouvert) {
  $('#tiroir').hidden = !ouvert;
  $('#btn-poignee').setAttribute('aria-expanded', String(ouvert));
  $('#btn-poignee .ico-slot').innerHTML = icone(ouvert ? 'chevronBas' : 'chevronHaut', 22);
  if (ouvert) { majSecurites(); fermerMenusFlottants(); }
  placerEchelle();
}
const basculerTiroir = () => { tiroir($('#tiroir').hidden); vibrer(8); };
$('#btn-poignee').addEventListener('click', basculerTiroir);
$('.stat-vit').addEventListener('click', basculerTiroir);
// Poser un doigt sur une manette, ou toucher la carte, referme le tiroir : on veut conduire, pas régler.
for (const id of ['#zone-xy', '#zone-rot']) $(id).addEventListener('pointerdown', () => { if (!$('#tiroir').hidden) tiroir(false); }, true);
$('#carte').addEventListener('pointerdown', () => { if (!$('#tiroir').hidden) tiroir(false); });

// -- Inclinaison --
const incl = new Inclinaison();
const padIncl = $('#manette-incl');
const zoneXY = $('#zone-xy');
$('#incl-zone').value = incl.zoneMorteDeg; $('#incl-plein').value = incl.pleinDeg;
$('#incl-zone-val').textContent = `${incl.zoneMorteDeg}°`; $('#incl-plein-val').textContent = `${incl.pleinDeg}°`;

function majInclinaison() {
  const v = incl.valeurs();
  pilote.maj('inclinaison', { x: v.x, y: v.y });
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
  incl.maintenu = true;
  pilote.definirContact('inclinaison', true);
  journal.noterDoigt(performance.now(), SOURCES_DOIGT.inclinaison, ACTIONS_DOIGT.appui, 0, 0);
  majInclinaison(); vibrer(8);
});
const lacherPad = () => {
  if (!incl.maintenu) return;
  incl.maintenu = false; zoneXY.classList.remove('active');
  pilote.definirContact('inclinaison', false);
  journal.noterDoigt(performance.now(), SOURCES_DOIGT.inclinaison, ACTIONS_DOIGT.relache, 0, 0);
  pilote.maj('inclinaison', { x: 0, y: 0 });
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
  if (!actif) pilote.maj('inclinaison', { x: 0, y: 0 });
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
  journal.noterVisibilite(performance.now(), !document.hidden);
  if (document.hidden) {
    pilote.toutArreter(); manetteXY.relacher(); manetteRot.relacher();
    if (S.transport?.connecte && !S.urgence.actif) S.transport.envoyer(encoderStop());
    stockageJournal.sauvegarder();
  }
});

// -- Sécurités obstacles : interrupteur (param reflexe + param carte_on), état lu sur le rover --
const ETIQUETTES_SECURITES = {
  actives: 'actives', coupees: 'COUPÉES', partielles: 'à moitié coupées', inconnu: 'en attente du rover…',
};
let minuterieSecurites = null;

function majSecurites() {
  const connecte = !!S.transport?.connecte;
  let etat = connecte ? etatSecurites(reglages.params) : 'inconnu';
  if (connecte && etat === 'inconnu' && reglages.params.size > 0 && performance.now() - (S.tConnexion ?? 0) > 3500) etat = 'absent';
  const sw = $('#sw-securites');
  const coupees = etat === 'coupees' || etat === 'partielles';
  sw.setAttribute('aria-checked', String(!coupees));
  sw.disabled = !connecte || etat === 'inconnu' || etat === 'absent' || S.securitesEnCours;
  poserTexte($('#securites-detail'), etat === 'absent' ? 'non disponible sur ce rover' : S.securitesEnCours ? 'vérification…' : (ETIQUETTES_SECURITES[etat] ?? ''));
  const bandeau = $('#bandeau-securites');
  bandeau.hidden = !coupees;
  $('#poignee-alerte').hidden = !coupees;
  $('#vit-alerte').hidden = !coupees;
  if (coupees) {
    poserTexte($('#bandeau-texte'), etat === 'partielles'
      ? "Sécurités obstacles À MOITIÉ COUPÉES : le rover freine moins bien devant un mur"
      : "MODE RADIOCOMMANDE : sécurités coupées, aucun freinage devant un mur");
  }
  majPwm();
  const swRef = $('#sw-reflexe');
  const valReflexe = connecte ? reglages.params.get('reflexe')?.valeur : undefined;
  const refDispo = typeof valReflexe === 'number';
  const refActif = !refDispo || valReflexe >= 0.5;
  swRef.setAttribute('aria-checked', String(refActif));
  swRef.disabled = !connecte || !refDispo;
  poserTexte($('#reflexe-aide'), !connecte || !refDispo
    ? 'En attente du rover (paramètre reflexe)… Coupé, le rover ne freine plus tout seul devant un obstacle.'
    : refActif
      ? 'Actif : le rover ralentit et s’arrête devant un obstacle vu par le sonar. Coupé, il ne freine plus tout seul devant un obstacle.'
      : 'Coupé : le rover ne freine plus tout seul devant un obstacle.');
}

// -- Puissance des moteurs (param pwm_max) : lue à la connexion, envoyée au relâchement du curseur --
function majPwm() {
  const curseur = $('#pwm-max');
  const v = S.transport?.connecte ? lirePwmMax(reglages.params) : null;
  if (v !== null && document.activeElement !== curseur) curseur.value = String(v);
  curseur.disabled = v === null;
  poserTexte($('#pwm-val'), v === null ? '—' : String(v));
}
$('#pwm-max').addEventListener('input', () => poserTexte($('#pwm-val'), $('#pwm-max').value));
$('#pwm-max').addEventListener('change', () => {
  if (!S.transport?.connecte) return;
  envoyerTexte(commandePwmMax($('#pwm-max').value), { silencieux: true });
  setTimeout(() => envoyerTexte('params', { silencieux: true }), 250); // on relit la valeur réelle
});

/** Un paramètre arrive du rover : on s'en sert pour afficher l'état réel, et pour la remise en service à la connexion. */
function surParamRecu(p) {
  if (p.nom === 'pwm_max') { majPwm(); return; }
  if (p.nom !== 'reflexe' && p.nom !== 'carte_on') return;
  if (S.verifSecurites && p.valeur < 0.5) {
    envoyerTexte(`param ${p.nom} 1`, { silencieux: true });
    clearTimeout(S.relireParams); S.relireParams = setTimeout(() => envoyerTexte('params', { silencieux: true }), 1500);
    afficherToast('evt', 'Sécurités obstacles remises en service');
  }
  majSecurites();
}

function basculerSecurites(actives) {
  if (!S.transport?.connecte || S.securitesEnCours) return;
  const v = actives ? 1 : 0;
  S.verifSecurites = false; // un choix volontaire n'est jamais « corrigé »
  S.securitesEnCours = true;
  majSecurites();
  for (const nom of ['reflexe', 'carte_on']) envoyerTexte(`param ${nom} ${v}`, { silencieux: true });
  setTimeout(() => envoyerTexte('params', { silencieux: true }), 250); // on relit l'état réel, on ne le suppose pas
  clearTimeout(minuterieSecurites);
  minuterieSecurites = setTimeout(() => {
    S.securitesEnCours = false;
    const etat = etatSecurites(reglages.params);
    const bon = actives ? etat === 'actives' : etat === 'coupees';
    if (!bon) afficherToast('err', "Le rover n'a pas confirmé le changement des sécurités");
    majSecurites();
  }, 1800);
  vibrer(actives ? 15 : [40, 40, 40]);
}
$('#sw-securites').addEventListener('click', () => basculerSecurites($('#sw-securites').getAttribute('aria-checked') !== 'true'));
$('#btn-securites-remettre').addEventListener('click', () => basculerSecurites(true));
$('#sw-reflexe').addEventListener('click', () => {
  if (!S.transport?.connecte) return;
  const actif = $('#sw-reflexe').getAttribute('aria-checked') !== 'true';
  S.verifSecurites = false;
  envoyerTexte(`param reflexe ${actif ? 1 : 0}`, { silencieux: true });
  setTimeout(() => envoyerTexte('params', { silencieux: true }), 250);
  vibrer(actif ? 15 : [35, 35, 35]);
});
majSecurites();

// -- Figures de conduite : orbite, pivot, diagonale, carré, huit ; jouées tant qu'on maintient le doigt (figures.js) --
// Les limites sont celles que le rover reçoit avec le réglage de vitesse : 100 % = v_max, rotation = w_max.
initFigures({
  pilote, estConnecte: () => !!S.transport?.connecte,
  limites: () => ({ vMax: PREF.vitesse, wMax: rotationPour(PREF.vitesse) }),
  fermerTiroir: () => tiroir(false), vibrer, afficherToast,
});

// -- Patrouille par points : on touche jusqu'à 6 points sur la carte, numérotés, puis « Lancer » --
const patrouille = new Patrouille();
const patrouilleDispo = () => S.modes.includes('patrouille');

function majPatrouille() {
  carte.etapes = patrouille.points;
  carte.invalide = true;
  const dispo = patrouilleDispo();
  const bouton = $('#btn-patrouille');
  bouton.disabled = !dispo || !S.transport?.connecte;
  const aide = $('#patrouille-aide');
  aide.hidden = dispo;
  aide.textContent = dispo ? '' : 'Pas sur ce firmware.';
  bouton.title = dispo ? '' : 'Pas sur ce firmware.';
  const n = patrouille.points.length;
  poserTexte($('#patrouille-texte'), n === 0 ? `Touchez jusqu'à ${MAX_POINTS} points sur la carte.`
    : n < MIN_POINTS ? `Point 1 posé : ajoutez-en au moins un autre.`
      : patrouille.pleine ? `${n} points : c'est complet. Lancez la patrouille.` : `${n} points posés (${MAX_POINTS} au plus).`);
  $('#pat-lancer').disabled = !patrouille.lancable || !dispo || S.urgence.actif;
  $('#pat-annuler').disabled = n === 0;
  $('#pat-effacer').disabled = n === 0;
}
function ouvrirPatrouille() {
  if (!patrouilleDispo()) { afficherToast('err', "Ce rover ne propose pas encore la patrouille"); return; }
  S.avantPatrouille = S.vue === 'carte' ? 'pilotage' : S.vue;
  patrouille.actif = true; patrouille.effacer(); S.enPatrouille = false;
  allerA('carte'); // la carte seule : les manettes sont masquées pendant qu'on pose les points
  $('#patrouille').hidden = false;
  majPatrouille();
}
function fermerPatrouille(retour = true) {
  patrouille.actif = false;
  $('#patrouille').hidden = true;
  if (retour) allerA(S.avantPatrouille ?? 'pilotage');
  majPatrouille();
}
$('#btn-patrouille').addEventListener('click', ouvrirPatrouille);
$('#pat-annuler').addEventListener('click', () => { patrouille.annulerDernier(); majPatrouille(); });
$('#pat-effacer').addEventListener('click', () => { patrouille.effacer(); majPatrouille(); });
$('#pat-fermer').addEventListener('click', () => { patrouille.effacer(); fermerPatrouille(); });
$('#pat-lancer').addEventListener('click', () => {
  const commande = patrouille.commande();
  if (!commande) return;
  if (envoyerTexte(commande)) {
    afficherToast('evt', `Patrouille lancée : ${patrouille.points.length} points`);
    vibrer(15);
    fermerPatrouille(); // les points restent affichés tant que la patrouille tourne
  }
});
majPatrouille();

// -- Semi-veille : « veille <secondes> » (0 = jamais) --
function envoyerVeille(secondes) {
  const s = Math.max(0, Math.min(3600, Math.round(Number(secondes))));
  if (!Number.isFinite(s)) return;
  if (envoyerTexte(`veille ${s}`)) {
    $$('#seg-veille button').forEach((b) => b.classList.toggle('actif', Number(b.dataset.s) === s));
    $('#veille-s').value = $$('#seg-veille button').some((b) => Number(b.dataset.s) === s) ? '' : s;
    afficherToast('evt', s > 0 ? `Veille après ${s} s sans rien faire` : 'Veille désactivée');
  }
}
$$('#seg-veille button').forEach((b) => b.addEventListener('click', () => envoyerVeille(b.dataset.s)));
$('#veille-ok').addEventListener('click', () => { if ($('#veille-s').value !== '') envoyerVeille($('#veille-s').value); });

// -- Matériel du rover : diagnostic lisible et étendu pour Rust, à la demande --
function afficherMateriel() {
  const boite = $('#b-materiel-boite');
  const detailsEl = $('#b-materiel-details');
  if (!S.materiel) {
    poserTexte($('#b-materiel'), 'Pas encore demandé.');
    boite.classList.remove('inquietant');
    detailsEl.hidden = true;
    detailsEl.textContent = '';
    return;
  }
  const diag = diagnosticMateriel(S.materiel, S.acquisition, S.profils, { acqBrut: S.acqBrut, nav: S.nav, liaison: S.liaison });
  poserTexte($('#b-materiel'), diag.resume || 'Réponse du rover illisible.');
  boite.classList.toggle('inquietant', diag.alerte);
  detailsEl.textContent = '';
  if (diag.details.length > 0) {
    for (const d of diag.details) {
      const div = document.createElement('div');
      div.className = `materiel-item${d.alerte ? ' alerte' : ''}`;
      const dt = document.createElement('dt');
      dt.textContent = d.libelle;
      const dd = document.createElement('dd');
      dd.textContent = d.valeur;
      div.append(dt, dd);
      detailsEl.append(div);
    }
    detailsEl.hidden = false;
  } else {
    detailsEl.hidden = true;
  }
}
$('#btn-materiel').addEventListener('click', () => {
  if (!S.transport?.connecte) { poserTexte($('#b-materiel'), 'Pas de liaison avec le rover.'); return; }
  poserTexte($('#b-materiel'), 'Demande en cours…');
  envoyerTexte('materiel', { silencieux: true });
  if (S.profil.famille === 'rust') envoyerTexte('liaison', { silencieux: true });
});

// -- Essai « qualité de la liaison » (50 trames écho 0x12 ou PING) --
const essaiQualite = new EssaiQualiteLiaison({
  envoyer: (trame) => S.transport?.envoyer(trame) ?? false,
  surProgres: ({ envoyees, recues, total, mode }) => {
    const etiqu = mode === 'echo' ? 'écho' : 'PING';
    poserTexte($('#b-qualite-resultat'), `Essai ${etiqu} en cours : ${envoyees}/${total} envoyées (${recues} reçues)…`);
  },
  surFin: (r) => {
    const etiqu = r.mode === 'echo' ? 'écho 0x12' : 'PING';
    const med = r.medianeMs === null ? 'aucune réponse' : `médiane ${String(r.medianeMs).replace('.', ',')} ms (min ${String(r.minMs).replace('.', ',')} / max ${String(r.maxMs).replace('.', ',')} ms)`;
    poserTexte($('#b-qualite-resultat'), `${med} · pertes : ${r.pertes}/${r.envoyees} (${r.tauxPertesPct} %) · ${etiqu}`);
    $('#b-qualite-boite').classList.toggle('inquietant', r.pertes > 5 || r.medianeMs === null);
    appliquerProfilUI();
  },
});
$('#btn-qualite-liaison').addEventListener('click', () => {
  if (!S.transport?.connecte) { poserTexte($('#b-qualite-resultat'), 'Pas de liaison avec le rover.'); return; }
  const mode = S.profil.capacites.bancEcho ? 'echo' : 'ping';
  $('#b-qualite-boite').classList.remove('inquietant');
  essaiQualite.demarrer({ mode, total: 50 });
  appliquerProfilUI();
});

// -- Réglages Rust : nom du rover, enregistrement flash, réglages d'usine --
function afficherRetour(sel, texte, niveau = '') {
  const el = $(sel);
  el.textContent = texte;
  el.className = `retour-rover${niveau ? ` ${niveau}` : ''}`;
  el.hidden = !texte;
}
function reinitialiserRetoursReglages() {
  afficherRetour('#params-retour', '');
  afficherRetour('#rover-nom-retour', '');
  afficherRetour('#maj-retour', '');
  $('#rover-nom-aide').hidden = true;
  $('#maj-progres').hidden = true;
  $('#maj-barre').style.width = '0%';
  fermerConfirmationUsine();
}

function majAffichageMajRover() {
  const connecte = !!S.transport?.connecte;
  const dispo = connecte && S.profil.capacites.majSansFil;
  if (!connecte) {
    poserTexte($('#maj-etat-ligne'), 'Connectez-vous au rover pour envoyer une mise à jour .maj.');
  } else if (!dispo) {
    poserTexte($('#maj-etat-ligne'), 'Mise à jour sans fil absente sur ce firmware.');
  } else if (S.majEtatRover) {
    const e = S.majEtatRover;
    const crcTxt = S.majBrut?.crc ?? e.crc ?? '—';
    poserTexte($('#maj-etat-ligne'), `État du chargeur : etat=${e.etat ?? '?'}, taille=${e.taille ?? 0} o, crc=${crcTxt}.`);
  } else {
    poserTexte($('#maj-etat-ligne'), 'Prêt : choisissez un fichier .maj (brut v2 pour Rust, compressé pour MicroPython).');
  }
  $('#maj-fichier').disabled = pilotageMaj.enCours;
  $('#btn-maj-lancer').disabled = !dispo || !S.paquetMaj || pilotageMaj.enCours;
  $('#btn-maj-annuler').hidden = !pilotageMaj.enCours;
  $('#btn-redemarrer').disabled = !connecte || pilotageMaj.enCours;
}

function verifierMajApresReconnexion(force = false) {
  if (!S.majAttenteVerif) return;
  if (!force && (!S.infoRecue || !S.majEtatRover)) return;
  clearTimeout(timerVerifMaj);
  const res = verifierApresRedemarrage({
    entete: S.majAttenteVerif,
    majLigne: S.majEtatRover,
    majBrut: S.majBrut,
    materiel: S.materiel,
    version: S.profil.version,
  });
  if (res.statut === 'attente' && !force) return;
  S.majAttenteVerif = null;
  const niv = res.statut === 'ok' ? 'ok' : 'err';
  afficherRetour('#maj-retour', res.message, niv);
  noter(niv === 'ok' ? 'evt' : 'err', res.message);
}

$('#maj-fichier').addEventListener('change', async (ev) => {
  const fichier = ev.target.files?.[0];
  S.paquetMaj = null;
  if (!fichier) { $('#maj-info').hidden = true; majAffichageMajRover(); return; }
  try {
    const octets = new Uint8Array(await fichier.arrayBuffer());
    const entete = lireEnteteMaj(octets);
    S.paquetMaj = { octets, entete, nom: fichier.name };
    const carteTxt = entete.carte ? ` · carte ${entete.carte}` : '';
    const crcHex = entete.crcBrut.toString(16).padStart(8, '0');
    const compat = verifierCompatibilitePaquet(entete, { famille: S.profil.famille, carteCible: S.info?.carte ?? '' });
    $('#maj-info').hidden = false;
    poserTexte($('#maj-info'), `${fichier.name} — format v${entete.version}, ${Math.round(entete.tailleBrute / 1024)} Ko, CRC ${crcHex}${carteTxt}${compat.ok ? '' : ` · ⚠ ${compat.message}`}`);
    if (!compat.ok) afficherRetour('#maj-retour', compat.message, 'err');
    else afficherRetour('#maj-retour', '');
  } catch (err) {
    $('#maj-info').hidden = true;
    afficherRetour('#maj-retour', err.message || 'Fichier .maj invalide', 'err');
  }
  majAffichageMajRover();
});

$('#btn-maj-lancer').addEventListener('click', async () => {
  if (!S.transport?.connecte || !S.paquetMaj) return;
  const compat = verifierCompatibilitePaquet(S.paquetMaj.entete, { famille: S.profil.famille, carteCible: S.info?.carte ?? '' });
  if (!compat.ok) { afficherRetour('#maj-retour', compat.message, 'err'); return; }
  if (S.urgence.actif) { afficherRetour('#maj-retour', "Désactivez l'arrêt d'urgence avant la mise à jour.", 'err'); return; }
  const enMouvement = () => !!(S.etat?.flags?.mouvement || (S.etat?.vitesse ?? 0) > 2);
  if (enMouvement()) {
    afficherRetour('#maj-retour', 'Arrêtez complètement le rover avant de lancer la mise à jour.', 'err');
    return;
  }
  $('#maj-progres').hidden = false;
  $('#maj-barre').style.width = '0%';
  poserTexte($('#maj-progres-texte'), '0 %');
  afficherRetour('#maj-retour', 'Envoi de la mise à jour…');
  majAffichageMajRover();
  const PHASES = {
    debut: 'Initialisation…', envoi: 'Transfert…', verification: 'Vérification du paquet…',
    installation: 'Programmation…', redemarrage: 'Redémarrage du rover…',
  };
  try {
    S.majAttenteVerif = S.paquetMaj.entete;
    const tailleBloc = tailleBlocPourMtu(S.transport.mtu);
    const entete = await pilotageMaj.executer(S.paquetMaj.octets, {
      tailleBloc,
      enMouvement,
      surProgres: ({ phase, confirme, total, debitKoS }) => {
        const pct = total > 0 ? Math.min(100, Math.round((confirme * 100) / total)) : 0;
        $('#maj-barre').style.width = `${pct}%`;
        poserTexte($('#maj-progres-texte'), `${pct} %`);
        const deb = debitKoS > 0 ? ` (${debitKoS.toFixed(1).replace('.', ',')} Ko/s)` : '';
        afficherRetour('#maj-retour', `${PHASES[phase] ?? 'Mise à jour…'}${deb}`);
      },
    });
    S.majAttenteVerif = entete;
    afficherRetour('#maj-retour', 'Paquet installé : redémarrage du rover en cours…', 'ok');
  } catch (err) {
    S.majAttenteVerif = null;
    afficherRetour('#maj-retour', err.message || 'Échec de la mise à jour', 'err');
  } finally {
    majAffichageMajRover();
  }
});

$('#btn-maj-annuler').addEventListener('click', () => {
  pilotageMaj.annuler();
  majAffichageMajRover();
});

$('#btn-redemarrer').addEventListener('click', () => {
  if (!S.transport?.connecte) { afficherToast('err', 'Pas de liaison avec le rover'); return; }
  if (envoyerTexte('redemarrer')) afficherRetour('#maj-retour', 'Redémarrage demandé…');
});
function fermerConfirmationUsine() {
  $('#btn-params-usine').hidden = false;
  $('#btn-params-usine-confirmer').hidden = true;
  $('#btn-params-usine-annuler').hidden = true;
}

$('#btn-params-sauver').addEventListener('click', () => {
  if (!S.profil.capacites.sauverParams) { afficherToast('err', 'Pas sur ce firmware'); return; }
  fermerConfirmationUsine();
  afficherRetour('#params-retour', 'Enregistrement demandé…');
  envoyerTexte('params sauver');
});
$('#btn-params-usine').addEventListener('click', () => {
  if (!S.profil.capacites.reglagesUsine) { afficherToast('err', 'Pas sur ce firmware'); return; }
  $('#btn-params-usine').hidden = true;
  $('#btn-params-usine-confirmer').hidden = false;
  $('#btn-params-usine-annuler').hidden = false;
});
$('#btn-params-usine-annuler').addEventListener('click', fermerConfirmationUsine);
$('#btn-params-usine-confirmer').addEventListener('click', () => {
  fermerConfirmationUsine();
  afficherRetour('#params-retour', 'Restauration demandée…');
  envoyerTexte('params usine');
});

$('#rover-nom-saisie').addEventListener('input', () => {
  const saisie = $('#rover-nom-saisie').value;
  const aide = $('#rover-nom-aide');
  if (!saisie) { aide.hidden = true; return; }
  const r = validerNomRover(saisie);
  aide.hidden = r.valide;
  if (!r.valide) poserTexte(aide, r.erreur);
});
$('#btn-nom-envoyer').addEventListener('click', () => {
  if (!S.profil.capacites.changementNom) { afficherToast('err', 'Pas sur ce firmware'); return; }
  const r = validerNomRover($('#rover-nom-saisie').value);
  const aide = $('#rover-nom-aide');
  if (!r.valide) {
    aide.hidden = false;
    poserTexte(aide, r.erreur);
    return;
  }
  aide.hidden = true;
  envoyerTexte(r.commande);
});
$('#btn-nom-origine').addEventListener('click', () => {
  if (!S.profil.capacites.changementNom) { afficherToast('err', 'Pas sur ce firmware'); return; }
  $('#rover-nom-aide').hidden = true;
  envoyerTexte('nom -');
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

/** Les écrans ; « carte » est l'écran de pilotage sans les manettes (carte seule, toucher pour envoyer le rover). */
const SECTION_DE = { carte: 'pilotage' };
function allerA(nom) {
  S.vue = nom;
  $('#app').dataset.vue = nom;
  const section = SECTION_DE[nom] ?? nom;
  $$('.vue').forEach((v) => v.classList.toggle('actif', v.id === `vue-${section}`));
  $$('.onglets button, .menu-lateral > button[data-vue]').forEach((b) => {
    const actif = b.dataset.vue === nom;
    b.classList.toggle('actif', actif);
    if (actif) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  tiroir(false);
  fermerMenusFlottants();
  if (patrouille.actif && nom !== 'carte') { patrouille.actif = false; $('#patrouille').hidden = true; majPatrouille(); }
  if (section === 'pilotage') { carte.demarrer(); carte.redimensionner(); placerEchelle(); } else { carte.arreter(); manetteXY.relacher(); manetteRot.relacher(); }
  if (nom === 'bord') { bord.demarrer(); if (S.etat) bord.majEtat(S.etat, S.modes, carte.positionAbsolue(S.etat) ?? undefined, suiviTension.minimum); } else bord.arreter();
  if (nom === 'partage') montrerPartage();
  if (nom === 'reglages' && S.transport?.connecte && reglages.params.size === 0) envoyerTexte('params', { silencieux: true });
}
document.addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-vue], button[data-vue-lien]');
  if (!b) return;
  const nom = b.dataset.vueLien ?? b.dataset.vue;
  allerA(nom);
});

// -- Menu latéral (paysage) : replié ou ouvert, mémorisé --
function reglerMenu(ouvert, memoriser = true) {
  $('#app').dataset.menu = ouvert ? 'ouvert' : 'ferme';
  if (memoriser) stocker('menu', ouvert ? '1' : '0');
  requestAnimationFrame(() => { carte.redimensionner(); placerEchelle(); });
}
$('#btn-menu-replier').addEventListener('click', () => reglerMenu(false));
$('#btn-menu-ouvrir').addEventListener('click', () => { if (paysage.matches) reglerMenu(true); });
reglerMenu(lire('menu') !== '0', false);

// -- Menu du rover (nom + chevron) : Se connecter / Démo / Se déconnecter --
function majMenuRover() {
  const connecte = !!S.transport && S.transport.etat !== 'deconnecte';
  $('#mr-deconnecter').hidden = !connecte;
}
function fermerMenusFlottants() {
  for (const [menu, bouton] of [['#menu-rover', '#btn-liaison'], ['#menu-couches', '#btn-couches']]) {
    $(menu).hidden = true; $(bouton).setAttribute('aria-expanded', 'false');
  }
}
function basculerMenu(menu, bouton) {
  const ouvrir = $(menu).hidden;
  fermerMenusFlottants();
  $(menu).hidden = !ouvrir;
  $(bouton).setAttribute('aria-expanded', String(ouvrir));
}
$('#btn-liaison').addEventListener('click', (ev) => { ev.stopPropagation(); majMenuRover(); basculerMenu('#menu-rover', '#btn-liaison'); });
$('#btn-couches').addEventListener('click', (ev) => { ev.stopPropagation(); basculerMenu('#menu-couches', '#btn-couches'); });
document.addEventListener('click', (ev) => { if (!ev.target.closest('.menu-flottant')) fermerMenusFlottants(); });
$('#mr-connecter').addEventListener('click', () => { fermerMenusFlottants(); ouvrirConnexion(); });
$('#mr-demo').addEventListener('click', () => { fermerMenusFlottants(); utiliserTransport(new TransportDemo({ firmware: 'rust' })); });
$('#mr-demo-mpy').addEventListener('click', () => { fermerMenusFlottants(); utiliserTransport(new TransportDemo({ firmware: 'micropython' })); });
$('#mr-deconnecter').addEventListener('click', () => { fermerMenusFlottants(); S.transport?.deconnecter(); });

// -- Couches de la carte : carte, trace, échos du sonar, chemin, base --
const COUCHES = [['carte', 'Carte'], ['trace', 'Trace'], ['echos', 'Échos du sonar'], ['chemin', 'Chemin'], ['base', 'Base']];
function poserCouche(nom, visible) {
  carte.couches[nom] = visible;
  carte.invalide = true;
  stocker(`couche_${nom}`, visible ? '1' : '0');
  for (const el of $$(`[data-couche="${nom}"]`)) {
    if (el.tagName === 'INPUT') el.checked = visible; else el.setAttribute('aria-pressed', String(visible));
  }
}
for (const [nom, libelle] of COUCHES) {
  const ligne = document.createElement('label');
  ligne.innerHTML = '<input type="checkbox" data-couche="' + nom + '"><span></span>';
  $('span', ligne).textContent = libelle;
  $('input', ligne).addEventListener('change', (ev) => poserCouche(nom, ev.target.checked));
  $('#menu-couches').append(ligne);
  const chip = document.createElement('button');
  chip.type = 'button'; chip.className = 'chip-couche'; chip.dataset.couche = nom; chip.textContent = libelle;
  chip.addEventListener('click', () => poserCouche(nom, !carte.couches[nom]));
  $('#tiroir-couches').append(chip);
  poserCouche(nom, lire(`couche_${nom}`) !== '0');
}

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
$('#cx-demo').addEventListener('click', () => { fermerFeuilles(); utiliserTransport(new TransportDemo({ firmware: 'rust' })); });
$('#cx-demo-mpy').addEventListener('click', () => { fermerFeuilles(); utiliserTransport(new TransportDemo({ firmware: 'micropython' })); });
$('#cx-deconnecter').addEventListener('click', () => { fermerFeuilles(); S.transport?.deconnecter(); });

// ============================================================================
// 15. Démarrage
// ============================================================================

const parametres = new URLSearchParams(location.search);
const simUrl = parametres.get('sim');
$('#cx-ws').value = simUrl ?? lire('ws') ?? '';

actualiserProfil();
allerA('pilotage');
carte.redimensionner();
placerEchelle(); setTimeout(placerEchelle, 400);

if (simUrl) {
  const url = normaliserUrlWs(simUrl);
  if (url) utiliserTransport(new TransportWs(url)); else afficherToast('err', `Adresse « ${simUrl} » invalide`);
} else if (parametres.has('demo')) {
  const d = parametres.get('demo');
  utiliserTransport(new TransportDemo({
    monde: d === 'couloir' ? 'couloir' : 'salle',
    firmware: d === 'micropython' || d === 'mpy' ? 'micropython' : 'rust',
  }));
} else {
  setTimeout(ouvrirConnexion, 350); // première visite : on propose tout de suite de se connecter
}

// Fonctionnement hors ligne : le service worker garde les fichiers en cache.
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// Pour les curieux : l'objet est accessible depuis la console du navigateur (window.roveros).
window.roveros = { S, carte, pilote, reglages };
