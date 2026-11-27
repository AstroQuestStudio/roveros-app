// journal.js — boîte noire de séance (logique pure + persistance IndexedDB groupée).
//
// Enregistre à coût quasi nul (tableaux typés préalloués, aucune allocation par trame) :
//   - chaque trame envoyée, durée d'écriture Bluetooth et échecs ;
//   - chaque trame ÉTAT reçue et champs demandés (`champ plafond frein tension ...`) ;
//   - chaque ligne de texte, connexion/déconnexion, visibilité de page ;
//   - position brute du doigt sur chaque manette (appui, mouvement, relâchement, sortie de zone) ;
//   - repères « Marquer » posés par le pilote.
//
// Aucune dépendance au DOM. Testable sous Node. Aucune donnée personnelle stockée.

import { T, NOMS_DRAPEAUX } from './protocole.js';
import { causeLimitation } from './diagnostic.js';

export const CAPACITE_ENVOIS = 32768; // > 21 min à 25 trames/s
export const CAPACITE_ETATS = 32768;  // > 27 min à 20 trames/s
export const CAPACITE_CHAMPS = 16384; // > 68 min à 4 Hz
export const CAPACITE_DOIGTS = 65536; // > 18 min à 60 Hz
export const CAPACITE_EVENEMENTS = 4096;
export const CAPACITE_JOURNAL_ROVER = 2048;

export const SOURCES_DOIGT = { xy: 0, rot: 1, inclinaison: 2, clavier: 3 };
export const NOMS_SOURCE_DOIGT = ['xy', 'rot', 'inclinaison', 'clavier'];
export const ACTIONS_DOIGT = { appui: 0, mouvement: 1, relache: 2, sortie: 3, annule: 4 };
export const NOMS_ACTION_DOIGT = ['appui', 'mouvement', 'relache', 'sortie', 'annule'];

export const CHAMPS_RUST_DEMANDES = ['plafond', 'frein', 'tension', 'a_lim', 'cycles'];

const BIT_URGENCE = 1 << NOMS_DRAPEAUX.indexOf('urgence');
const BIT_GARDE = 1 << NOMS_DRAPEAUX.indexOf('garde');
const BIT_OBSTACLE = 1 << NOMS_DRAPEAUX.indexOf('obstacle');
const BIT_LAISSE = 1 << NOMS_DRAPEAUX.indexOf('laisse');
const BIT_BLOCAGE = 1 << NOMS_DRAPEAUX.indexOf('blocage');
const BIT_PATINE = 1 << NOMS_DRAPEAUX.indexOf('patine');
const BIT_BATTERIE = 1 << NOMS_DRAPEAUX.indexOf('batterie');
const BIT_DRIVER_KO = 1 << NOMS_DRAPEAUX.indexOf('driver_ko');
const BIT_IMU_KO = 1 << NOMS_DRAPEAUX.indexOf('imu_ko');
const BIT_AVEUGLE = 1 << NOMS_DRAPEAUX.indexOf('aveugle');
const BIT_RETARD = 1 << NOMS_DRAPEAUX.indexOf('retard');
const BIT_SOULEVE = 1 << NOMS_DRAPEAUX.indexOf('souleve');
const BIT_CHOC = 1 << NOMS_DRAPEAUX.indexOf('choc');

const s8 = (v) => (v > 127 ? v - 256 : v);
const fmtVirgule = (n, d = 2) => n.toFixed(d).replace('.', ',');

/** Extrait uniquement la famille et la version majeure du navigateur (aucune donnée personnelle). */
export function familleNavigateur(ua = typeof navigator !== 'undefined' ? navigator.userAgent : '') {
  const s = String(ua ?? '');
  for (const [nom, rx] of [
    ['Edge', /EdgA?\/(\d+)/],
    ['Opera', /OPR\/(\d+)/],
    ['Chrome', /Chrom(?:e|ium)\/(\d+)/],
    ['Firefox', /Firefox\/(\d+)/],
    ['Safari', /Version\/(\d+).*Safari\//],
  ]) {
    const m = s.match(rx);
    if (m) return `${nom} ${m[1]}`;
  }
  return 'Navigateur inconnu';
}

/** Formate un instant epoch (ms) en heure lisible française : « 20 h 02 min 11 s ». */
export function formaterHeureFr(epochMs) {
  const d = new Date(epochMs);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(d.getHours())} h ${p2(d.getMinutes())} min ${p2(d.getSeconds())} s`;
}

/** Décode un entier de drapeaux 24 bits en objet de drapeaux booléens (sans allocation répétée si réutilisé). */
function remplirFlags(drapeaux, cible) {
  cible.urgence = (drapeaux & BIT_URGENCE) !== 0;
  cible.garde = (drapeaux & BIT_GARDE) !== 0;
  cible.obstacle = (drapeaux & BIT_OBSTACLE) !== 0;
  cible.laisse = (drapeaux & BIT_LAISSE) !== 0;
  cible.blocage = (drapeaux & BIT_BLOCAGE) !== 0;
  cible.patine = (drapeaux & BIT_PATINE) !== 0;
  cible.batterie = (drapeaux & BIT_BATTERIE) !== 0;
  cible.driver_ko = (drapeaux & BIT_DRIVER_KO) !== 0;
  cible.imu_ko = (drapeaux & BIT_IMU_KO) !== 0;
  cible.aveugle = (drapeaux & BIT_AVEUGLE) !== 0;
  cible.retard = (drapeaux & BIT_RETARD) !== 0;
  cible.souleve = (drapeaux & BIT_SOULEVE) !== 0;
  cible.choc = (drapeaux & BIT_CHOC) !== 0;
  return cible;
}

export class JournalSeance {
  constructor({
    debutHorlogeMs = Date.now(),
    debutPerfMs = typeof performance !== 'undefined' ? performance.now() : 0,
    navigateur = familleNavigateur(),
    cadencePrevueMs = 1000 / 15,
  } = {}) {
    this.debutHorlogeMs = debutHorlogeMs;
    this.debutPerfMs = debutPerfMs;
    this.navigateur = navigateur;
    this.cadencePrevueMs = cadencePrevueMs;
    this.transport = '';
    this.firmware = { famille: 'inconnu', version: '' };
    this.champsDemandes = [];
    this.sale = false; // vrai si des données nouvelles restent à enregistrer en IndexedDB

    // --- Tampon circulaire des trames envoyées + durée d'écriture ---
    const CE = CAPACITE_ENVOIS;
    this.envois = {
      cap: CE,
      total: 0,
      t: new Float64Array(CE),
      type: new Uint8Array(CE),
      vx: new Int8Array(CE),
      vy: new Int8Array(CE),
      w: new Int8Array(CE),
      opt: new Uint8Array(CE),
      vMaxCm: new Uint8Array(CE),
      doigtActif: new Uint8Array(CE),
      dureeMs: new Float32Array(CE),
      ok: new Uint8Array(CE),
    };

    // --- Tampon circulaire des trames ÉTAT reçues ---
    const CS = CAPACITE_ETATS;
    this.etats = {
      cap: CS,
      total: 0,
      t: new Float64Array(CS),
      vitesse: new Uint8Array(CS),
      drapeaux: new Uint32Array(CS),
      comportement: new Uint8Array(CS),
      tensionDv: new Uint8Array(CS),
      tete: new Int8Array(CS),
      sonar: new Uint8Array(CS),
      libre: new Uint8Array(CS),
      rssi: new Int8Array(CS),
      xMm: new Int16Array(CS),
      yMm: new Int16Array(CS),
      capCdeg: new Int16Array(CS),
      plafond: new Float32Array(CS),
      frein: new Uint8Array(CS),
    };

    // --- Tampon circulaire des champs supplémentaires (`c plafond=... frein=...`) ---
    const CC = CAPACITE_CHAMPS;
    this.champs = {
      cap: CC,
      total: 0,
      t: new Float64Array(CC),
      plafond: new Float32Array(CC),
      frein: new Uint8Array(CC),
      tension: new Float32Array(CC),
      aLim: new Float32Array(CC),
      cycles: new Uint32Array(CC),
    };

    // --- Tampon circulaire des positions brutes du doigt ---
    const CD = CAPACITE_DOIGTS;
    this.doigts = {
      cap: CD,
      total: 0,
      t: new Float64Array(CD),
      source: new Uint8Array(CD),
      action: new Uint8Array(CD),
      x: new Float32Array(CD),
      y: new Float32Array(CD),
    };

    // --- Événements discrets (connexions, textes, visibilité, repères, diagnostics) ---
    this.evenements = [];
    // --- Lignes du journal embarqué relevé par la commande « journal » ---
    this.journalRover = [];
    this._dernierPlafond = NaN;
    this._dernierFrein = 255;
    this._dernierCycles = -1;
  }

  epochDe(tPerf) {
    return this.debutHorlogeMs + (tPerf - this.debutPerfMs);
  }

  /** Enregistre une trame envoyée (aucune allocation). Renvoie un identifiant entier pour `noterFinEcriture`. */
  noterEnvoi(t, trame, vMaxMs = 0.4, doigtMasque = 0) {
    const E = this.envois;
    const id = E.total++;
    const i = id & (E.cap - 1);
    const type = trame[0] ?? 0;
    E.t[i] = t;
    E.type[i] = type;
    if (type === T.MANETTE && trame.length >= 5) {
      E.vx[i] = s8(trame[1]);
      E.vy[i] = s8(trame[2]);
      E.w[i] = s8(trame[3]);
      E.opt[i] = trame[4];
    } else {
      E.vx[i] = 0; E.vy[i] = 0; E.w[i] = 0; E.opt[i] = 0;
    }
    E.vMaxCm[i] = Math.min(255, Math.max(0, Math.round((Number(vMaxMs) || 0.4) * 100)));
    E.doigtActif[i] = doigtMasque & 0xff;
    E.dureeMs[i] = NaN;
    E.ok[i] = 255; // en attente de résolution
    this.sale = true;
    return id;
  }

  /** Complète une écriture commencée avec `noterEnvoi` (aucune allocation). */
  noterFinEcriture(id, ok, dureeMs) {
    const E = this.envois;
    if (id < 0 || id >= E.total || E.total - id > E.cap) return;
    const i = id & (E.cap - 1);
    E.ok[i] = ok ? 1 : 0;
    E.dureeMs[i] = dureeMs;
    this.sale = true;
  }

  /** Enregistre une trame ÉTAT décodée (aucune allocation). */
  noterEtat(t, e) {
    if (!e) return;
    const S = this.etats;
    const i = (S.total++) & (S.cap - 1);
    S.t[i] = t;
    S.vitesse[i] = e.vitesse & 0xff;
    S.drapeaux[i] = e.drapeaux >>> 0;
    S.comportement[i] = e.comportement & 0xff;
    S.tensionDv[i] = Math.min(255, Math.max(0, Math.round((e.tension ?? 0) * 10)));
    S.tete[i] = e.tete | 0;
    S.sonar[i] = e.sonar & 0xff;
    S.libre[i] = e.libre & 0xff;
    S.rssi[i] = e.rssi | 0;
    S.xMm[i] = e.x | 0;
    S.yMm[i] = e.y | 0;
    S.capCdeg[i] = Math.round((e.cap ?? 0) * 100) | 0;
    S.plafond[i] = this._dernierPlafond;
    S.frein[i] = this._dernierFrein;
    this.sale = true;
  }

  /** Enregistre les champs supplémentaires issus de `champ …` (`c plafond=…`) sans allocation. */
  noterChamps(t, v) {
    if (!v || typeof v !== 'object') return;
    const C = this.champs;
    const i = (C.total++) & (C.cap - 1);
    const plafond = typeof v.plafond === 'number' ? v.plafond : NaN;
    const frein = typeof v.frein === 'number' ? Math.max(0, Math.min(254, Math.round(v.frein))) : 255;
    const tension = typeof v.tension === 'number' ? v.tension : NaN;
    const aLim = typeof v.a_lim === 'number' ? v.a_lim : NaN;
    const cycles = typeof v.cycles === 'number' && v.cycles >= 0 ? (v.cycles >>> 0) : 0xffffffff;
    C.t[i] = t;
    C.plafond[i] = plafond;
    C.frein[i] = frein;
    C.tension[i] = tension;
    C.aLim[i] = aLim;
    C.cycles[i] = cycles;
    if (!Number.isNaN(plafond)) this._dernierPlafond = plafond;
    if (frein !== 255) this._dernierFrein = frein;
    if (cycles !== 0xffffffff) {
      if (this._dernierCycles >= 0 && cycles < this._dernierCycles) {
        this._pousserEvenement({ t, genre: 'redemarrage', cyclesAvant: this._dernierCycles, cyclesApres: cycles });
      }
      this._dernierCycles = cycles;
    }
    this.sale = true;
  }

  /** Enregistre la position brute d'un doigt / source (aucune allocation). */
  noterDoigt(t, source, action, x = 0, y = 0) {
    const D = this.doigts;
    const i = (D.total++) & (D.cap - 1);
    D.t[i] = t;
    D.source[i] = typeof source === 'number' ? source : (SOURCES_DOIGT[source] ?? 0);
    D.action[i] = typeof action === 'number' ? action : (ACTIONS_DOIGT[action] ?? 1);
    D.x[i] = x;
    D.y[i] = y;
    this.sale = true;
  }

  _pousserEvenement(ev) {
    this.evenements.push(ev);
    if (this.evenements.length > CAPACITE_EVENEMENTS) {
      this.evenements.splice(0, this.evenements.length - CAPACITE_EVENEMENTS);
    }
    this.sale = true;
  }

  noterTexte(t, texte) {
    this._pousserEvenement({ t, genre: 'texte', texte: String(texte) });
  }

  noterLiaison(t, etat, message = '', transport = '', firmware = null) {
    if (transport) this.transport = transport;
    if (firmware) this.firmware = { famille: firmware.famille ?? 'inconnu', version: firmware.version ?? '' };
    if (etat !== 'connecte') { this._dernierPlafond = NaN; this._dernierFrein = 255; this._dernierCycles = -1; }
    this._pousserEvenement({ t, genre: 'liaison', etat, message: String(message || ''), transport });
  }

  noterVisibilite(t, visible) {
    this._pousserEvenement({ t, genre: 'visibilite', visible: !!visible });
  }

  /** Pose un repère utilisateur (« j'ai senti une hésitation ici »). */
  marquer(t = typeof performance !== 'undefined' ? performance.now() : 0, note = 'Hésitation ressentie') {
    const rep = { t, genre: 'marque', note: String(note || 'Hésitation ressentie') };
    this._pousserEvenement(rep);
    return rep;
  }

  /** Range un relevé de diagnostic (cause de redémarrage raz=, état des bus, liaison) dans le journal de séance. */
  noterDiagnostic(t, diag) {
    if (!diag || typeof diag !== 'object') return;
    this._pousserEvenement({
      t,
      genre: 'diagnostic',
      raz: diag.raz ?? null,
      bus: Array.isArray(diag.bus) ? diag.bus.map((b) => ({ index: b.index, nom: b.nom, texte: b.texte, alerte: !!b.alerte, abrt: b.abrt, lig: b.lig, reprises: b.reprises, tentatives: b.tentatives })) : [],
      resume: diag.resume ?? '',
      alerte: !!diag.alerte,
    });
  }

  /** Enregistre une ligne « j <temps_ms> <nom> <valeurs…> » relevée depuis le rover (telle quelle, alignable). */
  noterJournalRover(tReception, ligneBrute, parsed, { lotId = 0, decalagePerfMs = null } = {}) {
    const tempsMs = typeof parsed?.tempsMs === 'number' && Number.isFinite(parsed.tempsMs) ? parsed.tempsMs : null;
    const aligne = decalagePerfMs !== null && tempsMs !== null;
    const t = aligne ? tempsMs + decalagePerfMs : tReception;
    const entree = {
      lotId,
      ligne: String(ligneBrute),
      tempsMs,
      nom: parsed?.nom ? String(parsed.nom) : '',
      valeurs: parsed?.valeursTexte ? String(parsed.valeursTexte) : '',
      t,
      tReception,
      aligne,
    };
    this.journalRover.push(entree);
    if (this.journalRover.length > CAPACITE_JOURNAL_ROVER) {
      this.journalRover.splice(0, this.journalRover.length - CAPACITE_JOURNAL_ROVER);
    }
    this.sale = true;
    return entree;
  }

  /** Aligne les lignes d'un relevé « journal » sur l'horloge de l'application (decalage = tApp - tRoverMs). */
  alignerJournalRover(lotId, decalagePerfMs) {
    if (!Number.isFinite(decalagePerfMs)) return 0;
    let maj = 0;
    for (const entree of this.journalRover) {
      if (entree.lotId === lotId && entree.tempsMs !== null) {
        entree.t = entree.tempsMs + decalagePerfMs;
        entree.aligne = true;
        maj++;
      }
    }
    if (maj > 0) this.sale = true;
    return maj;
  }

  vider() {
    this.envois.total = 0;
    this.etats.total = 0;
    this.champs.total = 0;
    this.doigts.total = 0;
    this.evenements.length = 0;
    this.journalRover.length = 0;
    this._dernierPlafond = NaN;
    this._dernierFrein = 255;
    this._dernierCycles = -1;
    this.sale = false;
  }
}

// ---------- Itération ordonnée sur un tampon circulaire ----------

function bornesTampon(buf) {
  const n = Math.min(buf.total, buf.cap);
  const debut = buf.total - n;
  return { debut, fin: buf.total, n };
}

function pourChaque(buf, tMin, tMax, fn) {
  const { debut, fin } = bornesTampon(buf);
  const mask = buf.cap - 1;
  for (let id = debut; id < fin; id++) {
    const i = id & mask;
    const t = buf.t[i];
    if (t < tMin) continue;
    if (t > tMax) break;
    fn(i, id, t);
  }
}

// ---------- Analyse automatique (fonction pure) ----------

const SEUIL_ECRITURE_LENTE_MS = 100;
const SEUIL_TROU_RECEPTION_MS = 300;
const SEUIL_BAISSE_DUREE_MS = 300;
const SEUIL_RATIO_VITESSE = 0.60;

function analyserFenetre(journal, tMin, tMax, { cadencePrevueMs } = {}) {
  const cadence = cadencePrevueMs ?? journal.cadencePrevueMs ?? (1000 / 15);
  const seuilTrouEnvoi = 2 * cadence;
  const phrases = [];

  // Index des déconnexions dans la fenêtre (pour ne pas compter un changement de session comme un trou).
  const coupures = [];
  for (const ev of journal.evenements) {
    if (ev.t >= tMin && ev.t <= tMax) {
      if (ev.genre === 'liaison' && ev.etat !== 'connecte') coupures.push(ev.t);
    }
  }
  const aCoupureEntre = (a, b) => coupures.some((tc) => tc >= a && tc <= b);

  // 1. Trous d'envoi, écritures lentes / en échec, STOP alors que le doigt est posé
  const trousEnvoi = [];
  const ecrituresLentes = [];
  const echecsEcriture = [];
  const stopsDoigtPose = [];
  const envoisManette = []; // pour corréler à la vitesse commandée

  let prevManetteT = null;
  let stopEntreDeux = false;

  pourChaque(journal.envois, tMin - 600, tMax, (i, _id, t) => {
    const E = journal.envois;
    const type = E.type[i];
    if (type === T.MANETTE) {
      envoisManette.push({ t, vx: E.vx[i], vy: E.vy[i], w: E.w[i], vMax: E.vMaxCm[i] / 100, doigtActif: E.doigtActif[i] });
    } else if (type === T.STOP || type === T.URGENCE) {
      envoisManette.push({ t, vx: 0, vy: 0, w: 0, vMax: E.vMaxCm[i] / 100, stop: true });
    }

    if (t < tMin) return;

    if (type === T.MANETTE) {
      if (prevManetteT !== null && !stopEntreDeux && !aCoupureEntre(prevManetteT, t)) {
        const dt = t - prevManetteT;
        if (dt > seuilTrouEnvoi && dt < 5000) {
          trousEnvoi.push({ tDebut: prevManetteT, tFin: t, dureeMs: dt });
        }
      }
      prevManetteT = t;
      stopEntreDeux = false;
    } else if (type === T.STOP || type === T.URGENCE) {
      stopEntreDeux = true;
      if (type === T.STOP && E.doigtActif[i] !== 0) {
        stopsDoigtPose.push({ t });
      }
    }

    const ok = E.ok[i];
    const duree = E.dureeMs[i];
    if (ok === 0) echecsEcriture.push({ t, type, dureeMs: Number.isFinite(duree) ? duree : 0 });
    else if (ok === 1 && duree >= SEUIL_ECRITURE_LENTE_MS) ecrituresLentes.push({ t, dureeMs: duree });
  });

  // 2. Trous de réception et périodes de vitesse < 60 % de la consigne pendant > 300 ms
  const trousReception = [];
  const baisses = [];
  let prevEtatT = null;
  let idxCmd = 0;
  const flagsTmp = {};
  let periodeCourante = null;

  const clorePeriode = () => {
    if (!periodeCourante) return;
    const dureeMs = periodeCourante.tFin - periodeCourante.tDebut;
    if (dureeMs > SEUIL_BAISSE_DUREE_MS) baisses.push({ ...periodeCourante, dureeMs });
    periodeCourante = null;
  };

  pourChaque(journal.etats, tMin, tMax, (i, _id, t) => {
    const S = journal.etats;
    if (prevEtatT !== null && !aCoupureEntre(prevEtatT, t)) {
      const dt = t - prevEtatT;
      if (dt > SEUIL_TROU_RECEPTION_MS && dt < 10000) {
        trousReception.push({ tDebut: prevEtatT, tFin: t, dureeMs: dt });
      }
    }
    prevEtatT = t;

    // Recherche de la dernière consigne MANETTE/STOP connue avant t
    while (idxCmd + 1 < envoisManette.length && envoisManette[idxCmd + 1].t <= t) idxCmd++;
    const cmd = envoisManette[idxCmd];
    const comportement = S.comportement[i];
    const vMesure = S.vitesse[i] / 100;
    const drapeaux = S.drapeaux[i];
    remplirFlags(drapeaux, flagsTmp);

    if (!cmd || cmd.stop || t - cmd.t > 700 || comportement !== 0) {
      clorePeriode();
      return;
    }

    const fracTrans = Math.min(1, Math.hypot(cmd.vx, cmd.vy) / 100);
    const vConsigne = fracTrans * cmd.vMax;
    if (vConsigne < 0.08) {
      clorePeriode();
      return;
    }

    if (vMesure < SEUIL_RATIO_VITESSE * vConsigne) {
      const plafond = S.plafond[i];
      const frein = S.frein[i];
      const tension = S.tensionDv[i] / 10;
      const eSim = { flags: flagsTmp, libre: S.libre[i], tension, vitesse: S.vitesse[i] };
      const trouEnvoi = trousEnvoi.some((g) => g.tFin >= t - 500 && g.tDebut <= t);
      const ecritureLente = ecrituresLentes.some((w) => Math.abs(w.t - t) < 400) || echecsEcriture.some((w) => Math.abs(w.t - t) < 400);
      const trouRx = trousReception.some((g) => g.tFin >= t - 500 && g.tDebut <= t);
      const cause = causeLimitation(eSim, {
        commande: cmd,
        pousse: true,
        plafond,
        frein,
        vConsigne,
        trouEnvoi,
        liaisonRalentie: ecritureLente || trouRx,
      });

      if (!periodeCourante) {
        periodeCourante = {
          tDebut: t,
          tFin: t,
          vConsigneSum: vConsigne,
          vMesureSum: vMesure,
          n: 1,
          plafondMin: Number.isFinite(plafond) && plafond >= 0 ? plafond : Infinity,
          causePrincipale: cause?.analyse ?? null,
          garde: flagsTmp.garde,
        };
      } else {
        periodeCourante.tFin = t;
        periodeCourante.vConsigneSum += vConsigne;
        periodeCourante.vMesureSum += vMesure;
        periodeCourante.n++;
        if (Number.isFinite(plafond) && plafond >= 0) periodeCourante.plafondMin = Math.min(periodeCourante.plafondMin, plafond);
        if (!periodeCourante.causePrincipale && cause?.analyse) periodeCourante.causePrincipale = cause.analyse;
        if (flagsTmp.garde) periodeCourante.garde = true;
      }
    } else {
      clorePeriode();
    }
  });
  clorePeriode();

  // 3. Redémarrages, diagnostics et déconnexions
  for (const ev of journal.evenements) {
    if (ev.t < tMin || ev.t > tMax) continue;
    const h = formaterHeureFr(journal.epochDe(ev.t));
    if (ev.genre === 'redemarrage') {
      phrases.push(`${h} : redémarrage du rover détecté (compteur de cycles revenu de ${ev.cyclesAvant} à ${ev.cyclesApres})`);
    } else if (ev.genre === 'diagnostic') {
      if (ev.raz?.alerte) phrases.push(`${h} : cause du redémarrage : ${ev.raz.libelle}`);
      if (Array.isArray(ev.bus)) {
        for (const b of ev.bus) {
          if (b.alerte || b.reprises > 0 || b.tentatives > 0) {
            phrases.push(`${h} : ${b.nom} — ${b.texte}`);
          }
        }
      }
    } else if (ev.genre === 'liaison' && ev.etat === 'erreur') {
      phrases.push(`${h} : liaison perdue${ev.message ? ` (${ev.message})` : ''}`);
    } else if (ev.genre === 'visibilite' && !ev.visible) {
      phrases.push(`${h} : page passée en arrière-plan (navigation interrompue)`);
    }
  }

  // 4. Mise en phrases en français simple avec l'heure
  for (const b of baisses) {
    const h = formaterHeureFr(journal.epochDe(b.tDebut));
    const dureeS = fmtVirgule(b.dureeMs / 1000, 1);
    const vRef = b.plafondMin < Infinity ? b.plafondMin : (b.vMesureSum / b.n);
    const cause = b.causePrincipale
      ?? (b.garde ? "le rover s'est arrêté de lui-même (garde)" : 'vitesse inférieure à la consigne sans drapeau explicite');
    phrases.push(`${h} : vitesse limitée à ${fmtVirgule(vRef, 2)} m/s pendant ${dureeS} s, ${cause}`);
  }

  if (trousEnvoi.length > 0) {
    const h = formaterHeureFr(journal.epochDe(trousEnvoi[0].tDebut));
    const maxMs = Math.round(Math.max(...trousEnvoi.map((g) => g.dureeMs)));
    const aGarde = baisses.some((b) => b.garde) || (() => {
      let vu = false;
      pourChaque(journal.etats, tMin, tMax, (i) => { if ((journal.etats.drapeaux[i] & BIT_GARDE) !== 0) vu = true; });
      return vu;
    })();
    const fin = aGarde ? " : le rover s'est arrêté de lui-même" : '';
    phrases.push(`${h} : ${trousEnvoi.length} trou${trousEnvoi.length > 1 ? 's' : ''} d'envoi de plus de ${Math.round(seuilTrouEnvoi)} ms, le plus long ${maxMs} ms${fin}`);
  }

  if (stopsDoigtPose.length > 0) {
    const h = formaterHeureFr(journal.epochDe(stopsDoigtPose[0].t));
    phrases.push(`${h} : ${stopsDoigtPose.length} arrêt${stopsDoigtPose.length > 1 ? 's' : ''} (STOP) envoyé${stopsDoigtPose.length > 1 ? 's' : ''} alors que le doigt était posé`);
  }

  if (echecOuLente(echecsEcriture, ecrituresLentes)) {
    if (echecsEcriture.length > 0) {
      const h = formaterHeureFr(journal.epochDe(echecsEcriture[0].t));
      phrases.push(`${h} : ${echecsEcriture.length} échec${echecsEcriture.length > 1 ? 's' : ''} d'écriture Bluetooth`);
    }
    if (ecrituresLentes.length > 0) {
      const h = formaterHeureFr(journal.epochDe(ecrituresLentes[0].t));
      const maxMs = Math.round(Math.max(...ecrituresLentes.map((e) => e.dureeMs)));
      phrases.push(`${h} : ${ecrituresLentes.length} écriture${ecrituresLentes.length > 1 ? 's' : ''} Bluetooth lente${ecrituresLentes.length > 1 ? 's' : ''} (jusqu'à ${maxMs} ms)`);
    }
  }

  if (trousReception.length > 0) {
    const h = formaterHeureFr(journal.epochDe(trousReception[0].tDebut));
    const maxMs = Math.round(Math.max(...trousReception.map((g) => g.dureeMs)));
    phrases.push(`${h} : ${trousReception.length} trou${trousReception.length > 1 ? 's' : ''} de réception, le plus long ${maxMs} ms`);
  }

  return {
    phrases,
    stats: {
      trousEnvoi: trousEnvoi.length,
      trousEnvoiMaxMs: trousEnvoi.length ? Math.round(Math.max(...trousEnvoi.map((g) => g.dureeMs))) : 0,
      ecrituresLentes: ecrituresLentes.length,
      echecsEcriture: echecsEcriture.length,
      trousReception: trousReception.length,
      stopsDoigtPose: stopsDoigtPose.length,
      baissesVitesse: baisses.length,
    },
  };
}

function echecOuLente(a, b) { return a.length > 0 || b.length > 0; }

/** Analyse complète de la séance et des fenêtres [−5 s ; +2 s] autour de chaque repère « Marquer ». */
export function analyserJournal(journal) {
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const buf of [journal.envois, journal.etats, journal.champs, journal.doigts]) {
    const { debut, fin } = bornesTampon(buf);
    if (fin > debut) {
      const mask = buf.cap - 1;
      tMin = Math.min(tMin, buf.t[debut & mask]);
      tMax = Math.max(tMax, buf.t[(fin - 1) & mask]);
    }
  }
  for (const ev of journal.evenements) {
    tMin = Math.min(tMin, ev.t);
    tMax = Math.max(tMax, ev.t);
  }
  if (!Number.isFinite(tMin)) {
    return {
      dureeMs: 0,
      resume: [],
      reperes: [],
      stats: { manettes: 0, stops: 0, etats: 0, trousEnvoi: 0, trousEnvoiMaxMs: 0, ecrituresLentes: 0, echecsEcriture: 0, trousReception: 0, stopsDoigtPose: 0, baissesVitesse: 0 },
    };
  }

  let manettes = 0;
  let stops = 0;
  pourChaque(journal.envois, tMin, tMax, (i) => {
    if (journal.envois.type[i] === T.MANETTE) manettes++;
    else if (journal.envois.type[i] === T.STOP) stops++;
  });

  const global = analyserFenetre(journal, tMin, tMax);
  const reperes = journal.evenements
    .filter((ev) => ev.genre === 'marque')
    .map((ev) => {
      const fen = analyserFenetre(journal, ev.t - 5000, ev.t + 2000);
      return {
        t: ev.t,
        heure: formaterHeureFr(journal.epochDe(ev.t)),
        note: ev.note,
        phrases: fen.phrases.length > 0 ? fen.phrases : ['Aucune anomalie mesurée autour de ce repère (5 s avant, 2 s après).'],
        stats: fen.stats,
      };
    });

  return {
    dureeMs: Math.max(0, tMax - tMin),
    resume: global.phrases,
    reperes,
    stats: {
      manettes,
      stops,
      etats: bornesTampon(journal.etats).n,
      ...global.stats,
    },
  };
}

// ---------- Export JSON sans données personnelles ----------

export function exporterJson(journal) {
  const analyse = analyserJournal(journal);
  const envois = [];
  pourChaque(journal.envois, -Infinity, Infinity, (i) => {
    const E = journal.envois;
    envois.push({
      t: Math.round(E.t[i] * 10) / 10,
      type: E.type[i],
      vx: E.vx[i],
      vy: E.vy[i],
      w: E.w[i],
      opt: E.opt[i],
      vMax: E.vMaxCm[i] / 100,
      doigt: E.doigtActif[i],
      ok: E.ok[i] === 255 ? null : E.ok[i] === 1,
      dureeMs: Number.isFinite(E.dureeMs[i]) ? Math.round(E.dureeMs[i] * 10) / 10 : null,
    });
  });

  const etats = [];
  pourChaque(journal.etats, -Infinity, Infinity, (i) => {
    const S = journal.etats;
    etats.push({
      t: Math.round(S.t[i] * 10) / 10,
      vitesse: S.vitesse[i] / 100,
      drapeaux: S.drapeaux[i],
      comportement: S.comportement[i],
      tension: S.tensionDv[i] / 10,
      libre: S.libre[i],
      sonar: S.sonar[i],
      tete: S.tete[i],
      rssi: S.rssi[i],
      plafond: Number.isFinite(S.plafond[i]) ? Math.round(S.plafond[i] * 1000) / 1000 : null,
      frein: S.frein[i] === 255 ? null : S.frein[i],
    });
  });

  const champs = [];
  pourChaque(journal.champs, -Infinity, Infinity, (i) => {
    const C = journal.champs;
    champs.push({
      t: Math.round(C.t[i] * 10) / 10,
      plafond: Number.isFinite(C.plafond[i]) ? Math.round(C.plafond[i] * 1000) / 1000 : null,
      frein: C.frein[i] === 255 ? null : C.frein[i],
      tension: Number.isFinite(C.tension[i]) ? Math.round(C.tension[i] * 1000) / 1000 : null,
      a_lim: Number.isFinite(C.aLim[i]) ? Math.round(C.aLim[i] * 1000) / 1000 : null,
      cycles: C.cycles[i] === 0xffffffff ? null : C.cycles[i],
    });
  });

  const doigts = [];
  pourChaque(journal.doigts, -Infinity, Infinity, (i) => {
    const D = journal.doigts;
    doigts.push({
      t: Math.round(D.t[i] * 10) / 10,
      source: NOMS_SOURCE_DOIGT[D.source[i]] ?? D.source[i],
      action: NOMS_ACTION_DOIGT[D.action[i]] ?? D.action[i],
      x: Math.round(D.x[i] * 1000) / 1000,
      y: Math.round(D.y[i] * 1000) / 1000,
    });
  });

  return {
    format: 'roveros-journal-v1',
    date: new Date(journal.debutHorlogeMs).toISOString(),
    navigateur: journal.navigateur,
    transport: journal.transport || 'aucun',
    firmware: { famille: journal.firmware.famille, version: journal.firmware.version },
    champsDemandes: [...journal.champsDemandes],
    dureeMs: Math.round(analyse.dureeMs),
    stats: analyse.stats,
    resume: analyse.resume,
    reperes: analyse.reperes,
    envois,
    etats,
    champs,
    doigts,
    evenements: journal.evenements.map((ev) => ({ ...ev, t: Math.round(ev.t * 10) / 10 })),
    journalRover: journal.journalRover.map((e) => ({
      ligne: e.ligne,
      tempsMs: e.tempsMs,
      nom: e.nom,
      valeurs: e.valeurs,
      t: Math.round(e.t * 10) / 10,
      heure: formaterHeureFr(journal.epochDe(e.t)),
      aligne: e.aligne,
    })),
  };
}

// ---------- Persistance asynchrone groupée (IndexedDB) ----------

const DB_NOM = 'roveros-journal';
const DB_STORE = 'seances';
const CLE_COURANTE = 'courante';

function copierTranche(buf) {
  const { debut, n } = bornesTampon(buf);
  const mask = buf.cap - 1;
  const copie = {};
  for (const [k, arr] of Object.entries(buf)) {
    if (!ArrayBuffer.isView(arr)) continue;
    const out = new arr.constructor(n);
    for (let j = 0; j < n; j++) out[j] = arr[(debut + j) & mask];
    copie[k] = out;
  }
  return copie;
}

function rechargerTranche(buf, copie) {
  if (!copie) return;
  const cles = Object.keys(copie);
  if (cles.length === 0) return;
  const n = Math.min(copie[cles[0]].length, buf.cap);
  for (const k of cles) {
    if (ArrayBuffer.isView(buf[k])) buf[k].set(copie[k].subarray(0, n), 0);
  }
  buf.total = n;
}

export function creerInstantanee(journal) {
  return {
    debutHorlogeMs: journal.debutHorlogeMs,
    debutPerfMs: journal.debutPerfMs,
    navigateur: journal.navigateur,
    cadencePrevueMs: journal.cadencePrevueMs,
    transport: journal.transport,
    firmware: { ...journal.firmware },
    champsDemandes: [...journal.champsDemandes],
    envois: copierTranche(journal.envois),
    etats: copierTranche(journal.etats),
    champs: copierTranche(journal.champs),
    doigts: copierTranche(journal.doigts),
    evenements: journal.evenements.slice(),
    journalRover: journal.journalRover.slice(),
  };
}

export function restaurerInstantanee(journal, snap) {
  if (!snap || typeof snap !== 'object') return false;
  journal.debutHorlogeMs = snap.debutHorlogeMs ?? journal.debutHorlogeMs;
  journal.debutPerfMs = snap.debutPerfMs ?? journal.debutPerfMs;
  journal.navigateur = snap.navigateur ?? journal.navigateur;
  journal.cadencePrevueMs = snap.cadencePrevueMs ?? journal.cadencePrevueMs;
  journal.transport = snap.transport ?? '';
  journal.firmware = snap.firmware ? { ...snap.firmware } : { famille: 'inconnu', version: '' };
  journal.champsDemandes = Array.isArray(snap.champsDemandes) ? [...snap.champsDemandes] : [];
  rechargerTranche(journal.envois, snap.envois);
  rechargerTranche(journal.etats, snap.etats);
  rechargerTranche(journal.champs, snap.champs);
  rechargerTranche(journal.doigts, snap.doigts);
  journal.evenements = Array.isArray(snap.evenements) ? snap.evenements.slice(-CAPACITE_EVENEMENTS) : [];
  journal.journalRover = Array.isArray(snap.journalRover) ? snap.journalRover.slice(-CAPACITE_JOURNAL_ROVER) : [];
  journal.sale = false;
  return true;
}

/** Persiste le journal par écritures groupées asynchrones dans IndexedDB (jamais sur le chemin de la manette). */
export class StockageJournal {
  constructor(journal) {
    this.journal = journal;
    this._db = null;
    this._minuterie = null;
    this._enCours = false;
  }

  async ouvrir() {
    if (typeof indexedDB === 'undefined') return null;
    if (this._db) return this._db;
    this._db = await new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NOM, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return this._db;
  }

  async charger() {
    const db = await this.ouvrir();
    if (!db) return false;
    const snap = await new Promise((resolve) => {
      try {
        const tx = db.transaction(DB_STORE, 'readonly');
        const req = tx.objectStore(DB_STORE).get(CLE_COURANTE);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return snap ? restaurerInstantanee(this.journal, snap) : false;
  }

  /** Démarre une sauvegarde groupée toutes les 3 s (uniquement si le journal a changé). */
  demarrer(periodeMs = 3000) {
    if (this._minuterie !== null) return;
    this._minuterie = setInterval(() => { if (this.journal.sale) this.sauvegarder(); }, periodeMs);
  }

  arreter() {
    clearInterval(this._minuterie);
    this._minuterie = null;
  }

  async sauvegarder() {
    if (this._enCours) return false;
    const db = await this.ouvrir();
    if (!db) return false;
    this._enCours = true;
    try {
      const snap = creerInstantanee(this.journal);
      this.journal.sale = false;
      return await new Promise((resolve) => {
        try {
          const tx = db.transaction(DB_STORE, 'readwrite');
          tx.objectStore(DB_STORE).put(snap, CLE_COURANTE);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        } catch {
          resolve(false);
        }
      });
    } finally {
      this._enCours = false;
    }
  }

  async effacer() {
    this.journal.vider();
    const db = await this.ouvrir();
    if (!db) return false;
    return await new Promise((resolve) => {
      try {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).delete(CLE_COURANTE);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  }
}
