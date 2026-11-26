// bord.js — le tableau de bord : tension, vitesse, sonar, cap, drapeaux en clair,
// et le petit radar polaire de la tête du sonar.

import { DRAPEAUX_FR, NOMS_DRAPEAUX } from './protocole.js';
import { icone, libelleMode } from './icones.js';
import { echapper } from './reglages.js';
import { poserTexte, poserDonnee } from './utile.js';

// Estimation du niveau de batterie à partir de la tension.
// Le rover mesure la tension APRÈS son régulateur (6,0 V tant que les accus tiennent) : elle ne baisse
// qu'en fin de charge. 6,0 V = plein, 5,3 V = seuil d'alerte du rover. À adapter à votre rover.
export const V_VIDE = 5.3;
export const V_PLEIN = 6.0;

/** Pourcentage de batterie estimé (0 à 100). */
export const niveauBatterie = (volts) => Math.round(Math.min(1, Math.max(0, (volts - V_VIDE) / (V_PLEIN - V_VIDE))) * 100);

/** Nombre de barres (1 à 4) pour une force de signal en dBm ; 0 si inconnue. */
export function barresSignal(rssi) {
  if (!rssi) return 0;
  if (rssi >= -60) return 4;
  if (rssi >= -70) return 3;
  if (rssi >= -80) return 2;
  return 1;
}

const ORDRE_GRAVITE = { danger: 0, alerte: 1, info: 2, ok: 3 };

export class TableauDeBord {
  constructor(racine) {
    this.racine = racine;
    this.q = (s) => racine.querySelector(s);
    // On retrouve chaque élément UNE fois ; les trames d'état arrivent 10 fois par seconde.
    const ids = ['tension', 'batt-pct', 'batt-jauge', 'vitesse', 'sonar', 'cap', 'pos', 'libre', 'cible', 'mode', 'drapeaux'];
    this.el = Object.fromEntries(ids.map((id) => [id, racine.querySelector(`#b-${id}`)]));
    this.radar = new Radar(this.q('#radar-canvas'));
    this.drapeauxAffiches = '';
  }

  /** Met à jour tous les compteurs à partir d'une trame ÉTAT décodée. `modes` = liste des comportements. */
  majEtat(e, modes, pos = { x: e.x / 1000, y: e.y / 1000 }) { // pos : position absolue en mètres (la carte glisse avec le rover)
    const el = this.el;
    const virgule = (v, n) => v.toFixed(n).replace('.', ',');
    const pct = niveauBatterie(e.tension);
    poserTexte(el.tension, virgule(e.tension, 1));
    poserTexte(el['batt-pct'], `${pct} %`);
    if (el['batt-jauge']._pct !== pct) { el['batt-jauge']._pct = pct; el['batt-jauge'].style.setProperty('--niveau', `${pct}%`); }
    poserDonnee(el['batt-jauge'], 'niveau', pct < 15 || e.flags.batterie ? 'bas' : pct < 35 ? 'moyen' : 'bon');
    poserTexte(el.vitesse, e.vitesse);
    poserTexte(el.sonar, e.sonar === 0 ? '—' : e.sonar >= 255 ? '2,5+' : virgule(e.sonar / 100, 2));
    poserTexte(el.cap, Math.round((e.cap + 360) % 360));
    poserTexte(el.pos, `${virgule(pos.x, 2)} ; ${virgule(pos.y, 2)}`);
    poserTexte(el.libre, e.libre === 255 ? 'inconnue' : `${e.libre} cm`);
    poserTexte(el.cible, e.cibleD > 0 ? `${e.cibleD} cm, ${e.cibleGis > 0 ? '+' : ''}${e.cibleGis}°` : 'aucune');
    poserTexte(el.mode, modes[e.comportement] ? libelleMode(modes[e.comportement]) : (e.comportement === 0 ? 'Manuel' : `Mode n°${e.comportement}`));
    this._drapeaux(e);
    this.radar.majEtat(e);
  }

  _drapeaux(e) {
    const actifs = NOMS_DRAPEAUX.filter((n) => e.flags[n]);
    const cle = actifs.join(',');
    if (cle === this.drapeauxAffiches) return;
    this.drapeauxAffiches = cle;
    const liste = this.el.drapeaux;
    if (!actifs.length) { liste.innerHTML = '<li class="drapeau neutre">Rien à signaler</li>'; return; }
    actifs.sort((a, b) => ORDRE_GRAVITE[DRAPEAUX_FR[a].gravite] - ORDRE_GRAVITE[DRAPEAUX_FR[b].gravite]);
    liste.innerHTML = actifs.map((n) => {
      const d = DRAPEAUX_FR[n];
      const ico = d.gravite === 'ok' ? 'ok' : d.gravite === 'info' ? 'info' : 'alerte';
      return `<li class="drapeau ${d.gravite}">${icone(ico, 18)}<span>${echapper(d.texte)}</span></li>`;
    }).join('');
  }

  ajouterPoints(points) { this.radar.ajouterPoints(points); }
  demarrer() { this.radar.demarrer(); }
  arreter() { this.radar.arreter(); }
}

// ---------- Radar polaire ----------

export class Radar {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.echos = []; // { gis (rad), d (m), t }
    this.etat = { tete: 0, sonar: 0 };
    this.actif = false;
    this.portee = 2.55;
    this._dernier = 0;
    this._boucle = this._boucle.bind(this);
    new ResizeObserver(() => this._taille()).observe(canvas);
  }

  _taille() {
    const r = this.canvas.getBoundingClientRect();
    if (r.width < 2) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.l = r.width; this.h = r.height; this.dpr = dpr;
  }

  majEtat(e) { this.etat = { tete: e.tete, sonar: e.sonar }; }

  ajouterPoints(points) {
    const t = performance.now();
    for (const p of points) if (p.distance > 0) this.echos.push({ gis: (p.gisement * Math.PI) / 180, d: p.distance / 1000, t });
    if (this.echos.length > 300) this.echos.splice(0, this.echos.length - 300);
  }

  demarrer() { if (!this.actif) { this.actif = true; this._taille(); requestAnimationFrame(this._boucle); } }
  arreter() { this.actif = false; }

  _boucle(t) {
    if (!this.actif) return;
    requestAnimationFrame(this._boucle);
    if (document.hidden || t - this._dernier < 40) return;
    this._dernier = t;
    this.dessiner();
  }

  dessiner() {
    if (!this.l) return;
    const { ctx, l: W, h: H } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2; const cy = H - 14;
    const R = Math.min(W / 2 - 10, H - 30);
    // Demi-disque : anneaux tous les 50 cm (0,5 / 1 / 1,5 / 2 / 2,5 m) et rayons tous les 30°.
    ctx.strokeStyle = 'rgba(238,240,245,0.10)'; ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(238,240,245,0.6)'; ctx.font = '500 10px Geist, system-ui, sans-serif'; ctx.textAlign = 'center';
    for (let m = 0.5; m <= this.portee + 0.01; m += 0.5) {
      const r = (m / this.portee) * R;
      ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI, 2 * Math.PI); ctx.stroke();
      ctx.fillText(`${String(m).replace('.', ',')} m`, cx + r - 14, cy - 3);
    }
    for (let a = -90; a <= 90; a += 30) {
      const ra = (a * Math.PI) / 180;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.sin(ra) * R, cy - Math.cos(ra) * R); ctx.stroke();
    }
    // Échos qui s'estompent
    const maintenant = performance.now();
    this.echos = this.echos.filter((e) => maintenant - e.t < 3500);
    for (const e of this.echos) {
      const age = (maintenant - e.t) / 3500;
      ctx.fillStyle = `rgba(79,227,208,${(1 - age) * 0.95})`;
      const r = Math.min(e.d / this.portee, 1) * R;
      ctx.beginPath(); ctx.arc(cx + Math.sin(e.gis) * r, cy - Math.cos(e.gis) * r, 3.2, 0, Math.PI * 2); ctx.fill();
    }
    // Rayon de la tête
    const a = (this.etat.tete * Math.PI) / 180;
    const longueur = this.etat.sonar > 0 && this.etat.sonar < 255 ? Math.min(this.etat.sonar / 100 / this.portee, 1) * R : R;
    ctx.strokeStyle = '#4fe3d0'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.sin(a) * longueur, cy - Math.cos(a) * longueur); ctx.stroke();
    // Le rover, vu de dessus, en bas
    ctx.fillStyle = '#f5a83a';
    ctx.beginPath(); ctx.moveTo(cx, cy - 9); ctx.lineTo(cx + 7, cy + 5); ctx.lineTo(cx - 7, cy + 5); ctx.closePath(); ctx.fill();
  }
}
