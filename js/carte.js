// carte.js — la carte en direct (canvas) : cases libres / occupées / inconnues, rover à l'échelle,
// trace du trajet, faisceau du sonar, échos qui s'estompent, chemin prévu, cible, base, marqueur.
//
// Style « carte marine » : l'inconnu est un fond sombre quadrillé, l'espace libre est de l'eau,
// les obstacles sont de la terre (sable clair), et le sonar balaie comme sur un écran de bateau.
//
// Gestes : un doigt qui glisse déplace la carte, deux doigts pincent pour zoomer, un simple
// toucher envoie le rover à cet endroit (l'application reçoit l'événement via `surToucher`).

import { TAILLE_CARTE, CASE_LIBRE, CASE_OCCUPEE, appliquerCarte } from './protocole.js';
import { LARGEUR_ROVER, LONGUEUR_ROVER, positionSonar } from './gabarit.js';

// Palette de la carte (mêmes tons que l'interface : encre, eau, sable, turquoise du sonar, ambre du rover).
const COULEURS = {
  fond: '#07080d',
  grille: 'rgba(238, 240, 245, 0.05)',
  grilleForte: 'rgba(238, 240, 245, 0.11)',
  texte: 'rgba(238, 240, 245, 0.7)',
  libre: [16, 48, 72],
  occupe: [217, 199, 154],
  sonar: '#4fe3d0',
  rover: '#f5a83a',
  trace: 'rgba(245, 168, 58, 0.5)',
  chemin: '#eef0f5',
  cible: '#eef0f5',
  marqueur: '#eef0f5',
  base: '#a3a9b8',
};

const PPM_MIN = 30; // pixels par mètre
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
    this.grille = new Uint8Array(TAILLE_CARTE * TAILLE_CARTE);
    this.couche = document.createElement('canvas');
    this.couche.width = this.couche.height = TAILLE_CARTE;
    this.coucheCtx = this.couche.getContext('2d');
    this.image = this.coucheCtx.createImageData(TAILLE_CARTE, TAILLE_CARTE);
    this.sale = true; // la couche doit être recalculée
    this.invalide = true; // il faut redessiner (on ne redessine rien quand rien ne change)
    this.rover = { x: 0, y: 0, cap: 0, tete: 0, sonar: 0, ok: false }; // mètres, radians
    this.trace = [];
    this.echos = [];
    this.chemin = [];
    this.cible = null;
    this.marqueur = null;
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

  definirCellule(m) { if (m > 0.005 && m < 1) this.cellule = m; }

  /** Applique une trame CARTE décodée. */
  appliquerCarte(msg) { if (appliquerCarte(this.grille, msg) > 0) this.sale = this.invalide = true; }

  effacerCarte() { this.grille.fill(0); this.sale = this.invalide = true; }

  /** Met à jour la position du rover à partir d'une trame ÉTAT décodée. */
  majEtat(e) {
    const r = this.rover;
    const memo = `${e.x},${e.y},${e.cap},${e.tete},${e.sonar},${e.cibleD},${e.cibleGis}`;
    if (memo !== this._memoEtat) { this._memoEtat = memo; this.invalide = true; }
    r.x = e.x / 1000; r.y = e.y / 1000; r.cap = (e.cap * Math.PI) / 180;
    r.tete = (e.tete * Math.PI) / 180; r.sonar = e.sonar; r.ok = true;
    const dern = this.trace[this.trace.length - 1];
    if (!dern || Math.hypot(r.x - dern.x, r.y - dern.y) > 0.03) {
      this.trace.push({ x: r.x, y: r.y });
      if (this.trace.length > 2000) this.trace.shift();
    }
    if (e.cibleD > 0) {
      const a = r.cap + (e.cibleGis * Math.PI) / 180;
      this.cible = { x: r.x + Math.sin(a) * (e.cibleD / 100), y: r.y + Math.cos(a) * (e.cibleD / 100) };
    } else this.cible = null;
    if (this.marqueur && Math.hypot(this.marqueur.x - r.x, this.marqueur.y - r.y) < 0.1) this.marqueur = null;
  }

  ajouterPoints(points) {
    const maintenant = performance.now();
    for (const p of points) {
      if (p.distance > 0) { this.echos.push({ x: p.x / 1000, y: p.y / 1000, t: maintenant }); this.invalide = true; }
    }
    if (this.echos.length > 600) this.echos.splice(0, this.echos.length - 600);
  }

  definirChemin(points) { this.chemin = points.map((p) => ({ x: p.x / 1000, y: p.y / 1000 })); this.invalide = true; }

  poserMarqueur(x, y) { this.marqueur = { x, y, t: performance.now() }; this.invalide = true; }
  retirerMarqueur() { this.marqueur = null; this.invalide = true; }

  /** Après « recaler » : nouvelle origine, tout l'historique géométrique est caduc. */
  reinitialiserTrajet() { this.trace = []; this.echos = []; this.chemin = []; this.marqueur = null; this.cible = null; this.invalide = true; }

  // ---------- Vue ----------

  recentrer() { this.suivre = true; this.vue.ppm = Math.min(this.largeur, this.hauteur) / 2.6; this._signalerVue(); }

  zoomer(facteur, px = this.largeur / 2, py = this.hauteur / 2) {
    const v = this.vue;
    const wx = v.cx + (px - this.largeur / 2) / v.ppm;
    const wy = v.cy - (py - this.hauteur / 2) / v.ppm;
    v.ppm = Math.min(PPM_MAX, Math.max(PPM_MIN, v.ppm * facteur));
    v.cx = wx - (px - this.largeur / 2) / v.ppm;
    v.cy = wy + (py - this.hauteur / 2) / v.ppm;
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
      this.zoomer(ev.deltaY < 0 ? 1.15 : 1 / 1.15, ev.clientX - r.left, ev.clientY - r.top);
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
      if (dAvant > 4) this.zoomer(dApres / dAvant, mx, my);
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
    if (document.hidden || t - this._dernier < 30) return; // ~30 images par seconde au plus
    // Économie : on ne redessine que si quelque chose a changé ou s'anime (échos, marqueur, suivi).
    const anime = this.echos.length > 0 || this.marqueur !== null || (this.suivre && this.rover.ok && this._ecartSuivi() > 0.0005);
    if (!this.invalide && !anime) return;
    this._dernier = t;
    this.invalide = false;
    this.dessiner();
  }

  _ecartSuivi() {
    return Math.hypot(this.rover.x - this.vue.cx, this.rover.y - this.decalage * this.hauteur / this.vue.ppm - this.vue.cy);
  }

  /** Reconstruit la petite image 64×64 des cases (ligne 0 = bas de la carte, donc retournée). */
  _majCouche() {
    const d = this.image.data;
    const N = TAILLE_CARTE;
    for (let l = 0; l < N; l++) {
      for (let c = 0; c < N; c++) {
        const v = this.grille[l * N + c];
        const o = ((N - 1 - l) * N + c) * 4;
        if (v === CASE_LIBRE) { [d[o], d[o + 1], d[o + 2]] = COULEURS.libre; d[o + 3] = 255; }
        else if (v === CASE_OCCUPEE) { [d[o], d[o + 1], d[o + 2]] = COULEURS.occupe; d[o + 3] = 255; }
        else d[o + 3] = 0;
      }
    }
    this.coucheCtx.putImageData(this.image, 0, 0);
    this.sale = false;
  }

  dessiner() {
    const { ctx, largeur: W, hauteur: H, vue } = this;
    if (this.suivre && this.rover.ok) {
      vue.cx += (this.rover.x - vue.cx) * 0.2;
      vue.cy += (this.rover.y - this.decalage * H / vue.ppm - vue.cy) * 0.2;
    }
    if (this.sale) this._majCouche();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = COULEURS.fond;
    ctx.fillRect(0, 0, W, H);

    this._dessinerGrille();

    // Cases de la carte : image 64×64 agrandie sans lissage (carrés nets).
    const demi = (TAILLE_CARTE / 2) * this.cellule;
    const [x0, y0] = this.versEcran(-demi, demi);
    const taille = TAILLE_CARTE * this.cellule * vue.ppm;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.couche, x0, y0, taille, taille);
    ctx.strokeStyle = 'rgba(238,240,245,0.16)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 5]);
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, taille, taille);
    ctx.setLineDash([]);

    this._dessinerBase();
    this._dessinerTrace();
    this._dessinerChemin();
    this._dessinerCible();
    this._dessinerEchos();
    this._dessinerSonar();
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

  _dessinerTrace() {
    const { ctx, trace } = this;
    if (trace.length < 2) return;
    ctx.strokeStyle = COULEURS.trace; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    trace.forEach((p, i) => { const [px, py] = this.versEcran(p.x, p.y); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
    ctx.stroke();
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

  _dessinerEchos() {
    const { ctx } = this;
    const maintenant = performance.now();
    this.echos = this.echos.filter((e) => maintenant - e.t < DUREE_ECHO_MS);
    ctx.fillStyle = COULEURS.sonar;
    for (const e of this.echos) {
      const age = (maintenant - e.t) / DUREE_ECHO_MS;
      ctx.globalAlpha = Math.max(0, 1 - age) * 0.95;
      const [px, py] = this.versEcran(e.x, e.y);
      ctx.beginPath(); ctx.arc(px, py, 2.6 * (1 - age * 0.4), 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  _dessinerSonar() {
    const { ctx, rover } = this;
    if (!rover.ok) return;
    const a = rover.cap + rover.tete; // angle absolu, horaire à partir de +y
    const portee = rover.sonar > 0 && rover.sonar < 255 ? rover.sonar / 100 : PORTEE_SONAR;
    const capteur = positionSonar(rover.x, rover.y, rover.cap); // le faisceau part du capteur, pas du centre
    const [sx, sy] = this.versEcran(capteur.x, capteur.y);
    const L = portee * this.vue.ppm;
    // Sur l'écran, l'angle horaire depuis le haut = angle canvas (depuis +x, horaire) − 90°.
    const ac = a - Math.PI / 2;
    const demi = (8 * Math.PI) / 180;
    ctx.fillStyle = 'rgba(79, 227, 208, 0.13)';
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.arc(sx, sy, L, ac - demi, ac + demi); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = COULEURS.sonar; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + Math.cos(ac) * L, sy + Math.sin(ac) * L); ctx.stroke();
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

  _dessinerRover() {
    const { ctx, rover } = this;
    if (!rover.ok) return;
    const [px, py] = this.versEcran(rover.x, rover.y);
    const e = this.vue.ppm; // pixels par mètre : le rover est dessiné à l'échelle
    const L = LONGUEUR_ROVER * e; const l = LARGEUR_ROVER * e;
    ctx.save();
    ctx.translate(px, py);
    // Halo minimal pour retrouver le rover quand on dézoome beaucoup.
    if (L < 20) {
      ctx.strokeStyle = 'rgba(245,168,58,0.5)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(0, 0, 13, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.rotate(rover.cap); // la rotation canvas positive = sens horaire : conforme au cap
    const roue = { l: Math.max(2, l * 0.2), h: Math.max(3, L * 0.26) };
    ctx.fillStyle = '#1a1e28'; ctx.strokeStyle = COULEURS.rover; ctx.lineWidth = 1.5;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      ctx.fillRect(sx * (l / 2) - (sx > 0 ? 0 : roue.l * 0.9), sy * (L / 2 - roue.h * 0.6) - roue.h / 2, roue.l * 0.9, roue.h);
    }
    ctx.fillStyle = '#0b0d14';
    ctx.beginPath(); ctx.roundRect(-l / 2, -L / 2, l, L, Math.max(2, l * 0.18)); ctx.fill(); ctx.stroke();
    // flèche d'avant
    ctx.fillStyle = COULEURS.rover;
    ctx.beginPath(); ctx.moveTo(0, -L / 2 - Math.max(3, L * 0.16)); ctx.lineTo(l * 0.3, -L * 0.12); ctx.lineTo(-l * 0.3, -L * 0.12); ctx.closePath(); ctx.fill();
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
