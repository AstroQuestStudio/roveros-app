// transport-ble.js — Bluetooth Low Energy (Web Bluetooth) vers le vrai rover.
//
// Le rover expose le service « UART Nordic » :
//   - on ÉCRIT sur la caractéristique 6E400002 (sans réponse : plus rapide) ;
//   - on REÇOIT par notifications sur la caractéristique 6E400003.
// Une trame = une écriture = une notification.

import { Transport } from './transport.js';
import { BLE } from './protocole.js';

/** Vrai si ce navigateur sait faire du Web Bluetooth (Chrome sur Android, Chrome/Edge sur PC). */
export const bluetoothDisponible = () =>
  typeof navigator !== 'undefined' && !!navigator.bluetooth && typeof navigator.bluetooth.requestDevice === 'function';

const ATTENTES_RECONNEXION_MS = [500, 1000, 2000, 3000, 4000, 5000, 5000, 5000];

export class TransportBle extends Transport {
  constructor() {
    super('ble');
    this.appareil = null;
    this._caracEcriture = null;
    this._caracNotif = null;
    this._voulu = false; // l'utilisateur veut-il rester connecté ?
    this._essais = 0;
    this._surDeconnexion = () => this._deconnecteParLaLiaison();
    this._surNotification = (ev) => this._recevoir(new Uint8Array(ev.target.value.buffer.slice(
      ev.target.value.byteOffset, ev.target.value.byteOffset + ev.target.value.byteLength)));
  }

  get nomAppareil() { return this.appareil?.name ?? ''; }

  /** Ouvre la fenêtre de choix de Chrome (geste utilisateur obligatoire) puis se connecte. */
  async connecter() {
    if (!bluetoothDisponible()) {
      this._changerEtat('erreur', "Ce navigateur ne gère pas le Bluetooth web. Utilisez Chrome sur Android, ou essayez la démo.");
      return;
    }
    this._voulu = true;
    this._changerEtat('connexion', 'Choix du rover…');
    try {
      // Le nom Bluetooth peut être personnalisé (plus forcément « Rover-XXXX ») : on cherche par service UART Nordic.
      this.appareil = await navigator.bluetooth.requestDevice({
        filters: [{ services: [BLE.service] }, { namePrefix: 'Rover-' }],
        optionalServices: [BLE.service],
      });
    } catch (erreur) {
      this._voulu = false;
      // NotFoundError = l'utilisateur a fermé la fenêtre : pas une vraie erreur.
      if (erreur && erreur.name === 'NotFoundError') this._changerEtat('deconnecte', 'Aucun rover choisi.');
      else this._changerEtat('erreur', messageErreur(erreur));
      return;
    }
    this.appareil.addEventListener('gattserverdisconnected', this._surDeconnexion);
    this._essais = 0;
    await this._ouvrirLiaison();
  }

  /** Connexion GATT + abonnement aux notifications. Sert aussi à la reconnexion. */
  async _ouvrirLiaison() {
    try {
      this._changerEtat(this._essais > 0 ? 'reconnexion' : 'connexion', 'Connexion au rover…');
      const serveur = await this.appareil.gatt.connect();
      const service = await serveur.getPrimaryService(BLE.service);
      this._caracEcriture = await service.getCharacteristic(BLE.ecriture);
      this._caracNotif = await service.getCharacteristic(BLE.notification);
      this._caracNotif.addEventListener('characteristicvaluechanged', this._surNotification);
      await this._caracNotif.startNotifications();
      this._essais = 0;
      this._changerEtat('connecte', this.nomAppareil);
    } catch (erreur) {
      if (!this._voulu) return;
      await this._reessayer(erreur);
    }
  }

  async _reessayer(erreur) {
    if (this._essais >= ATTENTES_RECONNEXION_MS.length) {
      this._voulu = false;
      this._changerEtat('erreur', `Liaison perdue : ${messageErreur(erreur)}`);
      return;
    }
    const attente = ATTENTES_RECONNEXION_MS[this._essais++];
    this._changerEtat('reconnexion', `Nouvelle tentative dans ${Math.round(attente / 1000 * 10) / 10} s…`);
    await new Promise((r) => setTimeout(r, attente));
    if (this._voulu && this.appareil) await this._ouvrirLiaison();
  }

  _deconnecteParLaLiaison() {
    this._caracEcriture = null;
    this._caracNotif = null;
    if (this._voulu) {
      // Perte involontaire : reconnexion automatique. Le rover s'arrête seul (chien de garde).
      this._changerEtat('reconnexion', 'Liaison perdue, reconnexion…');
      this._essais = 0;
      this._reessayer(new Error('liaison perdue'));
    } else {
      this._changerEtat('deconnecte');
    }
  }

  async deconnecter() {
    this._voulu = false;
    try {
      if (this._caracNotif) this._caracNotif.removeEventListener('characteristicvaluechanged', this._surNotification);
      if (this.appareil?.gatt?.connected) this.appareil.gatt.disconnect();
    } catch { /* déjà déconnecté */ }
    this._changerEtat('deconnecte');
  }

  async _ecrire(trame) {
    if (!this._caracEcriture) throw new Error('pas de liaison');
    // Sans réponse : pas d'attente d'accusé, donc débit maximal. Repli sur l'écriture simple si absente.
    if (this._caracEcriture.writeValueWithoutResponse) await this._caracEcriture.writeValueWithoutResponse(trame);
    else await this._caracEcriture.writeValue(trame);
  }
}

function messageErreur(erreur) {
  if (!erreur) return 'erreur inconnue';
  if (erreur.name === 'SecurityError') return 'Bluetooth refusé par le navigateur (autorisez-le dans les réglages du site).';
  if (erreur.name === 'NetworkError') return 'Le rover ne répond pas : est-il allumé et à portée ?';
  if (erreur.name === 'NotSupportedError') return 'Ce rover ne propose pas le service attendu.';
  return erreur.message || String(erreur);
}
