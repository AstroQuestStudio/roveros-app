// transport-ws.js — WebSocket vers le simulateur sur PC (ws://hôte:8765/ws).
// Messages binaires, une trame par message. Reconnexion automatique tant que l'utilisateur le veut.

import { Transport } from './transport.js';

export const URL_WS_PAR_DEFAUT = 'ws://localhost:8765/ws';

/** Accepte « 192.168.1.5 », « hote:8765 » ou une URL complète, et renvoie une URL ws://… valide ou null. */
export function normaliserUrlWs(saisie) {
  let s = String(saisie ?? '').trim();
  if (!s) return null;
  if (!/^wss?:\/\//i.test(s)) s = `ws://${s}`;
  try {
    const u = new URL(s);
    if (!u.port) u.port = '8765';
    if (u.pathname === '/' || u.pathname === '') u.pathname = '/ws';
    return u.toString();
  } catch {
    return null;
  }
}

export class TransportWs extends Transport {
  constructor(url) {
    super('ws');
    this.url = url;
    this.socket = null;
    this._voulu = false;
    this._essais = 0;
  }

  async connecter() {
    this._voulu = true;
    this._essais = 0;
    this._ouvrir();
  }

  _ouvrir() {
    this._changerEtat(this._essais > 0 ? 'reconnexion' : 'connexion', this.url);
    let socket;
    try {
      socket = new WebSocket(this.url);
    } catch (erreur) {
      this._voulu = false;
      this._changerEtat('erreur', `Adresse invalide : ${this.url}`);
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.onopen = () => { this._essais = 0; this._changerEtat('connecte', this.url); };
    socket.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) this._recevoir(new Uint8Array(ev.data));
    };
    socket.onerror = () => { /* le détail arrive dans onclose */ };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this._voulu) { this._changerEtat('deconnecte'); return; }
      if (this._essais >= 8) {
        this._voulu = false;
        this._changerEtat('erreur', `Impossible de joindre ${this.url}. Le simulateur est-il lancé ?`);
        return;
      }
      this._essais++;
      this._changerEtat('reconnexion', `Nouvelle tentative (${this._essais}/8)…`);
      setTimeout(() => { if (this._voulu && !this.socket) this._ouvrir(); }, Math.min(1000 * this._essais, 4000));
    };
  }

  async deconnecter() {
    this._voulu = false;
    const s = this.socket;
    this.socket = null;
    try { s?.close(); } catch { /* déjà fermé */ }
    this._changerEtat('deconnecte');
  }

  async _ecrire(trame) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('pas de liaison');
    this.socket.send(trame);
  }
}
