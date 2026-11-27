// transport-demo.js — le transport « Démo » : le faux rover vit dans la page.
// Même interface que le Bluetooth et le WebSocket, donc l'application ne voit pas la différence.
// Simule aussi un bref trou de liaison et alimente le journal avec un exemple lisible (plafond + trou).

import { Transport } from './transport.js';
import { FauxRover } from './faux-rover.js';
import { encoderManette, encoderEtat, encoderStop, assemblerDrapeaux } from './protocole.js';

const PAS_MS = 50; // le faux rover avance par pas de 50 ms (20 Hz)

export class TransportDemo extends Transport {
  /** @param {object} o  monde : 'salle' (3 m) ou 'couloir' (12 m), firmware : 'rust' | 'micropython' | 'demo' */
  constructor({ monde = 'salle', firmware = 'rust' } = {}) {
    super('demo');
    this.monde = monde;
    this.firmware = firmware;
    this.rover = null;
    this._horloge = null;
    this._accueilTimer = null;
    this._trouTimer = null;
    this._redemTimer = null;
    this._dernier = 0;
    this._trouJusqua = 0;
    this._trouFait = false;
  }

  async connecter() {
    clearTimeout(this._accueilTimer);
    clearTimeout(this._trouTimer);
    clearTimeout(this._redemTimer);
    this._changerEtat('connexion', 'Démarrage du rover simulé…');
    this.rover = new FauxRover({
      monde: this.monde,
      firmware: this.firmware,
      fenetre: this.monde === 'couloir', // le couloir essaie la fenêtre de carte glissante
      // Les trames du faux rover arrivent comme celles d'un vrai, avec un tout petit délai.
      sortie: (trame) => queueMicrotask(() => {
        if (this.etat !== 'connecte') return;
        if (performance.now() < this._trouJusqua) return; // simule un trou de liaison bref
        this._recevoir(trame);
      }),
      planifier: (fn, ms) => setTimeout(() => { if (this.etat === 'connecte') fn(); }, ms),
      surRedemarrage: (info) => this._simulerRedemarrage(info),
    });
    this._dernier = performance.now();
    this._trouJusqua = 0;
    this._trouFait = false;
    this._horloge = setInterval(() => this._avancer(), PAS_MS);
    const nom = this.firmware === 'rust' ? 'Démo Rust' : this.firmware === 'micropython' ? 'Démo MicroPython' : 'Rover simulé';
    this._changerEtat('connecte', nom);
    this._accueilTimer = setTimeout(() => this.rover?.accueillir(), 120);
    // À 2,2 s : simule un trou de liaison de 380 ms pour que le diagnostic de liaison soit visible.
    this._trouTimer = setTimeout(() => {
      if (this.etat === 'connecte' && !this._trouFait) {
        this._trouFait = true;
        this._trouJusqua = performance.now() + 380;
      }
    }, 2200);
  }

  /** Avance la simulation du temps réel écoulé (au plus 4 pas d'un coup si l'onglet a été figé). */
  _avancer() {
    const maintenant = performance.now();
    let pas = Math.round((maintenant - this._dernier) / PAS_MS);
    this._dernier += pas * PAS_MS;
    pas = Math.min(pas, 4);
    for (let i = 0; i < pas; i++) this.rover.pas(PAS_MS / 1000);
  }

  async deconnecter() {
    clearInterval(this._horloge);
    clearTimeout(this._accueilTimer);
    clearTimeout(this._trouTimer);
    clearTimeout(this._redemTimer);
    this._horloge = null;
    this.rover = null;
    this._changerEtat('deconnecte');
  }

  _simulerRedemarrage({ pourMaj = false, entete = null } = {}) {
    if (this.etat !== 'connecte' || !this.rover) return;
    const precedent = this.rover;
    clearInterval(this._horloge);
    clearTimeout(this._accueilTimer);
    clearTimeout(this._trouTimer);
    clearTimeout(this._redemTimer);
    this._horloge = null;
    this._changerEtat('reconnexion', pourMaj ? 'Installation et redémarrage…' : 'Redémarrage du rover…');
    this._redemTimer = setTimeout(() => {
      const majInfo = { ...precedent.majInfo };
      if (pourMaj && entete) {
        if (precedent.simulerRetourArriere) {
          majInfo.etat = 3;
          majInfo.raz = 'garde';
        } else {
          majInfo.etat = 0;
          majInfo.taille = entete.tailleBrute;
          majInfo.crc = entete.crcBrut;
          majInfo.raz = 'voulu';
        }
      } else {
        majInfo.raz = 'voulu';
      }
      this.rover = new FauxRover({
        monde: this.monde,
        firmware: precedent.rustAncien ? 'rust-ancien' : this.firmware,
        fenetre: this.monde === 'couloir',
        raz: majInfo.raz,
        simulerRetourArriere: precedent.simulerRetourArriere,
        sortie: (trame) => queueMicrotask(() => {
          if (this.etat !== 'connecte') return;
          if (performance.now() < this._trouJusqua) return;
          this._recevoir(trame);
        }),
        planifier: (fn, ms) => setTimeout(() => { if (this.etat === 'connecte') fn(); }, ms),
        surRedemarrage: (info) => this._simulerRedemarrage(info),
      });
      this.rover.majInfo = majInfo;
      this.rover.nom = precedent.nom;
      this._dernier = performance.now();
      this._horloge = setInterval(() => this._avancer(), PAS_MS);
      const nom = this.firmware === 'rust' ? 'Démo Rust' : this.firmware === 'micropython' ? 'Démo MicroPython' : 'Rover simulé';
      this._changerEtat('connecte', nom);
      this._accueilTimer = setTimeout(() => this.rover?.accueillir(), 120);
    }, 550);
  }

  async _ecrire(trame) {
    if (performance.now() < this._trouJusqua) {
      await new Promise((r) => setTimeout(r, 130)); // écriture ralentie pendant le trou simulé
    }
    this.rover?.recevoir(trame);
  }
}

/**
 * Alimente le journal avec un court épisode simulé (plafond d'obstacle + trou de liaison)
 * afin que l'écran Journal soit immédiatement démonstratif sans vrai rover.
 */
export function alimenterDemoJournal(journal, tBase = performance.now()) {
  if (!journal) return;
  let dernierT = -Infinity;
  for (const buf of [journal.envois, journal.etats, journal.champs]) {
    if (buf.total > 0) dernierT = Math.max(dernierT, buf.t[(buf.total - 1) & (buf.cap - 1)]);
  }
  if (journal.evenements.length > 0) dernierT = Math.max(dernierT, journal.evenements[journal.evenements.length - 1].t);

  // Conserve un ordre chronologique strict dans les tampons circulaires.
  const t0 = tBase - 7000 > dernierT ? tBase - 7000 : dernierT + 100;
  // 1. Plafond d'obstacle simulé : 1,2 s à 0,20 m/s alors que la consigne demande 0,60 m/s
  journal.noterChamps(t0, { plafond: 0.20, frein: 1, tension: 7.9, a_lim: 1.0, cycles: 2 });
  for (let dt = 0; dt <= 1200; dt += 67) {
    const id = journal.noterEnvoi(t0 + dt, encoderManette(0, 100, 0), 0.6, 1);
    journal.noterFinEcriture(id, true, 10);
  }
  for (let dt = 50; dt <= 1250; dt += 100) {
    journal.noterEtat(t0 + dt, {
      vitesse: 20, drapeaux: assemblerDrapeaux({ mouvement: true }),
      comportement: 0, tension: 7.9, tete: 0, sonar: 30, libre: 26, rssi: -54, x: 0, y: 0, cap: 0,
    });
  }
  journal.noterEnvoi(t0 + 1300, encoderStop(), 0.6, 0);
  journal.marquer(t0 + 900, 'Exemple démo : ralentissement devant obstacle');

  // 2. Trou de liaison simulé : écart d'envoi de 410 ms + écriture lente (145 ms) + garde
  const t1 = t0 + 3500;
  journal.noterChamps(t1 - 100, { plafond: -1, frein: 0, tension: 7.8, a_lim: 1.0, cycles: 10 });
  for (let dt = 0; dt <= 200; dt += 67) {
    const id = journal.noterEnvoi(t1 + dt, encoderManette(0, 80, 0), 0.5, 1);
    journal.noterFinEcriture(id, true, 12);
  }
  journal.noterEtat(t1 + 100, {
    vitesse: 40, drapeaux: assemblerDrapeaux({ mouvement: true }),
    comportement: 0, tension: 7.8, tete: 0, sonar: 140, libre: 140, rssi: -68, x: 0, y: 0, cap: 0,
  });
  journal.noterEtat(t1 + 520, {
    vitesse: 0, drapeaux: assemblerDrapeaux({ garde: true }),
    comportement: 0, tension: 7.8, tete: 0, sonar: 140, libre: 140, rssi: -75, x: 0, y: 0, cap: 0,
  });
  const idLent = journal.noterEnvoi(t1 + 610, encoderManette(0, 80, 0), 0.5, 1);
  journal.noterFinEcriture(idLent, true, 145);
  journal.noterEnvoi(t1 + 700, encoderStop(), 0.5, 0);
}
