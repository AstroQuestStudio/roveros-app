// contours.js — transforme la grille de la carte (cases de 5 cm) en contours lisses, calculés côté téléphone.
//
// 1. boucles()  : le contour EXACT des cases choisies (frontière entre cases choisies et non choisies), sous forme
//                 de boucles fermées. Aucune case n'est inventée ni effacée : une case isolée donne sa boucle de 4 coins.
// 2. adoucir()  : arrondit les coins par la méthode de Chaikin. Les angles droits deviennent des arrondis de l'ordre
//                 d'une case, les escaliers du faisceau du sonar deviennent des diagonales lisses.
//
// Les coordonnées sont en « unités de case » : x = colonne, y = ligne (la ligne 0 est le bas de la carte).
// Les boucles tournent dans le sens trigonométrique, l'intérieur à gauche : un trou tourne dans l'autre sens,
// ce qui permet de tout remplir en une fois avec la règle « nonzero ».

/**
 * @param {Uint8Array} grille  N × N valeurs (ligne par ligne, la ligne 0 en premier)
 * @param {number} N           taille de la grille (64)
 * @param {(v:number, i:number)=>boolean} choisie  vrai pour les cases à contourner
 * @returns {Array<Array<[number, number]>>} boucles de sommets (coins de cases, sans coin superflu)
 */
export function boucles(grille, N, choisie) {
  const ok = (c, l) => c >= 0 && c < N && l >= 0 && l < N && choisie(grille[l * N + c], l * N + c);
  const L = N + 1; // sommets par ligne
  const sortantes = new Map(); // sommet de départ -> liste de sommets d'arrivée non encore utilisés
  const ajouter = (x0, y0, x1, y1) => {
    const a = y0 * L + x0;
    const liste = sortantes.get(a);
    if (liste) liste.push(y1 * L + x1); else sortantes.set(a, [y1 * L + x1]);
  };
  for (let l = 0; l < N; l++) {
    for (let c = 0; c < N; c++) {
      if (!ok(c, l)) continue;
      if (!ok(c, l - 1)) ajouter(c, l, c + 1, l); // dessous : vers l'est
      if (!ok(c + 1, l)) ajouter(c + 1, l, c + 1, l + 1); // droite : vers le nord
      if (!ok(c, l + 1)) ajouter(c + 1, l + 1, c, l + 1); // dessus : vers l'ouest
      if (!ok(c - 1, l)) ajouter(c, l + 1, c, l); // gauche : vers le sud
    }
  }
  const resultat = [];
  const xy = (v) => [v % L, Math.floor(v / L)];
  for (const [depart] of sortantes) {
    while (sortantes.get(depart)?.length) {
      const boucle = [];
      let courant = depart;
      let dir = null; // direction d'arrivée (dx, dy)
      for (;;) {
        const liste = sortantes.get(courant);
        if (!liste || !liste.length) break;
        const [cx, cy] = xy(courant);
        let choix = 0;
        if (liste.length > 1 && dir) {
          // Sommet où deux cases ne se touchent que par un coin : on tourne à droite pour garder le tout d'un seul tenant
          // (un mur en diagonale reste continu).
          let meilleur = -Infinity;
          liste.forEach((v, i) => {
            const [vx, vy] = xy(v);
            const croix = dir[0] * (vy - cy) - dir[1] * (vx - cx); // < 0 : virage à droite
            const score = -croix;
            if (score > meilleur) { meilleur = score; choix = i; }
          });
        }
        const suivant = liste.splice(choix, 1)[0];
        const [sx, sy] = xy(suivant);
        const nd = [sx - cx, sy - cy];
        // on ne garde que les vrais coins (pas les points alignés)
        if (!dir || dir[0] !== nd[0] || dir[1] !== nd[1]) boucle.push([cx, cy]);
        dir = nd;
        courant = suivant;
        if (courant === depart) break;
      }
      if (boucle.length >= 3) {
        // le premier sommet est peut-être aligné avec ses voisins : on le retire s'il l'est
        const n = boucle.length;
        const [px, py] = boucle[n - 1]; const [qx, qy] = boucle[0]; const [rx, ry] = boucle[1];
        if ((qx - px) * (ry - qy) - (qy - py) * (rx - qx) === 0) boucle.shift();
        resultat.push(boucle);
      }
    }
  }
  return resultat;
}

/** Une passe de Chaikin sur une boucle fermée : chaque côté est remplacé par ses points à 1/4 et 3/4. */
function chaikin(boucle) {
  const n = boucle.length;
  const sortie = new Array(n * 2);
  for (let i = 0; i < n; i++) {
    const [x0, y0] = boucle[i]; const [x1, y1] = boucle[(i + 1) % n];
    sortie[2 * i] = [0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1];
    sortie[2 * i + 1] = [0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1];
  }
  return sortie;
}

/**
 * Arrondit une boucle. Pour que le rayon d'arrondi soit le même partout (et pas proportionnel à la longueur
 * d'un mur), les longs côtés sont d'abord découpés en morceaux d'une case au plus.
 */
export function adoucir(boucle, iterations = 2, pas = 1) {
  let b = [];
  const n = boucle.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = boucle[i]; const [x1, y1] = boucle[(i + 1) % n];
    const morceaux = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / pas));
    for (let k = 0; k < morceaux; k++) b.push([x0 + ((x1 - x0) * k) / morceaux, y0 + ((y1 - y0) * k) / morceaux]);
  }
  for (let i = 0; i < iterations; i++) b = chaikin(b);
  return b;
}

/** Aire signée d'une boucle (positive dans le sens trigonométrique), en cases carrées. */
export function aire(boucle) {
  let s = 0;
  for (let i = 0; i < boucle.length; i++) {
    const [x0, y0] = boucle[i]; const [x1, y1] = boucle[(i + 1) % boucle.length];
    s += x0 * y1 - x1 * y0;
  }
  return s / 2;
}
