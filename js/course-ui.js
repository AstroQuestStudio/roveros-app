// course-ui.js — la carte « Course » de l'onglet Comportements : chronomètre, résumé, records, rejeu.
// Le rejeu dessine la trace du trajet (vitesse en couleur) et fait avancer un point à vitesse réelle.
// Les instants sont ceux de performance.now() : app.js les passe à chaque appel.

import { Course, ETATS, enTrame, Records, positionRejeu, couleurVitesse } from './course.js';

export const formaterSecondes = (s) => `${(s ?? 0).toFixed(1).replace('.', ',')} s`;
export const formaterVitesse = (v) => `${(v ?? 0).toFixed(2).replace('.', ',')} m/s`;
export const formaterDistance = (m) => `${Number(m ?? 0).toFixed(1).replace('.', ',')} m`;

/** Phrase d'écart au record, pour une course arrivée (d = résumé de la course). */
export function texteEcart(d) {
  const b = d.meilleurAvant;
  if (!b) return 'premier temps à cette distance';
  if (d.rang === 0) return `${formaterSecondes(b.temps - d.temps)} de mieux que l’ancien record`;
  return `+${formaterSecondes(d.temps - b.temps)} par rapport au record`;
}

export class CourseJeu {
  /** @param {Document} doc  @param {Records} [records]  les records sont lus et écrits via ce gestionnaire */
  constructor(doc = document, records = new Records()) {
    this.doc = doc;
    this.jeu = new Course();
    this.records = records;
    this.derniere = null; // résumé de la dernière course terminée
    this.distance = 3;
    this.raf = null;
    this.rejeu = { t: 0, vitesse: 1, dernier: 0, raf: null };
    const $ = (id) => doc.getElementById(id);
    this.el = {
      carte: $('course-carte'), etat: $('course-etat'), aide: $('course-aide'), chrono: $('course-chrono'),
      resume: $('course-resume'), temps: $('course-r-temps'), moyenne: $('course-r-moyenne'), pointe: $('course-r-pointe'),
      ralenti: $('course-r-ralenti'), ecart: $('course-r-ecart'), nouveau: $('course-nouveau'), titre: $('course-records-titre'),
      liste: $('course-records'), revoir: $('course-revoir'), effacer: $('course-effacer'), rejeuBoite: $('course-rejeu'),
      canvas: $('course-canvas'), rejeuInfo: $('course-rejeu-info'), vitesses: doc.querySelectorAll('[data-rejeu-vitesse]'),
    };
    this.el.revoir?.addEventListener('click', () => this.revoir());
    this.el.effacer?.addEventListener('click', () => { this.records.effacer(); this.rendre(); });
    this.el.vitesses.forEach((b) => b.addEventListener('click', () => this._choisirVitesse(Number(b.dataset.rejeuVitesse))));
    this._choisirVitesse(this.rejeu.vitesse);
    this.rendre();
  }

  /** Une course vient d'être lancée (distance en m). */
  lancer(distance, t) {
    this.arreterRejeu();
    this.distance = distance;
    this.jeu.lancer(distance, t);
    this.derniere = null;
    this.rendre();
    this._boucleChrono();
  }

  /** Un état du rover (trame décodée). Sans effet hors course. */
  etat(e, t) {
    if (!this.jeu.enCours) return;
    this.jeu.mesurer(enTrame(e), t);
    if (!this.jeu.enCours) this._terminer();
  }

  /** Une ligne de texte du rover. */
  ligne(texte, t) {
    if (!this.jeu.enCours) return;
    this.jeu.ligne(texte, t);
    if (!this.jeu.enCours) this._terminer();
  }

  arreter(t) { if (this.jeu.enCours) { this.jeu.arreter(t); this._terminer(); } }
  deconnexion(t) { if (this.jeu.enCours) { this.jeu.deconnexion(t); this._terminer(); } }
  commande(texte, t) { if (this.jeu.enCours) { this.jeu.commande(texte, t); if (!this.jeu.enCours) this._terminer(); } }

  _terminer() {
    cancelAnimationFrame(this.raf); this.raf = null;
    const r = this.jeu.resume();
    const meilleurAvant = this.records.meilleur(r.distanceCible);
    let rang = -1;
    if (r.etat === ETATS.ARRIVE && r.temps !== null) rang = this.records.enregistrer(r.distanceCible, r.temps);
    this.derniere = { ...r, meilleurAvant, rang, duree: this.jeu.duree(performance.now()) };
    this.rendre();
  }

  _boucleChrono() {
    cancelAnimationFrame(this.raf);
    const tick = () => {
      if (!this.jeu.enCours) { this.raf = null; return; }
      if (this.el.chrono) this.el.chrono.textContent = formaterSecondes(this.jeu.duree(performance.now()));
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Affichage selon l'état de la course. */
  rendre() {
    const { el, jeu } = this;
    if (!el.carte) return;
    const d = this.derniere;
    const arrivee = d !== null && d.etat === ETATS.ARRIVE && d.temps !== null;
    const dist = d ? d.distanceCible : (jeu.enCours ? jeu.distanceCible : this.distance);
    const classement = this.records.classement(dist);
    if (el.titre) el.titre.textContent = `Records à ${formaterDistance(dist)}`;
    if (el.etat) {
      el.etat.textContent = jeu.enCours
        ? (jeu.tDepart === null ? 'En attente du départ' : 'En course')
        : d ? ({ [ETATS.ARRIVE]: 'Arrivée', [ETATS.ABANDON]: 'Abandonnée' })[d.etat] : 'Prête';
    }
    if (el.aide) {
      el.aide.hidden = jeu.enCours;
      el.aide.textContent = d && d.etat === ETATS.ABANDON
        ? `Course abandonnée (${d.raison}). Aucun temps enregistré.`
        : 'Le rover roule droit devant sur la distance choisie, le plus vite possible. Le chrono part au premier mouvement réel.';
    }
    if (el.chrono) el.chrono.textContent = formaterSecondes(jeu.enCours ? jeu.duree(performance.now()) : d ? d.duree : 0);
    if (el.resume) el.resume.hidden = !arrivee;
    if (arrivee) {
      if (el.temps) el.temps.textContent = formaterSecondes(d.temps);
      if (el.moyenne) el.moyenne.textContent = formaterVitesse(d.moyenne);
      if (el.pointe) el.pointe.textContent = formaterVitesse(d.pointe);
      if (el.ralenti) el.ralenti.textContent = String(d.ralentissements);
      if (el.ecart) el.ecart.textContent = texteEcart(d);
    }
    if (el.nouveau) el.nouveau.hidden = !(arrivee && d.rang === 0);
    if (el.liste) {
      const lignes = classement.map((r, i) => {
        const li = this.doc.createElement('li');
        li.textContent = `${formaterSecondes(r.temps)} · ${new Date(r.date).toLocaleDateString('fr-FR')}`;
        if (d && d.rang === i) li.classList.add('actif');
        return li;
      });
      if (!lignes.length) {
        const li = this.doc.createElement('li');
        li.textContent = 'Aucun temps encore à cette distance';
        lignes.push(li);
      }
      el.liste.replaceChildren(...lignes);
    }
    if (el.revoir) el.revoir.disabled = !(d && d.trace && d.trace.length > 1);
  }

  // ----- Rejeu -----

  revoir() {
    if (!this.derniere?.trace?.length || !this.el.rejeuBoite || !this.el.canvas) return;
    this.el.rejeuBoite.hidden = false;
    this.rejeu.t = 0;
    this.rejeu.dernier = performance.now();
    this.arreterRejeu(true);
    this.rejeu.raf = requestAnimationFrame(this._tickRejeu);
  }

  _choisirVitesse(v) {
    this.rejeu.vitesse = v;
    this.el.vitesses.forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.rejeuVitesse) === v)));
  }

  arreterRejeu(silencieux = false) {
    cancelAnimationFrame(this.rejeu.raf); this.rejeu.raf = null;
    if (!silencieux && this.el.rejeuBoite) this.el.rejeuBoite.hidden = true;
  }

  _tickRejeu = () => {
    const trace = this.derniere?.trace ?? [];
    const fin = trace.length ? trace[trace.length - 1].t : 0;
    const now = performance.now();
    this.rejeu.t = Math.min(fin, this.rejeu.t + ((now - this.rejeu.dernier) / 1000) * this.rejeu.vitesse);
    this.rejeu.dernier = now;
    this.dessinerRejeu();
    this.rejeu.raf = this.rejeu.t < fin ? requestAnimationFrame(this._tickRejeu) : null;
  };

  dessinerRejeu() {
    const c = this.el.canvas;
    const trace = this.derniere?.trace ?? [];
    if (!c || trace.length < 2) return;
    const dpr = globalThis.devicePixelRatio || 1;
    const w = c.clientWidth || 320;
    const h = c.clientHeight || 240;
    // La taille du canevas ne change qu'au besoin : la redéfinir efface le dessin et coûte cher à chaque image.
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const marge = 18;
    const xs = trace.map((p) => p.x); const ys = trace.map((p) => p.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const s = Math.min((w - 2 * marge) / Math.max(x1 - x0, 0.2), (h - 2 * marge) / Math.max(y1 - y0, 0.2));
    const ecran = (x, y) => [marge + (x - x0) * s + ((w - 2 * marge) - (x1 - x0) * s) / 2, h - marge - (y - y0) * s - ((h - 2 * marge) - (y1 - y0) * s) / 2];
    const vmax = Math.max(...trace.map((p) => p.v), 0.01);
    ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (let i = 1; i < trace.length; i++) {
      const [ax, ay] = ecran(trace[i - 1].x, trace[i - 1].y);
      const [bx, by] = ecran(trace[i].x, trace[i].y);
      ctx.strokeStyle = couleurVitesse(trace[i].v, vmax);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    }
    const [dx, dy] = ecran(trace[0].x, trace[0].y);
    ctx.fillStyle = '#9aa4b2'; ctx.beginPath(); ctx.arc(dx, dy, 4, 0, Math.PI * 2); ctx.fill();
    const p = positionRejeu(trace, this.rejeu.t);
    const [px, py] = ecran(p.x, p.y);
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.fill();
    if (this.el.rejeuInfo) this.el.rejeuInfo.textContent = `${formaterSecondes(this.rejeu.t)} sur ${formaterSecondes(trace.at(-1).t)} · ${formaterVitesse(p.v)} · ×${this.rejeu.vitesse}`;
  }
}
