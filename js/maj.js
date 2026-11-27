// maj.js — mise à jour sans fil du firmware (protocole 0x20..0x23 -> 0xA0, identique à outils/maj_ble.py).
//
// Prend en charge :
//   - format brut v2 (firmware 100 % Rust avec chargeur A/B embassy-boot) ;
//   - format compressé v1 (firmware MicroPython).
// Logique pure, testable sous Node sans navigateur ni Bluetooth.

import {
  encoderMajDebut, encoderMajBloc, encoderMajFin, encoderMajInstaller,
} from './protocole.js';

export const MAGIE_MAJ = 0x4A4D5652; // « RVMJ » petit-boutiste
export const TAILLE_ENTETE_MAJ = 64;
export const AVANCE_MAJ = 12000; // octets d'avance max au-delà du dernier octet confirmé (file rover = 64 trames)

export const ETATS_MAJ = {
  RECEPTION: 0,
  PRET: 1,
  INSTALLE: 2,
  DESORDRE: 3,
  E_TAILLE: 0x81,
  E_CRC: 0x82,
  E_IMAGE: 0x83,
  E_ABSENT: 0x84,
};

export const ERREURS_IMAGE = {
  1: 'en-tête invalide (magie)',
  2: 'version de paquet non gérée par ce firmware',
  3: "somme de contrôle de l'en-tête invalide",
  4: 'paquet destiné à une autre carte',
  5: "taille de l'image invalide ou trop grande",
  6: 'table des vecteurs de démarrage invalide',
  7: 'erreur de lecture ou écriture en flash',
  8: 'le rover est en mouvement',
  9: 'état du chargeur incompatible (redémarrez le rover)',
};

const TABLE_CRC32 = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 IEEE 802.3 (identique à zlib.crc32 et rust100/liaison/src/maj.rs). */
export function crc32(octets, initial = 0) {
  let c = (initial ^ 0xffffffff) >>> 0;
  for (let i = 0; i < octets.length; i++) {
    c = (TABLE_CRC32[(c ^ octets[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

const decodeurUtf8 = new TextDecoder('utf-8', { fatal: true });

/** Contrôle basique de la table des vecteurs ARM Cortex-M0+ (rust100/liaison/src/maj.rs:107-120). */
export function vecteursValides(debutImage) {
  if (!debutImage || debutImage.length < 8) return false;
  const vue = new DataView(debutImage.buffer, debutImage.byteOffset, debutImage.byteLength);
  const sp = vue.getUint32(0, true);
  const reset = vue.getUint32(4, true);
  return sp > 0x20000000 && sp <= 0x20042000 && (sp & 3) === 0
    && (reset & 1) === 1 && reset >= 0x100070c0 && reset < 0x10200000;
}

/**
 * Lit et vérifie intégralement l'en-tête d'un fichier .maj (format v1 compressé ou v2 brut).
 * Lève une Error explicite en français si le paquet est corrompu ou incomplet.
 */
export function lireEnteteMaj(donnees) {
  const paquet = donnees instanceof Uint8Array ? donnees : new Uint8Array(donnees ?? 0);
  if (paquet.length < TAILLE_ENTETE_MAJ + 65) {
    throw new Error('Fichier trop court pour être un paquet .maj RoverOS.');
  }
  const vue = new DataView(paquet.buffer, paquet.byteOffset, paquet.byteLength);
  const magie = vue.getUint32(0, true);
  const version = vue.getUint32(4, true);
  if (magie !== MAGIE_MAJ) {
    throw new Error('Ce fichier n’est pas un paquet de mise à jour RoverOS (signature RVMJ absente).');
  }
  if (version !== 1 && version !== 2) {
    throw new Error(`Version de paquet inconnue (${version}).`);
  }
  const crcEnteteLu = vue.getUint32(48, true);
  const crcEnteteCalcule = crc32(paquet.subarray(0, 48));
  if (crcEnteteLu !== crcEnteteCalcule) {
    throw new Error("En-tête du paquet corrompu (somme de contrôle invalide).");
  }

  const tailleBrute = vue.getUint32(8, true);
  const tailleComp = vue.getUint32(12, true);
  const crcBrut = vue.getUint32(16, true);
  const crcComp = vue.getUint32(20, true);
  const champCarte = paquet.subarray(24, 48);
  const finNom = champCarte.indexOf(0);
  let carte = '';
  try {
    carte = decodeurUtf8.decode(finNom >= 0 ? champCarte.subarray(0, finNom) : champCarte).trim();
  } catch {
    throw new Error('Nom de carte illisible dans l’en-tête.');
  }
  if (!carte) throw new Error('Nom de carte absent de l’en-tête.');

  if (TAILLE_ENTETE_MAJ + tailleComp !== paquet.length) {
    throw new Error(`Paquet tronqué ou incomplet (${paquet.length} o reçus, ${TAILLE_ENTETE_MAJ + tailleComp} o attendus).`);
  }
  const flux = paquet.subarray(TAILLE_ENTETE_MAJ);
  if (crc32(flux) !== crcComp) {
    throw new Error('Contenu du paquet corrompu (somme de contrôle du flux invalide).');
  }
  if (version === 2) {
    if (tailleBrute !== tailleComp || crcBrut !== crcComp || tailleBrute < 512) {
      throw new Error('En-tête incohérent pour un paquet brut v2.');
    }
    if (!vecteursValides(flux.subarray(0, 8))) {
      throw new Error('Image invalide : table des vecteurs ARM absente ou hors plage.');
    }
  }

  return {
    version,
    tailleBrute,
    tailleComp,
    crcBrut,
    crcComp,
    crcPaquet: crc32(paquet),
    carte,
  };
}

/** Vérifie la compatibilité du paquet avec le rover connecté avant tout envoi. */
export function verifierCompatibilitePaquet(entete, { famille, carteCible = '' } = {}) {
  if (!entete) return { ok: false, message: 'Aucun paquet analysé.' };
  if (famille === 'rust') {
    if (entete.version !== 2) {
      return {
        ok: false,
        message: 'Paquet v1 (compressé) incompatible : le firmware Rust attend un paquet brut v2.',
      };
    }
    if (!/^PicoW-R100-AB/.test(entete.carte)) {
      return {
        ok: false,
        message: `Carte visée « ${entete.carte} » incompatible avec un rover Rust (attendu PicoW-R100-AB…).`,
      };
    }
  } else if (famille === 'micropython') {
    if (entete.version !== 1) {
      return {
        ok: false,
        message: 'Paquet v2 (brut) incompatible : le firmware MicroPython attend un paquet compressé v1.',
      };
    }
    if (/^PicoW-R100-/.test(entete.carte)) {
      return {
        ok: false,
        message: `Carte visée « ${entete.carte} » incompatible avec un rover MicroPython.`,
      };
    }
  }
  if (carteCible && entete.carte !== carteCible) {
    return {
      ok: false,
      message: `Carte visée « ${entete.carte} » différente de la carte du rover (« ${carteCible} »).`,
    };
  }
  return { ok: true, message: '' };
}

/** Fabrique un paquet .maj brut v2 (utile pour les essais et la démo). */
export function fabriquerPaquetMajV2(image, carte = 'PicoW-R100-AB') {
  const img = image instanceof Uint8Array ? image : new Uint8Array(image);
  const entete = new Uint8Array(TAILLE_ENTETE_MAJ);
  const vue = new DataView(entete.buffer);
  vue.setUint32(0, MAGIE_MAJ, true);
  vue.setUint32(4, 2, true);
  vue.setUint32(8, img.length, true);
  vue.setUint32(12, img.length, true);
  const crcImg = crc32(img);
  vue.setUint32(16, crcImg, true);
  vue.setUint32(20, crcImg, true);
  const nomOctets = new TextEncoder().encode(carte);
  if (nomOctets.length > 23) throw new Error('Nom de carte trop long');
  entete.set(nomOctets, 24);
  vue.setUint32(48, crc32(entete.subarray(0, 48)), true);
  const paquet = new Uint8Array(TAILLE_ENTETE_MAJ + img.length);
  paquet.set(entete, 0);
  paquet.set(img, TAILLE_ENTETE_MAJ);
  return paquet;
}

/** Traduit une trame réponse 0xA0 (état, valeur) en message français clair. */
export function messageErreurMaj(etat, valeur = 0) {
  switch (etat) {
    case ETATS_MAJ.E_TAILLE:
      return `Paquet trop grand pour la réserve du rover (max ${Math.round(valeur / 1024)} Ko).`;
    case ETATS_MAJ.E_CRC:
      return 'Paquet abîmé pendant l’envoi (somme de contrôle refusée) : recommencez.';
    case ETATS_MAJ.E_IMAGE:
      return `Paquet refusé par le rover : ${ERREURS_IMAGE[valeur] ?? `code ${valeur}`}.`;
    case ETATS_MAJ.E_ABSENT:
      return 'Aucun paquet prêt sur le rover, ou mise à jour sans fil indisponible.';
    default:
      return `Réponse inattendue du rover (état ${etat}).`;
  }
}

/** Calcule la taille des données d'un bloc 0x21 d'après le MTU négocié (outils/maj_ble.py:183). */
export function tailleBlocPourMtu(mtu) {
  const m = Number.isFinite(mtu) && mtu >= 23 ? mtu : 183;
  return Math.max(15, Math.min(m, 247) - 3 - 5);
}

/**
 * Exécute le dialogue complet de mise à jour (0x20 -> 0x21 -> 0x22 -> 0x23) exactement selon outils/maj_ble.py.
 */
export class PilotageMaj {
  constructor({ envoyer, maintenant = () => performance.now(), attendre = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this._envoyer = envoyer;
    this._maintenant = maintenant;
    this._attendre = attendre;
    this._file = [];
    this._attenteReponse = null;
    this._annule = false;
    this.enCours = false;
  }

  /** À appeler à chaque trame 0xA0 décodée ({ type: 'maj', etat, valeur }). */
  surReponse(msg) {
    if (!msg || typeof msg.etat !== 'number') return;
    if (this._attenteReponse) {
      const resolve = this._attenteReponse;
      this._attenteReponse = null;
      resolve(msg);
    } else {
      this._file.push(msg);
    }
  }

  annuler() {
    this._annule = true;
    if (this._attenteReponse) {
      const r = this._attenteReponse;
      this._attenteReponse = null;
      r(null);
    }
  }

  _viderFile() {
    this._file.length = 0;
  }

  _attendreReponse(delaiMs) {
    if (this._file.length > 0) return Promise.resolve(this._file.shift());
    return new Promise((resolve) => {
      const min = setTimeout(() => {
        if (this._attenteReponse === fin) {
          this._attenteReponse = null;
          resolve(null);
        }
      }, delaiMs);
      const fin = (msg) => { clearTimeout(min); resolve(msg); };
      this._attenteReponse = fin;
    });
  }

  _prendreReponse() {
    return this._file.length > 0 ? this._file.shift() : null;
  }

  async executer(paquet, { tailleBloc = 172, enMouvement = () => false, surProgres = () => {} } = {}) {
    if (this.enCours) throw new Error('Une mise à jour est déjà en cours.');
    const entete = lireEnteteMaj(paquet);
    if (enMouvement()) {
      throw new Error('Arrêtez complètement le rover avant de lancer la mise à jour.');
    }
    this.enCours = true;
    this._annule = false;
    this._viderFile();
    const crc = entete.crcPaquet;
    try {
      surProgres({ phase: 'debut', confirme: 0, total: paquet.length, debitKoS: 0 });
      this._envoyer(encoderMajDebut(paquet.length, crc), { priorite: false });
      const repDebut = await this._attendreReponse(5000);
      if (this._annule) throw new Error('Mise à jour annulée.');
      if (!repDebut) {
        throw new Error('Le rover ne répond pas à la demande de mise à jour.');
      }

      if (repDebut.etat !== ETATS_MAJ.PRET) {
        if (repDebut.etat !== ETATS_MAJ.RECEPTION) {
          throw new Error(messageErreurMaj(repDebut.etat, repDebut.valeur));
        }
        let confirme = repDebut.valeur;
        let envoye = confirme;
        const depart = confirme;
        const t0 = this._maintenant();
        let tProgres = t0;
        const avance = Math.min(AVANCE_MAJ, 64 * tailleBloc);

        if (confirme > 0) {
          surProgres({ phase: 'reprise', confirme, total: paquet.length, debitKoS: 0 });
        }

        while (confirme < paquet.length) {
          if (this._annule) throw new Error('Mise à jour annulée.');
          if (enMouvement()) throw new Error('Mise à jour interrompue : le rover s’est mis en mouvement.');

          let r;
          while ((r = this._prendreReponse()) !== null) {
            if (r.etat === ETATS_MAJ.RECEPTION) {
              if (r.valeur > confirme) {
                confirme = r.valeur;
                tProgres = this._maintenant();
              }
            } else if (r.etat === ETATS_MAJ.DESORDRE) {
              envoye = r.valeur;
              tProgres = this._maintenant();
            } else {
              throw new Error(messageErreurMaj(r.etat, r.valeur));
            }
          }

          if (confirme >= paquet.length) break;

          const prochainLot = Math.min(tailleBloc, paquet.length - envoye);
          if (envoye < paquet.length && envoye - confirme + prochainLot <= avance) {
            const bloc = paquet.subarray(envoye, envoye + prochainLot);
            const ok = this._envoyer(encoderMajBloc(envoye, bloc), { rapide: true });
            if (ok !== false) envEcrire: {
              envoye += bloc.length;
              break envEcrire;
            }
            await this._attendre(10);
          } else {
            await this._attendre(5);
            if (this._maintenant() - tProgres > 2000) {
              envoye = confirme;
              tProgres = this._maintenant();
              this._envoyer(encoderMajDebut(paquet.length, crc));
            }
          }

          const dtS = Math.max(0.1, (this._maintenant() - t0) / 1000);
          const debitKoS = (confirme - depart) / 1024 / dtS;
          surProgres({ phase: 'envoi', confirme, total: paquet.length, debitKoS });
        }

        surProgres({ phase: 'verification', confirme: paquet.length, total: paquet.length, debitKoS: 0 });
        let verifOk = false;
        for (let essai = 0; essai < 3 && !verifOk; essai++) {
          this._envoyer(encoderMajFin());
          const finDeadline = this._maintenant() + 40000;
          while (this._maintenant() < finDeadline) {
            if (this._annule) throw new Error('Mise à jour annulée.');
            const restant = Math.max(50, finDeadline - this._maintenant());
            const r = await this._attendreReponse(Math.min(restant, 5000));
            if (!r) {
              if (this._maintenant() >= finDeadline) break;
              continue;
            }
            if (r.etat === ETATS_MAJ.PRET) { verifOk = true; break; }
            if (r.etat === ETATS_MAJ.RECEPTION || r.etat === ETATS_MAJ.DESORDRE) continue;
            throw new Error(messageErreurMaj(r.etat, r.valeur));
          }
        }
        if (!verifOk) throw new Error('Le rover n’a pas confirmé la vérification du paquet.');
      }

      surProgres({ phase: 'installation', confirme: paquet.length, total: paquet.length, debitKoS: 0 });
      this._viderFile();
      this._envoyer(encoderMajInstaller(crc));
      const repInst = await this._attendreReponse(5000);
      if (!repInst) throw new Error("Le rover n’a pas confirmé le lancement de l’installation.");
      if (repInst.etat !== ETATS_MAJ.INSTALLE) {
        throw new Error(messageErreurMaj(repInst.etat, repInst.valeur));
      }
      surProgres({ phase: 'redemarrage', confirme: paquet.length, total: paquet.length, debitKoS: 0 });
      return entete;
    } finally {
      this.enCours = false;
    }
  }
}

/**
 * Vérifie après reconnexion si le nouveau firmware tourne ou si un retour arrière a eu lieu.
 * @returns {{ statut: 'ok'|'retour_arriere'|'echec'|'attente', message: string }}
 */
export function verifierApresRedemarrage({ entete, majLigne, majBrut, materiel, version }) {
  if (!entete) return { statut: 'attente', message: '' };
  const etat = majLigne?.etat;
  const raz = materiel?.raz ? String(materiel.raz) : '';
  if (etat === 3 || raz === 'garde') {
    return {
      statut: 'retour_arriere',
      message: `Retour arrière automatique : le nouveau firmware n'a pas confirmé son démarrage (état ${etat ?? '?'}, raz=${raz || '?'}). L'ancien firmware tourne toujours.`,
    };
  }
  const taille = Number(majLigne?.taille);
  const crcHex = String(majBrut?.crc ?? majLigne?.crc ?? '').toLowerCase().padStart(8, '0');
  const crcAttendu = entete.crcBrut.toString(16).padStart(8, '0');
  if (etat === 0 && taille === entete.tailleBrute && crcHex === crcAttendu) {
    const vTxt = version ? ` (${version})` : '';
    const razTxt = raz ? `, raz=${raz}` : '';
    return {
      statut: 'ok',
      message: `Mise à jour réussie${vTxt} : état=0, taille=${taille} o, crc=${crcHex}${razTxt}.`,
    };
  }
  if (majLigne) {
    return {
      statut: 'echec',
      message: `Le rover a redémarré mais ne confirme pas le paquet attendu (reçu etat=${etat} taille=${taille} crc=${crcHex}, attendu taille=${entete.tailleBrute} crc=${crcAttendu}${raz ? `, raz=${raz}` : ''}).`,
    };
  }
  return { statut: 'attente', message: 'Vérification en cours après reconnexion…' };
}
