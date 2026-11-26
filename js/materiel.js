// materiel.js — la ligne de diagnostic du matériel, lisible.
// Le rover répond à la commande « materiel » par :
//   materiel cycles=… calcul=… calcul_max=… duree_max=… retards=… err_driver=… err_centrale=… mem=…
// (durées en microsecondes, mémoire en octets).

const virgule = (v) => v.toFixed(1).replace('.', ',');
const ms = (us) => virgule(us / 1000);
const pluriel = (n, un, plusieurs) => (n > 1 ? plusieurs : un);

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
