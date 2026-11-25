// inclinaison.js — piloter en penchant le téléphone (capteur d'orientation du navigateur).
//
// Le téléphone mesure deux angles : beta (avant/arrière) et gamma (gauche/droite).
// On compare ces angles à un « neutre » (la position où l'on tient confortablement le téléphone) :
//   - sous la zone morte, rien ne bouge ;
//   - à l'angle plein (25° par défaut), le rover va à 100 %.
// Par sécurité, l'application ne tient compte de l'inclinaison que tant qu'un doigt reste appuyé
// sur la surface de pilotage (« homme mort »).

const limiter = (v, a, b) => Math.min(b, Math.max(a, v));

export class Inclinaison extends EventTarget {
  constructor() {
    super();
    this.actif = false;
    this.beta = null; // angles bruts les plus récents
    this.gamma = null;
    this.neutre = null; // { beta, gamma } mémorisés par la calibration
    this.zoneMorteDeg = 4;
    this.pleinDeg = 25;
    this.maintenu = false; // le doigt est-il sur la surface ?
    this._surOrientation = (ev) => this._recevoir(ev);
    try {
      const memo = JSON.parse(localStorage.getItem('roveros.inclinaison') ?? 'null');
      if (memo) { this.zoneMorteDeg = memo.zoneMorteDeg ?? 4; this.pleinDeg = memo.pleinDeg ?? 25; }
    } catch { /* stockage indisponible : valeurs par défaut */ }
  }

  /** Le navigateur possède-t-il l'API ? (Les PC sans capteur l'ont mais n'envoient rien.) */
  static get possible() { return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window; }

  /**
   * Active l'écoute. Sur iPhone/Safari, une permission explicite est requise (geste utilisateur).
   * Renvoie { ok, message }.
   */
  async activer() {
    if (!Inclinaison.possible) return { ok: false, message: "Ce navigateur n'a pas de capteur d'inclinaison." };
    try {
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        const reponse = await DeviceOrientationEvent.requestPermission();
        if (reponse !== 'granted') return { ok: false, message: "Accès au capteur d'inclinaison refusé." };
      }
    } catch (erreur) {
      return { ok: false, message: `Capteur d'inclinaison indisponible : ${erreur.message ?? erreur}` };
    }
    window.addEventListener('deviceorientation', this._surOrientation);
    this.actif = true;
    // Si aucun angle n'arrive en 1,5 s, c'est qu'il n'y a pas de capteur (ordinateur de bureau).
    await new Promise((r) => setTimeout(r, 1500));
    if (this.beta === null) {
      this.desactiver();
      return { ok: false, message: "Aucun capteur d'inclinaison détecté sur cet appareil." };
    }
    return { ok: true, message: '' };
  }

  desactiver() {
    window.removeEventListener('deviceorientation', this._surOrientation);
    this.actif = false;
    this.maintenu = false;
    this.beta = this.gamma = null;
  }

  _recevoir(ev) {
    if (ev.beta === null || ev.gamma === null || ev.beta === undefined) return;
    this.beta = ev.beta; this.gamma = ev.gamma;
    this.dispatchEvent(new Event('angle'));
  }

  /** Mémorise la position actuelle comme position neutre. */
  calibrer() {
    if (this.beta === null) return false;
    this.neutre = { beta: this.beta, gamma: this.gamma };
    return true;
  }

  enregistrerReglages() {
    try {
      localStorage.setItem('roveros.inclinaison', JSON.stringify({ zoneMorteDeg: this.zoneMorteDeg, pleinDeg: this.pleinDeg }));
    } catch { /* tant pis */ }
  }

  /** Angle d'écran (0, 90, 180 ou 270) : le téléphone peut être tenu en paysage. */
  static _angleEcran() {
    const a = (screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0;
    return ((Math.round(a / 90) * 90) % 360 + 360) % 360;
  }

  /** Écarts bruts (en degrés) par rapport au neutre, vus depuis l'utilisateur : droite + et avant +. */
  ecarts() {
    if (this.beta === null) return { droite: 0, avant: 0 };
    if (!this.neutre) this.calibrer(); // premier appui : le neutre est la position de départ
    const db = this.beta - this.neutre.beta;
    const dg = this.gamma - this.neutre.gamma;
    switch (Inclinaison._angleEcran()) {
      case 90: return { droite: db, avant: dg };
      case 180: return { droite: -dg, avant: db };
      case 270: return { droite: -db, avant: -dg };
      default: return { droite: dg, avant: -db }; // portrait : pencher le haut vers l'avant = avancer
    }
  }

  /** Commande normalisée { x, y } entre −1 et 1 (0 si le doigt n'est pas posé). */
  valeurs() {
    if (!this.actif || !this.maintenu) return { x: 0, y: 0 };
    const { droite, avant } = this.ecarts();
    const norme = (d) => {
      const a = Math.abs(d);
      if (a < this.zoneMorteDeg) return 0;
      return Math.sign(d) * limiter((a - this.zoneMorteDeg) / (this.pleinDeg - this.zoneMorteDeg), 0, 1);
    };
    return { x: norme(droite), y: norme(avant) };
  }
}
