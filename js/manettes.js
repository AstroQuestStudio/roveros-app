// manettes.js — tout ce qui sert à piloter à la main :
//   - Manette : un joystick virtuel tactile (ou à la souris) ;
//   - Clavier : flèches / ZQSD (ou WASD) pour avancer, A et E pour tourner ;
//   - Pilote  : mélange toutes les sources et envoie la trame MANETTE à 20 Hz tant qu'on bouge.
//
// Règle du protocole : sans trame pendant 0,4 s, le rover s'arrête tout seul.
// On envoie donc ~20 trames par seconde pendant le geste, puis quelques trames « 0,0,0 » à la fin.

import { encoderManette } from './protocole.js';

const limiter = (v, a, b) => Math.min(b, Math.max(a, v));
export const ZONE_MORTE_MANETTE = 0.08; // 8 % de course sans effet autour du centre

// ---------- Joystick virtuel ----------

export class Manette {
  /**
   * Une manette « flottante » : le doigt se pose N'IMPORTE OÙ dans la zone et le joystick apparaît
   * sous le pouce. On n'a donc jamais besoin de regarder le téléphone pour trouver la manette.
   *
   * @param {HTMLElement} zone   surface tactile (reçoit les gestes)
   * @param {HTMLElement} racine le disque dessiné ; il doit contenir un .manette-pouce
   * @param {object} options  axes : 'xy' (joystick libre) ou 'x' (le pouce ne bouge qu'à l'horizontale)
   *                          surChangement(x, y) : valeurs entre −1 et 1, y positif = vers le haut
   *                          surAppui() / surRelache() : pour le retour tactile (vibration)
   */
  constructor(zone, racine, { axes = 'xy', surChangement = () => {}, surAppui = () => {}, surRelache = () => {} } = {}) {
    this.zone = zone;
    this.racine = racine;
    this.pouce = racine.querySelector('.manette-pouce');
    this.axes = axes;
    this.surChangement = surChangement;
    this.surAppui = surAppui;
    this.surRelache = surRelache;
    this.x = 0; this.y = 0;
    this._id = null;
    this.desactive = false;
    this._centre = { x: 0, y: 0, rayon: 1 };
    zone.style.touchAction = 'none';
    zone.addEventListener('pointerdown', (ev) => this._appui(ev));
    zone.addEventListener('pointermove', (ev) => this._mouvement(ev));
    zone.addEventListener('pointerup', (ev) => this._levee(ev));
    zone.addEventListener('pointercancel', (ev) => this._levee(ev));
    zone.addEventListener('lostpointercapture', (ev) => this._levee(ev));
  }

  _appui(ev) {
    if (this._id !== null || this.desactive) return;
    ev.preventDefault();
    this._id = ev.pointerId;
    try { this.zone.setPointerCapture(ev.pointerId); } catch { /* pointeur déjà relâché */ }
    this.zone.classList.add('active');
    // Le disque se recentre sous le doigt (sans sortir de la zone).
    const z = this.zone.getBoundingClientRect();
    const rayon = this.racine.offsetWidth / 2;
    const marge = Math.min(rayon, z.width / 2, z.height / 2);
    const cx = Math.min(Math.max(ev.clientX - z.left, marge), z.width - marge);
    const cy = Math.min(Math.max(ev.clientY - z.top, marge), z.height - marge);
    this.racine.style.left = `${cx}px`;
    this.racine.style.top = `${cy}px`;
    this._centre = { x: z.left + cx, y: z.top + cy, rayon };
    this.surAppui();
    this._mouvement(ev);
  }

  _mouvement(ev) {
    if (ev.pointerId !== this._id) return;
    const { x: ox, y: oy, rayon } = this._centre;
    const course = rayon * 0.62; // distance maximale du pouce par rapport au centre
    let dx = ev.clientX - ox;
    let dy = ev.clientY - oy;
    if (this.axes === 'x') dy = 0;
    const d = Math.hypot(dx, dy);
    if (d > course) { dx = (dx / d) * course; dy = (dy / d) * course; }
    this.pouce.style.transition = 'none';
    this.pouce.style.transform = `translate(${dx}px, ${dy}px)`;
    this._valeurs(dx / course, -dy / course);
  }

  _levee(ev) {
    if (ev.pointerId !== this._id) return;
    this._id = null;
    this.zone.classList.remove('active');
    this.racine.style.left = ''; this.racine.style.top = ''; // retour à la position de repos
    this.pouce.style.transition = '';
    this.pouce.style.transform = '';
    this._valeurs(0, 0);
    this.surRelache();
  }

  /** Applique la zone morte et une courbe douce (plus de finesse au centre), puis prévient. */
  _valeurs(x, y) {
    const mag = Math.hypot(x, y);
    if (mag < ZONE_MORTE_MANETTE) { x = 0; y = 0; } else {
      // On ramène la plage [zone morte, 1] sur [0, 1], puis on arrondit un peu la courbe.
      const k = ((mag - ZONE_MORTE_MANETTE) / (1 - ZONE_MORTE_MANETTE)) ** 1.25 / mag;
      x *= k; y *= k;
    }
    this.x = limiter(x, -1, 1); this.y = limiter(y, -1, 1);
    this.surChangement(this.x, this.y);
  }

  /** Relâche de force (changement d'onglet, urgence...). */
  relacher() {
    if (this._id !== null) { try { this.zone.releasePointerCapture(this._id); } catch { /* déjà relâché */ } }
    this._id = null;
    this.zone.classList.remove('active');
    this.racine.style.left = ''; this.racine.style.top = '';
    this.pouce.style.transform = '';
    this._valeurs(0, 0);
  }
}

// ---------- Clavier ----------

export class Clavier {
  /** surChangement(x, y, w) : x droite +, y avant +, w rotation horaire + (valeurs −1, 0 ou 1). */
  constructor(surChangement) {
    this.touches = new Set();
    this.surChangement = surChangement;
    window.addEventListener('keydown', (ev) => this._touche(ev, true));
    window.addEventListener('keyup', (ev) => this._touche(ev, false));
    window.addEventListener('blur', () => { this.touches.clear(); this._signaler(); });
  }

  static NOMS = {
    ArrowUp: 'avant', z: 'avant', w: 'avant',
    ArrowDown: 'arriere', s: 'arriere',
    ArrowLeft: 'gauche', q: 'gauche',
    ArrowRight: 'droite', d: 'droite',
    a: 'tourneG', e: 'tourneD',
  };

  _touche(ev, appuyee) {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    // On ne vole pas les touches quand on tape dans un champ de saisie.
    const cible = ev.target;
    if (cible && (cible.tagName === 'INPUT' || cible.tagName === 'TEXTAREA' || cible.isContentEditable)) {
      if (!appuyee) this.touches.clear();
      return;
    }
    const nom = Clavier.NOMS[ev.key] ?? Clavier.NOMS[String(ev.key).toLowerCase()];
    if (!nom) return;
    ev.preventDefault();
    if (appuyee) this.touches.add(nom); else this.touches.delete(nom);
    this._signaler();
  }

  _signaler() {
    const t = this.touches;
    this.surChangement(
      (t.has('droite') ? 1 : 0) - (t.has('gauche') ? 1 : 0),
      (t.has('avant') ? 1 : 0) - (t.has('arriere') ? 1 : 0),
      (t.has('tourneD') ? 1 : 0) - (t.has('tourneG') ? 1 : 0),
    );
  }
}

// ---------- Pilote : le chef d'orchestre ----------

export class Pilote {
  /**
   * @param {Function} envoyer  (trame) => boolean : envoie une trame sur le transport actif
   * @param {object} options    frequence : trames par seconde (20 par défaut)
   */
  constructor(envoyer, { frequence = 20 } = {}) {
    this.envoyer = envoyer;
    this.sources = {
      joystick: { x: 0, y: 0 },
      rotation: { x: 0 },
      clavier: { x: 0, y: 0, w: 0 },
      inclinaison: { x: 0, y: 0 },
    };
    this.monde = false; // repère du monde ou du rover
    this.bloque = false; // arrêt d'urgence verrouillé : on n'envoie plus rien
    this.sortie = { vx: 0, vy: 0, w: 0 }; // dernière commande en pour cent, pour l'affichage
    this._zerosRestants = 0;
    this._ecouteurs = new Set();
    this._minuterie = setInterval(() => this._tic(), 1000 / frequence);
  }

  /** Abonne un affichage : fn({ vx, vy, w, actif }) est appelée à chaque tic. */
  surTic(fn) { this._ecouteurs.add(fn); }

  /** Commande actuelle en pour cent (−100…100), toutes sources confondues. */
  calculer() {
    const s = this.sources;
    const p = (v) => Math.round(limiter(v, -1, 1) * 100);
    return {
      vx: p(s.joystick.x + s.clavier.x + s.inclinaison.x),
      vy: p(s.joystick.y + s.clavier.y + s.inclinaison.y),
      w: p(s.rotation.x + s.clavier.w),
    };
  }

  _tic() {
    const c = this.calculer();
    this.sortie = c;
    const actif = c.vx !== 0 || c.vy !== 0 || c.w !== 0;
    if (!this.bloque) {
      if (actif) {
        this.envoyer(encoderManette(c.vx, c.vy, c.w, this.monde));
        this._zerosRestants = 3; // à la fin du geste : quelques trames 0,0,0 pour être sûr
      } else if (this._zerosRestants > 0) {
        this._zerosRestants--;
        this.envoyer(encoderManette(0, 0, 0, this.monde));
      }
    }
    for (const fn of this._ecouteurs) fn({ ...c, actif });
  }

  /** Coupe immédiatement toute commande (urgence, perte de liaison). */
  toutArreter() {
    const s = this.sources;
    s.joystick.x = s.joystick.y = 0; s.rotation.x = 0;
    s.clavier.x = s.clavier.y = s.clavier.w = 0;
    s.inclinaison.x = s.inclinaison.y = 0;
    this._zerosRestants = 0;
  }
}
