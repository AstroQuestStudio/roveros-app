// transport-demo.js — le transport « Démo » : le faux rover vit dans la page.
// Même interface que le Bluetooth et le WebSocket, donc l'application ne voit pas la différence.

import { Transport } from './transport.js';
import { FauxRover } from './faux-rover.js';

const PAS_MS = 50; // le faux rover avance par pas de 50 ms (20 Hz)

export class TransportDemo extends Transport {
  constructor() {
    super('demo');
    this.rover = null;
    this._horloge = null;
    this._dernier = 0;
    this._temps = 0;
  }

  async connecter() {
    this._changerEtat('connexion', 'Démarrage du rover simulé…');
    this.rover = new FauxRover({
      // Les trames du faux rover arrivent comme celles d'un vrai, avec un tout petit délai.
      sortie: (trame) => queueMicrotask(() => { if (this.etat === 'connecte') this._recevoir(trame); }),
      planifier: (fn, ms) => setTimeout(() => { if (this.etat === 'connecte') fn(); }, ms),
    });
    this._dernier = performance.now();
    this._horloge = setInterval(() => this._avancer(), PAS_MS);
    this._changerEtat('connecte', 'Rover simulé');
    setTimeout(() => this.rover?.accueillir(), 120);
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
    this._horloge = null;
    this.rover = null;
    this._changerEtat('deconnecte');
  }

  async _ecrire(trame) {
    this.rover?.recevoir(trame);
  }
}
