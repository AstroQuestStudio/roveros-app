// demo.js — la carte « Démo » (mode « demo » du rover) : le rover vérifie qu'un objet est posé devant lui,
// tourne autour, puis annonce le résultat. Logique pure : aucun DOM ici. Le rover parle (lignes de texte),
// la démo traduit ces lignes en phrases utiles et rend un affichage (état, phrase, détail, durée, distance).

export const ETATS = { PRET: 'pret', VERIFICATION: 'verification', EN_COURS: 'en_cours', FINIE: 'finie', REFUSEE: 'refusee', ARRETEE: 'arretee' };
const LIBELLES = {
  pret: 'Prête', verification: 'Vérification', en_cours: 'En cours', finie: 'Terminée', refusee: 'Refusée', arretee: 'Arrêtée',
};
export const COMMANDE_DEMO = 'mode demo';

/** Les chiffres sont gardés ; seul le point devient une virgule, comme dans le reste de l'application. */
function nombreFr(s) { return String(s).replace('.', ','); }

/** La ligne « modes … » annonce-t-elle la démo ? Sans elle, la carte reste cachée. */
export function annonceDemo(modes) {
  return Array.isArray(modes) && modes.includes('demo');
}

/** Traduit un refus du rover (le texte qui suit « err demo : ») en phrase utile pour l'utilisateur. */
export function traduireRefus(corps) {
  let m;
  if (/pas d['’]objet devant/i.test(corps)) {
    return "Il n'y a pas d'objet devant le rover. Posez-en un entre 35 et 75 cm devant.";
  }
  if ((m = /objet trop pr[èe]s \(([\d.]+) m\)/i.exec(corps))) {
    return `L'objet est trop près (${nombreFr(m[1])} m). Éloignez-le : il doit être entre 35 et 75 cm devant le rover.`;
  }
  if ((m = /obstacle à ([\d.]+) m à (droite|gauche) \(il manque ([\d.]+) m\)/i.exec(corps))) {
    return `Il manque ${nombreFr(m[3])} m de place libre : un obstacle est à ${nombreFr(m[1])} m à ${m[2]} du rover. Dégagez ce côté.`;
  }
  if (/c['’]est un mur/i.test(corps)) {
    return "Devant le rover, il y a un mur et non un objet. Posez l'objet entre 35 et 75 cm devant.";
  }
  return `La démo ne peut pas démarrer : ${corps}`;
}

/** Machine « prête → vérification → en cours → terminée / refusée / arrêtée ». Une démo à la fois. */
export class Demo {
  constructor() { this.reinitialiser(); }

  /** Remise à zéro (nouvelle liaison) : la démo repart de « prête », jusqu'à ce que la liaison dise le contraire. */
  reinitialiser() {
    this.connecte = false;
    this.etat = ETATS.PRET;
    this.phrase = 'Posez un objet devant le rover, puis lancez la démo.';
    this.detail = '';
    this.duree = null; // « 121 s » à la fin
    this.distance = null; // « 10,7 m » à la fin
  }

  /** Une démo peut partir si on est connecté et qu'aucune n'est en cours. */
  peutLancer() {
    return this.connecte && this.etat !== ETATS.VERIFICATION && this.etat !== ETATS.EN_COURS;
  }

  /** Appelé quand la commande « mode demo » est bien partie. Les lignes du rover prennent ensuite le relais. */
  demarrer() {
    if (!this.peutLancer()) return false;
    this.poser(ETATS.VERIFICATION, 'Commande envoyée : le rover vérifie que la place est libre.', '');
    return true;
  }

  /** Arrêt demandé (bouton d'arrêt d'urgence) : seulement si une démo tourne. */
  arreter() {
    if (this.etat !== ETATS.VERIFICATION && this.etat !== ETATS.EN_COURS) return false;
    this.poser(ETATS.ARRETEE, "Démo arrêtée par l'arrêt d'urgence.", '');
    return true;
  }

  /** La liaison change. Perdue pendant une démo, on ne sait plus où en est le rover : on le dit. */
  liaison(connecte) {
    this.connecte = !!connecte;
    if (!this.connecte && (this.etat === ETATS.VERIFICATION || this.etat === ETATS.EN_COURS)) {
      this.poser(
        ETATS.ARRETEE,
        'Liaison perdue pendant la démo : on ne sait plus où en est le rover.',
        "Reconnectez-vous pour vérifier. Si le rover bouge encore, utilisez l'arrêt d'urgence.",
      );
      return true;
    }
    return false;
  }

  /** Une ligne de texte du rover. Renvoie true si l'affichage a changé. */
  ligne(texte) {
    const brut = String(texte ?? '').trim();
    let m;
    if (/^err\s+demo\s*:/i.test(brut)) {
      const corps = brut.replace(/^err\s+demo\s*:\s*/i, '');
      this.poser(ETATS.REFUSEE, traduireRefus(corps), `Réponse du rover : ${corps}`);
      return true;
    }
    const sansPrefixe = brut.replace(/^evt\s+/i, '');
    if (/^mode d[ée]mo\s*:/i.test(brut)) {
      this.poser(ETATS.VERIFICATION, 'Le rover vérifie que la place est libre.', '');
      return true;
    }
    if ((m = /^demo\s*:\s*place libre,?\s*objet à ([\d.]+) m/i.exec(sansPrefixe))) {
      this.poser(ETATS.EN_COURS, "Place libre : le rover tourne autour de l'objet.", `Objet à ${nombreFr(m[1])} m.`);
      return true;
    }
    if ((m = /^demo finie\s*:\s*([\d.]+) s\s*,\s*([\d.]+) m/i.exec(sansPrefixe))) {
      this.poser(ETATS.FINIE, 'Démo terminée.', '');
      this.duree = `${nombreFr(m[1])} s`;
      this.distance = `${nombreFr(m[2])} m`;
      return true;
    }
    if ((m = /^demo arr[êe]t[ée]e\b\s*:?\s*(.*)$/i.exec(sansPrefixe))) {
      const raison = m[1].trim();
      this.poser(ETATS.ARRETEE, 'Démo arrêtée par le rover, pour des raisons de sécurité.', raison ? `Raison : ${raison}` : '');
      return true;
    }
    return false;
  }

  /** Ce qu'il faut afficher : rien de plus, rien de moins. */
  vue() {
    return {
      etat: this.etat,
      libelle: LIBELLES[this.etat],
      phrase: this.phrase,
      detail: this.detail,
      duree: this.etat === ETATS.FINIE ? this.duree : null,
      distance: this.etat === ETATS.FINIE ? this.distance : null,
      lancable: this.peutLancer(),
      enCours: this.etat === ETATS.VERIFICATION || this.etat === ETATS.EN_COURS,
    };
  }

  poser(etat, phrase, detail) {
    this.etat = etat;
    this.phrase = phrase;
    this.detail = detail;
    if (etat !== ETATS.FINIE) { this.duree = null; this.distance = null; }
  }
}
