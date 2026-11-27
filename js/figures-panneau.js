// figures-panneau.js — le panneau « Figures » de l'onglet Pilotage : choix de la figure, curseurs,
// et un gros bouton à MAINTENIR. Toute la logique (formules, sécurités) est dans figures.js ; ici, l'affichage.

import { ConduiteFigure, BORNES } from './figures.js';

const $ = (sel) => document.querySelector(sel);

const LIBELLES_COINS = {
  'avant-gauche': 'Avant gauche', 'avant-droit': 'Avant droit', 'arriere-gauche': 'Arrière gauche', 'arriere-droit': 'Arrière droit',
};
const LIBELLES_DIRECTIONS = {
  'avant-droite': 'Avant droite', 'avant-gauche': 'Avant gauche', 'arriere-droite': 'Arrière droite', 'arriere-gauche': 'Arrière gauche',
};

/** Ce que demande chaque figure : un curseur de taille (rayon ou côté) et un choix secondaire. */
const REGLAGES = {
  orbite: { taille: 'rayon', choix: { nom: 'sens', options: [['horaire', 'Horaire'], ['antihoraire', 'Antihoraire']] } },
  pivot: { choix: { nom: 'coin', options: Object.entries(LIBELLES_COINS) } },
  diagonale: { choix: { nom: 'direction', options: Object.entries(LIBELLES_DIRECTIONS) } },
  carre: { taille: 'cote' },
  huit: { taille: 'rayon' },
};
const TITRES_TAILLE = { rayon: 'Rayon', cote: 'Côté' };
const AIDES = {
  orbite: 'Le rover tourne autour d’un point devant lui, nez tourné vers ce point.',
  pivot: 'Le rover pivote autour d’un de ses coins, qui reste immobile.',
  diagonale: 'Le rover glisse en diagonale, sans tourner.',
  carre: 'Le rover parcourt un carré, sans tourner.',
  huit: 'Deux cercles enchaînés, nez dans le sens de la marche.',
};

const metres = (v) => `${v.toFixed(2).replace('.', ',')} m`;

/**
 * Branche le panneau Figures.
 * @param {object} o  pilote (Pilote) ; estConnecte() ; limites() -> { vMax, wMax } en m/s et rad/s ;
 *                    fermerTiroir() ; vibrer(motif) ; afficherToast(genre, texte)
 */
export function initFigures({ pilote, estConnecte, limites, fermerTiroir, vibrer, afficherToast }) {
  const panneau = $('#figures');
  const bouton = $('#fig-jouer');
  if (!panneau || !bouton) return null;

  const conduite = new ConduiteFigure(pilote, { estConnecte });
  const etat = {
    nom: 'orbite',
    taille: { rayon: 0.6, cote: 0.6 },
    vitesse: 0.6,
    choix: { sens: 'horaire', coin: 'avant-gauche', direction: 'avant-droite' },
  };

  function dessiner() {
    const r = REGLAGES[etat.nom];
    for (const b of panneau.querySelectorAll('#fig-choix button')) b.classList.toggle('actif', b.dataset.figure === etat.nom);

    const bloc = $('#fig-taille-bloc');
    bloc.hidden = !r.taille;
    if (r.taille) {
      const [min, max] = BORNES[r.taille];
      const curseur = $('#fig-taille');
      curseur.min = Math.round(min * 100);
      curseur.max = Math.round(max * 100);
      curseur.value = Math.round(etat.taille[r.taille] * 100);
      $('#fig-taille-titre').textContent = TITRES_TAILLE[r.taille];
      $('#fig-taille-val').textContent = metres(etat.taille[r.taille]);
    }

    const options = $('#fig-options');
    options.hidden = !r.choix;
    options.replaceChildren();
    if (r.choix) {
      for (const [valeur, libelle] of r.choix.options) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.valeur = valeur;
        b.textContent = libelle;
        b.classList.toggle('actif', etat.choix[r.choix.nom] === valeur);
        options.append(b);
      }
    }

    $('#fig-vitesse').value = Math.round(etat.vitesse * 100);
    $('#fig-vitesse-val').textContent = `${Math.round(etat.vitesse * 100)} %`;
    $('#fig-aide').textContent = AIDES[etat.nom];
  }

  // -- Choix de la figure et des réglages : chaque changement arrête une figure en cours --
  $('#fig-choix').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-figure]');
    if (!b) return;
    conduite.arreter();
    etat.nom = b.dataset.figure;
    dessiner();
    vibrer?.(8);
  });
  $('#fig-options').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-valeur]');
    if (!b) return;
    etat.choix[REGLAGES[etat.nom].choix.nom] = b.dataset.valeur;
    dessiner();
    vibrer?.(8);
  });
  $('#fig-taille').addEventListener('input', (ev) => {
    const cle = REGLAGES[etat.nom].taille;
    if (!cle) return;
    etat.taille[cle] = Number(ev.target.value) / 100;
    $('#fig-taille-val').textContent = metres(etat.taille[cle]);
  });
  $('#fig-vitesse').addEventListener('input', (ev) => {
    etat.vitesse = Number(ev.target.value) / 100;
    $('#fig-vitesse-val').textContent = `${Math.round(etat.vitesse * 100)} %`;
  });

  // -- Le gros bouton : la figure ne se joue que doigt posé. Relâcher, perdre le focus ou la liaison = arrêt. --
  const relacher = () => { bouton.classList.remove('joue'); conduite.arreter(); };
  bouton.addEventListener('pointerdown', (ev) => {
    if (ev.button > 0) return;
    ev.preventDefault();
    bouton.setPointerCapture?.(ev.pointerId);
    if (!estConnecte()) { afficherToast('err', 'Pas de liaison avec le rover'); return; }
    const { vMax, wMax } = limites();
    const lance = conduite.demarrer(etat.nom, {
      vMax, wMax, rayon: etat.taille.rayon, cote: etat.taille.cote, vitesse: etat.vitesse, ...etat.choix,
    });
    if (!lance) { afficherToast('evt', 'Une manette est posée : relâchez-la pour jouer une figure'); return; }
    bouton.classList.add('joue');
    vibrer?.(8);
  });
  bouton.addEventListener('pointerup', relacher);
  bouton.addEventListener('pointercancel', relacher);
  bouton.addEventListener('lostpointercapture', relacher);
  bouton.addEventListener('contextmenu', (ev) => ev.preventDefault());
  // Une manette touchée ou la liaison coupée arrête la figure sans passer par le bouton : on suit l'état.
  setInterval(() => { if (!conduite.actif && bouton.classList.contains('joue')) bouton.classList.remove('joue'); }, 100);
  window.addEventListener('blur', relacher);
  document.addEventListener('visibilitychange', () => { if (document.hidden) relacher(); });

  function ouvrir() {
    panneau.hidden = false;
    fermerTiroir?.();
    dessiner();
    vibrer?.(8);
  }
  function fermer() {
    relacher();
    panneau.hidden = true;
  }
  $('#btn-figures').addEventListener('click', ouvrir);
  $('#fig-fermer').addEventListener('click', fermer);
  dessiner();
  return { conduite, ouvrir, fermer };
}
