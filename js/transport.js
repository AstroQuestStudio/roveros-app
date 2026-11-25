// transport.js — classe de base commune aux trois transports (Bluetooth, WebSocket, Démo).
//
// Interface identique pour tous :
//   transport.envoyer(trame, options)   met une trame (Uint8Array) dans la file d'envoi
//   événement « trame »  : { detail: Uint8Array }  une trame reçue du rover
//   événement « etat »   : { detail: { etat, message } }
//        etat ∈ 'deconnecte' | 'connexion' | 'connecte' | 'reconnexion' | 'erreur'
//   transport.connecter() / transport.deconnecter()
//
// La file d'envoi garantit qu'on n'envoie JAMAIS plus de 25 trames par seconde
// (règle de sécurité du protocole) : une trame toutes les 41 ms au plus.

import { T } from './protocole.js';

/** Intervalle minimal entre deux écritures : 41 ms soit moins de 25 trames/s. */
export const INTERVALLE_MIN_MS = 41;
const TAILLE_MAX_FILE = 64;

export class Transport extends EventTarget {
  constructor(nom) {
    super();
    this.nom = nom; // 'ble' | 'ws' | 'demo'
    this.etat = 'deconnecte';
    this._file = [];
    this._minuterie = null;
    this._dernierEnvoi = -Infinity;
    this.envoyees = 0; // compteur, pratique pour les tests et le diagnostic
  }

  get connecte() { return this.etat === 'connecte'; }

  /** Change l'état de la liaison et prévient l'application. */
  _changerEtat(etat, message = '') {
    if (etat === this.etat && !message) return;
    this.etat = etat;
    if (etat !== 'connecte') this._file.length = 0; // jamais d'ancien ordre après une coupure
    this.dispatchEvent(new CustomEvent('etat', { detail: { etat, message } }));
  }

  /** Signale à l'application une trame reçue. */
  _recevoir(octets) {
    this.dispatchEvent(new CustomEvent('trame', { detail: octets }));
  }

  /**
   * Met une trame dans la file.
   *  - options.priorite : la trame passe devant les autres (arrêt d'urgence, stop).
   *  - options.cle      : une trame de même clé déjà en attente est remplacée
   *                       (pour les MANETTE : seule la plus récente compte).
   * Renvoie false si la liaison n'est pas établie.
   */
  envoyer(trame, options = {}) {
    if (!this.connecte) return false;
    const type = trame[0];
    const priorite = options.priorite ?? (type === T.URGENCE || type === T.STOP);
    const cle = options.cle ?? (type === T.MANETTE ? 'manette' : null);
    if (cle) {
      const i = this._file.findIndex((e) => e.cle === cle);
      if (i >= 0) this._file.splice(i, 1);
    }
    const element = { trame, cle, tentatives: 0 };
    if (priorite) this._file.unshift(element);
    else this._file.push(element);
    // File trop longue (liaison lente) : on abandonne les plus anciennes, sauf les prioritaires.
    while (this._file.length > TAILLE_MAX_FILE) {
      const i = this._file.findIndex((e) => e.trame[0] !== T.URGENCE && e.trame[0] !== T.STOP);
      this._file.splice(i < 0 ? 0 : i, 1);
    }
    this._pomper();
    return true;
  }

  /** Vide la file d'envoi (utile quand on verrouille l'arrêt d'urgence). */
  viderFile() { this._file.length = 0; }

  _pomper() {
    if (this._minuterie !== null || this._file.length === 0) return;
    const attente = Math.max(0, this._dernierEnvoi + INTERVALLE_MIN_MS - performance.now());
    this._minuterie = setTimeout(async () => {
      this._minuterie = null;
      const element = this._file.shift();
      if (!element) return;
      this._dernierEnvoi = performance.now();
      try {
        await this._ecrire(element.trame);
        this.envoyees++;
      } catch (erreur) {
        // Un ordre vital (urgence, stop) est retenté ; le reste est abandonné (le suivant arrive vite).
        const vital = element.trame[0] === T.URGENCE || element.trame[0] === T.STOP;
        if (vital && element.tentatives < 5 && this.connecte) {
          element.tentatives++;
          this._file.unshift(element);
        }
        this._erreurEcriture(erreur);
      }
      this._pomper();
    }, attente);
  }

  /** À redéfinir : écrit réellement une trame sur la liaison. */
  async _ecrire() { throw new Error('non implémenté'); }

  /** À redéfinir si besoin : une écriture a échoué. */
  _erreurEcriture() {}

  async connecter() { throw new Error('non implémenté'); }
  async deconnecter() {}
}
