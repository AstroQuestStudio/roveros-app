// manettes.js — tout ce qui sert à piloter à la main :
//   - Manette : un joystick virtuel tactile (ou à la souris) ;
//   - Clavier : flèches / ZQSD (ou WASD) pour avancer, A et E pour tourner ;
//   - Pilote  : mélange toutes les sources et envoie la trame MANETTE.
//
// Règle du protocole : sans trame MANETTE pendant 0,4 s, le rover s'arrête tout seul.
// Le Pilote respecte donc ces règles :
//   - tant qu'un doigt est posé : une trame à cadence fixe (15 Hz), même si la valeur ne change pas ;
//   - un vrai changement part tout de suite (sans attendre le prochain battement) ;
//   - rien du tout quand on ne touche à rien (une trame « 0,0,0 » en boucle annulerait un comportement) ;
//   - au relâchement : STOP envoyé 3 fois, puis le silence ;
//   - un lissage léger arrondit le tremblement du pouce ; l'arrêt, lui, est immédiat.

import { encoderManette, encoderStop } from './protocole.js';

const limiter = (v, a, b) => Math.min(b, Math.max(a, v));
/** Course sans effet autour du centre (10 %), pour que le pouce qui repose ne fasse pas avancer le rover. */
export const ZONE_MORTE_MANETTE = 0.10;

/**
 * Courbe de la manette : (x, y) bruts entre −1 et 1 -> (x, y) de commande.
 *  - zone morte au centre ;
 *  - progressivité : les petits mouvements donnent de petites vitesses (0,3·t + 0,7·t²) ;
 *  - aide à la ligne droite : un léger écart latéral en poussant tout droit est effacé
 *    (progressivement, pour ne créer aucun saut) ; la diagonale voulue reste intacte.
 */
export function courbeManette(x, y, { aideAxes = true } = {}) {
  const mag = Math.hypot(x, y);
  if (mag < ZONE_MORTE_MANETTE) return { x: 0, y: 0 };
  const t = Math.min(1, (mag - ZONE_MORTE_MANETTE) / (1 - ZONE_MORTE_MANETTE));
  // Dès la sortie de la zone morte, au moins 1 % de consigne pour éviter une bande morte cachée à l'arrondi.
  const k = (0.01 + 0.99 * (0.3 * t + 0.7 * t * t)) / mag;
  x *= k; y *= k;
  if (aideAxes) {
    const ax = Math.abs(x); const ay = Math.abs(y);
    const grand = Math.max(ax, ay);
    if (grand > 0) {
      const f = limiter((Math.min(ax, ay) / grand - 0.12) / 0.25, 0, 1); // 0 sous 12 % d'écart, 1 au-dessus de 37 %
      if (ax < ay) x *= f; else y *= f;
    }
  }
  return { x: limiter(x, -1, 1), y: limiter(y, -1, 1) };
}

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
  constructor(zone, racine, { axes = 'xy', surChangement = () => {}, surAppui = () => {}, surRelache = () => {}, surDoigt = null } = {}) {
    this.zone = zone;
    this.racine = racine;
    this.pouce = racine.querySelector('.manette-pouce');
    this.axes = axes;
    this.surChangement = surChangement;
    this.surAppui = surAppui;
    this.surRelache = surRelache;
    this.surDoigt = surDoigt;
    this.x = 0; this.y = 0;
    this._id = null;
    this._capturee = false;
    this._horsZone = false;
    this.desactive = false;
    this._centre = { x: 0, y: 0, rayon: 1 };
    zone.style.touchAction = 'none';
    zone.addEventListener('pointerdown', (ev) => this._appui(ev));
    zone.addEventListener('pointermove', (ev) => this._mouvement(ev));
    zone.addEventListener('pointerup', (ev) => this._levee(ev));
    zone.addEventListener('pointercancel', (ev) => this._levee(ev));
    // Capture perdue sans relâchement : le repli sur window prend le relais au lieu de couper le mouvement.
    zone.addEventListener('lostpointercapture', (ev) => { if (ev.pointerId === this._id) this._capturee = false; });
    // Repli sur window : si la capture échoue ou est perdue en multipoint, le relâchement hors zone reste détecté.
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      // Tant que la capture tient, la zone reçoit déjà l'événement (qui remonte ensuite jusqu'ici) : ne pas le traiter deux fois.
      window.addEventListener('pointermove', (ev) => { if (!this._capturee) this._mouvement(ev); });
      window.addEventListener('pointerup', (ev) => this._levee(ev));
      window.addEventListener('pointercancel', (ev) => this._levee(ev));
      window.addEventListener('blur', () => this.relacher());
    }
  }

  _appui(ev) {
    if (this.desactive) return;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    ev.preventDefault(); // toujours empêcher le navigateur d'interpréter un second doigt comme un geste
    if (this._id !== null) return;
    this._id = ev.pointerId;
    this._horsZone = false;
    this._capturee = false;
    try { this.zone.setPointerCapture(ev.pointerId); this._capturee = true; } catch { /* pointeur déjà relâché ou capture refusée */ }
    this.zone.classList.add('active');
    // Le disque se recentre sous le doigt (sans sortir de la zone).
    const z = this.zone.getBoundingClientRect();
    const rayon = Math.max(1, this.racine.offsetWidth / 2);
    const marge = Math.min(rayon, z.width / 2, z.height / 2);
    const cx = Math.min(Math.max(ev.clientX - z.left, marge), z.width - marge);
    const cy = Math.min(Math.max(ev.clientY - z.top, marge), z.height - marge);
    this.racine.style.left = `${cx}px`;
    this.racine.style.top = `${cy}px`;
    this._centre = { x: z.left + cx, y: z.top + cy, rayon };
    this._zoneRect = z;
    this.surAppui();
    this._mouvement(ev, true);
  }

  _mouvement(ev, estAppui = false) {
    if (ev.pointerId !== this._id) return;
    const { x: ox, y: oy, rayon } = this._centre;
    const course = Math.max(1, rayon * 0.62); // distance maximale du pouce par rapport au centre
    let dx = ev.clientX - ox;
    let dy = ev.clientY - oy;
    if (this.axes === 'x') dy = 0;
    const d = Math.hypot(dx, dy);
    if (d > course) { dx = (dx / d) * course; dy = (dy / d) * course; }
    this.pouce.style.transition = 'none';
    this.pouce.style.transform = `translate(${dx}px, ${dy}px)`;
    const bx = dx / course;
    const by = -dy / course;
    const r = this._zoneRect;
    const hors = !!r && (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom);
    if (this.surDoigt) {
      if (estAppui) this.surDoigt('appui', bx, by);
      else if (hors && !this._horsZone) this.surDoigt('sortie', bx, by);
      else this.surDoigt('mouvement', bx, by);
    }
    this._horsZone = hors;
    this._valeurs(bx, by);
  }

  _levee(ev) {
    if (ev.pointerId !== this._id) return;
    if (this._capturee) { try { this.zone.releasePointerCapture(ev.pointerId); } catch { /* déjà relâché */ } }
    this._id = null;
    this._capturee = false;
    this._horsZone = false;
    this.zone.classList.remove('active');
    this.racine.style.left = ''; this.racine.style.top = ''; // retour à la position de repos
    this.pouce.style.transition = '';
    this.pouce.style.transform = '';
    if (this.surDoigt) this.surDoigt('relache', 0, 0);
    this._valeurs(0, 0);
    this.surRelache();
  }

  /** Applique la courbe (zone morte, progressivité, aide à la ligne droite), puis prévient. */
  _valeurs(x, y) {
    const c = courbeManette(x, y, { aideAxes: this.axes === 'xy' });
    this.x = c.x; this.y = c.y;
    this.surChangement(this.x, this.y);
  }

  /** Relâche de force (changement d'onglet, urgence...). */
  relacher() {
    if (this._id === null) return;
    if (this._capturee) { try { this.zone.releasePointerCapture(this._id); } catch { /* déjà relâché */ } }
    this._id = null;
    this._capturee = false;
    this._horsZone = false;
    this.zone.classList.remove('active');
    this.racine.style.left = ''; this.racine.style.top = '';
    this.pouce.style.transform = '';
    if (this.surDoigt) this.surDoigt('annule', 0, 0);
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

/** Réglages du pilote (millisecondes sauf mention contraire). */
export const REGLAGES_PILOTE = {
  frequence: 15, // battement : trames par seconde tant qu'on commande
  tic: 10, // calcul interne du lissage et du battement
  tauMontee: 70, // lissage quand on accélère
  tauDescente: 40, // lissage quand on ralentit (plus court : on freine franchement)
  seuilChangement: 3, // écart (points de pourcentage) qui déclenche un envoi immédiat
  espaceMin: 45, // jamais deux envois « de changement » plus proches que cela
  stopRepetitions: 3, // STOP envoyés au relâchement
  stopEspace: 60,
  delaiZoneMorteMs: 250, // grâce lors d'un passage au centre sans lâcher le doigt
};

export class Pilote {
  /**
   * @param {Function} envoyer  (trame) => boolean : envoie une trame sur le transport actif
   * @param {object} options    frequence : battement en trames par seconde (15 par défaut)
   *                            horloge : () => ms (pour les tests) ; minuterie : false pour piloter _tic à la main
   */
  constructor(envoyer, { frequence = REGLAGES_PILOTE.frequence, horloge = () => performance.now(), minuterie = true } = {}) {
    this.envoyer = envoyer;
    this.horloge = horloge;
    this.reglages = { ...REGLAGES_PILOTE, frequence };
    this.sources = {
      joystick: { x: 0, y: 0 },
      rotation: { x: 0 },
      clavier: { x: 0, y: 0, w: 0 },
      inclinaison: { x: 0, y: 0 },
      figure: { x: 0, y: 0, w: 0 }, // figures.js : consigne de la figure jouée (doigt maintenu)
    };
    this.contacts = new Set(); // sources avec un doigt actuellement posé
    this.monde = false; // repère du monde ou du rover
    this.bloque = false; // arrêt d'urgence verrouillé : on n'envoie plus rien
    this.sortie = { vx: 0, vy: 0, w: 0 }; // dernière commande lissée en pour cent, pour l'affichage
    this.stats = { manette: 0, stop: 0 };
    this._lisse = { vx: 0, vy: 0, w: 0 };
    this._dernierEnvoye = null;
    this._tEnvoi = -Infinity;
    this._tChangement = -Infinity;
    this._tReposContact = null;
    this._enMarche = false; // une trame de marche est partie depuis le dernier arrêt
    this._stopsRestants = 0;
    this._tStop = -Infinity;
    this._tPrec = horloge();
    this._ecouteurs = new Set();
    this._minuterie = minuterie ? setInterval(() => this._tic(), this.reglages.tic) : null;
  }

  /** Abonne un affichage : fn({ vx, vy, w, actif }) est appelée à chaque tic. */
  surTic(fn) { this._ecouteurs.add(fn); }

  /** Indique si un doigt est actuellement posé sur une source (empêche STOP sur bref passage par zéro). */
  definirContact(nom, pose) {
    if (pose) this.contacts.add(nom); else this.contacts.delete(nom);
    if (!pose) { this._tReposContact = null; this._tic(); }
  }

  /** Change une source (joystick, rotation, clavier, inclinaison) ET réagit tout de suite. */
  maj(nom, valeur) { this.sources[nom] = valeur; this._tic(); }

  /** À appeler après avoir modifié `sources` à la main : évite d'attendre le prochain tic. */
  signaler() { this._tic(); }

  /** Arrête la minuterie interne (tests, fermeture de la page). */
  arreter() { clearInterval(this._minuterie); this._minuterie = null; }

  /** Commande souhaitée en pour cent (−100…100), toutes sources confondues, avant lissage. */
  calculer() {
    const s = this.sources;
    const p = (v) => Math.round(limiter(v, -1, 1) * 100);
    return {
      vx: p(s.joystick.x + s.clavier.x + s.inclinaison.x + s.figure.x),
      vy: p(s.joystick.y + s.clavier.y + s.inclinaison.y + s.figure.y),
      w: p(s.rotation.x + s.clavier.w + s.figure.w),
    };
  }

  /** Lissage : zéro immédiat au relâchement ; avec doigt posé, descente lissée pour ne pas couper au centre. */
  _lisser(cible, dt, doigtPose = false) {
    const r = this.reglages;
    for (const k of ['vx', 'vy', 'w']) {
      const c = cible[k];
      let l = this._lisse[k];
      if (c === 0 && !doigtPose) l = 0;
      else {
        const accelere = l === 0 || (Math.sign(c) === Math.sign(l) && Math.abs(c) >= Math.abs(l));
        l += (c - l) * (1 - Math.exp(-dt / (accelere ? r.tauMontee : r.tauDescente)));
        if (Math.abs(c - l) < 0.5) l = c;
      }
      this._lisse[k] = l;
    }
    return { vx: Math.round(this._lisse.vx), vy: Math.round(this._lisse.vy), w: Math.round(this._lisse.w) };
  }

  _tic(maintenant = this.horloge()) {
    const r = this.reglages;
    const dt = limiter(maintenant - this._tPrec, 0, 100);
    this._tPrec = maintenant;
    const cible = this.calculer();
    const cibleActive = cible.vx !== 0 || cible.vy !== 0 || cible.w !== 0;
    const doigtPose = this.contacts.size > 0;
    if (cibleActive) this._tReposContact = null;
    else if (doigtPose) this._tReposContact ??= maintenant;
    else this._tReposContact = null;

    const c = this._lisser(cible, dt, doigtPose);
    this.sortie = c;
    const actif = c.vx !== 0 || c.vy !== 0 || c.w !== 0;
    const graceZoneMorte = doigtPose && this._enMarche && this._tReposContact !== null
      && maintenant - this._tReposContact < r.delaiZoneMorteMs;

    if (this.bloque) {
      // Arrêt d'urgence : le reste de l'application s'en charge, on ne dit plus rien.
      this._enMarche = false; this._stopsRestants = 0;
    } else if (actif || (this._enMarche && (cibleActive || graceZoneMorte))) {
      this._stopsRestants = 0;
      const d = this._dernierEnvoye;
      const periode = 1000 / r.frequence;
      const ecoule = maintenant - this._tEnvoi;
      const ecart = d ? Math.max(Math.abs(c.vx - d.vx), Math.abs(c.vy - d.vy), Math.abs(c.w - d.w)) : Infinity;
      const axeChange = d && ['vx', 'vy', 'w'].some((k) => (c[k] === 0) !== (d[k] === 0));
      const battement = ecoule >= periode;
      const changement = (ecart >= r.seuilChangement || axeChange) && (maintenant - this._tChangement >= r.espaceMin);
      if (battement || changement) {
        this.envoyer(encoderManette(c.vx, c.vy, c.w, this.monde));
        this.stats.manette++;
        this._dernierEnvoye = { ...c };
        if (changement) this._tChangement = maintenant;
        // Cadence verrouillée sur l'horloge réelle : un tic en retard ne décale pas tous les suivants.
        this._tEnvoi = battement && Number.isFinite(this._tEnvoi) && ecoule < 2 * periode
          ? this._tEnvoi + periode
          : maintenant;
        this._enMarche = true;
      }
    } else if (this._enMarche) {
      // Doigt levé : STOP, répété pour qu'une trame perdue ne laisse pas rouler le rover. Puis silence.
      if (this._stopsRestants === 0) { this._stopsRestants = r.stopRepetitions; this._tStop = -Infinity; this._dernierEnvoye = null; }
      if (maintenant - this._tStop >= r.stopEspace) {
        this.envoyer(encoderStop());
        this.stats.stop++;
        this._tStop = maintenant;
        if (--this._stopsRestants === 0) this._enMarche = false;
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
    s.figure.x = s.figure.y = s.figure.w = 0;
    this.contacts.clear();
    this._tReposContact = null;
    this._lisse = { vx: 0, vy: 0, w: 0 };
  }
}
