// latence.js — la latence affichée = le temps aller-retour mesuré avec les trames PING (0x11) / PONG (0x91).
// Une trame PING part toutes les 2 s (une seule petite trame : aucune gêne pour les commandes).

import { encoderPing, encoderEcho } from './protocole.js';

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

/** Calcule médiane, bornes et pertes à partir des temps aller-retour mesurés (ms). */
export function calculerQualiteLiaison(rtts, total) {
  const envoyees = Math.max(0, Number(total) || 0);
  const valides = (Array.isArray(rtts) ? rtts : [])
    .filter((v) => Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  const recues = valides.length;
  const pertes = Math.max(0, envoyees - recues);
  const tauxPertesPct = envoyees > 0 ? Math.round((pertes / envoyees) * 100) : 0;
  if (recues === 0) {
    return { envoyees, recues: 0, pertes, tauxPertesPct, medianeMs: null, minMs: null, maxMs: null };
  }
  const m = Math.floor(recues / 2);
  const mediane = recues % 2 === 1 ? valides[m] : (valides[m - 1] + valides[m]) / 2;
  return {
    envoyees,
    recues,
    pertes,
    tauxPertesPct,
    medianeMs: Math.round(mediane * 10) / 10,
    minMs: Math.round(valides[0] * 10) / 10,
    maxMs: Math.round(valides[recues - 1] * 10) / 10,
  };
}

/**
 * Essai ponctuel « qualité de la liaison » : envoie N trames (50 par défaut)
 * d'écho de banc (0x12 -> 0x92) ou PING (0x11 -> 0x91) et mesure la médiane et les pertes.
 */
export class EssaiQualiteLiaison {
  constructor({ envoyer, maintenant = () => performance.now(), surProgres, surFin } = {}) {
    this.envoyer = envoyer;
    this.maintenant = maintenant;
    this.surProgres = surProgres;
    this.surFin = surFin;
    this.actif = false;
    this.mode = 'ping';
    this.total = 50;
    this._lot = 1;
    this._envoyees = 0;
    this._enAttente = new Map();
    this._rtts = [];
    this._timerEnvoi = null;
    this._timerFin = null;
  }

  demarrer({ mode = 'echo', total = 50, intervalleMs = 45, delaiFinMs = 900 } = {}) {
    this.arreter();
    this.actif = true;
    this.mode = mode === 'echo' ? 'echo' : 'ping';
    this.total = total;
    this._lot = ((this._lot + 1) & 0xff) || 1;
    this._envoyees = 0;
    this._enAttente.clear();
    this._rtts = [];

    const envoyerSuivante = () => {
      if (!this.actif) return;
      const seq = this._envoyees;
      if (seq >= this.total) {
        clearInterval(this._timerEnvoi);
        this._timerEnvoi = null;
        this._timerFin = setTimeout(() => this._terminer(), delaiFinMs);
        return;
      }
      this._envoyees++;
      this._enAttente.set(seq, this.maintenant());
      const trame = this.mode === 'echo'
        ? encoderEcho(Uint8Array.of(this._lot, seq & 0xff))
        : encoderPing((200 + seq) & 0xff);
      this.envoyer(trame);
      this.surProgres?.({ envoyees: this._envoyees, recues: this._rtts.length, total: this.total, mode: this.mode });
    };

    envoyerSuivante();
    this._timerEnvoi = setInterval(envoyerSuivante, intervalleMs);
  }

  surEcho(donnees) {
    if (!this.actif || this.mode !== 'echo' || !donnees || donnees.length < 2) return false;
    if (donnees[0] !== this._lot) return false;
    return this._enregistrerReponse(donnees[1]);
  }

  surPong(n) {
    if (!this.actif || this.mode !== 'ping') return false;
    const seq = (n - 200 + 256) & 0xff;
    return this._enregistrerReponse(seq);
  }

  _enregistrerReponse(seq) {
    const t0 = this._enAttente.get(seq);
    if (t0 === undefined) return false;
    this._enAttente.delete(seq);
    this._rtts.push(Math.max(0, this.maintenant() - t0));
    this.surProgres?.({ envoyees: this._envoyees, recues: this._rtts.length, total: this.total, mode: this.mode });
    if (this._envoyees >= this.total && this._enAttente.size === 0) this._terminer();
    return true;
  }

  _terminer() {
    if (!this.actif) return;
    const mode = this.mode;
    const resultat = { mode, ...calculerQualiteLiaison(this._rtts, this.total) };
    this.arreter();
    this.surFin?.(resultat);
  }

  arreter() {
    this.actif = false;
    clearInterval(this._timerEnvoi);
    clearTimeout(this._timerFin);
    this._timerEnvoi = null;
    this._timerFin = null;
  }
}
