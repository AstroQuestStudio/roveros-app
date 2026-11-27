// course.js — le jeu de la course (mode « course ») : chronomètre, mesures, records, rejeu.
// Logique pure : aucun DOM ici. Le rover annonce, la course mesure. Les temps sont en ms (horloge
// de l'application), les distances en m, les vitesses en m/s.

export const ETATS = { PRET: 'pret', EN_COURSE: 'en_course', ARRIVE: 'arrive', ABANDON: 'abandonne' };
export const SEUIL_DEPART = 0.02; // m/s : au-delà, le rover roule vraiment
export const SEUIL_RALENTI = 0.3; // fraction de la pointe en dessous de laquelle on parle de ralentissement
export const DUREE_RALENTI = 0.3; // s
export const PAS_TRACE = 100; // ms : 10 échantillons par seconde au plus
export const MAX_TRACE = 3000;
export const MAX_RECORDS = 5;
export const CLE_RECORDS = 'roveros.course.records';

/** Trame d'état décodée (mm, cm/s) vers les unités du jeu (m, m/s). */
export function enTrame(e) {
  return { x: e.x / 1000, y: e.y / 1000, v: e.vitesse / 100, arrive: e.flags?.arrive === true ? true : e.flags?.arrive === false ? false : undefined };
}

/** Machine « prêt → en course → arrivé / abandonné ». Une seule course à la fois. */
export class Course {
  constructor() { this.reinitialiser(); }

  reinitialiser() {
    this.etat = ETATS.PRET;
    this.distanceCible = 0;
    this.tDepart = null; // ms : premier état où le rover roule vraiment
    this.tFin = null;
    this.dernier = null; // {x, y, v} du dernier état pris en compte
    this.distance = 0; // m parcourus depuis le départ réel
    this.pointe = 0; // m/s
    this.ralentissements = 0;
    this.debutRalenti = null;
    this.ralentiCompte = false;
    this.arriveVu = false; // le drapeau « arrive » est retombé au moins une fois depuis le lancement
    this.trace = []; // {t (s depuis le départ), x, y, v}
    this.derniereTrace = -Infinity;
    this.temps = null; // s, départ réel → arrivée (null si pas arrivé)
    this.moyenne = null; // m/s : distance parcourue / temps
    this.raison = null; // pourquoi on a abandonné
  }

  get enCours() { return this.etat === ETATS.EN_COURSE; }

  lancer(distance, t) {
    this.reinitialiser();
    this.etat = ETATS.EN_COURSE;
    this.distanceCible = distance;
    this.tLancement = t;
  }

  /** Un état du rover, en unités du jeu (voir enTrame). */
  mesurer(e, t) {
    if (!this.enCours) return;
    if (e.arrive === false) this.arriveVu = true;
    if (this.tDepart === null) {
      if (e.v > SEUIL_DEPART) this._demarrer(e, t);
    } else {
      this._avancer(e, t);
    }
    if (this.enCours && e.arrive === true && this.arriveVu) this._arriver(t);
  }

  /** Une ligne de texte du rover (« evt arrivé », « err … », « evt objectif abandonné »). */
  ligne(texte, t) {
    if (!this.enCours) return;
    const s = String(texte ?? '').trim();
    const message = s.replace(/^(evt|err)\s+/i, '');
    if (/^err\b/i.test(s)) { this.abandonner(`rover : ${message}`, t); return; }
    // « objectif abandonné » peut arriver du rover à cause de la commande elle-même : on n'en tient compte qu'en roulant
    if (/objectif abandonn/i.test(message)) { if (this.tDepart !== null) this.abandonner('le rover a abandonné', t); return; }
    if (/arriv[ée]/i.test(message)) this._arriver(t); // « arrivé » (le é n'est pas un caractère de mot pour \b)
  }

  /** STOP, déconnexion, ou toute autre commande de mode envoyée pendant la course. */
  arreter(t) { this.abandonner('arrêt (STOP)', t); }
  deconnexion(t) { this.abandonner('liaison perdue', t); }

  /** Une commande texte envoyée : « mode … » autre que la course elle-même arrête la course. */
  commande(texte, t) {
    if (/^mode\b/i.test(String(texte).trim()) && !/^mode course\b/i.test(String(texte).trim())) this.abandonner('autre commande', t);
  }

  abandonner(raison, t) {
    if (!this.enCours) return;
    this.etat = ETATS.ABANDON;
    this.raison = raison;
    this.tFin = t;
  }

  /** Durée affichée, en s : elle tourne pendant la course et s'arrête à l'arrivée ou à l'abandon. */
  duree(t) {
    if (this.tDepart === null) return 0;
    return ((this.tFin ?? t) - this.tDepart) / 1000;
  }

  resume() {
    return {
      etat: this.etat,
      distanceCible: this.distanceCible,
      distance: this.distance,
      temps: this.temps,
      moyenne: this.moyenne,
      pointe: this.pointe,
      ralentissements: this.ralentissements,
      raison: this.raison,
      trace: this.trace,
    };
  }

  _demarrer(e, t) {
    this.tDepart = t;
    this.dernier = { x: e.x, y: e.y, v: e.v };
    this.pointe = e.v;
    this._echantillonner(e, t, false);
  }

  _avancer(e, t) {
    this.distance += Math.hypot(e.x - this.dernier.x, e.y - this.dernier.y);
    this.dernier = { x: e.x, y: e.y, v: e.v };
    this.pointe = Math.max(this.pointe, e.v);
    this._ralentir(e.v, t);
    this._echantillonner(e, t, false);
  }

  /** Un ralentissement = vitesse sous 30 % de la pointe pendant plus de 0,3 s, compté une fois par épisode. */
  _ralentir(v, t) {
    if (v < SEUIL_RALENTI * this.pointe) {
      if (this.debutRalenti === null) this.debutRalenti = t;
      if (!this.ralentiCompte && (t - this.debutRalenti) / 1000 > DUREE_RALENTI) {
        this.ralentissements += 1;
        this.ralentiCompte = true;
      }
    } else {
      this.debutRalenti = null;
      this.ralentiCompte = false;
    }
  }

  _echantillonner(e, t, force) {
    const point = { t: (t - this.tDepart) / 1000, x: e.x, y: e.y, v: e.v };
    if (force) {
      if (this.trace.length < MAX_TRACE) this.trace.push(point);
      else this.trace[MAX_TRACE - 1] = point;
      this.derniereTrace = t;
      return;
    }
    if (this.trace.length >= MAX_TRACE) return;
    if (this.trace.length > 0 && t - this.derniereTrace < PAS_TRACE) return;
    this.trace.push(point);
    this.derniereTrace = t;
  }

  _arriver(t) {
    if (this.tDepart !== null && this.dernier) {
      this._echantillonner(this.dernier, t, true);
      this.temps = (t - this.tDepart) / 1000;
      this.moyenne = this.temps > 0 ? this.distance / this.temps : 0;
    }
    this.etat = ETATS.ARRIVE;
    this.tFin = t;
  }
}

/** Clé des records : la distance arrondie au demi-mètre (« 3 », « 3.5 »). */
export function cleDistance(distance) {
  return String(Math.round(Number(distance) * 2) / 2);
}

/** Stockage du navigateur, ou null s'il est indisponible (accès refusé, navigation privée…). */
export function stockageLocal(global = globalThis) {
  try { return global.localStorage ?? null; } catch { return null; }
}

/**
 * Les cinq meilleurs temps par distance, avec leur date. Lus et écrits dans le stockage s'il
 * existe ; sinon ils restent en mémoire pour la session. Aucun accès au stockage ne lève d'erreur.
 */
export class Records {
  constructor(stockage = stockageLocal()) {
    this.stockage = stockage;
    this.donnees = null; // { cle: [{ temps, date }] }, chargé à la demande
  }

  _charger() {
    if (this.donnees) return this.donnees;
    let brut = null;
    try { brut = this.stockage ? this.stockage.getItem(CLE_RECORDS) : null; } catch { brut = null; }
    this.donnees = {};
    try {
      const lu = JSON.parse(brut ?? '{}');
      if (lu && typeof lu === 'object' && !Array.isArray(lu)) {
        for (const [cle, liste] of Object.entries(lu)) {
          if (!Array.isArray(liste)) continue;
          const propres = liste.filter((r) => r && Number.isFinite(r.temps) && r.temps > 0 && Number.isFinite(r.date));
          this.donnees[cle] = propres.sort((a, b) => a.temps - b.temps).slice(0, MAX_RECORDS);
        }
      }
    } catch { this.donnees = {}; }
    return this.donnees;
  }

  _ecrire() {
    try { if (this.stockage) this.stockage.setItem(CLE_RECORDS, JSON.stringify(this.donnees)); } catch { /* stockage indisponible : mémoire seule */ }
  }

  /** Classement d'une distance, du plus rapide au plus lent. */
  classement(distance) {
    return [...(this._charger()[cleDistance(distance)] ?? [])];
  }

  meilleur(distance) {
    return this.classement(distance)[0] ?? null;
  }

  /** Range un temps. Renvoie le rang (0 = record) ou -1 s'il n'entre pas dans les cinq meilleurs. */
  enregistrer(distance, temps, date = Date.now()) {
    const donnees = this._charger();
    const cle = cleDistance(distance);
    const entree = { temps, date };
    const liste = [...(donnees[cle] ?? []), entree].sort((a, b) => a.temps - b.temps).slice(0, MAX_RECORDS);
    donnees[cle] = liste;
    this._ecrire();
    return liste.includes(entree) ? liste.indexOf(entree) : -1;
  }

  effacer() {
    this.donnees = {};
    try { if (this.stockage) this.stockage.removeItem(CLE_RECORDS); } catch { /* rien à effacer */ }
  }
}

/** Position interpolée sur la trace (t en s depuis le départ), et indice du segment courant. */
export function positionRejeu(trace, t) {
  if (!trace.length) return null;
  if (t <= trace[0].t) return { ...trace[0], i: 0 };
  const last = trace[trace.length - 1];
  if (t >= last.t) return { ...last, i: trace.length - 1 };
  let a = 0;
  let b = trace.length - 1;
  while (b - a > 1) {
    const m = (a + b) >> 1;
    if (trace[m].t <= t) a = m; else b = m;
  }
  const p = trace[a];
  const q = trace[b];
  const f = q.t === p.t ? 0 : (t - p.t) / (q.t - p.t);
  return { x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f, v: p.v + (q.v - p.v) * f, i: a };
}

/** Couleur d'un segment selon sa vitesse : du bleu-vert (lent) à l'ambre (pointe). */
export function couleurVitesse(v, vmax) {
  const r = vmax > 0 ? Math.min(1, Math.max(0, v / vmax)) : 0;
  const lent = [29, 233, 198];
  const vite = [255, 179, 71];
  const c = lent.map((l, k) => Math.round(l + (vite[k] - l) * r));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}
