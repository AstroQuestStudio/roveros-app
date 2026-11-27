// diagnostic.js — dire en clair POURQUOI le rover n'avance pas (ou avance lentement).
//
//   - phraseEtat(etat, contexte) : traduit les drapeaux de la trame ÉTAT en UNE phrase, la plus utile du moment ;
//   - Diagnostic                 : stabilise cette phrase (un drapeau d'une seule trame ne change rien) et décide
//                                  quand prévenir par une notification (jamais deux fois la même en moins de 5 s) ;
//   - Limiteur                   : l'anti-doublon, réutilisé pour les messages texte du rover et les vibrations.
//
// Pas de DOM ici : tout se teste sous Node.

/** Anti-doublon : une même clé n'est autorisée qu'une fois par fenêtre (5 s par défaut). */
export class Limiteur {
  constructor(fenetreMs = 5000) {
    this.fenetreMs = fenetreMs;
    this._vus = new Map();
  }

  /** true si on peut annoncer cette clé maintenant (et le note). */
  autoriser(cle, maintenant = performance.now()) {
    const avant = this._vus.get(cle);
    if (avant !== undefined && maintenant - avant < this.fenetreMs) return false;
    this._vus.set(cle, maintenant);
    if (this._vus.size > 200) for (const [k, t] of this._vus) if (maintenant - t > this.fenetreMs) this._vus.delete(k);
    return true;
  }
}

const ARRONDI_MIN_CM = 1;

const fmtVitesse = (v) => `${v.toFixed(2).replace('.', ',')} m/s`;

/**
 * Traduit un code `frein` du cœur Rust (coeur/src/pilote.rs) en explication claire.
 * Partagé entre l'affichage en direct (Pilotage) et l'analyse du journal.
 */
export function traduireFrein(frein, direction = { cle: 'avant', devant: 'devant', cote: 'devant lui' }, plafond = null) {
  const cap = Number.isFinite(plafond) && plafond >= 0 ? ` à ${fmtVitesse(plafond)}` : '';
  switch (frein) {
    case 1:
      return {
        cle: 'frein-1',
        enDirect: `Ralenti${cap} : obstacle vu ${direction.devant}`,
        analyse: 'le rover voyait un obstacle devant',
      };
    case 2:
      return {
        cle: 'frein-2',
        enDirect: direction.cle === 'avant'
          ? `Ralenti${cap} : direction que le rover ne regarde pas`
          : `Ralenti${cap} : il ne regarde pas ${direction.cote}`,
        analyse: 'direction que le rover ne regardait pas',
      };
    case 3:
      return {
        cle: 'frein-3',
        enDirect: `Ralenti${cap} : obstacle sur la carte dans le passage`,
        analyse: 'obstacle sur la carte dans le passage',
      };
    case 4:
      return {
        cle: 'frein-4',
        enDirect: `Ralenti${cap} : zone incertaine sur la carte`,
        analyse: 'zone incertaine sur la carte',
      };
    case 5:
      return {
        cle: 'frein-5',
        enDirect: `Ralenti${cap} : obstacle vu sur le côté`,
        analyse: 'le rover voyait un obstacle sur le côté',
      };
    case 6:
      return {
        cle: 'frein-6',
        enDirect: `Ralenti${cap} : obstacle tout près`,
        analyse: 'obstacle tout près du rover',
      };
    default:
      return null;
  }
}

/**
 * Détermine la cause principale d'un ralentissement ou arrêt à partir d'un état + contexte.
 * Utilisée par `phraseEtat` (direct) et `analyserJournal` (a posteriori).
 */
export function causeLimitation(e, ctx = {}) {
  if (!e) return null;
  const f = e.flags ?? {};
  const d = directionMot(ctx.commande);
  const pousse = ctx.pousse ?? (Math.abs(ctx.commande?.vx ?? 0) > 5 || Math.abs(ctx.commande?.vy ?? 0) > 5 || Math.abs(ctx.commande?.w ?? 0) > 5);

  if (ctx.ecritureKo) return { cle: 'ecriture-ko', niveau: 'danger', enDirect: 'Les commandes ne partent plus (écriture Bluetooth en échec)', analyse: "échec d'écriture Bluetooth" };
  if (f.urgence || ctx.urgenceApp) return { cle: 'urgence', niveau: 'danger', enDirect: "Arrêt d'urgence : maintenez le bouton rouge pour déverrouiller", analyse: "arrêt d'urgence actif" };
  if (f.driver_ko) return { cle: 'driver_ko', niveau: 'danger', enDirect: 'Pilote des moteurs en panne : le rover ne peut pas rouler', analyse: 'carte moteurs muette (driver_ko)' };
  if (f.souleve) return { cle: 'souleve', niveau: 'danger', enDirect: 'Pris en main, ou roues sans prise : cap non tenu', analyse: 'rover soulevé ou roues sans prise' };
  if (f.choc) return { cle: 'choc', niveau: 'danger', enDirect: 'Contact avec un obstacle : le rover a ressenti un choc', analyse: 'contact détecté avec un obstacle' };
  if (f.blocage) return { cle: 'blocage', niveau: 'danger', enDirect: 'Roue bloquée : le rover est coincé', analyse: 'roue bloquée' };
  if (f.garde && (pousse || ctx.trouEnvoi)) return { cle: 'garde', niveau: 'alerte', enDirect: "Plus d'ordre reçu : arrêté (liaison coupée ?)", analyse: "le rover s'est arrêté de lui-même (garde)" };
  if (f.obstacle) {
    const cm = e.libre > 0 && e.libre < 255 ? Math.max(ARRONDI_MIN_CM, Math.round(e.libre)) : null;
    return {
      cle: 'obstacle',
      niveau: 'alerte',
      enDirect: cm !== null ? `Obstacle à ${cm} cm ${d.devant}` : `Arrêté : obstacle ${d.devant}`,
      analyse: d.cle === 'avant' || d.cle === 'arriere' ? `le rover voyait un obstacle ${d.devant}` : `le rover voyait un obstacle ${d.devant}`,
    };
  }
  if (f.laisse) return { cle: 'laisse', niveau: 'alerte', enDirect: 'Limite de zone atteinte : le rover ne va pas plus loin', analyse: 'limite de zone atteinte' };
  if (f.imu_ko) return { cle: 'imu_ko', niveau: 'danger', enDirect: 'Centrale inertielle en panne : cap non tenu', analyse: 'centrale inertielle en panne' };
  if (f.aveugle) {
    return {
      cle: 'aveugle',
      niveau: 'alerte',
      enDirect: d.cle === 'avant' || !pousse
        ? "Ralenti : il avance vers une zone qu'il n'a pas regardée"
        : `Ralenti : il ne voit pas ${d.cote}`,
      analyse: 'direction que le rover ne regardait pas',
    };
  }
  if (pousse && Number.isFinite(ctx.plafond) && ctx.plafond >= 0 && ctx.frein >= 1 && ctx.frein <= 6) {
    const vRef = ctx.vConsigne ?? ctx.vMax ?? 1;
    if (ctx.plafond < vRef * 0.95) {
      const fr = traduireFrein(ctx.frein, d, ctx.plafond);
      if (fr) return { cle: fr.cle, niveau: 'alerte', enDirect: fr.enDirect, analyse: fr.analyse };
    }
  }
  if (f.patine) return { cle: 'patine', niveau: 'alerte', enDirect: 'Les roues patinent : le rover glisse', analyse: 'les roues patinaient' };
  if (f.batterie || (Number.isFinite(e.tension) && e.tension > 0 && e.tension < 5.6)) {
    return { cle: 'batterie', niveau: 'alerte', enDirect: 'Batterie faible : rechargez bientôt', analyse: 'tension batterie basse' };
  }
  if (f.retard) return { cle: 'retard', niveau: 'alerte', enDirect: 'Le rover est surchargé : commandes en retard', analyse: 'boucle du rover en retard' };
  if (ctx.liaisonRalentie && pousse) return { cle: 'liaison-lente', niveau: 'alerte', enDirect: 'Ralenti : liaison Bluetooth ralentie', analyse: 'liaison Bluetooth ralentie' };
  return null;
}

/** Où regarde le rover : d'après la commande de l'utilisateur (vx, vy en %), sinon « devant ». */
export function directionMot(commande) {
  const { vx = 0, vy = 0 } = commande ?? {};
  if (Math.abs(vx) <= 5 && Math.abs(vy) <= 5) return { cle: 'avant', devant: 'devant', cote: 'devant lui' };
  if (Math.abs(vy) >= Math.abs(vx)) return vy >= 0 ? { cle: 'avant', devant: 'devant', cote: 'devant lui' } : { cle: 'arriere', devant: 'derrière', cote: 'derrière lui' };
  return vx > 0 ? { cle: 'droite', devant: 'à droite', cote: 'son côté droit' } : { cle: 'gauche', devant: 'à gauche', cote: 'son côté gauche' };
}

/**
 * La phrase qui explique l'état du rover.
 * @param e  trame ÉTAT décodée (flags, libre en cm, vitesse en cm/s, comportement…) ou null
 * @param ctx { liaison: 'connecte'|…, commande: {vx,vy,w} (ce que l'utilisateur demande, en %),
 *              urgenceApp: bool, mode: nom du comportement en cours ('' si manuel), veille: bool (semi-veille du rover),
 *              restant: distance (m) qui reste jusqu'au point touché sur la carte (null si aucun « aller »), formaterDistance }
 * @returns {{ texte: string, niveau: 'neutre'|'ok'|'info'|'alerte'|'danger', cle: string }}
 */
export function phraseEtat(e, ctx = {}) {
  const commande = ctx.commande ?? { vx: 0, vy: 0, w: 0 };
  const pousse = Math.abs(commande.vx) > 5 || Math.abs(commande.vy) > 5 || Math.abs(commande.w) > 5;
  if (ctx.liaison && ctx.liaison !== 'connecte') {
    const texte = ctx.liaison === 'connexion' || ctx.liaison === 'reconnexion' ? 'Connexion au rover…' : 'Pas de rover connecté';
    return { texte, niveau: 'neutre', cle: 'liaison' };
  }
  if (ctx.ecritureKo) return { texte: 'Les commandes ne partent plus (écriture Bluetooth en échec)', niveau: 'danger', cle: 'ecriture-ko' };
  if (!e) return { texte: 'En attente du rover…', niveau: 'neutre', cle: 'attente' };
  // la liaison est ouverte mais le rover ne donne plus d'état : l'écran ne doit pas afficher un « Prêt à rouler » périmé
  if (ctx.silenceMs > 2500) return { texte: `Plus de nouvelles du rover depuis ${Math.round(ctx.silenceMs / 1000)} s`, niveau: 'alerte', cle: 'silence' };
  const f = e.flags;
  const cause = causeLimitation(e, { ...ctx, commande, pousse });
  if (cause) return { texte: cause.enDirect, niveau: cause.niveau, cle: cause.cle };
  const fmt = ctx.formaterDistance ?? ((m) => `${Math.round(m * 100)} cm`);
  if (f.arrive && ctx.restant != null && ctx.restant > 0.3) {
    // le rover dit « arrivé » alors qu'il n'est pas sur la cible (par exemple au bord de sa carte) : on le dit
    return { texte: `Il se dit arrivé, mais le point est encore à ${fmt(ctx.restant)}`, niveau: 'alerte', cle: 'arrive-faux' };
  }
  if (f.arrive) return { texte: 'Arrivé à destination', niveau: 'ok', cle: 'arrive' };
  if (ctx.restant != null) return { texte: `En route : ${fmt(ctx.restant)} jusqu'au point`, niveau: 'info', cle: 'aller' };
  if (ctx.mode) return { texte: `${ctx.mode} en cours`, niveau: 'info', cle: 'mode' };
  if (f.mouvement || e.vitesse > 2) return { texte: 'En mouvement', niveau: 'ok', cle: 'mouvement' };
  if (ctx.veille) return { texte: 'En veille', niveau: 'neutre', cle: 'veille' }; // tête et moteurs au repos, jusqu'au réveil
  return { texte: 'Prêt à rouler', niveau: 'ok', cle: 'pret' };
}

/** Texte court pour une notification, d'après la clé de la phrase. */
const NOTIFIABLES = new Set(['driver_ko', 'souleve', 'choc', 'blocage', 'garde', 'obstacle', 'laisse', 'imu_ko', 'aveugle', 'patine', 'batterie', 'retard']);

// ---------- Défauts passagers ----------

/**
 * Drapeaux qui retombent d'eux-mêmes quand la carte moteurs décroche (quelques dizaines de ms).
 * Ils ne sont affichés qu'après DUREE_DEFAUT_PASSAGER_MS d'affilée. L'arrêt d'urgence, la batterie
 * faible, la garde et le contact avec un obstacle restent immédiats (ils ne sont pas dans cette liste).
 */
export const DEFAUTS_PASSAGERS = ['driver_ko', 'blocage', 'patine', 'souleve', 'imu_ko'];
export const DUREE_DEFAUT_PASSAGER_MS = 400;

/**
 * Pur : quels défauts passagers afficher à l'instant `maintenant`.
 * @param flags       drapeaux de la trame (nom -> booléen)
 * @param leves       Map nom -> instant (ms) où le drapeau s'est levé, telle que rendue par l'appel précédent
 * @param maintenant  instant de réception de la trame (ms)
 * @param duree       durée minimale d'affilée avant affichage (ms)
 * @returns { flags: drapeaux à afficher, leves: Map à garder pour la trame suivante,
 *            masques: noms cachés cette trame, courts: { nom, duree } des défauts retombés avant `duree` }
 */
export function filtrerDefautsPassagers(flags = {}, leves = new Map(), maintenant = 0, duree = DUREE_DEFAUT_PASSAGER_MS) {
  const affiches = { ...flags };
  const nouvelles = new Map();
  const masques = [];
  for (const nom of DEFAUTS_PASSAGERS) {
    if (!flags[nom]) continue;
    const debut = leves.has(nom) ? leves.get(nom) : maintenant;
    nouvelles.set(nom, debut);
    if (maintenant - debut < duree) { affiches[nom] = false; masques.push(nom); }
  }
  const courts = [];
  for (const [nom, debut] of leves) {
    if (!nouvelles.has(nom) && debut !== undefined && maintenant - debut < duree) courts.push({ nom, duree: maintenant - debut });
  }
  return { flags: affiches, leves: nouvelles, masques, courts };
}

export class Diagnostic {
  /**
   * @param {object} o  tramesLigne : trames identiques avant de changer la ligne (2 ≈ 0,25 s)
   *                    tramesAnnonce : trames consécutives avant de prévenir par notification (3 ≈ 0,4 s)
   *                    limiteur : anti-doublon (5 s)
   */
  constructor({ tramesLigne = 2, tramesAnnonce = 3, limiteur = new Limiteur(5000) } = {}) {
    this.tramesLigne = tramesLigne;
    this.tramesAnnonce = tramesAnnonce;
    this.limiteur = limiteur;
    this.ligne = { texte: 'Pas de rover connecté', niveau: 'neutre', cle: 'liaison' };
    this._candidat = null;
    this._compteCandidat = 0;
    this._compteCle = new Map();
    this._leves = new Map(); // défauts passagers levés, et depuis quand (voir filtrerDefautsPassagers)
    this.courts = new Map(); // nom -> nombre de défauts passagers retombés avant DUREE_DEFAUT_PASSAGER_MS (non affichés)
  }

  reinitialiser() {
    this.ligne = { texte: 'Pas de rover connecté', niveau: 'neutre', cle: 'liaison' };
    this._candidat = null; this._compteCandidat = 0; this._compteCle.clear();
    this._leves.clear(); this.courts.clear();
  }

  /**
   * Retire de la trame les défauts passagers pas encore affichables (moins de DUREE_DEFAUT_PASSAGER_MS).
   * À appeler une fois par trame, avant `traiter` et l'affichage des drapeaux. Le journal reçoit la trame brute.
   * @returns la trame à afficher (la même si rien à retirer)
   */
  filtrer(e, maintenant = performance.now()) {
    if (!e || !e.flags) return e;
    const r = filtrerDefautsPassagers(e.flags, this._leves, maintenant);
    this._leves = r.leves;
    for (const c of r.courts) this.courts.set(c.nom, (this.courts.get(c.nom) ?? 0) + 1);
    return r.masques.length ? { ...e, flags: r.flags } : e;
  }

  /**
   * À appeler à chaque trame ÉTAT (ou quand la liaison change).
   * @returns {{ ligne, change: boolean, annonce: null | { cle, texte, niveau } }}
   */
  traiter(e, ctx, maintenant = performance.now()) {
    const p = phraseEtat(e, ctx);
    // Compteur de trames consécutives par cause.
    for (const cle of [...this._compteCle.keys()]) if (cle !== p.cle) this._compteCle.delete(cle);
    const n = (this._compteCle.get(p.cle) ?? 0) + 1;
    this._compteCle.set(p.cle, n);

    let change = false;
    if (p.cle === this.ligne.cle) {
      // Même cause : le texte (la distance) peut bouger sans attendre.
      change = p.texte !== this.ligne.texte || p.niveau !== this.ligne.niveau;
      this.ligne = p; this._candidat = null; this._compteCandidat = 0;
    } else {
      // Un liaison perdue s'affiche tout de suite ; le reste doit durer au moins `tramesLigne` trames.
      if (this._candidat === p.cle) this._compteCandidat++; else { this._candidat = p.cle; this._compteCandidat = 1; }
      if (p.cle === 'liaison' || this._compteCandidat >= this.tramesLigne) {
        this.ligne = p; change = true; this._candidat = null; this._compteCandidat = 0;
      }
    }

    let annonce = null;
    if (n === this.tramesAnnonce && NOTIFIABLES.has(p.cle) && this.ligne.cle === p.cle && this.limiteur.autoriser(`etat:${p.cle}`, maintenant)) {
      annonce = { cle: p.cle, texte: p.texte, niveau: p.niveau };
    }
    return { ligne: this.ligne, change, annonce };
  }
}

// ---------- Sécurités obstacles ----------

/** Les deux paramètres du rover qui forment « les sécurités obstacles ». */
export const PARAMS_SECURITES = ['reflexe', 'carte_on'];

/**
 * État réel des sécurités, lu dans les paramètres reçus du rover (Map nom -> { valeur }).
 * @returns {'actives'|'coupees'|'partielles'|'inconnu'}
 */
export function etatSecurites(params) {
  const v = PARAMS_SECURITES.map((n) => params.get(n)?.valeur);
  if (v.some((x) => typeof x !== 'number')) return 'inconnu';
  const coupes = v.filter((x) => x < 0.5).length;
  return coupes === 0 ? 'actives' : coupes === v.length ? 'coupees' : 'partielles';
}
