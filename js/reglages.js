// reglages.js — l'écran des réglages :
//   - les paramètres du rover (liste construite à partir des lignes « p nom valeur min max »),
//   - les commandes rapides, le mode du radar,
//   - la console de commandes texte.

/** Échappe le texte avant de l'insérer dans du HTML (les noms viennent du rover : on s'en méfie). */
export function echapper(t) {
  return String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Contrôle de saisie pour la commande « nom <NOM> » (20 caractères ASCII sans espace, ou « - »). */
export function validerNomRover(saisie) {
  const brut = String(saisie ?? '');
  if (brut.trim() === '') {
    return { valide: false, erreur: 'Entrez un nom (1 à 20 caractères ASCII sans espace) ou « - ».' };
  }
  if (brut.trim() === '-') {
    return { valide: true, nom: '-', commande: 'nom -' };
  }
  if (/\s/.test(brut)) {
    return { valide: false, erreur: "Pas d'espace dans le nom." };
  }
  if (brut.length > 20) {
    return { valide: false, erreur: '20 caractères maximum.' };
  }
  if (!/^[\x21-\x7e]+$/.test(brut)) {
    return { valide: false, erreur: 'Caractères ASCII uniquement (sans accent).' };
  }
  return { valide: true, nom: brut, commande: `nom ${brut}` };
}

/** Pas d'un curseur selon l'étendue des valeurs (≈ 200 crans, arrondi à une puissance de 10 × 1, 2 ou 5). */
export function pasCurseur(min, max) {
  const brut = (max - min) / 200;
  if (!(brut > 0)) return 1;
  const e = 10 ** Math.floor(Math.log10(brut));
  for (const m of [1, 2, 5, 10]) if (e * m >= brut) return e * m;
  return e * 10;
}

/** Explications courtes de quelques paramètres (affichées sous leur nom). */
export const DESCRIPTIONS = {
  vue_large: "Vue d'ensemble du sonar à la manette : toutes les N secondes, la tête balaie large (0 = jamais)",
  v_aveugle_man: "Vitesse maximale à la manette vers un côté que la tête ne regarde pas (marche arrière, côté), sécurités actives",
  reflexe: "1 = le rover ralentit et s'arrête devant ce que voit le sonar",
  carte_on: "1 = la carte d'obstacles sert à ralentir et à interdire les pivots près d'un mur",
  v_max: 'Vitesse maximale, en m/s',
  v_rapide: "Vitesse que le rover s'autorise quand le sonar voit la voie libre, en m/s",
  w_max: 'Rotation maximale, en rad/s',
};

const formatNombre = (v) => String(Math.round(v * 1e6) / 1e6);

export class Reglages {
  /**
   * @param {object} d  éléments de la page et fonctions :
   *   liste (conteneur des paramètres), recherche (input), console (conteneur), saisie (input),
   *   envoyerTexte(texte) : envoie une commande texte au rover
   */
  constructor({ liste, recherche, vide, console: zoneConsole, saisie, envoyerTexte }) {
    this.liste = liste;
    this.recherche = recherche;
    this.vide = vide;
    this.zoneConsole = zoneConsole;
    this.saisie = saisie;
    this.envoyerTexte = envoyerTexte;
    this.params = new Map(); // nom -> { nom, valeur, min, max, ligne }
    this.historique = [];
    this.posHistorique = 0;
    this._temporisation = new Map();

    recherche.addEventListener('input', () => this._filtrer());
    saisie.closest('form').addEventListener('submit', (ev) => { ev.preventDefault(); this._envoyerSaisie(); });
    saisie.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowUp' && this.historique.length) { ev.preventDefault(); this.posHistorique = Math.max(0, this.posHistorique - 1); saisie.value = this.historique[this.posHistorique] ?? ''; }
      if (ev.key === 'ArrowDown' && this.historique.length) { ev.preventDefault(); this.posHistorique = Math.min(this.historique.length, this.posHistorique + 1); saisie.value = this.historique[this.posHistorique] ?? ''; }
    });
    this._rendreVide();
  }

  /** Efface la liste (nouvelle connexion). */
  vider() {
    this.params.clear();
    this.liste.textContent = '';
    this._rendreVide();
  }

  /** Une ligne « p nom valeur min max » est arrivée : on crée ou met à jour la ligne de réglage. */
  majParam({ nom, valeur, min, max }) {
    let p = this.params.get(nom);
    if (!p) {
      p = { nom, valeur, min, max, ligne: null };
      this.params.set(nom, p);
      p.ligne = this._creerLigne(p);
      this.liste.append(p.ligne);
      this._trier();
    } else {
      p.valeur = valeur; p.min = min; p.max = max;
      this._remplir(p, false);
    }
    this._filtrer();
    this._rendreVide();
  }

  _creerLigne(p) {
    const ligne = document.createElement('div');
    ligne.className = 'param';
    ligne.dataset.nom = p.nom;
    ligne.innerHTML = `
      <label class="param-nom" for="p-${echapper(p.nom)}">${echapper(p.nom)}</label>
      <input class="param-nombre" id="p-${echapper(p.nom)}" type="number" inputmode="decimal" step="any" aria-label="Valeur de ${echapper(p.nom)}">
      <input class="param-curseur" type="range" aria-label="Curseur de ${echapper(p.nom)}">
      <span class="param-borne param-min"></span><span class="param-borne param-max"></span>
      ${DESCRIPTIONS[p.nom] ? `<span class="param-desc">${echapper(DESCRIPTIONS[p.nom])}</span>` : ''}`;
    const nombre = ligne.querySelector('.param-nombre');
    const curseur = ligne.querySelector('.param-curseur');
    // Le curseur envoie pendant le glissement (au plus 6 fois par seconde) et à la fin.
    curseur.addEventListener('input', () => { nombre.value = curseur.value; this._envoyerPlusTard(p.nom, Number(curseur.value)); });
    curseur.addEventListener('change', () => this._envoyerParam(p.nom, Number(curseur.value)));
    nombre.addEventListener('change', () => {
      let v = Number(nombre.value.replace(',', '.'));
      if (!Number.isFinite(v)) { nombre.value = formatNombre(p.valeur); return; }
      if (p.min !== null && p.max !== null) v = Math.min(p.max, Math.max(p.min, v));
      nombre.value = formatNombre(v); curseur.value = v;
      this._envoyerParam(p.nom, v);
    });
    p.ligne = ligne;
    this._remplir(p, true);
    return ligne;
  }

  _remplir(p, force) {
    const nombre = p.ligne.querySelector('.param-nombre');
    const curseur = p.ligne.querySelector('.param-curseur');
    const sansMinMax = p.min === null || p.max === null || !(p.max > p.min);
    curseur.hidden = sansMinMax;
    if (!sansMinMax) { curseur.min = p.min; curseur.max = p.max; curseur.step = pasCurseur(p.min, p.max); }
    p.ligne.querySelector('.param-min').textContent = sansMinMax ? '' : formatNombre(p.min);
    p.ligne.querySelector('.param-max').textContent = sansMinMax ? '' : formatNombre(p.max);
    // On ne touche pas à un champ que l'utilisateur est en train d'utiliser.
    if (force || (document.activeElement !== nombre && !p.ligne.classList.contains('en-cours'))) {
      nombre.value = formatNombre(p.valeur);
      curseur.value = p.valeur;
    }
  }

  _trier() {
    [...this.liste.children].sort((a, b) => a.dataset.nom.localeCompare(b.dataset.nom)).forEach((l) => this.liste.append(l));
  }

  _envoyerPlusTard(nom, v) {
    if (this._temporisation.has(nom)) return;
    this._temporisation.set(nom, setTimeout(() => { this._temporisation.delete(nom); this._envoyerParam(nom, v, true); }, 160));
  }

  _envoyerParam(nom, v, silencieux = false) {
    const p = this.params.get(nom);
    if (p) p.valeur = v;
    this.envoyerTexte(`param ${nom} ${formatNombre(v)}`, { silencieux });
  }

  _filtrer() {
    const q = this.recherche.value.trim().toLowerCase();
    let visibles = 0;
    for (const p of this.params.values()) {
      const ok = !q || p.nom.toLowerCase().includes(q);
      p.ligne.hidden = !ok;
      if (ok) visibles++;
    }
    this._rendreVide(visibles);
  }

  _rendreVide(visibles = this.params.size) {
    if (this.params.size === 0) {
      this.vide.hidden = false;
      this.vide.textContent = "Aucun paramètre reçu pour l'instant. Connectez-vous puis touchez « Actualiser ».";
    } else if (visibles === 0) {
      this.vide.hidden = false;
      this.vide.textContent = 'Aucun paramètre ne correspond à cette recherche.';
    } else this.vide.hidden = true;
  }

  // ---------- Console ----------

  _envoyerSaisie() {
    const texte = this.saisie.value.trim();
    if (!texte) return;
    this.saisie.value = '';
    if (this.historique[this.historique.length - 1] !== texte) this.historique.push(texte);
    if (this.historique.length > 50) this.historique.shift();
    this.posHistorique = this.historique.length;
    this.envoyerTexte(texte, { silencieux: false });
  }

  /** Ajoute une ligne dans la console. sens : 'sortant' (nous) ou 'entrant' (rover). */
  ecrireConsole(texte, sens = 'entrant', genre = '') {
    const l = document.createElement('div');
    l.className = `console-ligne ${sens} ${genre}`;
    l.textContent = `${sens === 'sortant' ? '› ' : ''}${texte}`;
    const enBas = this.zoneConsole.scrollTop + this.zoneConsole.clientHeight >= this.zoneConsole.scrollHeight - 30;
    this.zoneConsole.append(l);
    while (this.zoneConsole.childElementCount > 300) this.zoneConsole.firstElementChild.remove();
    if (enBas) this.zoneConsole.scrollTop = this.zoneConsole.scrollHeight;
  }
}
