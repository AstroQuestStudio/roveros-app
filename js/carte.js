// carte.js — la carte en direct (canvas) : cases libres / occupées / inconnues, rover à l'échelle,
// trace du trajet, faisceau du sonar, échos qui s'estompent, chemin prévu, cible, base, marqueur.
//
// Style « carte marine » : l'inconnu est un fond sombre quadrillé, l'espace libre est de l'eau,
// les obstacles sont de la terre (sable clair), et le sonar balaie comme sur un écran de bateau.
//
// Gestes : un doigt qui glisse déplace la carte, deux doigts pincent pour zoomer, un simple
// toucher envoie le rover à cet endroit (l'application reçoit l'événement via `surToucher`).

import { CASE_LIBRE, CASE_OCCUPEE, CASE_POSSIBLE } from './protocole.js';
import { CarteGlobale, TUILE } from './carte-globale.js';
import { Repere } from './repere.js';
import { boucles, adoucir } from './contours.js';
import { LARGEUR_ROVER, LONGUEUR_ROVER, positionSonar } from './gabarit.js';
import { Trace } from './trace.js';
import { Lisseur } from './lissage.js';

// Palette de la carte (mêmes tons que l'interface : encre, eau, sable, turquoise du sonar, ambre du rover).
const COULEURS = {
  fond: '#050b12',
  grille: 'rgba(140, 220, 235, 0.035)',
  grilleForte: 'rgba(140, 220, 235, 0.08)',
  texte: 'rgba(233, 242, 247, 0.78)',
  libre: '#0a4a70', // zone libre : surface lisse
  libreBord: 'rgba(96, 190, 225, 0.30)',
  possible: 'rgba(214, 192, 142, 0.20)', // prolongement incertain d'un obstacle : discret
  obstacle: '#c9b585',
  obstacleBord: 'rgba(52, 38, 14, 0.7)',
  touche: '#dccca0', // face d'un obstacle touchée par le sonar : à peine plus claire
  sonar: '#1de9c6',
  rover: '#f5a83a',
  trace: '#f6921e',
  chemin: '#eef0f5',
  cible: '#eef0f5',
  marqueur: '#eef0f5',
  base: '#a3a9b8',
};

const PPM_MIN = 30; // pixels par mètre (le zoom arrière descend plus bas si la carte est plus grande : voir _ppmMin)
const PPM_ABSOLU_MIN = 1.5;
const PPM_MAX = 700;
const DUREE_ECHO_MS = 4500; // un écho s'estompe en 4,5 s
const PORTEE_SONAR = 2.55;

/** Longueur « ronde » de barre d'échelle : 0,1 / 0,2 / 0,5 / 1 / 2 / 5 m. */
function longueurRonde(metresCible) {
  const base = 10 ** Math.floor(Math.log10(metresCible));
  for (const m of [1, 2, 5, 10]) if (base * m >= metresCible) return base * m;
  return base * 10;
}

export function formaterDistance(m) {
  if (m >= 1) return `${Number.isInteger(m) ? m : m.toFixed(1).replace('.', ',')} m`;
  return `${Math.round(m * 100)} cm`;
}

export class VueCarte extends EventTarget {
  constructor(canvas, { surToucher } = {}) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.surToucher = surToucher ?? (() => {});
    this.cellule = 0.05; // m, mis à jour par la ligne « info cellule=… »
    // La carte globale : des tuiles de 64 × 64 cases rangées à leur place ABSOLUE (elle grandit avec le rover).
    // Les positions reçues sont relatives au centre de la fenêtre du rover ; `repere` les ramène en absolu.
    this.globale = new CarteGlobale();
    this.repere = new Repere();
    this._tFormes = 0;
    this.invalide = true; // il faut redessiner (on ne redessine rien quand rien ne change)
    this.rover = { x: 0, y: 0, cap: 0, tete: 0, sonar: 0, ok: false }; // mètres, radians
    this.lisseur = new Lisseur(); // fait glisser le rover entre deux trames ÉTAT (8 à 20 par seconde)
    this.lissage = true; // mettre false pour afficher les positions telles qu'elles arrivent (mesures)
    this.stats = { images: 0, dessinMs: 0, depuis: performance.now() };
    this.trace = new Trace(); // l'historique des positions annoncées par le rover (2 000 points, un tous les 2 cm)
    this.couches = { carte: true, trace: true, echos: true, chemin: true, base: true }; // ce qui est dessiné
    this.echos = [];
    this.chemin = [];
    this.cible = null;
    this.marqueur = null;
    this.etapes = []; // points de la patrouille { x, y } en mètres, numérotés à l'écran
    this.vue = { cx: 0, cy: 0, ppm: 120 };
    this.suivre = true;
    this.margeBas = 0; // px : l'échelle remonte au-dessus des commandes qui flottent sur la carte
    this.decalage = 0; // fraction de la hauteur dont on remonte le rover (paysage : les commandes cachent le bas)
    this.largeur = 300; this.hauteur = 300; this.dpr = 1;
    this.actif = false;
    this._dernier = 0;
    this._pointeurs = new Map();
    this._geste = null;
    this._boucle = this._boucle.bind(this);
    this._brancher();
  }

  // ---------- Données ----------

  definirCellule(m) { this.repere.definirCellule(m); this.cellule = this.repere.cellule; }

  /** Applique une trame CARTE décodée : chaque ligne est rangée à sa place absolue, avec l'origine en cours. */
  appliquerCarte(msg) { if (this.globale.ranger(msg, this.repere) > 0) this.invalide = true; }

  effacerCarte() { this.globale.effacer(); this.invalide = true; }

  /**
   * Une trame ORIGINE est arrivée : la fenêtre du rover a glissé. La carte, la trace et le rover restent en
   * coordonnées absolues, donc rien ne bouge à l'écran. Un recalage du rover (position et carte remises à zéro)
   * ne se reconnaît pas ici : il est vu par le texte « reposé » / « recalé » ou par le saut de la position
   * à (0, 0) (voir majPosition dans app.js), qui vident alors la carte et la trace.
   */
  appliquerOrigine(o) {
    const res = this.repere.appliquer(o);
    this.cellule = this.repere.cellule;
    this.invalide = true;
    return res;
  }

  /** Position absolue (m) d'une trame ÉTAT décodée, ou null si elle est écrite dans un repère inconnu. */
  positionAbsolue(e) { return this.repere.absolu(e.x, e.y, e.versionOrigine); }

  /** Met à jour la position du rover à partir d'une trame ÉTAT décodée. Renvoie false si la trame est ignorée. */
  majEtat(e) {
    const r = this.rover;
    const pos = this.positionAbsolue(e);
    if (!pos) return false; // repère inconnu ou fenêtre en train de glisser : on garde la position précédente
    const memo = `${e.x},${e.y},${e.cap},${e.tete},${e.sonar},${e.cibleD},${e.cibleGis},${e.versionOrigine}`;
    if (memo !== this._memoEtat) { this._memoEtat = memo; this.invalide = true; }
    const x = pos.x; const y = pos.y;
    const cap = (e.cap * Math.PI) / 180; const tete = (e.tete * Math.PI) / 180;
    r.sonar = e.sonar;
    // Avec le lissage, c'est la boucle d'affichage qui déplace le rover image par image (voir _appliquerLissage).
    // Sans lui, ou quand la carte n'est pas à l'écran, on prend la position telle qu'elle arrive.
    if (!r.ok || !this.lissage || !this.actif) {
      r.x = x; r.y = y; r.cap = cap; r.tete = tete;
      if (this.trace.ajouter(x, y) && this.couches.trace) this.invalide = true;
    }
    r.ok = true;
    if (this.lissage) this.lisseur.pousser({ x, y, cap: e.cap, tete: e.tete }, performance.now());
    if (e.cibleD > 0) {
      const a = cap + (e.cibleGis * Math.PI) / 180;
      this.cible = { x: x + Math.sin(a) * (e.cibleD / 100), y: y + Math.cos(a) * (e.cibleD / 100) };
    } else this.cible = null;
    if (this.marqueur && Math.hypot(this.marqueur.x - x, this.marqueur.y - y) < 0.1) this.marqueur = null;
    return true;
  }

  ajouterPoints(points) {
    const maintenant = performance.now();
    for (const p of points) {
      if (p.distance > 0) {
        const pos = this.repere.absolu(p.x, p.y);
        if (!pos) continue;
        this.echos.push({ x: pos.x, y: pos.y, t: maintenant }); this.invalide = true;
        this.globale.marquerTouche(Math.floor(pos.x / this.cellule), Math.floor(pos.y / this.cellule));
      }
    }
    if (this.echos.length > 600) this.echos.splice(0, this.echos.length - 600);
  }

  definirChemin(points) {
    this.chemin = points.map((p) => this.repere.absolu(p.x, p.y)).filter(Boolean);
    this.invalide = true;
  }

  poserMarqueur(x, y) { this.marqueur = { x, y, t: performance.now() }; this.invalide = true; }
  retirerMarqueur() { this.marqueur = null; this.invalide = true; }

  /** Après « recaler » : nouvelle origine, tout l'historique géométrique est caduc. */
  reinitialiserTrajet() { this.repere.reinitialiser(); this.cellule = this.repere.cellule; this.lisseur.reinitialiser(); this.trace.effacer(); this.echos = []; this.chemin = []; this.marqueur = null; this.cible = null; this.invalide = true; }

  // ---------- Vue ----------

  /**
   * Reprend le suivi du rover. Si on le suivait déjà (deuxième toucher), on revient aussi au zoom d'origine ;
   * sinon on garde le zoom choisi (par exemple pour regarder toute la carte).
   */
  recentrer() {
    const dejaSuivi = this.suivre;
    this.suivre = true;
    if (dejaSuivi) this.vue.ppm = Math.min(this.largeur, this.hauteur) / 2.6;
    this._signalerVue();
  }

  /** Le zoom arrière le plus fort permis : celui qui fait tenir TOUTE la carte globale à l'écran (au plus 1,5 px/m). */
  _ppmMin() {
    const fit = this._ppmPourTout();
    return Math.max(PPM_ABSOLU_MIN, Math.min(PPM_MIN, fit ?? PPM_MIN));
  }

  /** Échelle (px/m) pour faire tenir toute la carte connue, rover compris, avec une marge ; null si la carte est vide. */
  _ppmPourTout() {
    const e = this._etendueMetres();
    if (!e) return null;
    const marge = 1.12;
    return Math.min(this.largeur / (Math.max(e.maxX - e.minX, 0.5) * marge), this.hauteur / (Math.max(e.maxY - e.minY, 0.5) * marge));
  }

  /** Étendue de la carte connue et du rover, en mètres absolus. */
  _etendueMetres() {
    const g = this.globale.etendue;
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    if (g) { minX = g.minCx * this.cellule; maxX = (g.maxCx + 1) * this.cellule; minY = g.minCy * this.cellule; maxY = (g.maxCy + 1) * this.cellule; }
    if (this.rover.ok) { minX = Math.min(minX, this.rover.x - 0.3); maxX = Math.max(maxX, this.rover.x + 0.3); minY = Math.min(minY, this.rover.y - 0.3); maxY = Math.max(maxY, this.rover.y + 0.3); }
    return Number.isFinite(minX) ? { minX, maxX, minY, maxY } : null;
  }

  /** Cadre toute la carte globale (le suivi est suspendu). */
  ajusterTout() {
    const e = this._etendueMetres();
    if (!e) return;
    this.suivre = false;
    this.vue.ppm = Math.min(PPM_MAX, Math.max(PPM_ABSOLU_MIN, this._ppmPourTout()));
    this.vue.cx = (e.minX + e.maxX) / 2; this.vue.cy = (e.minY + e.maxY) / 2;
    this._signalerVue();
  }

  /** Zoome autour d'un point de l'écran ; `geste` = vrai quand c'est la main de l'utilisateur (le suivi se suspend). */
  zoomer(facteur, px = this.largeur / 2, py = this.hauteur / 2, geste = false) {
    const v = this.vue;
    const wx = v.cx + (px - this.largeur / 2) / v.ppm;
    const wy = v.cy - (py - this.hauteur / 2) / v.ppm;
    v.ppm = Math.min(PPM_MAX, Math.max(this._ppmMin(), v.ppm * facteur));
    v.cx = wx - (px - this.largeur / 2) / v.ppm;
    v.cy = wy + (py - this.hauteur / 2) / v.ppm;
    if (geste) this.suivre = false;
    this._signalerVue();
  }

  _signalerVue() {
    this.invalide = true;
    this.dispatchEvent(new CustomEvent('vue', { detail: { suivre: this.suivre } }));
  }

  /** Distance en pixels d'une longueur en mètres, et l'inverse. */
  versEcran(x, y) {
    return [this.largeur / 2 + (x - this.vue.cx) * this.vue.ppm, this.hauteur / 2 - (y - this.vue.cy) * this.vue.ppm];
  }

  versMonde(px, py) {
    return [this.vue.cx + (px - this.largeur / 2) / this.vue.ppm, this.vue.cy - (py - this.hauteur / 2) / this.vue.ppm];
  }

  // ---------- Gestes ----------

  _brancher() {
    const c = this.canvas;
    c.style.touchAction = 'none';
    new ResizeObserver(() => this.redimensionner()).observe(c);
    c.addEventListener('pointerdown', (ev) => this._appui(ev));
    c.addEventListener('pointermove', (ev) => this._mouvement(ev));
    const fin = (ev) => this._levee(ev);
    c.addEventListener('pointerup', fin);
    c.addEventListener('pointercancel', fin);
    c.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const r = c.getBoundingClientRect();
      this.zoomer(ev.deltaY < 0 ? 1.15 : 1 / 1.15, ev.clientX - r.left, ev.clientY - r.top, true);
    }, { passive: false });
  }

  _position(ev) {
    const r = this.canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  _appui(ev) {
    try { this.canvas.setPointerCapture(ev.pointerId); } catch { /* pointeur déjà relâché */ }
    const p = this._position(ev);
    this._pointeurs.set(ev.pointerId, p);
    if (this._pointeurs.size === 1) this._geste = { depart: p, t: performance.now(), deplace: false, multi: false };
    else if (this._geste) this._geste.multi = true;
  }

  _mouvement(ev) {
    const avant = this._pointeurs.get(ev.pointerId);
    if (!avant || !this._geste) return;
    const p = this._position(ev);
    const g = this._geste;
    if (this._pointeurs.size === 1 && !g.multi) {
      if (!g.deplace && Math.hypot(p.x - g.depart.x, p.y - g.depart.y) > 9) g.deplace = true;
      if (g.deplace) {
        this.vue.cx -= (p.x - avant.x) / this.vue.ppm;
        this.vue.cy += (p.y - avant.y) / this.vue.ppm;
        this.invalide = true;
        if (this.suivre) { this.suivre = false; this._signalerVue(); }
      }
    } else if (this._pointeurs.size === 2) {
      // Pincer : le facteur de zoom est le rapport des écartements, centré sur le milieu des doigts.
      const autre = [...this._pointeurs.entries()].find(([id]) => id !== ev.pointerId)[1];
      const dAvant = Math.hypot(avant.x - autre.x, avant.y - autre.y);
      const dApres = Math.hypot(p.x - autre.x, p.y - autre.y);
      const mx = (p.x + autre.x) / 2; const my = (p.y + autre.y) / 2;
      const mxAvant = (avant.x + autre.x) / 2; const myAvant = (avant.y + autre.y) / 2;
      this.vue.cx -= (mx - mxAvant) / this.vue.ppm;
      this.vue.cy += (my - myAvant) / this.vue.ppm;
      this.invalide = true;
      if (dAvant > 4) this.zoomer(dApres / dAvant, mx, my, true);
      if (this.suivre) { this.suivre = false; this._signalerVue(); }
    }
    this._pointeurs.set(ev.pointerId, p);
  }

  _levee(ev) {
    if (!this._pointeurs.has(ev.pointerId)) return;
    const p = this._position(ev);
    this._pointeurs.delete(ev.pointerId);
    const g = this._geste;
    if (this._pointeurs.size === 0 && g) {
      const toucher = !g.deplace && !g.multi && ev.type === 'pointerup' && performance.now() - g.t < 700;
      this._geste = null;
      if (toucher) {
        const [x, y] = this.versMonde(p.x, p.y);
        this.surToucher(x, y);
      }
    }
  }

  // ---------- Dessin ----------

  redimensionner() {
    const r = this.canvas.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const premiere = this.largeur === 300 && this.hauteur === 300 && !this._dimensionne;
    this._dimensionne = true;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.invalide = true;
    this.largeur = r.width; this.hauteur = r.height;
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    if (premiere) this.vue.ppm = Math.min(this.largeur, this.hauteur) / 2.6;
  }

  demarrer() { if (!this.actif) { this.actif = true; requestAnimationFrame(this._boucle); } }
  arreter() { this.actif = false; }

  _boucle(t) {
    if (!this.actif) return;
    requestAnimationFrame(this._boucle);
    if (document.hidden) return;
    const maintenant = performance.now();
    const glisse = this._appliquerLissage(maintenant);
    // Économie : on ne redessine que si quelque chose a changé ou s'anime (rover qui glisse, échos, marqueur, suivi).
    const anime = glisse || this.echos.length > 0 || this.marqueur !== null || (this.suivre && this.rover.ok && this._ecartSuivi() > 0.0005);
    if (!this.invalide && !anime) return;
    this._dernier = t;
    this.invalide = false;
    const t0 = performance.now();
    this.dessiner();
    this.stats.images++;
    this.stats.dessinMs += performance.now() - t0;
  }

  /** Place le rover affiché (position, cap, tête du sonar) à l'endroit interpolé pour cette image. Vrai s'il glisse. */
  _appliquerLissage(maintenant) {
    if (!this.lissage) return false;
    const a = this.lisseur.lire(maintenant);
    if (!a) return false;
    const r = this.rover;
    const avant = r.x + r.y + r.cap + r.tete;
    r.x = a.x; r.y = a.y; r.cap = (a.cap * Math.PI) / 180; r.tete = (a.tete * Math.PI) / 180;
    if (this.trace.ajouter(r.x, r.y) && this.couches.trace) this.invalide = true; // la trace suit le rover affiché
    return this.lisseur.actif(maintenant) || avant !== r.x + r.y + r.cap + r.tete;
  }

  _ecartSuivi() {
    return Math.hypot(this.rover.x - this.vue.cx, this.rover.y - this.decalage * this.hauteur / this.vue.ppm - this.vue.cy);
  }

  /**
   * Recalcule les contours lissés des tuiles « sales » qui sont à l'écran (ou presque). Chaque tuile est calculée avec une
   * bordure d'une case empruntée à ses voisines, pour que les formes se raccordent sans couture d'une tuile à l'autre.
   * Au plus 12 fois par seconde et pendant 6 ms au plus : le reste attend l'image suivante.
   */
  _majFormes(visibles) {
    const maintenant = performance.now();
    if (maintenant - this._tFormes < 80) { this.invalide = true; return; }
    this._tFormes = maintenant;
    const debut = performance.now();
    const M = TUILE + 2;
    const padV = new Uint8Array(M * M); const padT = new Uint8Array(M * M);
    for (const tuile of visibles) {
      if (!tuile.sale && tuile.formes) continue;
      if (performance.now() - debut > 6) { this.invalide = true; return; }
      // la tuile et ses huit voisines
      const voisines = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) voisines.push(this.globale.tuile(tuile.tx + dx, tuile.ty + dy));
      for (let py = 0; py < M; py++) {
        const gy = py - 1; const oy = gy < 0 ? 0 : gy >= TUILE ? 2 : 1; const ly = gy < 0 ? TUILE - 1 : gy >= TUILE ? 0 : gy;
        for (let px = 0; px < M; px++) {
          const gx = px - 1; const ox = gx < 0 ? 0 : gx >= TUILE ? 2 : 1; const lx = gx < 0 ? TUILE - 1 : gx >= TUILE ? 0 : gx;
          const t = voisines[oy * 3 + ox];
          padV[py * M + px] = t ? t.v[ly * TUILE + lx] : 0;
          padT[py * M + px] = t ? t.t[ly * TUILE + lx] : 0;
        }
      }
      const touchee = (i) => {
        const c = i % M; const l = (i - c) / M;
        return padT[i] || (c > 0 && padT[i - 1]) || (c < M - 1 && padT[i + 1]) || (l > 0 && padT[i - M]) || (l < M - 1 && padT[i + M]);
      };
      const chemin = (predicat, iterations) => {
        const p = new Path2D();
        for (const b of boucles(padV, M, predicat)) {
          const lisse = adoucir(b, iterations);
          p.moveTo(lisse[0][0], lisse[0][1]);
          for (let i = 1; i < lisse.length; i++) p.lineTo(lisse[i][0], lisse[i][1]);
          p.closePath();
        }
        return p;
      };
      tuile.formes = {
        libre: chemin((v) => v === CASE_LIBRE, 3),
        possible: chemin((v) => v === CASE_POSSIBLE, 1),
        obstacle: chemin((v) => v === CASE_OCCUPEE, 2),
        touche: chemin((v, i) => v === CASE_OCCUPEE && !!touchee(i), 2),
      };
      tuile.sale = false;
    }
  }

  /** Dessine la carte globale : zone libre lisse, obstacles à contour net, inconnu = le fond. Seules les tuiles visibles. */
  _dessinerCarte() {
    const { ctx, vue } = this;
    const k = this.cellule * vue.ppm; // pixels par case
    const taille = TUILE * k;
    const px = 1 / k; // un pixel d'écran, en unités de case
    const visibles = [];
    for (const t of this.globale.tuiles.values()) {
      const [sx, sy] = this.versEcran(t.tx * TUILE * this.cellule, t.ty * TUILE * this.cellule); // coin bas gauche de la tuile
      if (sx > this.largeur + 2 || sx + taille < -2 || sy < -2 || sy - taille > this.hauteur + 2) continue;
      visibles.push(t);
      t.ecran = [sx, sy];
    }
    this._majFormes(visibles);
    const passe = (dessiner) => {
      for (const t of visibles) {
        if (!t.formes) continue;
        ctx.save();
        ctx.setTransform(this.dpr * k, 0, 0, -this.dpr * k, this.dpr * t.ecran[0], this.dpr * t.ecran[1]);
        ctx.beginPath(); ctx.rect(-0.03, -0.03, TUILE + 0.06, TUILE + 0.06); ctx.clip(); // chaque tuile reste dans son carré
        ctx.translate(-1, -1); // les formes sont calculées avec une bordure d'une case
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        dessiner(t.formes);
        ctx.restore();
      }
    };
    // zone libre : halo doux, surface, filet clair
    passe((f) => {
      ctx.strokeStyle = 'rgba(10, 74, 112, 0.35)'; ctx.lineWidth = 5 * px; ctx.stroke(f.libre);
      ctx.fillStyle = COULEURS.libre; ctx.fill(f.libre, 'nonzero');
      ctx.strokeStyle = COULEURS.libreBord; ctx.lineWidth = 1.2 * px; ctx.stroke(f.libre);
    });
    // possible : bien plus discret que les obstacles confirmés
    passe((f) => {
      ctx.fillStyle = COULEURS.possible; ctx.fill(f.possible, 'nonzero');
      ctx.strokeStyle = 'rgba(214, 192, 142, 0.35)'; ctx.lineWidth = 1 * px; ctx.stroke(f.possible);
    });
    // obstacles : formes pleines aux coins adoucis, contour net
    passe((f) => {
      ctx.fillStyle = COULEURS.obstacle; ctx.fill(f.obstacle, 'nonzero');
      ctx.fillStyle = COULEURS.touche; ctx.fill(f.touche, 'nonzero');
      ctx.strokeStyle = COULEURS.obstacleBord; ctx.lineWidth = 1.6 * px; ctx.stroke(f.obstacle);
    });
  }

  dessiner() {
    const { ctx, largeur: W, hauteur: H, vue } = this;
    const maintenant = performance.now();
    const k = 1 - Math.exp(-Math.min(100, maintenant - (this._tDessin ?? maintenant - 16)) / 60); // même glissement à 30 ou 60 images/s
    this._tDessin = maintenant;
    if (this.suivre && this.rover.ok) {
      vue.cx += (this.rover.x - vue.cx) * k;
      vue.cy += (this.rover.y - this.decalage * H / vue.ppm - vue.cy) * k;
    }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = COULEURS.fond;
    ctx.fillRect(0, 0, W, H);

    this._dessinerGrille();

    if (this.couches.carte) this._dessinerCarte();

    if (this.couches.base) this._dessinerBase();
    if (this.couches.trace) this._dessinerTrace();
    if (this.couches.chemin) this._dessinerChemin();
    this._dessinerCible();
    if (this.couches.echos) { this._dessinerEchos(); this._dessinerSonar(); }
    this._dessinerEtapes();
    this._dessinerMarqueur();
    this._dessinerRover();
    this._dessinerEchelle();
  }

  /** Quadrillage : deux tracés seulement (traits fins et traits au mètre), pas un par ligne. */
  _dessinerGrille() {
    const { ctx, largeur: W, hauteur: H, vue } = this;
    const pas = vue.ppm > 220 ? 0.1 : vue.ppm > 70 ? 0.5 : 1;
    const [xMin, yMax] = this.versMonde(0, 0);
    const [xMax, yMin] = this.versMonde(W, H);
    const fin = new Path2D(); const fort = new Path2D();
    for (let x = Math.ceil(xMin / pas) * pas; x <= xMax; x += pas) {
      const [px] = this.versEcran(x, 0);
      (Math.abs(Math.round(x) - x) < 1e-6 ? fort : fin).rect(Math.round(px), 0, 1, H);
    }
    for (let y = Math.ceil(yMin / pas) * pas; y <= yMax; y += pas) {
      const [, py] = this.versEcran(0, y);
      (Math.abs(Math.round(y) - y) < 1e-6 ? fort : fin).rect(0, Math.round(py), W, 1);
    }
    ctx.fillStyle = COULEURS.grille; ctx.fill(fin);
    ctx.fillStyle = COULEURS.grilleForte; ctx.fill(fort);
  }

  _dessinerBase() {
    const { ctx } = this;
    const [px, py] = this.versEcran(0, 0);
    ctx.save();
    ctx.translate(px, py);
    ctx.strokeStyle = COULEURS.base; ctx.fillStyle = COULEURS.base; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-5, 1); ctx.lineTo(0, -4); ctx.lineTo(5, 1); ctx.lineTo(5, 5); ctx.lineTo(-5, 5); ctx.closePath(); ctx.stroke();
    ctx.font = '500 11px Geist, system-ui, sans-serif'; ctx.textAlign = 'center';
    const d = this.rover.ok ? Math.hypot(this.rover.x, this.rover.y) : 0;
    ctx.fillText(d > 0.3 ? `base · ${formaterDistance(d)}` : 'base', 0, 22);
    ctx.restore();
    if (d > 0.3) { // pointillé du rover vers la base : « il croit que la base est par là »
      const [rx, ry] = this.versEcran(this.rover.x, this.rover.y);
      ctx.save();
      ctx.strokeStyle = COULEURS.base; ctx.globalAlpha = 0.45; ctx.lineWidth = 1.2; ctx.setLineDash([2, 6]);
      ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(px, py); ctx.stroke();
      ctx.restore();
    }
  }

  /** Trace du trajet : un trait fin qui s'estompe avec l'âge (pas de gribouillis orange quand le rover tourne). */
  _dessinerTrace() {
    const { ctx } = this;
    const points = this.trace.points;
    if (points.length < 2) return;
    const maintenant = performance.now();
    // quatre paliers d'âge : récent (< 8 s) bien visible, puis de plus en plus discret
    const paliers = [[8000, 0.85, 1.8], [25000, 0.5, 1.5], [80000, 0.28, 1.3], [Infinity, 0.13, 1.1]];
    const palier = (t) => { const a = maintenant - t; for (let i = 0; i < paliers.length; i++) if (a < paliers[i][0]) return i; return paliers.length - 1; };
    ctx.save();
    ctx.strokeStyle = COULEURS.trace; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (let pal = paliers.length - 1; pal >= 0; pal--) { // les plus vieux d'abord : le récent reste par-dessus
      ctx.globalAlpha = paliers[pal][1]; ctx.lineWidth = paliers[pal][2];
      ctx.beginPath();
      let enCours = false;
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const [px, py] = this.versEcran(p.x, p.y);
        if (palier(p.t ?? 0) === pal) {
          if (!enCours) {
            if (i > 0) { const q = points[i - 1]; const [qx, qy] = this.versEcran(q.x, q.y); ctx.moveTo(qx, qy); ctx.lineTo(px, py); } else ctx.moveTo(px, py);
            enCours = true;
          } else ctx.lineTo(px, py);
        } else enCours = false;
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  _dessinerChemin() {
    const { ctx, chemin, rover } = this;
    if (!chemin.length) return;
    ctx.strokeStyle = COULEURS.chemin; ctx.lineWidth = 2; ctx.setLineDash([7, 6]); ctx.globalAlpha = 0.85;
    ctx.beginPath();
    const [sx, sy] = this.versEcran(rover.x, rover.y);
    ctx.moveTo(sx, sy);
    chemin.forEach((p) => { const [px, py] = this.versEcran(p.x, p.y); ctx.lineTo(px, py); });
    ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    const fin = chemin[chemin.length - 1];
    const [ex, ey] = this.versEcran(fin.x, fin.y);
    ctx.fillStyle = COULEURS.chemin;
    ctx.beginPath(); ctx.moveTo(ex, ey - 6); ctx.lineTo(ex + 6, ey); ctx.lineTo(ex, ey + 6); ctx.lineTo(ex - 6, ey); ctx.closePath(); ctx.fill();
  }

  _dessinerCible() {
    const { ctx, cible } = this;
    if (!cible) return;
    const [px, py] = this.versEcran(cible.x, cible.y);
    ctx.strokeStyle = COULEURS.cible; ctx.fillStyle = COULEURS.cible; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(px, py, 10, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(px - 16, py); ctx.lineTo(px - 6, py); ctx.moveTo(px + 6, py); ctx.lineTo(px + 16, py);
    ctx.moveTo(px, py - 16); ctx.lineTo(px, py - 6); ctx.moveTo(px, py + 6); ctx.lineTo(px, py + 16); ctx.stroke();
  }

  /** Échos récents : de petits points qui s'estompent (jamais criards). */
  _dessinerEchos() {
    const { ctx } = this;
    const maintenant = performance.now();
    this.echos = this.echos.filter((e) => maintenant - e.t < DUREE_ECHO_MS);
    ctx.fillStyle = COULEURS.sonar;
    for (const e of this.echos) {
      const age = (maintenant - e.t) / DUREE_ECHO_MS;
      ctx.globalAlpha = Math.max(0, 1 - age) * 0.6;
      const [px, py] = this.versEcran(e.x, e.y);
      ctx.beginPath(); ctx.arc(px, py, 1.9 * (1 - age * 0.35), 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** Faisceau du sonar : un cône doux qui s'éteint avec la distance, et l'écho marqué à son point d'impact. */
  _dessinerSonar() {
    const { ctx, rover } = this;
    if (!rover.ok) return;
    const a = rover.cap + rover.tete; // angle absolu, horaire à partir de +y
    const mesure = rover.sonar > 0 && rover.sonar < 255;
    const portee = mesure ? rover.sonar / 100 : PORTEE_SONAR;
    const capteur = positionSonar(rover.x, rover.y, rover.cap); // le faisceau part du capteur, pas du centre
    const [sx, sy] = this.versEcran(capteur.x, capteur.y);
    const L = portee * this.vue.ppm;
    const ac = a - Math.PI / 2; // angle canvas
    const demi = (7.5 * Math.PI) / 180;
    const fort = mesure ? 1 : 0.55; // sans écho, le cône est plus pâle
    const degrade = ctx.createRadialGradient(sx, sy, 0, sx, sy, Math.max(L, 8));
    degrade.addColorStop(0, `rgba(29, 233, 198, ${0.30 * fort})`);
    degrade.addColorStop(0.55, `rgba(29, 233, 198, ${0.12 * fort})`);
    degrade.addColorStop(1, 'rgba(29, 233, 198, 0)');
    ctx.fillStyle = degrade;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.arc(sx, sy, L, ac - demi, ac + demi); ctx.closePath(); ctx.fill();
    // axe du faisceau, très fin
    const bx = sx + Math.cos(ac) * L; const by = sy + Math.sin(ac) * L;
    const axe = ctx.createLinearGradient(sx, sy, bx, by);
    axe.addColorStop(0, `rgba(29, 233, 198, ${0.5 * fort})`); axe.addColorStop(1, 'rgba(29, 233, 198, 0.05)');
    ctx.strokeStyle = axe; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(bx, by); ctx.stroke();
    if (mesure) { // l'écho, à son point d'impact
      ctx.fillStyle = 'rgba(224, 255, 250, 0.95)';
      ctx.beginPath(); ctx.arc(bx, by, 2.6, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(29, 233, 198, 0.45)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(bx, by, 6, 0, Math.PI * 2); ctx.stroke();
    }
  }

  /** Points de la patrouille : des pastilles numérotées reliées en boucle par un pointillé discret. */
  _dessinerEtapes() {
    const { ctx, etapes } = this;
    if (!etapes.length) return;
    const pts = etapes.map((p) => this.versEcran(p.x, p.y));
    ctx.save();
    if (pts.length > 1) {
      ctx.strokeStyle = 'rgba(233, 242, 247, 0.55)'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 6]);
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      if (pts.length > 2) ctx.closePath(); // en boucle : le dernier point retourne au premier
      ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.font = '600 13px Geist, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    pts.forEach(([px, py], i) => {
      ctx.fillStyle = 'rgba(5, 11, 18, 0.85)'; ctx.beginPath(); ctx.arc(px, py, 12, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = COULEURS.sonar; ctx.lineWidth = 1.6; ctx.stroke();
      ctx.fillStyle = '#e9f2f7'; ctx.fillText(String(i + 1), px, py + 0.5);
    });
    ctx.restore();
  }

  _dessinerMarqueur() {
    const { ctx, marqueur } = this;
    if (!marqueur) return;
    if (performance.now() - marqueur.t > 120000) { this.marqueur = null; return; }
    const [px, py] = this.versEcran(marqueur.x, marqueur.y);
    const pulse = ((performance.now() - marqueur.t) % 1400) / 1400;
    ctx.strokeStyle = COULEURS.marqueur; ctx.fillStyle = COULEURS.marqueur; ctx.lineWidth = 2;
    ctx.globalAlpha = 1 - pulse;
    ctx.beginPath(); ctx.arc(px, py, 8 + pulse * 22, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
    // petit fanion planté sur le point visé
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, py - 24); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(px, py - 24); ctx.lineTo(px + 15, py - 19); ctx.lineTo(px, py - 14); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.arc(px, py, 3.2, 0, Math.PI * 2); ctx.fill();
  }

  /**
   * Le rover, vu de dessus, à son gabarit réel (châssis 25 × 20 cm), 4 roues Mecanum avec leurs rouleaux en biais,
   * le capteur à ultrasons à l'avant (à 9,5 cm devant le centre) qui tourne avec l'angle de tête reçu.
   * Le devant est en haut du dessin : un chevron et le pare-chocs avant montrent le sens de marche.
   */
  _dessinerRover() {
    const { ctx, rover } = this;
    if (!rover.ok) return;
    const [px, py] = this.versEcran(rover.x, rover.y);
    const e = this.vue.ppm; // pixels par mètre
    const Lpx = LONGUEUR_ROVER * e;
    const k = Lpx < 34 ? 34 / Lpx : 1; // très dézoomé : on grossit un peu pour ne pas le perdre
    const detail = Lpx * k > 46;
    const demiL = LONGUEUR_ROVER / 2; const demiW = LARGEUR_ROVER / 2;
    ctx.save();
    ctx.translate(px, py);
    if (k > 1) { ctx.strokeStyle = 'rgba(29, 233, 198, 0.35)'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(0, 0, 16, 0, Math.PI * 2); ctx.stroke(); }
    ctx.rotate(rover.cap); // la rotation canvas positive = sens horaire : conforme au cap
    ctx.scale(e * k, e * k); // désormais 1 unité = 1 mètre ; le devant est vers −y
    const fil = 1.2 / (e * k); // un filet d'environ un pixel
    // ombre portée
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.beginPath(); ctx.roundRect(-demiW + 0.006, -demiL + 0.008, LARGEUR_ROVER, LONGUEUR_ROVER, 0.03); ctx.fill();
    // roues Mecanum : FG et RD à rouleaux « \ », FD et RG à rouleaux « / »
    const rx = demiW - 0.015; const ry = 0.076; const wl = 0.07; const ww = 0.03;
    for (const [sxr, syr] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const cx = sxr * rx; const cy = syr * ry;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.fillStyle = '#04080d';
      ctx.beginPath(); ctx.roundRect(-ww / 2, -wl / 2, ww, wl, 0.006); ctx.fill();
      if (detail) {
        ctx.save();
        ctx.beginPath(); ctx.roundRect(-ww / 2, -wl / 2, ww, wl, 0.006); ctx.clip();
        ctx.strokeStyle = 'rgba(150, 215, 230, 0.55)'; ctx.lineWidth = 0.0028;
        const pente = sxr * syr > 0 ? 1 : -1; // FG(−,−) et RD(+,+) : « \ »
        for (let t = -wl / 2 - ww; t < wl / 2 + ww; t += 0.0115) {
          ctx.beginPath(); ctx.moveTo(-ww / 2, t - pente * ww / 2); ctx.lineTo(ww / 2, t + pente * ww / 2); ctx.stroke();
        }
        ctx.restore();
      }
      ctx.strokeStyle = 'rgba(160, 220, 235, 0.55)'; ctx.lineWidth = fil;
      ctx.beginPath(); ctx.roundRect(-ww / 2, -wl / 2, ww, wl, 0.006); ctx.stroke();
      ctx.restore();
    }
    // châssis
    const corps = ctx.createLinearGradient(0, -demiL, 0, demiL);
    corps.addColorStop(0, '#22384c'); corps.addColorStop(1, '#0f1c29');
    ctx.fillStyle = corps;
    ctx.beginPath(); ctx.roundRect(-0.072, -demiL + 0.004, 0.144, LONGUEUR_ROVER - 0.008, 0.026); ctx.fill();
    ctx.strokeStyle = 'rgba(29, 233, 198, 0.85)'; ctx.lineWidth = fil * 1.1; ctx.stroke();
    if (detail) { // platine : un liseré intérieur
      ctx.strokeStyle = 'rgba(160, 220, 235, 0.16)'; ctx.lineWidth = fil;
      ctx.beginPath(); ctx.roundRect(-0.055, -0.1, 0.11, 0.2, 0.014); ctx.stroke();
    }
    // pare-chocs avant
    ctx.fillStyle = 'rgba(29, 233, 198, 0.9)';
    ctx.beginPath(); ctx.roundRect(-0.045, -demiL + 0.002, 0.09, 0.011, 0.004); ctx.fill();
    // chevron : le sens de marche
    ctx.strokeStyle = COULEURS.rover; ctx.lineWidth = 0.007; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-0.032, 0.012); ctx.lineTo(0, -0.034); ctx.lineTo(0.032, 0.012); ctx.stroke();
    // capteur à ultrasons : sur le devant, tourne avec l'angle de tête
    ctx.save();
    ctx.translate(0, -0.095);
    ctx.rotate(rover.tete);
    ctx.fillStyle = '#0b141d'; ctx.strokeStyle = 'rgba(29, 233, 198, 0.9)'; ctx.lineWidth = fil * 1.1;
    ctx.beginPath(); ctx.arc(0, 0, 0.0185, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#dff3f8';
    for (const dx of [-0.0085, 0.0085]) { ctx.beginPath(); ctx.arc(dx, -0.006, 0.0068, 0, Math.PI * 2); ctx.fill(); }
    ctx.strokeStyle = 'rgba(29, 233, 198, 0.9)'; ctx.lineWidth = 0.0035;
    ctx.beginPath(); ctx.moveTo(0, -0.006); ctx.lineTo(0, -0.026); ctx.stroke();
    ctx.restore();
    ctx.restore();
  }

  _dessinerEchelle() {
    const { ctx, hauteur: H, vue } = this;
    const longM = longueurRonde(90 / vue.ppm);
    const longPx = longM * vue.ppm;
    const x = 14; const y = H - 14 - this.margeBas;
    ctx.strokeStyle = COULEURS.texte; ctx.fillStyle = COULEURS.texte; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + longPx, y); ctx.lineTo(x + longPx, y - 5); ctx.stroke();
    ctx.font = '500 12px Geist, system-ui, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(formaterDistance(longM), x, y - 10);
    this.echelleTexte = formaterDistance(longM);
  }
}
