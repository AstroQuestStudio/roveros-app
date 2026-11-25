// generer-icones.mjs — fabrique les icônes de l'application (SVG + PNG) sans aucune dépendance.
// Utilisation :  node outils/generer-icones.mjs
// Le dessin : l'éventail d'un sonar (turquoise) devant un rover vu de dessus (ambre), sur fond nuit.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dossier = join(dirname(fileURLToPath(import.meta.url)), '..', 'icones');
mkdirSync(dossier, { recursive: true });

// ---------- Le dessin, en formes simples (repère 512 × 512, 0° = vers le haut) ----------
const FOND = '#0b0d14';
const SONAR = '#4fe3d0';
const AMBRE = '#f5a83a';
const AMBRE_SOMBRE = '#b97d22';
const CENTRE = [256, 334];
const formes = [
  { t: 'arc', cx: CENTRE[0], cy: CENTRE[1], r: 104, l: 20, a: 34, c: SONAR, o: 1 },
  { t: 'arc', cx: CENTRE[0], cy: CENTRE[1], r: 158, l: 20, a: 34, c: SONAR, o: 0.66 },
  { t: 'arc', cx: CENTRE[0], cy: CENTRE[1], r: 212, l: 20, a: 34, c: SONAR, o: 0.36 },
  { t: 'rect', x: 198, y: 308, w: 16, h: 36, rx: 5, c: AMBRE_SOMBRE, o: 1 },
  { t: 'rect', x: 198, y: 354, w: 16, h: 36, rx: 5, c: AMBRE_SOMBRE, o: 1 },
  { t: 'rect', x: 298, y: 308, w: 16, h: 36, rx: 5, c: AMBRE_SOMBRE, o: 1 },
  { t: 'rect', x: 298, y: 354, w: 16, h: 36, rx: 5, c: AMBRE_SOMBRE, o: 1 },
  { t: 'rect', x: 212, y: 296, w: 88, h: 108, rx: 24, c: AMBRE, o: 1 },
  { t: 'rect', x: 232, y: 322, w: 48, h: 62, rx: 12, c: FOND, o: 0.55 },
];

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** Dans quelle forme tombe le point (x, y) ? */
function dedans(f, x, y) {
  if (f.t === 'rect') {
    const cx = Math.min(Math.max(x, f.x + f.rx), f.x + f.w - f.rx);
    const cy = Math.min(Math.max(y, f.y + f.rx), f.y + f.h - f.rx);
    return x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h && Math.hypot(x - cx, y - cy) <= f.rx;
  }
  const dx = x - f.cx; const dy = y - f.cy;
  const d = Math.hypot(dx, dy);
  const angle = (Math.atan2(dx, -dy) * 180) / Math.PI; // 0° = vers le haut
  return Math.abs(d - f.r) <= f.l / 2 && Math.abs(angle) <= f.a;
}

// ---------- SVG ----------
function svg(masquable) {
  const s = masquable ? 0.78 : 1;
  const fond = masquable ? `<rect width="512" height="512" fill="${FOND}"/>` : `<rect width="512" height="512" rx="112" fill="${FOND}"/>`;
  const corps = formes.map((f) => {
    if (f.t === 'rect') return `<rect x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" rx="${f.rx}" fill="${f.c}" opacity="${f.o}"/>`;
    const a0 = ((-f.a - 90) * Math.PI) / 180; const a1 = ((f.a - 90) * Math.PI) / 180;
    const p = (a) => `${(f.cx + f.r * Math.cos(a)).toFixed(1)} ${(f.cy + f.r * Math.sin(a)).toFixed(1)}`;
    return `<path d="M${p(a0)} A${f.r} ${f.r} 0 0 1 ${p(a1)}" fill="none" stroke="${f.c}" stroke-width="${f.l}" stroke-linecap="butt" opacity="${f.o}"/>`;
  }).join('\n  ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  ${fond}
  <g transform="translate(256 256) scale(${s}) translate(-256 -256)">
  ${corps}
  </g>
</svg>
`;
}

// ---------- PNG ----------
function crc32(tampon) {
  let c; let crc = 0xffffffff;
  for (let n = 0; n < tampon.length; n++) {
    c = (crc ^ tampon[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function bloc(type, donnees) {
  const t = Buffer.from(type, 'ascii');
  const lon = Buffer.alloc(4); lon.writeUInt32BE(donnees.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, donnees])));
  return Buffer.concat([lon, t, donnees, crc]);
}
function png(taille, masquable) {
  const s = masquable ? 0.78 : 1;
  const SS = 4; // sur-échantillonnage 4×4 : bords lissés
  const brut = Buffer.alloc((taille * 4 + 1) * taille);
  const rayonFond = masquable ? 0 : (112 / 512) * taille;
  const fond = rgb(FOND);
  for (let py = 0; py < taille; py++) {
    brut[py * (taille * 4 + 1)] = 0; // filtre « aucun »
    for (let px = 0; px < taille; px++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const X = ((px + (sx + 0.5) / SS) / taille) * 512; const Y = ((py + (sy + 0.5) / SS) / taille) * 512;
        // fond (carré arrondi)
        const rf = rayonFond ? (rayonFond / taille) * 512 : 0;
        const cx = Math.min(Math.max(X, rf), 512 - rf); const cy = Math.min(Math.max(Y, rf), 512 - rf);
        if (Math.hypot(X - cx, Y - cy) > rf + 1e-9) continue;
        let col = fond.slice();
        const dx = (X - 256) / s + 256; const dy = (Y - 256) / s + 256;
        for (const f of formes) {
          if (!dedans(f, dx, dy)) continue;
          const c = rgb(f.c);
          col = col.map((v, i) => v * (1 - f.o) + c[i] * f.o);
        }
        r += col[0]; g += col[1]; b += col[2]; a += 255;
      }
      const n = SS * SS; const o = py * (taille * 4 + 1) + 1 + px * 4;
      const cov = a / 255;
      brut[o] = cov ? Math.round(r / cov) : 0; brut[o + 1] = cov ? Math.round(g / cov) : 0; brut[o + 2] = cov ? Math.round(b / cov) : 0;
      brut[o + 3] = Math.round(a / n);
    }
  }
  const entete = Buffer.alloc(13);
  entete.writeUInt32BE(taille, 0); entete.writeUInt32BE(taille, 4); entete[8] = 8; entete[9] = 6; // 8 bits, RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), bloc('IHDR', entete), bloc('IDAT', deflateSync(brut, { level: 9 })), bloc('IEND', Buffer.alloc(0))]);
}

writeFileSync(join(dossier, 'icone.svg'), svg(false));
writeFileSync(join(dossier, 'icone-masquable.svg'), svg(true));
writeFileSync(join(dossier, 'icone-192.png'), png(192, false));
writeFileSync(join(dossier, 'icone-512.png'), png(512, false));
writeFileSync(join(dossier, 'icone-masquable-512.png'), png(512, true));
console.log('Icônes écrites dans le dossier icones/');
