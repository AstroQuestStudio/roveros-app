// materiel.js — lecture et mise en forme du diagnostic matériel du rover.
//
// MicroPython répond à « materiel » par :
//   materiel cycles=… calcul=… calcul_max=… duree_max=… retards=… err_driver=… err_centrale=… mem=…
// Rust répond en plus avec :
//   … pile0=… pile1=… code_ram=… bus_max=… [marche_s=…] raz=…
// suivi de :
//   acquisition bus=… bus_max=… age=… abrt0=… lig0=… rep0=…/… ech0=… actif0=… abrt1=… lig1=… rep1=…/… ech1=… actif1=…
//   nav pas_us=… pas_max_us=… plan_max_us=… tranche_max_us=…
// et « liaison » répond avec ses compteurs radio/GATT.
// D'autres champs ou lignes (« profil … ») peuvent s'y ajouter sans casser le décodeur.

const virgule = (v) => v.toFixed(1).replace('.', ',');
const ms = (us) => virgule(us / 1000);
const pluriel = (n, un, plusieurs) => (n > 1 ? plusieurs : un);
const entier = (v) => Math.round(v).toLocaleString('fr-FR');
const formaterUs = (us) => (us >= 1000 ? `${entier(us)} µs (${ms(us)} ms)` : `${entier(us)} µs`);
const formaterOctets = (o) => (o >= 1024 ? `${Math.round(o / 1024)} Ko` : `${entier(o)} o`);

/** Seuil d'alerte pour les durées de cycle (2 ms = 2 000 µs). */
export const SEUIL_CYCLE_ALERTE_US = 2000;

const CLES_MATERIEL_CONNUES = new Set([
  'cycles', 'calcul', 'calcul_max', 'duree_max', 'retards',
  'err_driver', 'err_centrale', 'mem', 'pile0', 'pile1', 'code_ram', 'bus_max',
  'raz', 'marche_s',
]);

const CLES_ACQUISITION_CONNUES = new Set([
  'bus', 'bus_max', 'age',
  'abrt0', 'lig0', 'rep0', 'ech0', 'actif0',
  'abrt1', 'lig1', 'rep1', 'ech1', 'actif1',
]);

/**
 * Traduit en clair la cause du dernier redémarrage (`raz=` de rust100/src/redemarrage.rs:36-50).
 * @returns {{ code: string, libelle: string, alerte: boolean } | null}
 */
export function traduireRaz(raz, marcheS = null) {
  if (raz === undefined || raz === null || raz === '') return null;
  const code = String(raz).trim();
  const apres = Number.isFinite(marcheS) ? ` (après ${entier(marcheS)} s)` : '';
  let libelle = `Cause : ${code}`;
  let alerte = false;

  if (code === 'tension') libelle = 'Mise sous tension';
  else if (code === 'voulu') libelle = `Redémarrage voulu${apres}`;
  else if (code === 'run') libelle = `Redémarrage matériel (broche RUN)${apres}`;
  else if (code === 'debug') libelle = 'Redémarrage par port de débogage';
  else if (code === 'garde') { libelle = `Chien de garde expiré${apres}`; alerte = true; }
  else if (code === 'force') { libelle = 'Chien de garde forcé'; alerte = true; }
  else if (code === 'inconnue') { libelle = 'Cause inconnue'; alerte = true; }
  else if (code.startsWith('panique:')) {
    const [, coeur = '?', fichier = '', ligne = '?'] = code.split(':');
    libelle = `Panique (cœur ${coeur.replace(/^c/, '')}, ${fichier} ligne ${ligne})${apres}`;
    alerte = true;
  } else if (code.startsWith('faute:')) {
    const [, coeur = '?', pc = '?'] = code.split(':');
    libelle = `Faute matérielle (cœur ${coeur.replace(/^c/, '')}, PC 0x${pc})${apres}`;
    alerte = true;
  } else if (code.startsWith('pile:')) {
    const [, coeur = '?', sp = '?'] = code.split(':');
    libelle = `Débordement de pile (cœur ${coeur.replace(/^c/, '')}, SP 0x${sp})${apres}`;
    alerte = true;
  } else if (apres) {
    libelle += apres;
  }

  return { code, libelle, alerte };
}

/**
 * Traduit en clair l'état d'un bus I2C (0 = carte moteurs, 1 = centrale inertielle).
 * Lit les champs abrtN (hex), ligN (2 bits SDA/SCL), repN (tentatives/reprises), echN, actifN
 * produits par rust100/src/systeme.rs:890-893 et documentés dans rapports/rust-bus.md.
 */
export function traduireBus(index, acquisition = {}, acqBrut = null) {
  if (!acquisition || typeof acquisition !== 'object') return null;
  const kAbrt = `abrt${index}`;
  const kLig = `lig${index}`;
  const kRep = `rep${index}`;
  const kEch = `ech${index}`;
  const kActif = `actif${index}`;
  const present = [kAbrt, kLig, kRep, kEch, kActif].some((k) => k in acquisition || (acqBrut && k in acqBrut));
  if (!present) return null;

  const nomBus = index === 0 ? 'Carte moteurs (I2C0)' : 'Centrale inertielle (I2C1)';
  const rawAbrt = acqBrut?.[kAbrt] ?? acquisition[kAbrt];
  const abrt = rawAbrt !== undefined ? parseInt(String(rawAbrt), 16) || 0 : 0;

  const rawLig = acqBrut?.[kLig] ?? acquisition[kLig];
  const lig = rawLig !== undefined ? String(rawLig).padStart(2, '0') : '11';

  const rawRep = String(acqBrut?.[kRep] ?? acquisition[kRep] ?? '0/0');
  const [tentStr, repStr] = rawRep.split('/');
  const tentatives = Number.parseInt(tentStr, 10) || 0;
  const reprises = Number.parseInt(repStr, 10) || 0;

  const ech = Number(acquisition[kEch] ?? 0) || 0;
  const actif = Number(acquisition[kActif] ?? 0) || 0;

  const causesAbrt = [];
  if (abrt & 0x1) causesAbrt.push('adresse non acquittée');
  if (abrt & 0x8) causesAbrt.push('donnée non acquittée');
  if (abrt & 0x10000) causesAbrt.push('abandon demandé par le firmware');
  if (abrt && causesAbrt.length === 0) causesAbrt.push(`erreur 0x${abrt.toString(16)}`);

  let etatLignes = 'lignes libres';
  if (lig === '10') etatLignes = 'horloge tenue (SCL basse)';
  else if (lig === '01') etatLignes = 'données tenues (SDA basse)';
  else if (lig === '00') etatLignes = 'horloge et données tenues (SCL/SDA basses)';

  const morceaux = [];
  if (abrt & 0x1) {
    morceaux.push(`${index === 0 ? 'carte moteurs muette' : 'centrale muette'} (${causesAbrt.join(', ')})`);
  } else if (causesAbrt.length > 0) {
    morceaux.push(causesAbrt.join(', '));
  }
  if (lig !== '11' || abrt === 0) morceaux.push(etatLignes);

  if (tentatives > 0 || reprises > 0) {
    morceaux.push(`${reprises} ${pluriel(reprises, 'reprise réussie', 'reprises réussies')} sur ${tentatives} ${pluriel(tentatives, 'tentative', 'tentatives')}`);
  }
  if (ech > 0) morceaux.push(`${ech} ${pluriel(ech, 'échéance dépassée', 'échéances dépassées')}`);
  if (actif > 0) morceaux.push(`${actif} ${pluriel(actif, 'lancement refusé (bus actif)', 'lancements refusés (bus actif)')}`);

  const alerte = (abrt & 0x9) !== 0 || lig !== '11' || tentatives > reprises || ech > 0 || actif > 0;
  return {
    index,
    nom: nomBus,
    abrt,
    lig,
    tentatives,
    reprises,
    ech,
    actif,
    texte: morceaux.join(' · '),
    alerte,
  };
}

/** « calcul 0,7 ms, au pire 2,0 ms, aucun retard, mémoire libre 72 Ko » */
export function phraseMateriel(v) {
  if (!v || typeof v !== 'object') return '';
  const morceaux = [];
  if (Number.isFinite(v.calcul)) morceaux.push(`calcul ${ms(v.calcul)} ms`);
  if (Number.isFinite(v.calcul_max)) morceaux.push(`au pire ${ms(v.calcul_max)} ms`);
  if (Number.isFinite(v.retards)) morceaux.push(v.retards > 0 ? `${v.retards} ${pluriel(v.retards, 'retard', 'retards')}` : 'aucun retard');
  if (Number.isFinite(v.err_driver) && v.err_driver > 0) morceaux.push(`${v.err_driver} ${pluriel(v.err_driver, 'erreur', 'erreurs')} du pilote des moteurs`);
  if (Number.isFinite(v.err_centrale) && v.err_centrale > 0) morceaux.push(`${v.err_centrale} ${pluriel(v.err_centrale, 'erreur', 'erreurs')} de la centrale inertielle`);
  if (Number.isFinite(v.mem)) morceaux.push(`mémoire libre ${Math.round(v.mem / 1024)} Ko`);
  const raz = traduireRaz(v.raz, v.marche_s);
  if (raz) morceaux.push(`redémarrage : ${raz.libelle.toLowerCase()}`);
  return morceaux.join(', ');
}

/** Vrai si quelque chose mérite l'attention (retards, erreurs) : l'écran peut alors colorer la ligne. */
export function materielInquietant(v) {
  return !!v && ((v.retards ?? 0) > 0 || (v.err_driver ?? 0) > 0 || (v.err_centrale ?? 0) > 0);
}

/** Alerte du diagnostic étendu : durée max de cycle > 2 ms (2000 µs), retards > 0, erreurs de bus ou raz anormal. */
export function alerteMateriel(v, acquisition = null, acqBrut = null) {
  if (!v || typeof v !== 'object') return false;
  const raz = traduireRaz(v.raz, v.marche_s);
  const b0 = traduireBus(0, acquisition, acqBrut);
  const b1 = traduireBus(1, acquisition, acqBrut);
  return (
    materielInquietant(v)
    || (Number.isFinite(v.duree_max) && v.duree_max > SEUIL_CYCLE_ALERTE_US)
    || (Number.isFinite(v.calcul_max) && v.calcul_max > SEUIL_CYCLE_ALERTE_US)
    || !!raz?.alerte
    || !!b0?.alerte
    || !!b1?.alerte
  );
}

/** Vrai si les valeurs contiennent des champs étendus (piles, RAM code, bus, raz). */
export function aDiagnosticEtendu(v, acquisition = null) {
  if (acquisition && typeof acquisition === 'object' && Object.keys(acquisition).length > 0) return true;
  if (!v || typeof v !== 'object') return false;
  return v.pile0 !== undefined || v.pile1 !== undefined || v.code_ram !== undefined || v.bus_max !== undefined || v.raz !== undefined;
}

/**
 * Produit une synthèse structurée pour l'affichage du diagnostic (MicroPython ou Rust).
 * Conserve tous les champs inconnus dans `inconnus` et dans `details`.
 */
export function diagnosticMateriel(v, acquisition = null, profils = [], extra = {}) {
  if (!v || typeof v !== 'object') {
    return { resume: '', alerte: false, niveau: 'ok', details: [], inconnus: {}, raz: null, bus: [] };
  }
  const acqBrut = extra?.acqBrut ?? null;
  const nav = extra?.nav ?? null;
  const liaison = extra?.liaison ?? null;
  const alerte = alerteMateriel(v, acquisition, acqBrut);
  const details = [];
  const inconnus = {};

  const raz = traduireRaz(v.raz, v.marche_s);
  if (raz) {
    details.push({ cle: 'raz', libelle: 'Dernier redémarrage', valeur: raz.libelle, alerte: raz.alerte });
  }

  if (Number.isFinite(v.calcul)) {
    const maxTxt = Number.isFinite(v.calcul_max) ? ` (max ${formaterUs(v.calcul_max)})` : '';
    details.push({
      cle: 'calcul',
      libelle: 'Calcul',
      valeur: `${formaterUs(v.calcul)}${maxTxt}`,
      alerte: Number.isFinite(v.calcul_max) && v.calcul_max > SEUIL_CYCLE_ALERTE_US,
    });
  }
  if (Number.isFinite(v.duree_max)) {
    details.push({
      cle: 'duree_max',
      libelle: 'Durée max du cycle',
      valeur: formaterUs(v.duree_max),
      alerte: v.duree_max > SEUIL_CYCLE_ALERTE_US,
    });
  }
  if (Number.isFinite(v.retards)) {
    details.push({
      cle: 'retards',
      libelle: 'Retards',
      valeur: v.retards > 0 ? `${entier(v.retards)} ${pluriel(v.retards, 'retard', 'retards')}` : '0',
      alerte: v.retards > 0,
    });
  }
  if (Number.isFinite(v.err_driver) || Number.isFinite(v.err_centrale)) {
    const ed = v.err_driver ?? 0;
    const ec = v.err_centrale ?? 0;
    details.push({
      cle: 'erreurs',
      libelle: 'Erreurs de bus',
      valeur: `pilote ${entier(ed)}, centrale ${entier(ec)}`,
      alerte: ed > 0 || ec > 0,
    });
  }
  if (Number.isFinite(v.mem)) {
    details.push({ cle: 'mem', libelle: 'Mémoire libre', valeur: formaterOctets(v.mem), alerte: false });
  }
  if (Number.isFinite(v.code_ram)) {
    details.push({ cle: 'code_ram', libelle: 'Code en RAM', valeur: formaterOctets(v.code_ram), alerte: false });
  }
  if (Number.isFinite(v.pile0) || Number.isFinite(v.pile1)) {
    const p0 = Number.isFinite(v.pile0) ? formaterOctets(v.pile0) : '—';
    const p1 = Number.isFinite(v.pile1) ? formaterOctets(v.pile1) : '—';
    details.push({ cle: 'piles', libelle: 'Piles (cœur 0 / cœur 1)', valeur: `${p0} / ${p1}`, alerte: false });
  }

  const busList = [];
  const busMax = acquisition?.bus_max ?? v.bus_max;
  if (acquisition && typeof acquisition === 'object') {
    const morceauxBus = [];
    if (Number.isFinite(acquisition.bus)) morceauxBus.push(`${formaterUs(acquisition.bus)}`);
    if (Number.isFinite(busMax)) morceauxBus.push(`max ${formaterUs(busMax)}`);
    if (Number.isFinite(acquisition.age)) morceauxBus.push(`âge ${formaterUs(acquisition.age)}`);
    if (morceauxBus.length > 0) {
      details.push({ cle: 'acquisition', libelle: 'Attente des bus', valeur: morceauxBus.join(', '), alerte: false });
    }
    for (const i of [0, 1]) {
      const b = traduireBus(i, acquisition, acqBrut);
      if (b) {
        busList.push(b);
        details.push({ cle: `bus${i}`, libelle: b.nom, valeur: b.texte, alerte: b.alerte });
      }
    }
    for (const [k, val] of Object.entries(acquisition)) {
      if (!CLES_ACQUISITION_CONNUES.has(k)) {
        inconnus[`acquisition.${k}`] = val;
        details.push({ cle: `acquisition.${k}`, libelle: k, valeur: String(val), alerte: false });
      }
    }
  } else if (Number.isFinite(v.bus_max)) {
    details.push({ cle: 'bus_max', libelle: 'Attente max des bus', valeur: formaterUs(v.bus_max), alerte: false });
  }

  if (nav && typeof nav === 'object') {
    const parts = [];
    if (Number.isFinite(nav.pas_us)) parts.push(`pas ${formaterUs(nav.pas_us)}`);
    if (Number.isFinite(nav.pas_max_us)) parts.push(`max ${formaterUs(nav.pas_max_us)}`);
    if (Number.isFinite(nav.plan_max_us)) parts.push(`plan max ${formaterUs(nav.plan_max_us)}`);
    if (parts.length > 0) {
      details.push({ cle: 'nav', libelle: 'Navigateur (cœur 0)', valeur: parts.join(', '), alerte: false });
    }
  }

  if (liaison && typeof liaison === 'object') {
    const parts = [];
    if (Number.isFinite(liaison.mtu) && liaison.mtu > 0) parts.push(`MTU ${liaison.mtu}`);
    if (Number.isFinite(liaison.int_us) && liaison.int_us > 0) parts.push(`intervalle ${ms(liaison.int_us)} ms`);
    if (Number.isFinite(liaison.pertes)) parts.push(`pertes ${liaison.pertes}`);
    if (Number.isFinite(liaison.rxerr) && liaison.rxerr > 0) parts.push(`rxerr ${liaison.rxerr}`);
    if (Number.isFinite(liaison.txpleins) && liaison.txpleins > 0) parts.push(`txpleins ${liaison.txpleins}`);
    if (Number.isFinite(liaison.silence) && liaison.silence > 0) parts.push(`silences ${liaison.silence}`);
    if (parts.length > 0) {
      details.push({
        cle: 'liaison',
        libelle: 'Liaison Bluetooth (rover)',
        valeur: parts.join(', '),
        alerte: (liaison.pertes ?? 0) > 0 || (liaison.rxerr ?? 0) > 0 || (liaison.txpleins ?? 0) > 0,
      });
    }
  }

  if (Number.isFinite(v.cycles)) {
    details.push({ cle: 'cycles', libelle: 'Cycles', valeur: entier(v.cycles), alerte: false });
  }

  for (const [k, val] of Object.entries(v)) {
    if (!CLES_MATERIEL_CONNUES.has(k)) {
      inconnus[k] = val;
      details.push({ cle: k, libelle: k, valeur: String(val), alerte: false });
    }
  }

  if (Array.isArray(profils)) {
    for (const p of profils) {
      if (!p || !p.valeurs) continue;
      const vals = Object.entries(p.valeurs).map(([k, val]) => `${k}=${val}`).join(' ');
      details.push({
        cle: `profil.${p.section || 'ligne'}`,
        libelle: p.section ? `Profil ${p.section}` : 'Profil',
        valeur: vals,
        alerte: (p.valeurs.gt5ms ?? 0) > 0,
      });
    }
  }

  return {
    resume: phraseMateriel(v),
    alerte,
    niveau: alerte ? 'alerte' : 'ok',
    details,
    inconnus,
    raz,
    bus: busList,
  };
}
