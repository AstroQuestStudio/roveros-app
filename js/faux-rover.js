// faux-rover.js — un rover simulé, tout en JavaScript, qui parle le MÊME protocole que le vrai.
//
// Il sert à la démonstration : la page marche sans rover. Il n'utilise ni minuterie ni page web :
// on appelle `pas(dt)` à intervalles réguliers et il produit des trames par la fonction `sortie`.
// On lui envoie des ordres avec `recevoir(trame)`.
//
// Ce qui est simulé :
//   - un rover à roues Mecanum (il peut aller sur le côté) : cinématique holonome avec accélération limitée ;
//   - une pièce avec murs et obstacles (segments et cercles), dont le rover ne connaît rien au départ ;
//   - un sonar sur une tête qui balaie, et une carte d'occupation qui se remplit avec ses échos ;
//   - des comportements simples : chien, explorer, base, carre, glisse, danse, mur, slalom, calibrer ;
//   - la sécurité : arrêt d'urgence, chien de garde de 0,4 s, arrêt devant un obstacle.
//
// Repère : x à droite, y vers l'avant, cap en radians dans le sens horaire (0 = vers +y).
// Les distances sont en mètres dans le simulateur, et converties en millimètres dans les trames.

import {
  assemblerDrapeaux, decoderOrdre, encoderCarte, encoderChemin, encoderEtat, encoderPoints, encoderOrigine,
  encoderPong, encoderEchoRetour, encoderTexteRover, TAILLE_CARTE, CASE_INCONNUE, CASE_LIBRE, CASE_OCCUPEE,
} from './protocole.js';
import { RAYON_CIRCONSCRIT, LARGEUR_ROVER, positionSonar } from './gabarit.js';

export const MODES = ['manuel', 'chien', 'explorer', 'base', 'carre', 'glisse', 'danse', 'mur', 'slalom', 'calibrer', 'patrouille', 'arret'];
export const MODES_RUST = ['manuel'];
export const MODES_MICROPYTHON = ['manuel', 'base', 'autotest', 'calibrer', 'chien', 'danse', 'explorer', 'glisse', 'aller', 'slalom', 'mur', 'carre', 'patrouille', 'course'];

const CELLULE = 0.06; // taille d'une case de la carte, en mètres (la carte couvre ±1,92 m)
const RAYON = RAYON_CIRCONSCRIT; // cercle qui entoure le châssis réel (25 × 20 cm : voir gabarit.js)
const SONAR_MAX = 2.55;
const W_MAX = 2.4; // rad/s
const PAS = 0.05; // un pas de simulation = 50 ms (20 Hz)

const limiter = (v, a, b) => Math.min(b, Math.max(a, v));
const degres = (rad) => (rad * 180) / Math.PI;
const radians = (deg) => (deg * Math.PI) / 180;
/** Ramène un angle dans ]−π, π]. */
const enrouler = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a <= -Math.PI) a += 2 * Math.PI; return a; };

// ---------- Le monde : segments (murs) et cercles (piliers) ----------

/** Une boîte (rectangle tourné) sous forme de 4 segments. */
function boite(cx, cy, l, h, angle = 0) {
  const c = Math.cos(angle); const s = Math.sin(angle);
  const coins = [[-l / 2, -h / 2], [l / 2, -h / 2], [l / 2, h / 2], [-l / 2, h / 2]]
    .map(([px, py]) => [cx + px * c - py * s, cy + px * s + py * c]);
  return coins.map((p, i) => { const q = coins[(i + 1) % 4]; return { ax: p[0], ay: p[1], bx: q[0], by: q[1] }; });
}

function creerMonde() {
  return {
    segments: [
      ...boite(0, 0.15, 3.4, 3.3, 0), // les quatre murs de la pièce
      ...boite(0.9, 0.8, 0.5, 0.4, 0), // une caisse
      ...boite(-0.7, -0.7, 0.7, 0.2, 0.35), // une planche en biais
      { ax: 0.5, ay: -1.5, bx: 0.5, by: -0.7 }, // une cloison
    ],
    cercles: [{ x: -0.8, y: 0.9, r: 0.15 }], // un pilier
    // Parcours de la « cible » que le comportement chien suit (un promeneur imaginaire).
    ronde: [{ x: -1.3, y: -0.1 }, { x: 0.2, y: 0.2 }, { x: 0.2, y: 1.3 }, { x: -1.3, y: 1.4 }],
  };
}

/** Un couloir de 12 m (1,4 m de large) avec une caisse et un pilier : pour essayer la carte sans limite. */
function creerCouloir() {
  const y0 = -0.5; const y1 = 11.5; const l = 0.7;
  return {
    segments: [
      { ax: -l, ay: y0, bx: -l, by: y1 }, { ax: l, ay: y0, bx: l, by: y1 },
      { ax: -l, ay: y1, bx: l, by: y1 }, { ax: -l, ay: y0, bx: l, by: y0 },
      ...boite(-0.55, 4.2, 0.3, 0.5, 0), // une caisse contre le mur gauche
      ...boite(0.5, 8.5, 0.4, 0.3, 0), // une saillie contre le mur droit
    ],
    cercles: [{ x: 0.45, y: 6.4, r: 0.12 }], // un pilier contre le mur droit
    ronde: [{ x: 0, y: 1.5 }, { x: 0, y: 3 }, { x: 0, y: 6 }, { x: 0, y: 9 }],
  };
}

/** Distance du premier obstacle le long d'un rayon (ox, oy) -> (dx, dy) unitaire. Infinity si rien. */
function lancer(monde, ox, oy, dx, dy) {
  let meilleur = Infinity;
  for (const s of monde.segments) {
    const ex = s.bx - s.ax; const ey = s.by - s.ay;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const px = s.ax - ox; const py = s.ay - oy;
    const t = (px * ey - py * ex) / den;
    const u = (px * dy - py * dx) / den;
    if (t >= 0 && u >= 0 && u <= 1 && t < meilleur) meilleur = t;
  }
  for (const c of monde.cercles) {
    const fx = ox - c.x; const fy = oy - c.y;
    const b = fx * dx + fy * dy;
    const k = fx * fx + fy * fy - c.r * c.r;
    const disc = b * b - k;
    if (disc < 0) continue;
    const t = -b - Math.sqrt(disc);
    if (t >= 0 && t < meilleur) meilleur = t;
  }
  return meilleur;
}

/** Distance d'un point au plus proche obstacle (pour les collisions). */
function distanceObstacle(monde, x, y) {
  let m = Infinity;
  for (const s of monde.segments) {
    const ex = s.bx - s.ax; const ey = s.by - s.ay;
    const t = limiter(((x - s.ax) * ex + (y - s.ay) * ey) / (ex * ex + ey * ey), 0, 1);
    m = Math.min(m, Math.hypot(x - (s.ax + t * ex), y - (s.ay + t * ey)));
  }
  for (const c of monde.cercles) m = Math.min(m, Math.hypot(x - c.x, y - c.y) - c.r);
  return m;
}

// ---------- Cases de la carte ----------

const dansCarte = (c, l) => c >= 0 && c < TAILLE_CARTE && l >= 0 && l < TAILLE_CARTE;

// Cases à gonfler autour des obstacles pour que le châssis passe : disque de 3 cases (0,18 m).
const DISQUE = [];
for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (dx * dx + dy * dy <= 9.5) DISQUE.push([dx, dy]);

const DEFAUTS = {
  v_max: [0.5, 0.05, 1.2], // m/s : vitesse maximale à la manette
  v_rapide: [0.5, 0.05, 1.2], // m/s : vitesse que le rover s'autorise quand le sonar voit la voie libre
  w_max: [2.4, 0.5, 5.0], // rad/s : rotation maximale
  vue_large: [0, 0, 600], // s : toutes les N secondes la tête balaie large à la manette (0 = jamais)
  v_aveugle_man: [0.35, 0.05, 1.0], // m/s : vitesse maximale dans une direction que la tête ne regarde pas
  accel: [1.5, 0.3, 4.0],
  dist_arret: [0.06, 0.02, 0.4],
  dist_suivi: [0.5, 0.25, 1.5],
  gain_cap: [2.5, 0.5, 6.0],
  vitesse_tete: [90, 30, 240],
  reflexe: [1, 0, 1], // 1 = le rover ralentit et s'arrête devant ce que voit le sonar
  carte_on: [1, 0, 1], // 1 = la carte sert à ralentir près d'un obstacle
};

export class FauxRover {
  /**
   * @param {object} options
   *   sortie(trame)       reçoit chaque trame envoyée au téléphone
   *   planifier(fn, ms)   exécute fn après ms (pour simuler le délai du PONG) ; par défaut, tout de suite
   *   alea()              générateur de nombres entre 0 et 1 (Math.random par défaut)
   */
  constructor({ sortie, planifier = (fn) => fn(), alea = Math.random, fenetre = false, monde = 'salle', firmware = 'demo' } = {}) {
    this.sortie = sortie;
    this.planifier = planifier;
    this.alea = alea;
    this.firmware = firmware;
    this.nomOrigine = firmware === 'rust' ? 'LODILABIDON' : firmware === 'micropython' ? 'Rover-4538' : 'Rover-DEMO';
    this.nom = this.nomOrigine;
    this.version = firmware === 'rust' ? 'rust100-0.1' : firmware === 'micropython' ? '0.1.1' : 'demo-1.0';
    this.modes = firmware === 'rust' ? [...MODES_RUST] : firmware === 'micropython' ? [...MODES_MICROPYTHON] : [...MODES];
    this.params = {};
    for (const [nom, [v, min, max]] of Object.entries(DEFAUTS)) this.params[nom] = { v, min, max };
    this._paramsModifies = false;
    // Carte sans limite : avec `fenetre`, la grille de 64 × 64 suit le rover (origine annoncée par la trame ORIGINE,
    // positions envoyées relatives au centre de la fenêtre, carte « par différences »). Sans, c'est un rover non mis à jour.
    this.fenetre = fenetre;
    this.ox = -TAILLE_CARTE / 2; this.oy = -TAILLE_CARTE / 2; this.versionOrigine = 0;
    this.envoye = new Uint8Array(TAILLE_CARTE * TAILLE_CARTE); // ce que le téléphone a déjà reçu de la fenêtre
    this.aRenvoyer = new Set(); // lignes à renvoyer quoi qu'il arrive (connexion, raz, glissement)
    this.ligneFond = 0;
    this.monde = monde === 'couloir' ? creerCouloir() : creerMonde();
    this.t = 0; // temps simulé, secondes
    this.x = 0; this.y = 0; this.cap = 0;
    this.vxb = 0; this.vyb = 0; this.w = 0; // vitesses réelles dans le repère du rover
    this.mode = 'manuel';
    this.etat = {}; // mémoire propre au comportement en cours
    this.chemin = []; this.cheminEnvoye = '';
    this.but = null;
    this.urgence = false;
    this.manette = { vx: 0, vy: 0, w: 0, monde: false, t: -10 };
    this.vitessePct = 100;
    this.radar = 'auto';
    this.tete = 0; this.sensTete = 1;
    this.dernierEcho = 0; // cm
    this.carte = new Uint8Array(TAILLE_CARTE * TAILLE_CARTE);
    this.tension = 8.1;
    this.echos = [];
    this.flagsMemo = {};
    this.tArrive = -10;
    this.tBloque = 0; this.tObstacle = 0;
    this.cible = null; this.idxRonde = 0;
    this.ligneCarte = 0;
    this.cpt = { etat: 0, points: 0, carte: 0 };
    this.garde = false;
    this.tReplan = 0;
    this.cibleVue = false;
    this.veilleS = 0; // délai avant la semi-veille, en secondes (0 = jamais)
    this.veille = false;
    this.tOrdre = 0; // heure du dernier ordre reçu
  }

  // ===== Fenêtre de carte =====

  caseX(v) { return Math.floor(v / CELLULE) - this.ox; }
  caseY(v) { return Math.floor(v / CELLULE) - this.oy; }
  centreX(c) { return (c + this.ox + 0.5) * CELLULE; }
  centreY(l) { return (l + this.oy + 0.5) * CELLULE; }
  /** Centre de la fenêtre (m, repère du monde) : les positions envoyées sont relatives à ce point. */
  centreFenetre() { return { x: (this.ox + TAILLE_CARTE / 2) * CELLULE, y: (this.oy + TAILLE_CARTE / 2) * CELLULE }; }

  /** Quand le rover approche du bord (moins de 20 cases), la fenêtre glisse de 16 cases vers ce bord. */
  recentrerFenetre() {
    if (!this.fenetre) return;
    const N = TAILLE_CARTE;
    const c = this.caseX(this.x); const l = this.caseY(this.y);
    const dx = c < 20 ? -16 : c > N - 21 ? 16 : 0;
    const dy = l < 20 ? -16 : l > N - 21 ? 16 : 0;
    if (!dx && !dy) return;
    const neuve = new Uint8Array(N * N);
    for (let ln = 0; ln < N; ln++) {
      for (let cn = 0; cn < N; cn++) {
        const co = cn + dx; const lo = ln + dy; // la case de l'ancienne fenêtre qui se retrouve ici
        if (co >= 0 && co < N && lo >= 0 && lo < N) neuve[ln * N + cn] = this.carte[lo * N + co];
      }
    }
    this.carte = neuve; // ce qui sort de la fenêtre est oublié par le rover ; la bande découverte est « inconnue »
    this.ox += dx; this.oy += dy;
    this.versionOrigine = (this.versionOrigine + 2) & 0xfe;
    this.envoyerOrigine();
    this.renvoyerTout(); // après un glissement, le cœur renvoie toute la carte
    this.cheminEnvoye = ''; this.envoyerChemin();
  }

  envoyerOrigine() {
    if (this.fenetre) this.sortie(encoderOrigine({ ox: this.ox, oy: this.oy, version: this.versionOrigine, cellule: Math.round(CELLULE * 1000) }));
  }

  renvoyerTout() { for (let i = 0; i < TAILLE_CARTE; i++) this.aRenvoyer.add(i); }

  // ===== Entrées : ordres du téléphone =====

  /** Reçoit une trame du téléphone (Uint8Array) et agit. Ne lève jamais d'exception. */
  recevoir(trame) {
    let ordre = null;
    try { ordre = decoderOrdre(trame); } catch { /* trame illisible : ignorée */ }
    if (!ordre) return;
    switch (ordre.type) {
      case 'ping': this.planifier(() => this.sortie(encoderPong(ordre.n)), 15 + this.alea() * 25); return;
      case 'echo':
        if (this.firmware === 'rust') this.planifier(() => this.sortie(encoderEchoRetour(ordre.donnees)), 10 + this.alea() * 15);
        return;
      case 'urgence':
        this.urgence = ordre.actif;
        if (ordre.actif) this.annuler();
        return;
      case 'stop': this.annuler(); return;
      default: break;
    }
    if (this.urgence) { this.err("arrêt d'urgence actif : ordre refusé"); return; }
    this.tOrdre = this.t;
    if (this.veille) { this.veille = false; this.evt('réveil'); }
    switch (ordre.type) {
      case 'manette':
        if (this.mode !== 'manuel' || this.but) this.annuler();
        this.manette = { vx: ordre.vx, vy: ordre.vy, w: ordre.w, monde: ordre.monde, t: this.t };
        this.garde = false;
        break;
      case 'aller': {
        const c = this.fenetre ? this.centreFenetre() : { x: 0, y: 0 }; // ALLER est relatif au centre de la fenêtre
        this.allerA(c.x + ordre.x / 1000, c.y + ordre.y / 1000);
        break;
      }
      case 'texte': this.commande(ordre.texte); break;
      default: break;
    }
  }

  commande(texte) {
    const [mot, ...args] = texte.split(/\s+/);
    switch (mot) {
      case 'mode': this.lancerMode(args[0], args.slice(1)); break;
      case 'param': {
        const p = this.params[args[0]]; const v = Number(args[1]);
        if (!p || !Number.isFinite(v)) { this.err(`paramètre inconnu ou valeur invalide : ${args.join(' ')}`); break; }
        const borne = limiter(v, p.min, p.max);
        if (borne !== p.v) this._paramsModifies = true;
        p.v = borne;
        this.evt(`${args[0]} = ${p.v}`);
        this.ligneP(args[0]);
        break;
      }
      case 'params':
        if (args[0] === 'sauver') {
          if (this.firmware !== 'rust') { this.err('commande inconnue : params sauver'); break; }
          if (Math.hypot(this.vxb, this.vyb) > 0.02 || Math.abs(this.w) > 0.05) {
            this.err('params : rover en mouvement');
          } else if (this._paramsModifies) {
            this._paramsModifies = false;
            this.evt('paramètres enregistrés');
          } else {
            this.evt('paramètres inchangés');
          }
          break;
        }
        if (args[0] === 'usine') {
          if (this.firmware !== 'rust') { this.err('commande inconnue : params usine'); break; }
          for (const [nom, [v, min, max]] of Object.entries(DEFAUTS)) this.params[nom] = { v, min, max };
          this._paramsModifies = false;
          this.evt("paramètres d'usine restaurés");
          Object.keys(this.params).forEach((n) => this.ligneP(n));
          break;
        }
        if (args.length === 0) Object.keys(this.params).forEach((n) => this.ligneP(n));
        else this.err(`commande params inconnue : ${args.join(' ')}`);
        break;
      case 'nom': {
        if (this.firmware !== 'rust' && this.firmware !== 'micropython') { this.err('commande inconnue : nom'); break; }
        if (args.length === 1 && args[0] === '-') {
          this.nom = this.nomOrigine;
          this.evt(`nom enregistré : ${this.nomOrigine} (au prochain démarrage)`);
        } else if (args.length === 1 && /^[\x21-\x7e]{1,20}$/.test(args[0])) {
          this.nom = args[0];
          this.evt(`nom enregistré : ${this.nom} (au prochain démarrage)`);
        } else {
          this.err('nom invalide (20 caractères ASCII sans espace, ou -)');
        }
        break;
      }
      case 'maj':
        if (this.firmware === 'micropython') this.evt('mise à jour sans fil prête (trames 0x20 à 0x23)');
        else this.err('mise à jour sans fil : indisponible');
        break;
      case 'recaler': this.recaler(); break;
      case 'carte':
        if (args[0] === 'raz') { this.carte.fill(0); this.renvoyerTout(); this.evt('carte effacée'); } else this.err('commande carte inconnue');
        break;
      case 'radar':
        if (['arret', 'auto', 'balayage', 'fixe', 'suivi'].includes(args[0])) { this.radar = args[0]; this.evt(`radar : ${args[0]}`); } else this.err('mode radar inconnu');
        break;
      case 'vitesse': {
        const v = Number(args[0]);
        if (Number.isFinite(v)) this.vitessePct = limiter(v, 10, 100); else this.err('vitesse invalide');
        break;
      }
      case 'infos': this.envoyerInfos(); break;
      case 'veille': {
        const v = Number(args[0]);
        if (Number.isFinite(v) && v >= 0) { this.veilleS = v; this.evt(v > 0 ? `veille après ${v} s` : 'veille désactivée'); } else this.err('veille : nombre de secondes attendu');
        break;
      }
      case 'materiel':
        if (this.firmware === 'rust') {
          this.texte(`materiel cycles=${73120 + Math.round(this.t * 100)} calcul=240 calcul_max=328 duree_max=340 retards=0 err_driver=0 err_centrale=0 mem=148400 pile0=6388 pile1=1756 code_ram=55252 bus_max=0`);
          this.texte('acquisition bus=0 bus_max=0 age=3972');
        } else if (this.firmware === 'micropython') {
          this.texte(`materiel cycles=${46333 + Math.round(this.t * 100)} calcul=535 calcul_max=1853 duree_max=3183 retards=0 err_driver=0 err_centrale=0 mem=71728`);
        } else {
          this.texte('materiel cycles=' + Math.round(this.t * 100) + ' calcul=700 calcul_max=2000 duree_max=2300 retards=0 err_driver=0 err_centrale=0 mem=73728');
        }
        break;
      case 'profil':
        if (this.firmware === 'micropython') {
          if (args[0] === 'raz') this.evt('profil remis à zéro');
          else {
            this.texte('profil boucle max=540 moy=210 n=1200');
            this.texte('profil depassements gt2ms=0 gt5ms=0');
          }
        } else {
          this.err('commande inconnue : profil');
        }
        break;
      default: this.err(`commande inconnue : ${mot}`);
    }
  }

  // ===== Sorties en texte =====

  texte(ligne) { this.sortie(encoderTexteRover(ligne)); }
  evt(msg) { this.texte(`evt ${msg}`); }
  err(msg) { this.texte(`err ${msg}`); }
  ligneP(nom) { const p = this.params[nom]; this.texte(`p ${nom} ${p.v} ${p.min} ${p.max}`); }

  /** Lignes envoyées à la connexion : identité du rover et liste des comportements. */
  envoyerInfos() {
    this.texte(`info version=${this.version} nom=${this.nom} cellule=${CELLULE} v_max=${this.params.v_max.v} w_max=${this.params.w_max.v}`);
    this.texte(`modes ${this.modes.join(',')}`);
  }

  // ===== Comportements =====

  /** Arrête tout mouvement et tout comportement (STOP, urgence, manette qui reprend la main). */
  annuler() {
    this.mode = 'manuel'; this.etat = {}; this.but = null;
    this.manette = { vx: 0, vy: 0, w: 0, monde: false, t: -10 };
    this.viderChemin();
  }

  lancerMode(nom, args) {
    if (!this.modes.includes(nom)) { this.err(`mode inconnu : ${nom}`); return; }
    this.annuler();
    if (nom === 'arret' || nom === 'manuel') { this.evt('arrêt'); return; }
    this.mode = nom;
    const cote = Number(args[0]);
    this.etat = { t0: this.t, x0: this.x, y0: this.y, cap0: this.cap, cote: Number.isFinite(cote) && cote > 0.1 ? Math.min(cote, 1.2) : 0.5 };
    if (nom === 'chien') { this.cible = { ...this.monde.ronde[0] }; this.idxRonde = 1; this.radar = 'suivi'; }
    if (nom === 'explorer') { this.etat.phase = 'scan'; this.etat.tPhase = this.t; this.etat.echecs = []; this.radar = 'auto'; }
    if (nom === 'base') this.allerA(0, 0, true);
    if (nom === 'patrouille') {
      const nombres = args.map(Number).filter(Number.isFinite);
      const points = [];
      for (let i = 0; i + 1 < nombres.length && points.length < 6; i += 2) points.push({ x: nombres[i], y: nombres[i + 1] });
      if (points.length === 0) { this.err('patrouille : donnez au moins un point (x y en mètres)'); this.annuler(); return; }
      this.etat.points = points; this.etat.i = 0;
      this.evt(`patrouille de ${points.length} point${points.length > 1 ? 's' : ''}`);
      return;
    }
    if (nom === 'carre' || nom === 'glisse') this.etat.etapes = this.etapesFigure(nom);
    if (nom === 'mur') this.etat.phase = 'cherche';
    this.evt(`mode ${nom}`);
  }

  /** Programme d'un carré (on tourne) ou d'une « glisse » (on garde le cap et on va sur le côté). */
  etapesFigure(nom) {
    const { x0, y0, cap0, cote } = this.etat;
    const etapes = [];
    let x = x0; let y = y0;
    if (nom === 'carre') {
      // Avancer, pivoter de 90° à droite, avancer... quatre fois, puis retrouver le cap de départ.
      for (let k = 0; k < 4; k++) {
        const cap = cap0 + (k * Math.PI) / 2;
        if (k > 0) etapes.push({ cap });
        x += Math.sin(cap) * cote; y += Math.cos(cap) * cote;
        etapes.push({ x, y, cap });
      }
      etapes.push({ cap: cap0 });
    } else {
      // Glisse : avant, droite, arrière, gauche (repère du rover au départ), sans jamais tourner.
      for (const [rx, ry] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
        x += (rx * Math.cos(cap0) + ry * Math.sin(cap0)) * cote;
        y += (-rx * Math.sin(cap0) + ry * Math.cos(cap0)) * cote;
        etapes.push({ x, y, cap: cap0 });
      }
    }
    return etapes;
  }

  allerA(x, y, base = false, garder = false) {
    if (!base && !garder) this.annuler();
    const lim = (TAILLE_CARTE / 2) * CELLULE - 0.03;
    this.but = this.fenetre ? { x, y, base } : { x: limiter(x, -lim, lim), y: limiter(y, -lim, lim), base };
    this.tReplan = -10;
    this.tBloque = 0;
    this.tAller = this.t;
  }

  recaler() {
    // La position actuelle devient l'origine : on exprime tout le monde dans le nouveau repère.
    const c = Math.cos(this.cap); const s = Math.sin(this.cap);
    const conv = (px, py) => { const dx = px - this.x; const dy = py - this.y; return [dx * c - dy * s, dx * s + dy * c]; };
    this.monde.segments = this.monde.segments.map((g) => {
      const [ax, ay] = conv(g.ax, g.ay); const [bx, by] = conv(g.bx, g.by);
      return { ax, ay, bx, by };
    });
    this.monde.cercles = this.monde.cercles.map((k) => { const [x, y] = conv(k.x, k.y); return { ...k, x, y }; });
    this.monde.ronde = this.monde.ronde.map((p) => { const [x, y] = conv(p.x, p.y); return { x, y }; });
    if (this.cible) { const [x, y] = conv(this.cible.x, this.cible.y); this.cible = { x, y }; }
    this.x = 0; this.y = 0; this.cap = 0;
    this.carte.fill(0);
    if (this.fenetre) { this.ox = -TAILLE_CARTE / 2; this.oy = -TAILLE_CARTE / 2; this.versionOrigine = (this.versionOrigine + 2) & 0xfe; this.envoyerOrigine(); this.renvoyerTout(); }
    this.annuler();
    this.evt('recalé : nouvelle origine');
  }

  // ===== Planification sur la carte connue =====

  /** Grille des cases interdites : cases occupées gonflées. */
  grilleBloquee() {
    const bloque = new Uint8Array(this.carte.length);
    for (let l = 0; l < TAILLE_CARTE; l++) {
      for (let c = 0; c < TAILLE_CARTE; c++) {
        if (this.carte[l * TAILLE_CARTE + c] !== CASE_OCCUPEE) continue;
        for (const [dx, dy] of DISQUE) {
          if (dansCarte(c + dx, l + dy)) bloque[(l + dy) * TAILLE_CARTE + c + dx] = 1;
        }
      }
    }
    // Le rover est forcément quelque part : on dégage ses abords immédiats.
    const c0 = this.caseX(this.x); const l0 = this.caseY(this.y);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (dansCarte(c0 + dx, l0 + dy)) bloque[(l0 + dy) * TAILLE_CARTE + c0 + dx] = 0;
    return bloque;
  }

  /**
   * Plus court chemin (parcours en largeur, 8 voisins) du rover jusqu'à (bx, by).
   * Les cases inconnues sont franchissables, les cases occupées gonflées non.
   * Renvoie une liste de points { x, y } en mètres, simplifiée, ou null s'il n'y a pas de chemin.
   */
  trouverChemin(bx, by, seulementLibre = false) {
    const N = TAILLE_CARTE;
    const bloque = this.grilleBloquee();
    const passe = (i) => !bloque[i] && (!seulementLibre || this.carte[i] === CASE_LIBRE);
    const depart = limiter(this.caseY(this.y), 0, N - 1) * N + limiter(this.caseX(this.x), 0, N - 1);
    let but = limiter(this.caseY(by), 0, N - 1) * N + limiter(this.caseX(bx), 0, N - 1);
    const pere = new Int16Array(N * N).fill(-2);
    pere[depart] = -1;
    const file = [depart];
    const voisins = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    let trouve = false; let meilleur = depart; let meilleureD = Infinity;
    const cb = but % N; const lb = Math.floor(but / N);
    for (let tete = 0; tete < file.length; tete++) {
      const i = file[tete];
      const c = i % N; const l = Math.floor(i / N);
      const d = (c - cb) ** 2 + (l - lb) ** 2;
      if (d < meilleureD) { meilleureD = d; meilleur = i; }
      if (i === but) { trouve = true; break; }
      for (const [dx, dy] of voisins) {
        const nc = c + dx; const nl = l + dy;
        if (!dansCarte(nc, nl)) continue;
        const j = nl * N + nc;
        if (pere[j] !== -2 || !passe(j)) continue;
        // pas de coupe-coin : en diagonale, les deux cases voisines doivent être libres
        if (dx !== 0 && dy !== 0 && (!passe(l * N + nc) || !passe(nl * N + c))) continue;
        pere[j] = i;
        file.push(j);
      }
    }
    // But inatteignable (dans un obstacle) : on se contente de la case atteignable la plus proche.
    if (!trouve) { if (meilleur === depart || meilleureD > 25) return null; but = meilleur; }
    const cases = [];
    for (let i = but; i !== -1; i = pere[i]) cases.push(i);
    cases.reverse();
    // Simplification : on saute les cases intermédiaires tant que la ligne droite est dégagée.
    const droit = (a, b) => {
      const ca = a % N; const la = Math.floor(a / N); const cb2 = b % N; const lb2 = Math.floor(b / N);
      const n = Math.max(Math.abs(cb2 - ca), Math.abs(lb2 - la)) * 2;
      for (let k = 1; k < n; k++) {
        const c = Math.round(ca + ((cb2 - ca) * k) / n); const l = Math.round(la + ((lb2 - la) * k) / n);
        if (!passe(l * N + c)) return false;
      }
      return true;
    };
    const points = [];
    let a = 0;
    while (a < cases.length - 1) {
      let b = cases.length - 1;
      while (b > a + 1 && !droit(cases[a], cases[b])) b--;
      points.push({ x: this.centreX(cases[b] % N), y: this.centreY(Math.floor(cases[b] / N)) });
      a = b;
    }
    // le dernier point est exactement le but demandé (si on l'a atteint)
    if (trouve && points.length) points[points.length - 1] = { x: bx, y: by };
    return points;
  }

  /** Cherche la case libre la plus proche qui touche de l'inconnu (frontière d'exploration). */
  trouverFrontiere() {
    const N = TAILLE_CARTE;
    const bloque = this.grilleBloquee();
    const depart = limiter(this.caseY(this.y), 0, N - 1) * N + limiter(this.caseX(this.x), 0, N - 1);
    const vu = new Uint8Array(N * N); vu[depart] = 1;
    const file = [depart];
    const echecs = this.etat.echecs ?? [];
    for (let tete = 0; tete < file.length; tete++) {
      const i = file[tete]; const c = i % N; const l = Math.floor(i / N);
      if (i !== depart && this.carte[i] === CASE_LIBRE && !bloque[i]) {
        let inconnues = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (dansCarte(c + dx, l + dy) && this.carte[(l + dy) * N + c + dx] === CASE_INCONNUE) inconnues++;
        }
        const refuse = echecs.some(([ec, el]) => Math.abs(ec - c) <= 4 && Math.abs(el - l) <= 4);
        if (inconnues >= 3 && !refuse) return { c, l, x: this.centreX(c), y: this.centreY(l) };
      }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = c + dx; const nl = l + dy;
        if (!dansCarte(nc, nl)) continue;
        const j = nl * N + nc;
        if (!vu[j] && this.carte[j] === CASE_LIBRE && !bloque[j]) { vu[j] = 1; file.push(j); }
      }
    }
    return null;
  }

  viderChemin() { this.chemin = []; this.envoyerChemin(); }

  envoyerChemin() {
    const cle = this.chemin.map((p) => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`).join(';');
    if (cle === this.cheminEnvoye) return;
    this.cheminEnvoye = cle;
    const c = this.fenetre ? this.centreFenetre() : { x: 0, y: 0 };
    this.sortie(encoderChemin(this.chemin.map((p) => ({ x: (p.x - c.x) * 1000, y: (p.y - c.y) * 1000 }))));
  }

  /** Suit this.chemin. Renvoie { vx, vy, w, fini } dans le repère du rover (m/s, rad/s). */
  suivreChemin(vmax) {
    while (this.chemin.length > 1 && Math.hypot(this.chemin[0].x - this.x, this.chemin[0].y - this.y) < 0.08) this.chemin.shift();
    const p = this.chemin[0];
    if (!p) return { vx: 0, vy: 0, w: 0, fini: true };
    const dx = p.x - this.x; const dy = p.y - this.y;
    const d = Math.hypot(dx, dy);
    const dernier = this.chemin.length === 1;
    if (dernier && d < 0.05) { this.chemin.shift(); return { vx: 0, vy: 0, w: 0, fini: true }; }
    const dFin = Math.hypot(this.chemin[this.chemin.length - 1].x - this.x, this.chemin[this.chemin.length - 1].y - this.y);
    const bearing = Math.atan2(dx, dy);
    const err = enrouler(bearing - this.cap);
    const vit = Math.min(vmax, Math.max(0.1, 1.4 * dFin)) * Math.max(0.3, Math.cos(Math.min(Math.abs(err), 1.3)));
    const c = Math.cos(this.cap); const s = Math.sin(this.cap);
    const wx = (dx / d) * vit; const wy = (dy / d) * vit;
    const w = d > 0.25 ? limiter(this.params.gain_cap.v * err, -1.8, 1.8) : 0;
    return { vx: wx * c - wy * s, vy: wx * s + wy * c, w, fini: false };
  }

  /** Va vers un point (sans planifier) en tenant un cap. Renvoie { vx, vy, w, fini }. */
  allerDirect(x, y, cap, vmax) {
    const dx = x - this.x; const dy = y - this.y;
    const d = Math.hypot(dx, dy);
    const errCap = cap == null ? 0 : enrouler(cap - this.cap);
    const w = limiter(this.params.gain_cap.v * errCap, -1.5, 1.5);
    let vx = 0; let vy = 0;
    if (d > 0.025) {
      const vit = Math.min(vmax, Math.max(0.06, 1.5 * d));
      const wx = (dx / d) * vit; const wy = (dy / d) * vit;
      const c = Math.cos(this.cap); const s = Math.sin(this.cap);
      vx = wx * c - wy * s; vy = wx * s + wy * c;
    }
    const fini = d <= 0.03 && Math.abs(errCap) < radians(3);
    return { vx, vy, w, fini };
  }

  /** Planifie (si besoin) puis suit un but. Renvoie la commande, ou null si le but est inaccessible. */
  poursuivre(but, vmax, periode = 1.0, seulementLibre = false) {
    if (this.t - this.tReplan >= periode) {
      this.tReplan = this.t;
      const chemin = this.trouverChemin(but.x, but.y, seulementLibre);
      if (!chemin) { this.chemin = []; this.envoyerChemin(); return null; }
      this.chemin = chemin;
      this.envoyerChemin();
    }
    return this.suivreChemin(vmax);
  }

  // ===== Commande de chaque comportement (retourne vx, vy en m/s, w en rad/s, repère du rover) =====

  calculerCommande(dt) {
    const vmax = this.params.v_max.v * (this.vitessePct / 100);
    const nul = { vx: 0, vy: 0, w: 0 };
    const tm = this.t - this.etat.t0; // temps écoulé dans le comportement
    if (this.mode === 'patrouille' && !this.but) {
      const p = this.etat.points[this.etat.i];
      this.allerA(p.x, p.y, false, true);
    }
    // --- Aller en un point (toucher sur la carte) ou retour à la base ---
    if (this.but) {
      if (this.t - this.tAller > 90) { this.err('trop long : abandon'); this.annuler(); return nul; }
      if (this.tObstacle > 2) this.tReplan = -10; // bloqué un moment : on replanifie avec la carte à jour
      if (this.tObstacle > 7) { this.err('bloqué par un obstacle'); this.annuler(); return nul; }
      const cmd = this.poursuivre(this.but, vmax);
      if (!cmd) { this.err('pas de chemin vers ce point'); this.annuler(); return nul; }
      // En patrouille, 12 cm suffisent : un point trop près d'un obstacle n'arrêterait pas la boucle.
      if (this.mode === 'patrouille' && !cmd.fini && Math.hypot(this.but.x - this.x, this.but.y - this.y) < 0.12) cmd.fini = true;
      if (cmd.fini && this.mode === 'patrouille') {
        this.evt(`point ${this.etat.i + 1} atteint`);
        this.etat.i = (this.etat.i + 1) % this.etat.points.length; // on repart au premier point : patrouille en boucle
        this.but = null;
        return nul;
      }
      if (cmd.fini) {
        this.tArrive = this.t;
        this.evt(this.but.base ? 'de retour à la base' : 'arrivé');
        this.annuler();
        return nul;
      }
      return cmd;
    }
    switch (this.mode) {
      case 'manuel': return this.commandeManuelle(vmax);
      case 'chien': return this.comportementChien(dt, vmax);
      case 'explorer': return this.comportementExplorer(dt, vmax);
      case 'carre':
      case 'glisse': return this.comportementFigure(vmax);
      case 'danse': {
        if (tm > 14) { this.evt('danse terminée'); this.annuler(); return nul; }
        const ph = tm * 2 * Math.PI;
        return { vx: 0.22 * Math.sin(ph / 2.5), vy: 0.1 * Math.sin(ph / 1.25), w: 1.8 * Math.sin(ph / 3.5) };
      }
      case 'slalom': {
        const devant = lancer(this.monde, this.x, this.y, Math.sin(this.cap), Math.cos(this.cap));
        if (tm > 14 || devant < 0.5) { this.evt('slalom terminé'); this.annuler(); return nul; }
        return { vx: 0.2 * Math.sin((tm * 2 * Math.PI) / 3), vy: Math.min(vmax, 0.25), w: 0 };
      }
      case 'calibrer': {
        const fait = Math.abs(enrouler(this.cap - this.etat.cap0));
        if (tm > 1 && (fait < 0.12 || tm > 6.5)) {
          this.texte('calib gyro_biais=0.0031 echelle=1.002 deriv=0.04');
          this.evt('calibration terminée');
          this.annuler();
          return nul;
        }
        return { vx: 0, vy: 0, w: 1.2 };
      }
      case 'mur': return this.comportementMur(tm, vmax);
      default: return nul;
    }
  }

  commandeManuelle(vmax) {
    const m = this.manette;
    if (this.t - m.t > 0.4) {
      // Plus d'ordre depuis 0,4 s : arrêt de sécurité (drapeau « garde » si le dernier ordre bougeait).
      if (m.vx || m.vy || m.w) { this.garde = true; this.manette = { ...m, vx: 0, vy: 0, w: 0 }; }
      return { vx: 0, vy: 0, w: 0 };
    }
    let vx = (m.vx / 100) * vmax; let vy = (m.vy / 100) * vmax;
    if (m.monde) { // repère du monde : la direction ne dépend pas du cap
      const c = Math.cos(this.cap); const s = Math.sin(this.cap);
      [vx, vy] = [vx * c - vy * s, vx * s + vy * c];
    }
    return { vx, vy, w: (m.w / 100) * this.params.w_max.v * (this.vitessePct / 100) };
  }

  comportementChien(dt, vmax) {
    // La cible avance sur sa ronde à 0,25 m/s.
    const ronde = this.monde.ronde;
    const objectif = ronde[this.idxRonde % ronde.length];
    const dx = objectif.x - this.cible.x; const dy = objectif.y - this.cible.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.05) this.idxRonde++;
    else { this.cible.x += (dx / d) * 0.25 * dt; this.cible.y += (dy / d) * 0.25 * dt; }
    const dc = Math.hypot(this.cible.x - this.x, this.cible.y - this.y);
    if (dc <= this.params.dist_suivi.v) { this.chemin = []; this.envoyerChemin(); this.tReplan = -10; return this.regarder(this.cible, 0.5); }
    const cmd = this.poursuivre(this.cible, vmax, 0.5);
    return cmd ? { vx: cmd.vx, vy: cmd.vy, w: cmd.w } : { vx: 0, vy: 0, w: 0 };
  }

  /** Tourne sur place pour faire face à un point. */
  regarder(p, gain) {
    const err = enrouler(Math.atan2(p.x - this.x, p.y - this.y) - this.cap);
    return { vx: 0, vy: 0, w: limiter(gain * this.params.gain_cap.v * err, -1.5, 1.5) };
  }

  comportementExplorer(dt, vmax) {
    const e = this.etat;
    const nul = { vx: 0, vy: 0, w: 0 };
    if (e.phase === 'scan') { // un tour sur place pour regarder tout autour
      if (this.t - e.tPhase > 3.4) { e.phase = 'cherche'; return nul; }
      return { vx: 0, vy: 0, w: 2.0 };
    }
    if (e.phase === 'cherche') {
      const f = this.trouverFrontiere();
      if (!f) { this.evt('exploration terminée'); this.annuler(); return nul; }
      e.but = f; e.tBut = this.t; e.phase = 'va'; this.tReplan = -10;
      return nul;
    }
    // phase 'va'
    const cmd = this.poursuivre(e.but, vmax, 1.2, true);
    const trop = this.t - e.tBut > 25 || this.tObstacle > 3;
    if (!cmd || cmd.fini || trop) {
      e.echecs.push([e.but.c, e.but.l]);
      this.chemin = []; this.envoyerChemin();
      e.phase = 'scan'; e.tPhase = this.t; this.tObstacle = 0;
      return nul;
    }
    return cmd;
  }

  comportementFigure(vmax) {
    const e = this.etat;
    const etape = e.etapes[e.i ?? (e.i = 0)];
    if (!etape) { this.evt('figure terminée'); this.annuler(); return { vx: 0, vy: 0, w: 0 }; }
    if (this.tObstacle > 1.5) { this.err('obstacle sur le trajet : abandon'); this.annuler(); return { vx: 0, vy: 0, w: 0 }; }
    const cmd = etape.x === undefined
      ? { vx: 0, vy: 0, w: limiter(this.params.gain_cap.v * enrouler(etape.cap - this.cap), -1.5, 1.5), fini: Math.abs(enrouler(etape.cap - this.cap)) < radians(3) }
      : this.allerDirect(etape.x, etape.y, etape.cap, Math.min(vmax, 0.3));
    if (cmd.fini) e.i++;
    return cmd;
  }

  comportementMur(tm, vmax) {
    // Longe un mur à sa droite en gardant 0,30 m : avance, corrige sur le côté, tourne aux angles.
    const c = Math.cos(this.cap); const s = Math.sin(this.cap);
    const dF = lancer(this.monde, this.x, this.y, s, c);
    const dD = lancer(this.monde, this.x, this.y, c, -s) - RAYON;
    if (tm > 50) { this.evt('tour de pièce terminé'); this.annuler(); return { vx: 0, vy: 0, w: 0 }; }
    const v = Math.min(vmax, 0.28);
    if (dF < 0.5) return { vx: 0, vy: 0, w: -1.2 }; // mur devant : on tourne à gauche
    if (this.etat.phase === 'cherche') {
      if (dD < 0.45) this.etat.phase = 'longe';
      return { vx: 0, vy: v, w: 0 };
    }
    const ecart = Number.isFinite(dD) ? dD - 0.3 : 0; // > 0 : trop loin du mur
    return { vx: limiter(1.5 * ecart, -0.15, 0.15), vy: v, w: 0 };
  }

  // ===== Physique =====

  pas(dt = PAS) {
    this.t += dt;
    this.majCible(dt);
    let cmd = this.calculerCommande(dt);
    cmd = this.appliquerSecurites(cmd);
    this.integrer(cmd, dt);
    this.recentrerFenetre();
    const repos = this.mode === 'manuel' && !this.but && Math.hypot(this.vxb, this.vyb) < 0.01 && Math.abs(this.w) < 0.02;
    if (this.veilleS > 0 && !this.veille && repos && this.t - this.tOrdre > this.veilleS) { this.veille = true; this.evt('veille : tête et moteurs au repos'); }
    if (this.veille && !repos) { this.veille = false; this.evt('réveil'); }
    if (!this.veille) this.balayerSonar(dt);
    this.tension = Math.max(5.5, this.tension - 0.0006 * dt * (1 + 3 * Math.hypot(this.vxb, this.vyb)));
    // Cadences d'émission : ÉTAT 10 Hz, POINTS 10 Hz, CARTE 4 Hz.
    this.cpt.etat += dt; this.cpt.points += dt; this.cpt.carte += dt; this.cpt.origine = (this.cpt.origine ?? 0) + dt;
    if (this.cpt.origine >= 1) { this.cpt.origine = 0; this.envoyerOrigine(); }
    if (this.cpt.points >= 0.1) { this.cpt.points = 0; this.envoyerPoints(); }
    if (this.cpt.etat >= 0.1) { this.cpt.etat = 0; this.envoyerEtat(); }
    if (this.cpt.carte >= (this.fenetre ? 0.1 : 0.25)) { this.cpt.carte = 0; this.envoyerCarte(); }
  }

  majCible(dt) {
    // Hors du mode chien, la cible n'existe plus.
    if (this.mode !== 'chien' && this.cible) {
      this.cible = null;
      if (this.radar === 'suivi') this.radar = 'auto';
    }
  }

  /** Arrêt devant un obstacle, urgence, vitesse maximale. */
  appliquerSecurites(cmd) {
    let { vx, vy, w } = cmd;
    this.obstacle = false;
    const vit = Math.hypot(vx, vy);
    this.libreCm = 255;
    if (vit > 0.02) {
      const c = Math.cos(this.cap); const s = Math.sin(this.cap);
      const wx = (vx * c + vy * s) / vit; const wy = (-vx * s + vy * c) / vit;
      // trois rayons : centre et deux côtés du châssis
      let d = Infinity;
      for (const off of [-LARGEUR_ROVER / 2, 0, LARGEUR_ROVER / 2]) d = Math.min(d, lancer(this.monde, this.x - wy * off, this.y + wx * off, wx, wy));
      const marge = d - RAYON;
      const arret = this.params.dist_arret.v;
      // « zone non regardée » : la case devant n'est pas encore connue
      const cc = this.caseX(this.x + wx * 0.3); const ll = this.caseY(this.y + wy * 0.3);
      this.aveugle = dansCarte(cc, ll) && this.carte[ll * TAILLE_CARTE + cc] === CASE_INCONNUE && this.mode !== 'manuel';
      this.libreCm = this.aveugle ? 255 : Math.round(limiter(marge * 100, 0, 254));
      let k = 1;
      if (this.params.reflexe.v >= 0.5) {
        if (marge < arret) { k = 0; this.obstacle = true; } else if (marge < arret + 0.15) k = (marge - arret) / 0.15;
      }
      if (this.aveugle && this.params.carte_on.v >= 0.5) k = Math.min(k, 0.5);
      vx *= k; vy *= k;
    } else this.aveugle = false;
    this.tObstacle = this.obstacle && this.mode !== 'manuel' ? this.tObstacle + PAS : 0;
    if (this.urgence) { vx = 0; vy = 0; w = 0; }
    return { vx: limiter(vx, -1, 1), vy: limiter(vy, -1, 1), w: limiter(w, -this.params.w_max.v, this.params.w_max.v) };
  }

  integrer(cmd, dt) {
    const accel = this.params.accel.v * (this.urgence ? 5 : 1) * dt;
    const approche = (v, cible, max) => v + limiter(cible - v, -max, max);
    this.vxb = approche(this.vxb, cmd.vx, accel);
    this.vyb = approche(this.vyb, cmd.vy, accel);
    this.w = approche(this.w, cmd.w, 8 * dt * (this.urgence ? 3 : 1));
    const c = Math.cos(this.cap); const s = Math.sin(this.cap);
    const dx = (this.vxb * c + this.vyb * s) * dt;
    const dy = (-this.vxb * s + this.vyb * c) * dt;
    const libre = (x, y) => distanceObstacle(this.monde, x, y) > RAYON;
    const avant = [this.x, this.y];
    if (libre(this.x + dx, this.y + dy)) { this.x += dx; this.y += dy; }
    else if (libre(this.x + dx, this.y)) this.x += dx; // on glisse le long de l'obstacle
    else if (libre(this.x, this.y + dy)) this.y += dy;
    this.cap = enrouler(this.cap + this.w * dt);
    // Roue bloquée : on commande du mouvement et le rover n'avance pas.
    const attendu = Math.hypot(dx, dy); const reel = Math.hypot(this.x - avant[0], this.y - avant[1]);
    this.patine = attendu > 0.002 && reel < 0.6 * attendu && reel >= 0.2 * attendu;
    if (attendu > 0.002 && reel < 0.2 * attendu) this.tBloque += dt; else this.tBloque = Math.max(0, this.tBloque - dt);
    this.vitesseReelle = Math.hypot(this.vxb, this.vyb);
  }

  // ===== Sonar =====

  balayerSonar(dt) {
    const vt = this.params.vitesse_tete.v * dt;
    let cible = 0; let amp = 90; let centre = 0;
    switch (this.radar) {
      case 'arret': case 'fixe': amp = 0; break;
      case 'suivi':
        amp = 0;
        if (this.cible) cible = limiter(degres(enrouler(Math.atan2(this.cible.x - this.x, this.cible.y - this.y) - this.cap)), -90, 90);
        break;
      case 'auto':
        amp = 70;
        if (Math.hypot(this.vxb, this.vyb) > 0.05) centre = limiter(degres(Math.atan2(this.vxb, this.vyb)), -20, 20);
        break;
      default: break;
    }
    if (amp === 0) {
      this.tete += limiter(cible - this.tete, -vt, vt);
    } else {
      this.tete += this.sensTete * vt;
      const hi = Math.min(90, centre + amp); const lo = Math.max(-90, centre - amp);
      if (this.tete >= hi) { this.tete = hi; this.sensTete = -1; }
      if (this.tete <= lo) { this.tete = lo; this.sensTete = 1; }
    }
    if (this.radar === 'arret') return;
    const a = this.cap + radians(this.tete);
    const dx = Math.sin(a); const dy = Math.cos(a);
    const capteur = positionSonar(this.x, this.y, this.cap); // le capteur est à 9,5 cm devant le centre
    let d = lancer(this.monde, capteur.x, capteur.y, dx, dy);
    const echo = d <= SONAR_MAX;
    if (echo) d += (this.alea() - 0.5) * 0.01;
    const portee = echo ? d : SONAR_MAX;
    this.marquerRayon(capteur.x, capteur.y, dx, dy, portee, echo);
    this.dernierEcho = echo ? Math.max(1, Math.round(d * 100)) : 255;
    this.echos.push({
      gisement: this.tete, distance: echo ? Math.round(d * 1000) : 0,
      x: (capteur.x + dx * portee) * 1000, y: (capteur.y + dy * portee) * 1000, t: Math.round(this.t * 1000) & 0xffff,
    });
  }

  /** Met la carte à jour : cases traversées = libres, case touchée = occupée. */
  marquerRayon(ox, oy, dx, dy, portee, echo) {
    const px = -dy; const py = dx; // perpendiculaire (pour élargir un peu le faisceau)
    const poser = (s, decal, valeur) => {
      const c = this.caseX(ox + dx * s + px * decal); const l = this.caseY(oy + dy * s + py * decal);
      if (!dansCarte(c, l)) return;
      const i = l * TAILLE_CARTE + c;
      if (valeur === CASE_OCCUPEE) this.carte[i] = CASE_OCCUPEE;
      else if (this.carte[i] === CASE_INCONNUE) this.carte[i] = CASE_LIBRE;
    };
    for (let s = 0.06; s < portee - CELLULE * 0.6; s += CELLULE * 0.5) {
      const demi = s * 0.04;
      for (let o = -demi; o <= demi + 1e-6; o += CELLULE * 0.5) poser(s, o, CASE_LIBRE);
    }
    if (echo) {
      const demi = portee * 0.04;
      for (let o = -demi; o <= demi + 1e-6; o += CELLULE * 0.5) poser(portee + 0.005, o, CASE_OCCUPEE);
    }
  }

  // ===== Émission des trames =====

  drapeaux() {
    const f = {
      urgence: this.urgence, garde: this.garde, obstacle: !!this.obstacle, laisse: false,
      blocage: this.tBloque > 0.6, patine: !!this.patine, batterie: this.tension < 6.8,
      driver_ko: false, imu_ko: false, arrive: this.t - this.tArrive < 2.5, gyro_ok: true,
      aveugle: !!this.aveugle, sature: false, retard: false,
      mouvement: (this.vitesseReelle ?? 0) > 0.02 || Math.abs(this.w) > 0.05,
      cible: !!this.cible, souleve: false,
    };
    return assemblerDrapeaux(f);
  }

  envoyerEtat() {
    let cibleGis = 0; let cibleD = 0;
    if (this.cible) {
      cibleGis = degres(enrouler(Math.atan2(this.cible.x - this.x, this.cible.y - this.y) - this.cap));
      cibleD = Math.hypot(this.cible.x - this.x, this.cible.y - this.y) * 100;
    }
    const c = this.fenetre ? this.centreFenetre() : { x: 0, y: 0 };
    this.sortie(encoderEtat({
      versionOrigine: this.fenetre ? this.versionOrigine : undefined,
      x: (this.x - c.x) * 1000, y: (this.y - c.y) * 1000, cap: degres(this.cap), drapeaux: this.drapeaux(),
      comportement: this.but && !this.but.base && this.mode === 'manuel' ? 0 : Math.max(0, this.modes.indexOf(this.mode)),
      tension: this.tension + (this.alea() - 0.5) * 0.04, tete: this.tete, sonar: this.dernierEcho,
      cibleGis, cibleD, libre: this.libreCm ?? 255,
      vitesse: (this.vitesseReelle ?? 0) * 100,
      rssi: -52 - 7 * Math.sin(this.t / 9) - Math.round(this.alea() * 3),
    }));
  }

  envoyerPoints() {
    if (!this.echos.length) return;
    const c = this.fenetre ? this.centreFenetre() : { x: 0, y: 0 };
    this.sortie(encoderPoints(this.echos.splice(0, 17).map((e) => ({ ...e, x: e.x - c.x * 1000, y: e.y - c.y * 1000 }))));
  }

  /** Envoie la carte : sans fenêtre, 8 lignes à tour de rôle ; avec, seulement ce qui a changé (les plus proches d'abord). */
  envoyerCarte() {
    const N = TAILLE_CARTE;
    if (!this.fenetre) {
      const nombre = 8;
      const lignes = [];
      for (let k = 0; k < nombre; k++) lignes.push(this.carte.subarray((this.ligneCarte + k) * N, (this.ligneCarte + k + 1) * N));
      this.sortie(encoderCarte(this.ligneCarte, lignes));
      this.ligneCarte = (this.ligneCarte + nombre) % N;
      return;
    }
    const ligne = (l) => this.carte.subarray(l * N, (l + 1) * N);
    const change = (l) => this.aRenvoyer.has(l) || ligne(l).some((v, i) => v !== this.envoye[l * N + i]);
    const lr = Math.min(N - 1, Math.max(0, this.caseY(this.y)));
    // la ligne qui a changé la plus proche du rover, puis ses voisines qui ont changé aussi (jusqu'à 8 consécutives)
    let depart = -1;
    for (let d = 0; d < N && depart < 0; d++) {
      for (const l of [lr - d, lr + d]) if (l >= 0 && l < N && change(l)) { depart = l; break; }
    }
    if (depart < 0) { // rien n'a changé : une ligne par seconde en fond, pour qu'une trame perdue ne laisse pas une ligne fausse
      this.cpt.fond = (this.cpt.fond ?? 0) + 0.1;
      if (this.cpt.fond < 1) return;
      this.cpt.fond = 0;
      depart = this.ligneFond; this.ligneFond = (this.ligneFond + 1) % N;
      this.aRenvoyer.add(depart);
    }
    let debut = depart;
    while (debut > 0 && depart - debut < 3 && change(debut - 1)) debut--;
    let fin = depart;
    while (fin < N - 1 && fin - debut < 7 && change(fin + 1)) fin++;
    const lignes = [];
    for (let l = debut; l <= fin; l++) { lignes.push(ligne(l)); this.envoye.set(ligne(l), l * N); this.aRenvoyer.delete(l); }
    this.sortie(encoderCarte(debut, lignes));
  }

  /** À la connexion du téléphone : identité, comportements, paramètres. */
  accueillir() {
    this.envoyerInfos();
    this.envoyerOrigine();
    this.renvoyerTout();
    Object.keys(this.params).forEach((n) => this.ligneP(n));
    this.cheminEnvoye = '';
    this.envoyerChemin();
    this.evt('démo : rover simulé connecté');
  }
}
