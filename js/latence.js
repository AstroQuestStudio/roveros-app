// latence.js — la latence affichée = le temps aller-retour mesuré avec les trames PING (0x11) / PONG (0x91).
// Une trame PING part toutes les 2 s (une seule petite trame : aucune gêne pour les commandes).

import { encoderPing } from './protocole.js';

export class MesureLatence {
  /**
   * @param {object} o  envoyer(trame) : envoie la trame sur la liaison
   *                    maintenant() : horloge en ms (performance.now par défaut)
   *                    perduApresMs : sans PONG depuis ce délai, la liaison est dite « sans réponse »
   */
  constructor({ envoyer, maintenant = () => performance.now(), perduApresMs = 6000 } = {}) {
    this.envoyer = envoyer;
    this.maintenant = maintenant;
    this.perduApresMs = perduApresMs;
    this._n = 0;
    this._enAttente = new Map(); // numéro -> heure d'envoi
    this.reinitialiser();
  }

  reinitialiser() {
    this._enAttente.clear();
    this.brute = null; // dernier aller-retour mesuré, ms
    this.lissee = null; // moyenne glissante, ms
    this.dernierPong = null; // heure du dernier PONG
    this._depart = this.maintenant();
  }

  /** À appeler toutes les 2 s : envoie un PING numéroté. */
  tic() {
    this._n = (this._n + 1) & 255;
    this._enAttente.set(this._n, this.maintenant());
    if (this._enAttente.size > 16) this._enAttente.delete(this._enAttente.keys().next().value);
    this.envoyer(encoderPing(this._n));
  }

  /** Un PONG est arrivé. Renvoie le temps aller-retour en ms, ou null si ce numéro est inconnu (ou déjà reçu). */
  surPong(n) {
    const t0 = this._enAttente.get(n);
    if (t0 === undefined) return null;
    this._enAttente.delete(n);
    const maintenant = this.maintenant();
    const ms = Math.max(0, maintenant - t0);
    this.brute = ms;
    this.lissee = this.lissee === null ? ms : this.lissee * 0.6 + ms * 0.4;
    this.dernierPong = maintenant;
    return ms;
  }

  /** Latence à afficher, en ms entiers, ou null tant qu'aucune mesure n'est arrivée. */
  get ms() { return this.lissee === null ? null : Math.round(this.lissee); }

  /** Vrai si le rover ne répond plus aux PING depuis `perduApresMs`. */
  get sansReponse() {
    return this.maintenant() - (this.dernierPong ?? this._depart) > this.perduApresMs;
  }
}
