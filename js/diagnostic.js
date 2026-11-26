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
 *              urgenceApp: bool, mode: nom du comportement en cours ('' si manuel), securites: bool (obstacles actifs) }
 * @returns {{ texte: string, niveau: 'neutre'|'ok'|'info'|'alerte'|'danger', cle: string }}
 */
export function phraseEtat(e, ctx = {}) {
  const commande = ctx.commande ?? { vx: 0, vy: 0, w: 0 };
  const pousse = Math.abs(commande.vx) > 5 || Math.abs(commande.vy) > 5 || Math.abs(commande.w) > 5;
  if (ctx.liaison && ctx.liaison !== 'connecte') {
    const texte = ctx.liaison === 'connexion' || ctx.liaison === 'reconnexion' ? 'Connexion au rover…' : 'Pas de rover connecté';
    return { texte, niveau: 'neutre', cle: 'liaison' };
  }
  if (!e) return { texte: 'En attente du rover…', niveau: 'neutre', cle: 'attente' };
  const f = e.flags;
  const d = directionMot(commande);

  if (f.urgence || ctx.urgenceApp) return { texte: "Arrêt d'urgence : maintenez le bouton rouge pour déverrouiller", niveau: 'danger', cle: 'urgence' };
  if (f.driver_ko) return { texte: 'Pilote des moteurs en panne : le rover ne peut pas rouler', niveau: 'danger', cle: 'driver_ko' };
  if (f.souleve) return { texte: 'Pris en main, ou roues sans prise : cap non tenu', niveau: 'danger', cle: 'souleve' };
  if (f.choc) return { texte: 'Contact avec un obstacle : le rover a ressenti un choc', niveau: 'danger', cle: 'choc' };
  if (f.blocage) return { texte: 'Roue bloquée : le rover est coincé', niveau: 'danger', cle: 'blocage' };
  if (f.garde && pousse) return { texte: 'Plus d\'ordre reçu : arrêté (liaison coupée ?)', niveau: 'alerte', cle: 'garde' };
  if (f.obstacle) {
    const cm = e.libre > 0 && e.libre < 255 ? Math.max(ARRONDI_MIN_CM, Math.round(e.libre)) : null;
    const texte = cm !== null ? `Obstacle à ${cm} cm ${d.devant}` : `Arrêté : obstacle ${d.devant}`;
    return { texte, niveau: 'alerte', cle: 'obstacle' };
  }
  if (f.laisse) return { texte: 'Limite de zone atteinte : le rover ne va pas plus loin', niveau: 'alerte', cle: 'laisse' };
  if (f.imu_ko) return { texte: 'Centrale inertielle en panne : cap non tenu', niveau: 'danger', cle: 'imu_ko' };
  if (f.aveugle) {
    const texte = d.cle === 'avant' || !pousse
      ? "Ralenti : il avance vers une zone qu'il n'a pas regardée"
      : `Ralenti : il ne voit pas ${d.cote}`;
    return { texte, niveau: 'alerte', cle: 'aveugle' };
  }
  if (f.patine) return { texte: 'Les roues patinent : le rover glisse', niveau: 'alerte', cle: 'patine' };
  if (f.batterie) return { texte: 'Batterie faible : rechargez bientôt', niveau: 'alerte', cle: 'batterie' };
  if (f.retard) return { texte: 'Le rover est surchargé : commandes en retard', niveau: 'alerte', cle: 'retard' };
  if (f.arrive) return { texte: 'Arrivé à destination', niveau: 'ok', cle: 'arrive' };
  if (ctx.mode) return { texte: `${ctx.mode} en cours`, niveau: 'info', cle: 'mode' };
  if (f.mouvement || e.vitesse > 2) return { texte: 'En mouvement', niveau: 'ok', cle: 'mouvement' };
  if (f.cible) return { texte: 'Il suit une cible', niveau: 'info', cle: 'cible' };
  return { texte: 'Prêt : poussez la manette de gauche pour avancer', niveau: 'ok', cle: 'pret' };
}

/** Texte court pour une notification, d'après la clé de la phrase. */
const NOTIFIABLES = new Set(['driver_ko', 'souleve', 'choc', 'blocage', 'garde', 'obstacle', 'laisse', 'imu_ko', 'aveugle', 'patine', 'batterie', 'retard']);

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
  }

  reinitialiser() {
    this.ligne = { texte: 'Pas de rover connecté', niveau: 'neutre', cle: 'liaison' };
    this._candidat = null; this._compteCandidat = 0; this._compteCle.clear();
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
