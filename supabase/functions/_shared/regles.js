// Calculs et règles du temps de travail.
// Module sans dépendance, partagé par la page (navigateur) et la fonction des rappels (Deno).
// Dates au format AAAA-MM-JJ, heures au format HH:MM ou HH:MM:SS, durées en minutes.

export const TYPES_EVT = { arrivee: 'Arrivée', pause: 'Début de pause', reprise: 'Fin de pause', depart: 'Départ' };
export const SOURCES = { pointage: 'Pointé en direct', saisie: 'Saisi après coup', correction: 'Correction employeur' };
export const JOURS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
export const JOURS_LONGS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

const pad = n => String(n).padStart(2, '0');
export const iso = d => d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
const D = s => new Date(s + 'T12:00:00Z');
export const ajouterJours = (s, n) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
export const jourSemaine = s => ((D(s).getUTCDay() + 6) % 7) + 1; // 1 = lundi … 7 = dimanche
export const lundi = s => ajouterJours(s, 1 - jourSemaine(s));
export const ecartJours = (a, b) => Math.round((D(b) - D(a)) / 864e5);
const jjmm = s => s.slice(8, 10) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4);
export const enMin = h => { if (!h) return null; const [a, b] = String(h).split(':'); return +a * 60 + +b; };
export const hhmm = m => pad(Math.floor(m / 60)) + ':' + pad(m % 60);
export const duree = m => {
  if (m == null) return '–';
  const s = m < 0 ? '-' : ''; m = Math.abs(Math.round(m));
  return s + Math.floor(m / 60) + 'h' + pad(m % 60);
};

/** Date et heure actuelles à Paris, quel que soit le fuseau de l'appareil ou du serveur. */
export function maintenantParis(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date).map(x => [x.type, x.value]));
  const h = +p.hour % 24;
  return { jour: `${p.year}-${p.month}-${p.day}`, heure: pad(h) + ':' + p.minute, minutes: h * 60 + +p.minute };
}

export const valides = evts => evts.filter(e => !e.annule_le);

/**
 * Analyse d'une journée à partir de ses événements valides.
 * Une coupure (départ puis nouvelle arrivée) compte comme une pause.
 */
export function analyserJour(evts) {
  const liste = valides(evts).slice().sort((a, b) =>
    enMin(a.heure) - enMin(b.heure) || String(a.saisi_le || '').localeCompare(String(b.saisi_le || '')));
  let etat = 'hors', debutTravail = null, debutPause = null, incoherent = false;
  const plages = [], pauses = [];
  for (const e of liste) {
    const t = enMin(e.heure);
    if (e.type === 'arrivee') {
      if (etat !== 'hors') { incoherent = true; continue; }
      if (plages.length) pauses.push([plages[plages.length - 1][1], t]);
      debutTravail = t; etat = 'travail';
    } else if (e.type === 'pause') {
      if (etat !== 'travail') { incoherent = true; continue; }
      plages.push([debutTravail, t]); debutPause = t; etat = 'pause';
    } else if (e.type === 'reprise') {
      if (etat !== 'pause') { incoherent = true; continue; }
      pauses.push([debutPause, t]); debutTravail = t; etat = 'travail';
    } else if (e.type === 'depart') {
      if (etat === 'travail') { plages.push([debutTravail, t]); etat = 'hors'; }
      else if (etat === 'pause') { pauses.push([debutPause, t]); etat = 'hors'; incoherent = true; }
      else incoherent = true;
    }
  }
  const travail = plages.reduce((s, [a, b]) => s + Math.max(0, b - a), 0);
  return {
    vide: liste.length === 0,
    plages, pauses, travail,
    debut: liste.length ? (plages[0]?.[0] ?? (etat === 'travail' ? debutTravail : null)) : null,
    fin: etat === 'hors' && plages.length ? plages[plages.length - 1][1] : null,
    etat,            // hors | travail | pause : état en fin de liste
    complet: etat === 'hors' && plages.length > 0 && !incoherent,
    incoherent,
    pauseMax: pauses.reduce((m, [a, b]) => Math.max(m, b - a), 0),
    enCours: { etat, depuis: etat === 'travail' ? debutTravail : etat === 'pause' ? debutPause : null },
  };
}

/** Plages prévues par l'agenda type pour une date donnée. */
export function agendaPour(versions, jour) {
  const v = versions.filter(x => x.valable_du <= jour).sort((a, b) =>
    b.valable_du.localeCompare(a.valable_du) || String(b.saisi_le || '').localeCompare(String(a.saisi_le || '')))[0];
  if (!v) return null;
  return (v.plages && v.plages[String(jourSemaine(jour))]) || [];
}
export const minutesPrevues = plages => (plages || []).reduce((s, [a, b]) => s + Math.max(0, enMin(b) - enMin(a)), 0);

/** Jour normalement travaillé : selon l'agenda type, sinon du lundi au vendredi. */
export function jourOuvre(versions, jour) {
  const p = agendaPour(versions, jour);
  return p ? p.length > 0 : jourSemaine(jour) <= 5;
}

export const absencePour = (absences, jour) =>
  absences.find(a => !a.annule_le && a.du <= jour && jour <= a.au) || null;

/** Regroupe des événements par jour. */
export function parJour(evts) {
  const m = {};
  for (const e of evts) (m[e.jour] ||= []).push(e);
  return m;
}

/**
 * Jours ouvrés passés sans saisie complète ni absence.
 * Fenêtre : de max(debut, aujourdhui - fenetre) à la veille.
 */
export function joursManquants({ evtsParJour, absences, versions, debut, aujourdhui, fenetre = 14 }) {
  const out = [];
  let d = ajouterJours(aujourdhui, -fenetre);
  if (debut && d < debut) d = debut;
  for (; d < aujourdhui; d = ajouterJours(d, 1)) {
    if (!jourOuvre(versions, d) || absencePour(absences, d)) continue;
    const a = analyserJour(evtsParJour[d] || []);
    if (a.vide) out.push({ jour: d, motif: 'vide' });
    else if (!a.complet) out.push({ jour: d, motif: 'incomplet' });
  }
  return out;
}

/** Synthèse d'une semaine (lundi → dimanche). */
export function semaine({ lundi: l, evtsParJour, absences, versions, params }) {
  let travail = 0, prevu = 0, joursAbsence = 0;
  const contrat = (params.heures_hebdo || 35) * 60;
  const jours = [];
  for (let i = 0; i < 7; i++) {
    const d = ajouterJours(l, i);
    const a = analyserJour(evtsParJour[d] || []);
    const abs = absencePour(absences, d);
    const plan = agendaPour(versions, d);
    const p = abs ? 0 : minutesPrevues(plan);
    if (abs && jourOuvre(versions, d)) joursAbsence++;
    travail += a.travail; prevu += p;
    jours.push({ jour: d, analyse: a, absence: abs, plan: plan || [], prevu: p });
  }
  // Heures attendues au contrat, réduites des jours d'absence (au prorata des jours ouvrés)
  const ouvres = jours.filter(j => jourOuvre(versions, j.jour)).length || 5;
  const attendu = Math.round(contrat * (ouvres - joursAbsence) / ouvres);
  return { lundi: l, jours, travail, prevu, attendu, joursAbsence, heuresSup: Math.max(0, travail - contrat) };
}

/**
 * Alertes sur une période [du, au]. Les règles hebdomadaires ne portent que sur des
 * semaines terminées avant « aujourdhui ». Chaque alerte a une clé stable (dédoublonnage des emails).
 */
export function alertes({ evtsParJour, absences, versions, params, du, au, aujourdhui }) {
  const out = [];
  const P = params;
  const add = (jour, regle, niveau, message) => out.push({ cle: regle + ':' + jour, jour, regle, niveau, message });
  const A = d => analyserJour(evtsParJour[d] || []);

  for (let d = du; d <= au; d = ajouterJours(d, 1)) {
    const a = A(d);
    if (a.vide) continue;
    if (a.incoherent) add(d, 'incoherent', 'info', 'Suite de pointages incohérente (vérifier les heures du jour).');
    if (a.travail > P.max_jour_min)
      add(d, 'max_jour', 'depassement', `Durée quotidienne de ${duree(a.travail)}, au-delà du maximum de ${duree(P.max_jour_min)}.`);
    if (a.travail >= P.pause_seuil_min && a.pauseMax < P.pause_duree_min)
      add(d, 'pause', 'depassement', `${duree(a.travail)} de travail sans pause d'au moins ${P.pause_duree_min} min.`);
    // Repos quotidien : de la fin de la veille au début du jour
    const veille = A(ajouterJours(d, -1));
    if (a.debut != null && veille.fin != null) {
      const repos = 1440 - veille.fin + a.debut;
      if (repos < P.repos_quotidien_min)
        add(d, 'repos_quotidien', 'depassement', `Repos de ${duree(repos)} depuis la veille, en dessous des ${duree(P.repos_quotidien_min)} requises.`);
    }
    // Écart avec l'agenda type
    if (!absencePour(absences, d)) {
      const plan = agendaPour(versions, d);
      if (plan) {
        const p = minutesPrevues(plan);
        if (p === 0 && a.travail > 0)
          add(d, 'agenda', 'ecart', `Travail un jour non prévu à l'agenda type (${duree(a.travail)}).`);
        else if (a.travail > p + P.tolerance_agenda_min)
          add(d, 'agenda', 'ecart', `${duree(a.travail)} travaillées pour ${duree(p)} prévues à l'agenda type (+${duree(a.travail - p)}).`);
      }
    }
  }

  // Règles hebdomadaires
  for (let l = lundi(du); l <= au; l = ajouterJours(l, 7)) {
    const dim = ajouterJours(l, 6);
    if (dim >= aujourdhui) continue;
    const s = semaine({ lundi: l, evtsParJour, absences, versions, params });
    if (s.travail === 0) continue;
    if (s.travail > P.max_semaine_min)
      add(l, 'max_semaine', 'depassement', `Semaine du ${jjmm(l)} : ${duree(s.travail)}, au-delà du maximum de ${duree(P.max_semaine_min)}.`);
    if (s.heuresSup > 0)
      add(l, 'heures_sup', 'info', `Semaine du ${jjmm(l)} : ${duree(s.heuresSup)} au-delà des ${P.heures_hebdo} h (heures supplémentaires).`);
    // Moyenne sur les 12 dernières semaines (ou moins si l'historique est plus court)
    let tot = 0, n = 0;
    for (let k = 0; k < 12; k++) {
      const lk = ajouterJours(l, -7 * k);
      if (P.date_debut && ajouterJours(lk, 6) < P.date_debut) break;
      tot += semaine({ lundi: lk, evtsParJour, absences, versions, params }).travail; n++;
    }
    if (n && tot / n > P.moyenne_12s_min)
      add(l, 'moyenne_12s', 'depassement', `Semaine du ${jjmm(l)} : moyenne de ${duree(tot / n)} sur ${n} semaine(s), au-delà de ${duree(P.moyenne_12s_min)}.`);
    // Repos hebdomadaire : plus long intervalle sans travail touchant la semaine.
    // On regarde aussi la veille (dimanche précédent) et le lendemain (lundi suivant),
    // pour qu'un repos à cheval sur deux semaines soit compté en entier.
    const bornes = [];
    for (let i = -1; i <= 7; i++) {
      const a = A(ajouterJours(l, i));
      for (const [x, y] of a.plages) bornes.push([i * 1440 + x, i * 1440 + y]);
    }
    bornes.sort((x, y) => x[0] - y[0]);
    let curseur = -1440, maxRepos = 0;
    // Fenêtre : la semaine, élargie de 11 h de chaque côté (le repos quotidien peut l'enjamber)
    const compter = (a, b) => {
      a = Math.max(a, -660); b = Math.min(b, 7 * 1440 + 660);
      if (b > a) maxRepos = Math.max(maxRepos, b - a);
    };
    for (const [x, y] of bornes) { compter(curseur, x); curseur = Math.max(curseur, y); }
    compter(curseur, 8 * 1440);
    if (maxRepos < P.repos_hebdo_min)
      add(l, 'repos_hebdo', 'depassement', `Semaine du ${jjmm(l)} : repos continu le plus long de ${duree(maxRepos)}, en dessous de ${duree(P.repos_hebdo_min)}.`);
  }
  return out.sort((a, b) => a.jour.localeCompare(b.jour));
}

export const LIBELLES_REGLES = {
  max_jour: 'Durée maximale quotidienne',
  pause: 'Pause obligatoire',
  repos_quotidien: 'Repos quotidien',
  max_semaine: 'Durée maximale hebdomadaire',
  moyenne_12s: 'Moyenne sur 12 semaines',
  repos_hebdo: 'Repos hebdomadaire',
  heures_sup: 'Heures supplémentaires',
  agenda: "Écart avec l'agenda type",
  incoherent: 'Pointages incohérents',
};
