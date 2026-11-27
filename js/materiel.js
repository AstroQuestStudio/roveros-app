// materiel.js — lecture et mise en forme du diagnostic matériel du rover.
//
// MicroPython répond à « materiel » par :
//   materiel cycles=… calcul=… calcul_max=… duree_max=… retards=… err_driver=… err_centrale=… mem=…
// Rust répond en plus avec :
//   … pile0=… pile1=… code_ram=… bus_max=…
// suivi de :
//   acquisition bus=… bus_max=… age=…
// D'autres champs ou lignes (« nav … », « profil … ») peuvent s'y ajouter sans casser le décodeur.

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
]);

const CLES_ACQUISITION_CONNUES = new Set(['bus', 'bus_max', 'age']);

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
  return morceaux.join(', ');
}

/** Vrai si quelque chose mérite l'attention (retards, erreurs) : l'écran peut alors colorer la ligne. */
export function materielInquietant(v) {
  return !!v && ((v.retards ?? 0) > 0 || (v.err_driver ?? 0) > 0 || (v.err_centrale ?? 0) > 0);
}

/** Alerte du diagnostic étendu : durée max de cycle > 2 ms (2000 µs), retards > 0 ou erreurs de bus. */
export function alerteMateriel(v) {
  if (!v || typeof v !== 'object') return false;
  return (
    materielInquietant(v)
    || (Number.isFinite(v.duree_max) && v.duree_max > SEUIL_CYCLE_ALERTE_US)
    || (Number.isFinite(v.calcul_max) && v.calcul_max > SEUIL_CYCLE_ALERTE_US)
  );
}

/** Vrai si les valeurs contiennent des champs étendus (piles, RAM code, bus). */
export function aDiagnosticEtendu(v, acquisition = null) {
  if (acquisition && typeof acquisition === 'object' && Object.keys(acquisition).length > 0) return true;
  if (!v || typeof v !== 'object') return false;
  return v.pile0 !== undefined || v.pile1 !== undefined || v.code_ram !== undefined || v.bus_max !== undefined;
}

/**
 * Produit une synthèse structurée pour l'affichage du diagnostic (MicroPython ou Rust).
 * Conserve tous les champs inconnus dans `inconnus` et dans `details`.
 */
export function diagnosticMateriel(v, acquisition = null, profils = []) {
  if (!v || typeof v !== 'object') {
    return { resume: '', alerte: false, niveau: 'ok', details: [], inconnus: {} };
  }
  const alerte = alerteMateriel(v);
  const details = [];
  const inconnus = {};

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

  const busMax = acquisition?.bus_max ?? v.bus_max;
  if (acquisition && typeof acquisition === 'object') {
    const morceauxBus = [];
    if (Number.isFinite(acquisition.bus)) morceauxBus.push(`${formaterUs(acquisition.bus)}`);
    if (Number.isFinite(busMax)) morceauxBus.push(`max ${formaterUs(busMax)}`);
    if (Number.isFinite(acquisition.age)) morceauxBus.push(`âge ${formaterUs(acquisition.age)}`);
    if (morceauxBus.length > 0) {
      details.push({ cle: 'acquisition', libelle: 'Attente des bus', valeur: morceauxBus.join(', '), alerte: false });
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
  };
}
