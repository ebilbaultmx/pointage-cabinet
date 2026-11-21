// Pointage du cabinet : interface
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import * as R from './supabase/functions/_shared/regles.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const JSPDF = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js';
const AUTOTABLE = 'https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js';
const TYPES_ABS = ['Congés payés', 'Arrêt maladie', 'Arrêt enfant malade', 'Jour férié', 'Décès d’un proche',
  'Accident du travail', 'Mariage / PACS', 'Déménagement', 'RDV médecine du travail', 'Formation',
  'Convocation judiciaire', 'Récupération', 'Autre'];
const FORMES = { cabinet: 'Cabinet (nom propre)', scm: 'SCM', autre: 'Autre' };

// Lien d'invitation : il faut choisir un mot de passe à la première connexion
const ARRIVEE_PAR_INVITATION = /type=(invite|recovery)/.test(location.hash);

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, detectSessionInUrl: true } });

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fd = s => new Date(s + 'T12:00:00Z').toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const fdl = s => s ? new Date(s + 'T12:00:00Z').toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }) : '';
const fdt = ts => ts ? new Date(ts).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const hm = h => String(h || '').slice(0, 5);
const plagesTxt = pl => pl.length ? pl.map(([a, b]) => R.hhmm(a) + '–' + R.hhmm(b)).join(', ') : '–';
const agendaTxt = pl => pl && pl.length ? pl.map(([a, b]) => a + '–' + b).join(', ') : '–';
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* navigation privée */ } };

// ---------------------------------------------------------------------------
// État
// ---------------------------------------------------------------------------
const S = {
  moi: null, params: null, profils: [], employeurs: [], membres: [],
  emp: null, sel: null,
  evts: [], abs: [], versions: [], chargeDepuis: null,
  tab: null, wk: null, mois: null, du: null, au: null,
  journal: [], majLe: null, occupe: false,
};
const auj = () => R.maintenantParis().jour;
const actif = m => !m.date_fin || m.date_fin >= auj();
const monContrat = () => S.membres.find(m => m.profil === S.moi.id && m.role === 'salarie' && actif(m));
const empGeres = () => S.moi.admin
  ? S.employeurs.filter(e => e.actif)
  : S.employeurs.filter(e => S.membres.some(m => m.profil === S.moi.id && m.employeur === e.id && m.role === 'responsable' && actif(m)));
const gestionnaire = () => S.moi.admin || empGeres().length > 0;
const gere = () => S.sel && S.sel !== S.moi.id;                  // on consulte les heures de quelqu'un d'autre
const salariesDe = e => S.membres.filter(m => m.employeur === e && m.role === 'salarie')
  .sort((a, b) => (actif(b) - actif(a)) || nom(a.profil).localeCompare(nom(b.profil)));
const contratDe = id => S.membres.filter(m => m.profil === id && m.role === 'salarie').sort((a, b) => (actif(b) - actif(a)))[0];
const employeurDe = id => S.employeurs.find(e => e.id === contratDe(id)?.employeur);
const params = () => { const c = contratDe(S.sel) || {}; return { ...S.params, heures_hebdo: +c.heures_hebdo || 35, date_debut: c.date_debut }; };
const nom = id => S.profils.find(p => p.id === id)?.nom || (id ? 'Responsable' : 'Système');
const evtsParJour = () => R.parJour(S.evts);

function erreur(e) { alert('Opération impossible : ' + (e?.message || String(e))); }

// Lecture paginée (Supabase renvoie 1000 lignes au plus par requête)
async function toutLire(construire) {
  const out = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await construire().range(i, i + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

/** Charge les données de la personne sélectionnée depuis « du » (avec 13 semaines de marge pour les règles). */
async function assurer(du) {
  if (!S.sel) return;
  const depuis = R.ajouterJours(du, -91);
  if (S.chargeDepuis && S.chargeDepuis <= depuis) return;
  const [evts, abs, versions] = await Promise.all([
    toutLire(() => sb.from('evenements').select('*').eq('salarie', S.sel).gte('jour', depuis).order('jour')),
    toutLire(() => sb.from('absences').select('*').eq('salarie', S.sel).gte('au', depuis).order('du')),
    toutLire(() => sb.from('agenda_versions').select('*').eq('salarie', S.sel).order('valable_du')),
  ]);
  S.evts = evts; S.abs = abs; S.versions = versions; S.chargeDepuis = depuis; S.majLe = new Date();
}
async function recharger() {
  const d = S.chargeDepuis ? R.ajouterJours(S.chargeDepuis, 91) : auj();
  S.chargeDepuis = null;
  await assurer(d);
  render();
}
async function chargerOrganisation() {
  const [p, e, m, g] = await Promise.all([
    sb.from('profils').select('*').order('nom'), sb.from('employeurs').select('*').order('nom'),
    sb.from('membres').select('*'), sb.from('parametres').select('*').eq('id', 1).maybeSingle(),
  ]);
  for (const r of [p, e, m, g]) if (r.error) throw r.error;
  S.profils = p.data; S.employeurs = e.data; S.membres = m.data; S.params = g.data;
}

// ---------------------------------------------------------------------------
// Connexion
// ---------------------------------------------------------------------------
function vConnexion(msg = '') {
  $('tabs').innerHTML = ''; $('banner').innerHTML = ''; $('compte').innerHTML = ''; $('choix').innerHTML = '';
  $('view').innerHTML = `<section class="bg-white rounded-2xl border border-slate-200 p-5 max-w-sm mx-auto">
    <h2 class="font-semibold mb-3">Connexion</h2>
    ${msg ? `<p class="text-sm text-rose-700 mb-3">${esc(msg)}</p>` : ''}
    <div class="space-y-3">
      <div><label>Adresse email</label><input id="c-email" type="email" autocomplete="username"></div>
      <div><label>Mot de passe</label><input id="c-mdp" type="password" autocomplete="current-password"
        onkeydown="if(event.key==='Enter')seConnecter()"></div>
      <button class="btn bg-teal-600 text-white w-full" onclick="seConnecter()">Se connecter</button>
      <button class="text-sm underline text-slate-500 w-full" onclick="mdpOublie()">Mot de passe oublié</button>
    </div></section>`;
}
async function seConnecter() {
  const { error } = await sb.auth.signInWithPassword({ email: $('c-email').value.trim(), password: $('c-mdp').value });
  if (error) vConnexion('Email ou mot de passe incorrect.');
}
async function mdpOublie() {
  const email = $('c-email').value.trim();
  if (!email) return alert('Saisissez d’abord votre adresse email.');
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  if (error) return erreur(error);
  alert('Un email de réinitialisation vient d’être envoyé à ' + email + '.');
}
function vNouveauMdp() {
  openDlg(`<h3 class="font-bold mb-2">Choisissez votre mot de passe</h3>
    <p class="text-sm text-slate-500 mb-3">8 caractères au minimum.</p>
    <input id="n-mdp" type="password" autocomplete="new-password">
    <button class="btn bg-teal-600 text-white w-full mt-3" onclick="enregistrerMdp()">Enregistrer</button>`);
}
async function enregistrerMdp() {
  const p = $('n-mdp').value;
  if (p.length < 8) return alert('8 caractères au minimum.');
  const { error } = await sb.auth.updateUser({ password: p });
  if (error) return erreur(error);
  history.replaceState(null, '', location.pathname);
  closeDlg(); alert('Mot de passe enregistré.');
}
async function seDeconnecter() { await sb.auth.signOut(); location.reload(); }

let demarrage = null;
function demarrer(session) {
  if (!session) return vConnexion();
  return (demarrage ||= ouvrirSession(session).catch(e => { demarrage = null; erreur(e); }));
}
async function ouvrirSession(session) {
  const { data: moi } = await sb.from('profils').select('*').eq('id', session.user.id).maybeSingle();
  if (!moi || !moi.actif) {
    $('view').innerHTML = `<section class="bg-white rounded-2xl border border-slate-200 p-5">
      <p>Votre compte (${esc(session.user.email)}) n’est pas encore rattaché à un employeur.</p>
      <button class="btn bg-slate-100 mt-3" onclick="seDeconnecter()">Se déconnecter</button></section>`;
    return;
  }
  S.moi = moi;
  await chargerOrganisation();
  S.wk = R.lundi(auj()); S.mois = auj().slice(0, 7);
  if (gestionnaire()) {
    const emps = empGeres();
    S.emp = emps.find(e => e.id === lsGet('pointage.emp'))?.id || emps[0]?.id || null;
    const sal = salariesDe(S.emp);
    S.sel = sal.find(m => m.profil === lsGet('pointage.sel'))?.profil || sal.find(actif)?.profil || null;
    S.tab = 'suivi';
  } else {
    S.sel = moi.id; S.tab = 'pointer';
  }
  await assurer(R.ajouterJours(auj(), -31));
  if (ARRIVEE_PAR_INVITATION) vNouveauMdp();
  render();
}

// ---------------------------------------------------------------------------
// Rendu général
// ---------------------------------------------------------------------------
function openDlg(h) { $('dlgc').innerHTML = h; if (!$('dlg').open) $('dlg').showModal(); }
function closeDlg() { $('dlg').close(); }
async function setTab(t) {
  // L'onglet « Pointer » porte toujours sur ses propres heures
  if (t === 'pointer' && S.sel !== S.moi.id) { S.sel = S.moi.id; S.chargeDepuis = null; await assurer(R.ajouterJours(auj(), -31)); }
  S.tab = t; S.jrDu = undefined; render();
}
async function choisirEmployeur(id) {
  S.emp = id; lsSet('pointage.emp', id);
  await choisirSalarie(salariesDe(id).find(actif)?.profil || salariesDe(id)[0]?.profil || null);
}
async function choisirSalarie(id) {
  S.sel = id; lsSet('pointage.sel', id || ''); S.chargeDepuis = null; S.jrDu = undefined; brouillon = null;
  S.evts = []; S.abs = []; S.versions = [];
  await assurer(S.du || R.ajouterJours(auj(), -31)); render();
}

function render() {
  if (!S.moi) return;
  $('today').textContent = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('sync').textContent = S.majLe ? '● Données à jour à ' + S.majLe.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
  const statut = S.moi.admin ? 'Administratrice' : gestionnaire() ? 'Responsable' : 'Salarié(e)';
  $('compte').innerHTML = `<div class="font-medium">${esc(S.moi.nom)}</div>
    <div class="text-xs text-slate-500">${statut} · <button class="underline" onclick="seDeconnecter()">Se déconnecter</button></div>`;

  let tabs;
  if (gestionnaire()) {
    tabs = [['suivi', 'Suivi'], ['semaine', 'Semaine'], ['alertes', 'Alertes'], ['absences', 'Absences'], ['contrat', 'Contrat et agenda'], ['journal', 'Journal']];
    if (monContrat()) tabs.unshift(['pointer', 'Mon pointage']);
    if (S.moi.admin) tabs.push(['admin', 'Administration']);
  } else tabs = [['pointer', 'Pointer'], ['semaine', 'Semaine'], ['absences', 'Absences'], ['historique', 'Historique']];
  if (!tabs.find(t => t[0] === S.tab)) S.tab = tabs[0][0];
  $('tabs').innerHTML = tabs.map(([k, l]) => `<button onclick="setTab('${k}')" class="btn whitespace-nowrap ${S.tab === k ? 'bg-teal-600 text-white' : 'bg-white border border-slate-200 text-slate-600'}">${l}</button>`).join('');

  $('choix').innerHTML = gestionnaire() && !['admin', 'pointer'].includes(S.tab) ? vChoix() : '';
  if (S.tab === 'admin') { $('banner').innerHTML = ''; $('view').innerHTML = vAdmin(); return; }
  if (!S.sel) {
    $('banner').innerHTML = '';
    $('view').innerHTML = `<section class="bg-white rounded-2xl border border-slate-200 p-5 text-sm">Aucun salarié n’est encore rattaché à cet employeur.${S.moi.admin ? ' Utilisez l’onglet Administration pour inviter une personne.' : ''}</section>`;
    return;
  }
  renderBanniere();
  const vues = { pointer: vPointer, semaine: vSemaine, absences: vAbs, historique: vHistorique, suivi: vSuivi, alertes: vAlertes, contrat: vContrat, journal: vJournal };
  $('view').innerHTML = vues[S.tab]();
  tick();
}

function vChoix() {
  const emps = empGeres();
  const sal = salariesDe(S.emp);
  const opts = sal.map(m => `<option value="${m.profil}" ${m.profil === S.sel ? 'selected' : ''}>${esc(nom(m.profil))}${actif(m) ? '' : ' (sorti le ' + fdl(m.date_fin) + ')'}</option>`);
  if (monContrat() && S.sel === S.moi.id) opts.unshift(`<option value="${S.moi.id}" selected>Moi</option>`);
  return `<div class="mb-3 grid grid-cols-2 gap-3">
    <div><label>Employeur</label><select onchange="choisirEmployeur(this.value)">${emps.map(e => `<option value="${e.id}" ${e.id === S.emp ? 'selected' : ''}>${esc(e.nom)}</option>`).join('')}</select></div>
    <div><label>Salarié(e)</label><select onchange="choisirSalarie(this.value)" ${opts.length ? '' : 'disabled'}>${opts.join('') || '<option>Aucun</option>'}</select></div></div>`;
}

function renderBanniere() {
  const P = params();
  const mm = R.joursManquants({ evtsParJour: evtsParJour(), absences: S.abs, versions: S.versions, debut: P.date_debut, aujourdhui: auj() });
  let h = '';
  if (mm.length) h += `<div class="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">
    <b>⏰ ${gere() ? esc(nom(S.sel)) + ' n’a pas complété ses horaires' : 'Rappel : horaires non saisis ou incomplets'}</b> (${mm.length} jour${mm.length > 1 ? 's' : ''}) :
    ${mm.slice(0, 8).map(m => `<button class="underline mx-1" onclick="dlgJour('${m.jour}')">${fd(m.jour)}${m.motif === 'incomplet' ? ' (incomplet)' : ''}</button>`).join('')}</div>`;
  if (gere() && !S.versions.length) h += `<div class="mb-4 rounded-xl border border-sky-300 bg-sky-50 p-3 text-sm">L’agenda type n’est pas renseigné : les écarts avec le planning ne peuvent pas être calculés. <button class="underline" onclick="setTab('contrat')">Le renseigner</button></div>`;
  $('banner').innerHTML = h;
}

// ---------------------------------------------------------------------------
// Pointer (ses propres heures)
// ---------------------------------------------------------------------------
function vPointer() {
  const d = auj(), ev = (evtsParJour()[d] || []), a = R.analyserJour(ev), abs = R.absencePour(S.abs, d);
  const plan = R.agendaPour(S.versions, d);
  const e = a.etat;
  const b = (k, l, c, ok) => `<button class="btn ${c}" ${ok && !S.occupe ? '' : 'disabled'} onclick="pointer('${k}')">${l}</button>`;
  const st = e === 'pause' ? 'En pause' : e === 'travail' ? 'Au travail' : a.complet ? 'Journée terminée' : 'Pas encore arrivé(e)';
  return `<section class="bg-white rounded-2xl border border-slate-200 p-5 text-center">
   <p class="text-sm text-slate-500">Bonjour ${esc(S.moi.nom.split(' ')[0])} 👋</p>
   <p id="clock" class="text-5xl font-bold my-2 tabular-nums"></p>
   <p class="mb-1 text-teal-700 font-medium">${st}${abs ? ' – ' + esc(abs.type) : ''}</p>
   <p class="mb-4 text-xs text-slate-500">Prévu aujourd’hui : ${plan ? agendaTxt(plan) : 'agenda type non renseigné'}</p>
   <div class="grid grid-cols-2 gap-3">
    ${b('arrivee', '▶ Arrivée', 'bg-teal-600 text-white', e === 'hors')}
    ${b('depart', '■ Départ', 'bg-rose-600 text-white', e === 'travail')}
    ${b('pause', '☕ Début pause', 'bg-amber-500 text-white', e === 'travail')}
    ${b('reprise', '↩ Fin de pause', 'bg-sky-600 text-white', e === 'pause')}
   </div>
   ${listeEvts(ev, false)}
   <p class="mt-4 font-semibold">Temps travaillé aujourd’hui : ${R.duree(a.travail + (e === 'travail' ? Math.max(0, R.maintenantParis().minutes - a.enCours.depuis) : 0))}</p>
   <button class="mt-3 text-sm underline text-slate-500" onclick="dlgJour('${d}')">Saisir une heure oubliée</button>
  </section>`;
}
async function pointer(type) {
  if (S.occupe) return;
  S.occupe = true; render();
  const n = R.maintenantParis();
  const { error } = await sb.from('evenements').insert({ salarie: S.moi.id, jour: n.jour, type, heure: n.heure, source: 'pointage' });
  S.occupe = false;
  if (error) erreur(error);
  await recharger();
}
function tick() { const c = $('clock'); if (c) c.textContent = new Date().toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris' }); }
setInterval(tick, 1000);

/** Liste des événements d'une journée, avec origine et heure de saisie. */
function listeEvts(ev, actions) {
  if (!ev.length) return '';
  const tri = ev.slice().sort((x, y) => x.heure.localeCompare(y.heure) || x.saisi_le.localeCompare(y.saisi_le));
  return `<div class="mt-4 text-left text-sm divide-y divide-slate-100 border-t border-slate-100">${tri.map(e => `
    <div class="py-2 flex items-start justify-between gap-2 ${e.annule_le ? 'barre' : ''}">
      <div><b>${hm(e.heure)}</b> · ${R.TYPES_EVT[e.type]}
        <div class="text-xs ${e.annule_le ? '' : 'text-slate-500'}">${R.SOURCES[e.source]}${e.source !== 'pointage' ? ' le ' + fdt(e.saisi_le) : ''}${e.source === 'correction' ? ' par ' + esc(nom(e.saisi_par)) : ''}${e.motif ? ' – « ' + esc(e.motif) + ' »' : ''}
        ${e.annule_le ? `<br>Annulé le ${fdt(e.annule_le)} par ${esc(nom(e.annule_par))} – « ${esc(e.motif_annulation)} »` : ''}</div></div>
      ${actions && !e.annule_le ? `<button class="text-rose-700 text-xs underline whitespace-nowrap" onclick="annulerEvt('${e.id}')">Annuler</button>` : ''}
    </div>`).join('')}</div>`;
}

// ---------------------------------------------------------------------------
// Fenêtre d'une journée : compléter (salarié) ou corriger (responsable)
// ---------------------------------------------------------------------------
async function dlgJour(d) {
  if (!S.chargeDepuis || d < R.ajouterJours(S.chargeDepuis, 91)) await assurer(d);
  const ev = evtsParJour()[d] || [], A = !gere(), a = R.analyserJour(ev);
  openDlg(`<h3 class="font-bold mb-1">Journée du ${fd(d)}${A ? '' : ' – ' + esc(nom(S.sel))}</h3>
   <p class="text-xs text-slate-500 mb-3">${A
      ? 'Vous pouvez ajouter les heures manquantes. Elles seront marquées « saisi après coup » avec la date et l’heure de saisie. Les heures déjà enregistrées ne peuvent être corrigées que par un responsable.'
      : 'Une heure enregistrée n’est jamais effacée : elle est annulée avec un motif, et la correction est ajoutée. Tout reste visible dans le journal.'}</p>
   <div><label>Date</label><input id="j-d" type="date" value="${d}" max="${auj()}" onchange="if(this.value)dlgJour(this.value)"></div>
   ${listeEvts(ev, !A)}
   <p class="text-sm mt-2">Temps travaillé : <b>${R.duree(a.travail)}</b>${a.incoherent ? ' <span class="text-amber-700">(suite incohérente)</span>' : ''}</p>
   <div class="mt-4 rounded-xl bg-slate-50 p-3">
     <p class="text-sm font-semibold mb-2">Ajouter une heure</p>
     <div class="grid grid-cols-2 gap-3">
       <div><label>Type</label><select id="j-t">${Object.entries(R.TYPES_EVT).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
       <div><label>Heure</label><input id="j-h" type="time"></div>
       ${A ? '' : '<div class="col-span-2"><label>Motif de la correction (obligatoire)</label><input id="j-m" placeholder="Ex. : oubli de pointage signalé par la personne"></div>'}
     </div>
     <button class="btn bg-teal-600 text-white w-full mt-3" onclick="ajouterEvt('${d}')">Ajouter</button>
   </div>
   <button class="btn bg-slate-100 w-full mt-3" onclick="closeDlg();render()">Fermer</button>`);
}
async function ajouterEvt(d) {
  const type = $('j-t').value, heure = $('j-h').value, motif = $('j-m')?.value.trim();
  if (!heure) return alert('Indiquez une heure.');
  if (d === auj() && heure > R.maintenantParis().heure) return alert('Impossible de saisir une heure future.');
  if (gere() && !motif) return alert('Le motif de la correction est obligatoire.');
  const ligne = { salarie: S.sel, jour: d, type, heure, source: gere() ? 'correction' : 'saisie', motif: motif || null };
  const { error } = await sb.from('evenements').insert(ligne);
  if (error) return erreur(error);
  await recharger(); dlgJour(d);
}
async function annulerEvt(id) {
  const e = S.evts.find(x => x.id === id);
  const motif = prompt(`Motif de l’annulation de « ${R.TYPES_EVT[e.type]} ${hm(e.heure)} » (obligatoire) :`);
  if (!motif || !motif.trim()) return;
  const { error } = await sb.from('evenements').update({ motif_annulation: motif.trim() }).eq('id', id);
  if (error) return erreur(error);
  await recharger(); dlgJour(e.jour);
}

// ---------------------------------------------------------------------------
// Semaine
// ---------------------------------------------------------------------------
function vSemaine() {
  const P = params();
  const s = R.semaine({ lundi: S.wk, evtsParJour: evtsParJour(), absences: S.abs, versions: S.versions, params: P });
  const al = R.alertes({ evtsParJour: evtsParJour(), absences: S.abs, versions: S.versions, params: P, du: S.wk, au: R.ajouterJours(S.wk, 6), aujourdhui: auj() });
  const diff = s.travail - s.attendu;
  const rows = s.jours.map((j, i) => {
    const a = j.analyse, tard = (evtsParJour()[j.jour] || []).some(e => !e.annule_le && e.source !== 'pointage');
    const alJ = al.filter(x => x.jour === j.jour && x.niveau !== 'info');
    const contenu = j.absence
      ? `<span class="rounded-full bg-violet-100 text-violet-700 px-2 py-0.5 text-xs">${esc(j.absence.type)}</span>`
      : `${plagesTxt(a.plages)}${a.etat !== 'hors' ? ' <span class="text-xs text-amber-700">(en cours ou incomplet)</span>' : ''}`;
    return `<tr class="border-t border-slate-100 ${R.jourOuvre(S.versions, j.jour) ? '' : 'text-slate-400'} cursor-pointer hover:bg-slate-50" onclick="${j.jour <= auj() ? `dlgJour('${j.jour}')` : ''}">
      <td class="py-2 pr-2 whitespace-nowrap">${R.JOURS[i]} ${+j.jour.slice(8)}</td>
      <td class="text-xs text-slate-500 pr-2">${agendaTxt(j.plan)}</td>
      <td>${contenu}${tard ? '<div class="text-xs text-slate-500">saisi après coup</div>' : ''}${alJ.map(x => `<div class="text-xs ${x.niveau === 'depassement' ? 'text-rose-700' : 'text-sky-700'}">${esc(R.LIBELLES_REGLES[x.regle])}</div>`).join('')}</td>
      <td class="text-right font-semibold whitespace-nowrap">${a.vide ? '–' : R.duree(a.travail)}</td></tr>`;
  }).join('');
  const hebdo = al.filter(x => x.jour === S.wk && ['max_semaine', 'moyenne_12s', 'repos_hebdo', 'heures_sup'].includes(x.regle));
  return `<section class="bg-white rounded-2xl border border-slate-200 p-4">
   <div class="flex items-center justify-between mb-3"><button class="btn bg-slate-100 !py-1.5" onclick="semainePrec()">‹</button>
   <div class="text-center font-semibold">Semaine du ${fd(S.wk)}<div class="text-xs font-normal text-slate-500">au ${fd(R.ajouterJours(S.wk, 6))}</div></div>
   <button class="btn bg-slate-100 !py-1.5" onclick="S.wk=R.ajouterJours(S.wk,7);render()">›</button></div>
   <div class="grid grid-cols-3 gap-2 text-center mb-3">
    <div class="rounded-xl bg-teal-50 p-2"><div class="text-xs text-slate-500">Travaillé</div><div class="font-bold text-teal-700">${R.duree(s.travail)}</div></div>
    <div class="rounded-xl bg-slate-50 p-2"><div class="text-xs text-slate-500">Attendu (${P.heures_hebdo} h)</div><div class="font-bold">${R.duree(s.attendu)}</div></div>
    <div class="rounded-xl ${diff > 0 ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700'} p-2"><div class="text-xs text-slate-500">Écart</div><div class="font-bold">${diff > 0 ? '+' : ''}${R.duree(diff)}</div></div></div>
   <table class="w-full text-sm"><tr class="text-xs text-slate-500 text-left"><th class="font-medium">Jour</th><th class="font-medium">Prévu</th><th class="font-medium">Réalisé</th><th class="font-medium text-right">Durée</th></tr>${rows}</table>
   ${s.joursAbsence ? `<p class="text-xs text-slate-500 mt-2">${s.joursAbsence} jour(s) d’absence déduit(s) des heures attendues.</p>` : ''}
   ${hebdo.map(x => `<p class="text-xs mt-2 ${x.niveau === 'depassement' ? 'text-rose-700' : 'text-sky-700'}">${esc(x.message)}</p>`).join('')}
   <p class="text-xs text-slate-400 mt-3">Touchez un jour pour voir le détail des heures${gere() ? ' et le corriger' : ' ou compléter une heure oubliée'}.</p></section>`;
}
async function semainePrec() { S.wk = R.ajouterJours(S.wk, -7); await assurer(S.wk); render(); }

// ---------------------------------------------------------------------------
// Absences
// ---------------------------------------------------------------------------
function vAbs() {
  const list = S.abs.slice().sort((a, b) => b.du.localeCompare(a.du));
  return `<section class="bg-white rounded-2xl border border-slate-200 p-4">
   <h2 class="font-semibold mb-3">Déclarer une absence${gere() ? ' pour ' + esc(nom(S.sel)) : ''}</h2>
   <div class="grid grid-cols-2 gap-3">
    <div class="col-span-2"><label>Motif</label><select id="a-t">${TYPES_ABS.map(t => `<option>${t}</option>`).join('')}</select></div>
    <div><label>Du</label><input id="a-f" type="date" value="${auj()}"></div>
    <div><label>Au</label><input id="a-u" type="date" value="${auj()}"></div>
    <div class="col-span-2"><label>Note (facultatif)</label><input id="a-n"></div></div>
   <button class="btn bg-teal-600 text-white w-full mt-3" onclick="ajouterAbs()">Ajouter</button>
   <h3 class="font-semibold mt-6 mb-2">${gere() ? 'Absences' : 'Mes absences'}</h3>${absList(list)}</section>`;
}
function absList(list) {
  if (!list.length) return '<p class="text-sm text-slate-400">Aucune absence enregistrée.</p>';
  return list.map(a => {
    let n = 0; for (let d = a.du; d <= a.au; d = R.ajouterJours(d, 1)) if (R.jourOuvre(S.versions, d)) n++;
    return `<div class="flex items-start justify-between border-t border-slate-100 py-2 text-sm ${a.annule_le ? 'barre' : ''}"><div><b>${esc(a.type)}</b>
      <div class="${a.annule_le ? '' : 'text-slate-500'}">${fd(a.du)}${a.au !== a.du ? ' au ' + fd(a.au) : ''} · ${n} j ouvré(s)${a.note ? ' · ' + esc(a.note) : ''}</div>
      <div class="text-xs ${a.annule_le ? '' : 'text-slate-400'}">Déclarée le ${fdt(a.saisi_le)} par ${esc(nom(a.saisi_par))}${a.annule_le ? ` · annulée le ${fdt(a.annule_le)} – « ${esc(a.motif_annulation)} »` : ''}</div></div>
      ${gere() && !a.annule_le ? `<button class="text-rose-700 text-xs underline px-2" onclick="annulerAbs('${a.id}')">Annuler</button>` : ''}</div>`;
  }).join('');
}
async function ajouterAbs() {
  const du = $('a-f').value, au = $('a-u').value || du;
  if (!du || au < du) return alert('Dates invalides.');
  const { error } = await sb.from('absences').insert({ salarie: S.sel, type: $('a-t').value, du, au, note: $('a-n').value.trim() });
  if (error) return erreur(error);
  await recharger();
}
async function annulerAbs(id) {
  const motif = prompt('Motif de l’annulation de cette absence (obligatoire) :');
  if (!motif || !motif.trim()) return;
  const { error } = await sb.from('absences').update({ motif_annulation: motif.trim() }).eq('id', id);
  if (error) return erreur(error);
  await recharger();
}

// ---------------------------------------------------------------------------
// Suivi mensuel et exports (responsable)
// ---------------------------------------------------------------------------
function bornesMois(m) { const du = m + '-01'; return { du, au: R.ajouterJours(R.iso(new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 1))), -1) }; }
async function choisirMois(m) { if (!m) return; S.mois = m; const b = bornesMois(m); S.du = b.du; S.au = b.au; await assurer(b.du); render(); }

function vSuivi() {
  if (!S.du) { const b = bornesMois(S.mois); S.du = b.du; S.au = b.au; }
  const { du, au } = bornesMois(S.mois), EPJ = evtsParJour(), P = params();
  let tot = 0, prevu = 0, abd = 0, rows = '';
  for (let d = du; d <= au; d = R.ajouterJours(d, 1)) {
    const a = R.analyserJour(EPJ[d] || []), abs = R.absencePour(S.abs, d), plan = R.agendaPour(S.versions, d);
    if (abs && R.jourOuvre(S.versions, d)) abd++;
    tot += a.travail; prevu += abs ? 0 : R.minutesPrevues(plan);
    if (a.vide && !abs) continue;
    rows += `<tr class="border-t border-slate-100 cursor-pointer hover:bg-slate-50" onclick="dlgJour('${d}')"><td class="py-2 whitespace-nowrap">${fd(d)}</td>
      <td>${abs ? esc(abs.type) : plagesTxt(a.plages)}</td><td class="text-xs text-slate-500">${agendaTxt(plan)}</td><td class="text-right font-semibold">${a.vide ? '–' : R.duree(a.travail)}</td></tr>`;
  }
  const al = R.alertes({ evtsParJour: EPJ, absences: S.abs, versions: S.versions, params: P, du, au, aujourdhui: auj() });
  const nbDep = al.filter(x => x.niveau === 'depassement').length;
  const wks = [];
  for (let l = R.lundi(du); l <= au; l = R.ajouterJours(l, 7)) {
    const s = R.semaine({ lundi: l, evtsParJour: EPJ, absences: S.abs, versions: S.versions, params: P });
    wks.push(`<tr class="border-t border-slate-100"><td class="py-1.5">Sem. du ${fd(l)}</td><td class="text-right font-semibold">${R.duree(s.travail)}</td><td class="text-right text-slate-500">${R.duree(s.prevu)}</td><td class="text-right text-slate-500">${R.duree(s.attendu)}</td><td class="text-right ${s.heuresSup ? 'text-rose-700' : 'text-slate-400'}">${s.heuresSup ? '+' + R.duree(s.heuresSup) : '–'}</td></tr>`);
  }
  return `<section class="bg-white rounded-2xl border border-slate-200 p-4 space-y-4">
   <div class="max-w-xs"><label>Mois</label><input type="month" value="${S.mois}" onchange="choisirMois(this.value)"></div>
   <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
     <div class="rounded-xl bg-teal-50 p-3"><div class="text-xs text-slate-500">Travaillé</div><div class="text-xl font-bold text-teal-700">${R.duree(tot)}</div></div>
     <div class="rounded-xl bg-slate-50 p-3"><div class="text-xs text-slate-500">Prévu (agenda)</div><div class="text-xl font-bold">${R.duree(prevu)}</div></div>
     <div class="rounded-xl bg-violet-50 p-3"><div class="text-xs text-slate-500">Jours d’absence</div><div class="text-xl font-bold text-violet-700">${abd}</div></div>
     <div class="rounded-xl ${nbDep ? 'bg-rose-50' : 'bg-emerald-50'} p-3 cursor-pointer" onclick="setTab('alertes')"><div class="text-xs text-slate-500">Dépassements</div><div class="text-xl font-bold ${nbDep ? 'text-rose-700' : 'text-emerald-700'}">${nbDep}</div></div></div>
   <div class="overflow-x-auto"><h3 class="font-semibold mb-1">Heures par semaine</h3><table class="w-full text-sm">
     <tr class="text-xs text-slate-500"><th></th><th class="text-right font-medium">Travaillé</th><th class="text-right font-medium">Prévu</th><th class="text-right font-medium">Contrat</th><th class="text-right font-medium">Heures sup</th></tr>${wks.join('')}</table></div>
   <div class="overflow-x-auto"><h3 class="font-semibold mb-1">Détail</h3><table class="w-full text-sm">
     <tr class="text-xs text-slate-500 text-left"><th class="font-medium">Jour</th><th class="font-medium">Réalisé</th><th class="font-medium">Prévu</th><th class="font-medium text-right">Durée</th></tr>
     ${rows || '<tr><td class="text-slate-400 py-2" colspan="4">Aucune donnée ce mois-ci.</td></tr>'}</table></div>
   <div class="border-t border-slate-200 pt-4">
     <h3 class="font-semibold mb-2">Exporter</h3>
     <div class="grid grid-cols-2 gap-3 mb-3"><div><label>Du</label><input id="x-du" type="date" value="${S.du}"></div><div><label>Au</label><input id="x-au" type="date" value="${S.au}"></div></div>
     <div class="grid grid-cols-3 gap-2">
       <button class="btn bg-teal-600 text-white" onclick="exporter('pdf')">PDF</button>
       <button class="btn bg-slate-100" onclick="exporter('csv-heures')">CSV heures</button>
       <button class="btn bg-slate-100" onclick="exporter('csv-journal')">CSV saisies</button></div>
     <p class="text-xs text-slate-400 mt-2">Le PDF contient le relevé des heures, les alertes, puis sur une page séparée le journal des saisies et des modifications.</p>
   </div></section>`;
}

// ---------------------------------------------------------------------------
// Alertes (responsable)
// ---------------------------------------------------------------------------
function vAlertes() {
  const { du, au } = bornesMois(S.mois), P = params();
  const al = R.alertes({ evtsParJour: evtsParJour(), absences: S.abs, versions: S.versions, params: P, du, au, aujourdhui: auj() });
  const groupe = (niv, titre, coul) => {
    const l = al.filter(x => x.niveau === niv);
    return `<h3 class="font-semibold mt-4 mb-1 ${coul}">${titre} (${l.length})</h3>${l.length ? l.map(x => `<div class="border-t border-slate-100 py-2 text-sm cursor-pointer hover:bg-slate-50" onclick="dlgJour('${x.jour}')">
      <div class="text-xs text-slate-500">${fd(x.jour)} · ${esc(R.LIBELLES_REGLES[x.regle])}</div>${esc(x.message)}</div>`).join('') : '<p class="text-sm text-slate-400">Aucune.</p>'}`;
  };
  return `<section class="bg-white rounded-2xl border border-slate-200 p-4">
   <div class="max-w-xs"><label>Mois</label><input type="month" value="${S.mois}" onchange="choisirMois(this.value)"></div>
   ${groupe('depassement', 'Dépassements des règles légales', 'text-rose-700')}
   ${groupe('ecart', 'Écarts avec l’agenda type', 'text-amber-700')}
   ${groupe('info', 'Pour information', 'text-sky-700')}
   <p class="text-xs text-slate-400 mt-4">Règles contrôlées : repos quotidien de ${R.duree(P.repos_quotidien_min)}, ${R.duree(P.max_jour_min)} au plus par jour, pause de ${P.pause_duree_min} min dès ${R.duree(P.pause_seuil_min)} de travail, ${R.duree(P.max_semaine_min)} au plus par semaine, ${R.duree(P.moyenne_12s_min)} en moyenne sur 12 semaines, repos hebdomadaire de ${R.duree(P.repos_hebdo_min)}. Les règles hebdomadaires portent sur les semaines terminées.</p>
  </section>`;
}

// ---------------------------------------------------------------------------
// Contrat et agenda type (responsable)
// ---------------------------------------------------------------------------
let brouillon = null;
const PLAN_DEFAUT = () => { const p = [['08:30', '12:30'], ['14:00', '17:00']]; return { 1: p, 2: p, 3: p, 4: p, 5: p, 6: [], 7: [] }; };
function vContrat() {
  const c = contratDe(S.sel);
  const actuelle = S.versions.filter(v => v.valable_du <= auj()).slice(-1)[0] || S.versions.slice(-1)[0];
  if (!brouillon) brouillon = JSON.parse(JSON.stringify(actuelle?.plages || PLAN_DEFAUT()));
  let total = 0;
  const lignes = [1, 2, 3, 4, 5, 6, 7].map(j => {
    const pl = brouillon[j] || [];
    total += R.minutesPrevues(pl);
    return `<div class="border-t border-slate-100 py-2"><div class="flex justify-between items-center"><b class="text-sm">${R.JOURS_LONGS[j - 1]}</b>
      <span class="text-xs text-slate-500">${R.duree(R.minutesPrevues(pl))}</span></div>
      ${pl.map(([a, b], i) => `<div class="flex gap-2 items-center mt-1"><input type="time" value="${a}" onchange="majPlage(${j},${i},0,this.value)"><span>à</span><input type="time" value="${b}" onchange="majPlage(${j},${i},1,this.value)"><button class="text-rose-700 px-2" onclick="suppPlage(${j},${i})" title="Retirer">✕</button></div>`).join('')}
      <button class="text-xs underline text-teal-700 mt-1" onclick="ajoutPlage(${j})">Ajouter une plage</button></div>`;
  }).join('');
  const contrat = (+c?.heures_hebdo || 35) * 60;
  return `<section class="bg-white rounded-2xl border border-slate-200 p-4">
   <h2 class="font-semibold mb-2">Contrat de ${esc(nom(S.sel))}</h2>
   <div class="grid grid-cols-2 gap-3">
     <div class="col-span-2"><label>Poste</label><input id="k-poste" value="${esc(c?.poste)}" placeholder="Ex. : assistante dentaire"></div>
     <div><label>Heures par semaine</label><input id="k-h" type="number" step="0.5" value="${esc(c?.heures_hebdo)}"></div>
     <div><label>Début du suivi</label><input id="k-du" type="date" value="${esc(c?.date_debut)}"></div>
     <div><label>Fin de contrat (si connue)</label><input id="k-fin" type="date" value="${esc(c?.date_fin)}"></div>
     <button class="btn bg-slate-100 self-end" onclick="enregistrerContrat()">Enregistrer le contrat</button></div>

   <h2 class="font-semibold mt-6">Agenda type</h2>
   <p class="text-xs text-slate-500 mb-2">Le planning prévu, jour par jour. Il sert à repérer les dépassements et les jours où une saisie est attendue. Une modification crée une nouvelle version, sans changer le passé.</p>
   ${lignes}
   <p class="mt-3 text-sm">Total hebdomadaire : <b>${R.duree(total)}</b> ${total !== contrat ? `<span class="text-amber-700">(contrat : ${R.duree(contrat)})</span>` : '<span class="text-emerald-700">(conforme au contrat)</span>'}</p>
   <div class="grid grid-cols-2 gap-3 mt-3 items-end"><div><label>Applicable à partir du</label><input id="g-du" type="date" value="${actuelle ? auj() : (c?.date_debut || auj())}"></div>
   <button class="btn bg-teal-600 text-white" onclick="enregistrerAgenda()">Enregistrer l’agenda</button></div>
   <h3 class="font-semibold mt-6 mb-1">Versions</h3>
   ${S.versions.length ? S.versions.slice().reverse().map(v => `<div class="text-sm border-t border-slate-100 py-1.5">À partir du ${fdl(v.valable_du)} · ${R.duree([1, 2, 3, 4, 5, 6, 7].reduce((s, j) => s + R.minutesPrevues(v.plages[j]), 0))} par semaine <span class="text-xs text-slate-400">(enregistrée le ${fdt(v.saisi_le)} par ${esc(nom(v.saisi_par))})</span></div>`).join('') : '<p class="text-sm text-slate-400">Aucune version enregistrée.</p>'}
  </section>`;
}
function majPlage(j, i, k, v) { brouillon[j][i][k] = v; render(); }
function suppPlage(j, i) { brouillon[j].splice(i, 1); render(); }
function ajoutPlage(j) { (brouillon[j] ||= []).push(['08:30', '12:30']); render(); }
async function enregistrerAgenda() {
  const du = $('g-du').value;
  if (!du) return alert('Indiquez la date d’application.');
  for (const j of Object.keys(brouillon)) for (const [a, b] of brouillon[j]) if (!a || !b || b <= a) return alert(`Plage invalide le ${R.JOURS_LONGS[j - 1].toLowerCase()}.`);
  const { error } = await sb.from('agenda_versions').insert({ salarie: S.sel, valable_du: du, plages: brouillon });
  if (error) return erreur(error);
  brouillon = null; await recharger(); alert('Agenda type enregistré.');
}
async function enregistrerContrat() {
  const c = contratDe(S.sel), h = Number($('k-h').value);
  if (!(h > 0 && h <= 48)) return alert('Nombre d’heures invalide.');
  if (!$('k-du').value) return alert('Indiquez la date de début du suivi.');
  const { error } = await sb.from('membres').update({ poste: $('k-poste').value.trim(), heures_hebdo: h, date_debut: $('k-du').value, date_fin: $('k-fin').value || null }).eq('id', c.id);
  if (error) return erreur(error);
  await chargerOrganisation(); render(); alert('Contrat enregistré.');
}

// ---------------------------------------------------------------------------
// Journal (responsable) et historique (salarié)
// ---------------------------------------------------------------------------
async function chargerJournal() {
  const du = $('jr-du')?.value || R.ajouterJours(auj(), -30), au = $('jr-au')?.value || auj();
  S.jrDu = du; S.jrAu = au;
  try {
    S.journal = await toutLire(() => sb.from('journal').select('*').eq('salarie', S.sel).gte('le', du).lt('le', R.ajouterJours(au, 1)).order('le', { ascending: false }));
  } catch (e) { erreur(e); }
  render();
}
function decrire(r) {
  const x = r.apres || r.avant || {};
  const emp = id => S.employeurs.find(e => e.id === id)?.nom || 'un employeur';
  switch (r.table_nom) {
    case 'evenements': {
      const base = `${R.TYPES_EVT[x.type]} ${hm(x.heure)} du ${fdl(x.jour)}`;
      return r.action === 'insert' ? `Ajout : ${base} (${R.SOURCES[x.source].toLowerCase()})${x.motif ? ' – « ' + esc(x.motif) + ' »' : ''}`
        : `Annulation : ${base} – « ${esc(x.motif_annulation)} »`;
    }
    case 'absences': {
      const base = `${esc(x.type)} du ${fdl(x.du)} au ${fdl(x.au)}`;
      return r.action === 'insert' ? `Absence déclarée : ${base}` : `Absence annulée : ${base} – « ${esc(x.motif_annulation)} »`;
    }
    case 'agenda_versions': return `Nouvel agenda type, applicable à partir du ${fdl(x.valable_du)}`;
    case 'membres': return r.action === 'insert'
      ? `Rattachement à ${esc(emp(x.employeur))} comme ${x.role === 'salarie' ? 'salarié(e)' : 'responsable'}`
      : `Contrat modifié chez ${esc(emp(x.employeur))} : ${x.heures_hebdo} h par semaine, du ${fdl(x.date_debut)}${x.date_fin ? ' au ' + fdl(x.date_fin) : ''}`;
    case 'employeurs': return `Employeur ${r.action === 'insert' ? 'créé' : 'modifié'} : ${esc(x.nom)}`;
    case 'parametres': {
      const ch = Object.keys(r.apres || {}).filter(k => k !== 'modifie_le' && JSON.stringify(r.apres[k]) !== JSON.stringify(r.avant?.[k]));
      return 'Règles modifiées : ' + ch.map(k => `${k} ${esc(r.avant?.[k])} → ${esc(r.apres[k])}`).join(', ');
    }
    case 'profils': return `Compte ${r.action === 'insert' ? 'créé' : 'modifié'} : ${esc(x.nom)}${x.actif === false ? ' (désactivé)' : ''}`;
    case 'comptes': return `${r.action === 'invitation' ? 'Invitation envoyée' : 'Rattachement'} : ${esc(x.nom)} (${esc(x.email)}), ${esc(x.employeur)}`;
    case 'purge': return `Purge des données antérieures au ${fdl(x.avant_le)}`;
  }
  return r.table_nom + ' ' + r.action;
}
function vJournalCommun(titre, aide) {
  if (S.jrDu === undefined) { setTimeout(chargerJournal); return '<p class="text-slate-500">Chargement…</p>'; }
  return `<section class="bg-white rounded-2xl border border-slate-200 p-4">
   <h2 class="font-semibold">${titre}</h2><p class="text-xs text-slate-500 mb-3">${aide}</p>
   <div class="grid grid-cols-3 gap-3 items-end mb-3"><div><label>Du</label><input id="jr-du" type="date" value="${S.jrDu}"></div><div><label>Au</label><input id="jr-au" type="date" value="${S.jrAu}"></div>
   <button class="btn bg-slate-100" onclick="chargerJournal()">Afficher</button></div>
   ${lignesJournal(S.journal)}</section>`;
}
const lignesJournal = l => l.length ? l.map(r => `<div class="border-t border-slate-100 py-2 text-sm"><div class="text-xs text-slate-500">${fdt(r.le)} · ${esc(nom(r.par))}</div>${decrire(r)}</div>`).join('') : '<p class="text-sm text-slate-400">Aucune opération sur cette période.</p>';
const vJournal = () => vJournalCommun('Journal des opérations de ' + esc(nom(S.sel)), 'Chaque ajout, annulation ou changement de contrat est enregistré ici par le serveur, avec sa date et son auteur. Ce journal ne peut être ni modifié ni effacé depuis l’application.');
const vHistorique = () => vJournalCommun('Historique de mes heures', 'Toutes les opérations sur vos heures et absences, y compris les corrections d’un responsable, avec leur date et leur motif.');

// ---------------------------------------------------------------------------
// Administration (administratrice)
// ---------------------------------------------------------------------------
const CHAMPS_REGLES = [
  ['repos_quotidien_min', 'Repos quotidien minimal (minutes)'], ['max_jour_min', 'Durée maximale par jour (minutes)'],
  ['pause_seuil_min', 'Pause due à partir de (minutes de travail)'], ['pause_duree_min', 'Durée minimale de la pause (minutes)'],
  ['max_semaine_min', 'Durée maximale par semaine (minutes)'], ['moyenne_12s_min', 'Moyenne maximale sur 12 semaines (minutes)'],
  ['repos_hebdo_min', 'Repos hebdomadaire minimal (minutes)'], ['tolerance_agenda_min', 'Tolérance avant écart avec l’agenda type (minutes)'],
  ['alerte_employeur_h', 'Alerte au responsable après (heures de retard)'], ['conservation_annees', 'Durée de conservation (années)'],
];
const optsEmp = (sel = '') => S.employeurs.filter(e => e.actif).map(e => `<option value="${e.id}" ${e.id === sel ? 'selected' : ''}>${esc(e.nom)}</option>`).join('');
function vAdmin() {
  if (S.jrAdmin === undefined) setTimeout(chargerJournalAdmin);
  const personnes = S.profils.map(p => {
    const ms = S.membres.filter(m => m.profil === p.id);
    return `<div class="border-t border-slate-100 py-2 text-sm ${p.actif ? '' : 'barre'}">
      <div class="flex justify-between gap-2"><div><b>${esc(p.nom)}</b>${p.admin ? ' <span class="text-xs rounded-full bg-teal-50 text-teal-700 px-2">administratrice</span>' : ''}<div class="text-xs text-slate-500">${esc(p.email)}</div></div>
      <div class="text-right whitespace-nowrap"><button class="text-xs underline text-teal-700" onclick="dlgRattacher('${p.id}')">Rattacher</button>
      ${p.id !== S.moi.id ? `<button class="text-xs underline ${p.actif ? 'text-rose-700' : 'text-teal-700'} ml-2" onclick="basculerActif('${p.id}')">${p.actif ? 'Désactiver' : 'Réactiver'}</button>` : ''}</div></div>
      ${ms.map(m => `<div class="text-xs text-slate-600 mt-0.5">${esc(S.employeurs.find(e => e.id === m.employeur)?.nom)} · ${m.role === 'salarie' ? `salarié(e), ${m.heures_hebdo} h${m.poste ? ', ' + esc(m.poste) : ''}` : 'responsable'}${m.date_fin ? ' · jusqu’au ' + fdl(m.date_fin) : ''}
        ${m.role === 'responsable' && actif(m) ? ` <button class="underline text-rose-700" onclick="finResponsable('${m.id}')">retirer</button>` : ''}</div>`).join('')}
    </div>`;
  }).join('');
  return `<section class="bg-white rounded-2xl border border-slate-200 p-4 space-y-6">
   <div><h2 class="font-semibold mb-2">Inviter une personne</h2>
     <p class="text-xs text-slate-500 mb-2">Elle reçoit un email pour choisir son mot de passe. Un dentiste ou un gérant de SCM est « responsable » ; il voit et corrige les heures des salariés de son employeur.</p>
     <div class="grid grid-cols-2 gap-3">
       <div><label>Nom</label><input id="i-nom"></div><div><label>Email</label><input id="i-email" type="email"></div>
       <div><label>Employeur</label><select id="i-emp">${optsEmp(S.emp)}</select></div>
       <div><label>Rôle</label><select id="i-role"><option value="salarie">Salarié(e)</option><option value="responsable">Responsable</option></select></div>
       <div><label>Poste (salarié)</label><input id="i-poste" placeholder="Ex. : assistante dentaire"></div>
       <div><label>Heures par semaine (salarié)</label><input id="i-h" type="number" step="0.5" value="35"></div>
       <div><label>Début du suivi</label><input id="i-du" type="date" value="${auj()}"></div>
       <button class="btn bg-teal-600 text-white self-end" onclick="inviter()">Inviter</button></div></div>

   <div><h2 class="font-semibold mb-1">Personnes</h2>${personnes}</div>

   <div><h2 class="font-semibold mb-1">Employeurs</h2>
     ${S.employeurs.map(e => `<div class="border-t border-slate-100 py-2 text-sm flex justify-between gap-2 ${e.actif ? '' : 'barre'}"><div><b>${esc(e.nom)}</b> · ${FORMES[e.forme]}<div class="text-xs text-slate-500">${esc(e.adresse) || 'Adresse non renseignée'} · ${salariesDe(e.id).filter(actif).length} salarié(s)</div></div>
       <button class="text-xs underline text-teal-700" onclick="dlgEmployeur('${e.id}')">Modifier</button></div>`).join('')}
     <button class="btn bg-slate-100 w-full mt-2" onclick="dlgEmployeur('')">Ajouter un employeur</button></div>

   <div><h2 class="font-semibold mb-2">Règles légales (communes à tous)</h2>
     <div class="grid sm:grid-cols-2 gap-3">${CHAMPS_REGLES.map(([k, l]) => `<div><label>${l}</label><input id="p-${k}" type="number" step="any" value="${esc(S.params[k])}"></div>`).join('')}</div>
     <button class="btn bg-teal-600 text-white w-full mt-3" onclick="enregistrerRegles()">Enregistrer les règles</button></div>

   <div><h2 class="font-semibold mb-1">Journal d’administration</h2>${S.jrAdmin === undefined ? '<p class="text-sm text-slate-400">Chargement…</p>' : lignesJournal(S.jrAdmin)}</div>
  </section>`;
}
async function chargerJournalAdmin() {
  const { data, error } = await sb.from('journal').select('*').in('table_nom', ['employeurs', 'membres', 'profils', 'parametres', 'comptes', 'purge']).order('le', { ascending: false }).limit(50);
  if (error) return erreur(error);
  S.jrAdmin = data; if (S.tab === 'admin') render();
}
async function apresAdmin(msg) { await chargerOrganisation(); S.jrAdmin = undefined; render(); if (msg) alert(msg); }
async function inviter() {
  const corps = { nom: $('i-nom').value.trim(), email: $('i-email').value.trim(), employeur: $('i-emp').value, role: $('i-role').value,
    poste: $('i-poste').value.trim(), heures_hebdo: Number($('i-h').value), date_debut: $('i-du').value };
  if (!corps.nom || !corps.email) return alert('Nom et email requis.');
  const { data, error } = await sb.functions.invoke('comptes', { body: corps });
  if (error) {
    let m = error.message;
    try { m = (await error.context.json()).erreur || m; } catch { /* réponse non JSON */ }
    return alert('Invitation impossible : ' + m);
  }
  await apresAdmin(data.invite ? `Invitation envoyée à ${corps.email}.` : `${corps.nom} avait déjà un compte : rattachement ajouté.`);
}
function dlgRattacher(id) {
  openDlg(`<h3 class="font-bold mb-3">Rattacher ${esc(nom(id))}</h3>
   <div class="grid grid-cols-2 gap-3">
     <div class="col-span-2"><label>Employeur</label><select id="r-emp">${optsEmp(S.emp)}</select></div>
     <div><label>Rôle</label><select id="r-role"><option value="responsable">Responsable</option><option value="salarie">Salarié(e)</option></select></div>
     <div><label>Heures par semaine (salarié)</label><input id="r-h" type="number" step="0.5" value="35"></div>
     <div class="col-span-2"><label>Début</label><input id="r-du" type="date" value="${auj()}"></div></div>
   <div class="flex gap-2 mt-4"><button class="btn bg-slate-100 flex-1" onclick="closeDlg()">Annuler</button><button class="btn bg-teal-600 text-white flex-1" onclick="rattacher('${id}')">Rattacher</button></div>`);
}
async function rattacher(id) {
  const { error } = await sb.from('membres').insert({ profil: id, employeur: $('r-emp').value, role: $('r-role').value, heures_hebdo: Number($('r-h').value) || 35, date_debut: $('r-du').value || auj() });
  if (error) return alert(error.code === '23505' ? 'Ce rattachement existe déjà, ou la personne est déjà salariée d’un autre employeur (renseignez d’abord sa fin de contrat).' : 'Opération impossible : ' + error.message);
  closeDlg(); await apresAdmin('Rattachement enregistré.');
}
async function finResponsable(mid) {
  if (!confirm('Retirer ce rôle de responsable à partir d’aujourd’hui ?')) return;
  const { error } = await sb.from('membres').update({ date_fin: auj() }).eq('id', mid);
  if (error) return erreur(error);
  await apresAdmin();
}
async function basculerActif(id) {
  const p = S.profils.find(x => x.id === id);
  if (!confirm(`${p.actif ? 'Désactiver' : 'Réactiver'} le compte de ${p.nom} ? ${p.actif ? 'La personne ne pourra plus se connecter à l’application ; ses données sont conservées.' : ''}`)) return;
  const { error } = await sb.from('profils').update({ actif: !p.actif }).eq('id', id);
  if (error) return erreur(error);
  await apresAdmin();
}
function dlgEmployeur(id) {
  const e = S.employeurs.find(x => x.id === id) || { nom: '', forme: 'cabinet', adresse: '', actif: true };
  openDlg(`<h3 class="font-bold mb-3">${id ? 'Modifier l’employeur' : 'Nouvel employeur'}</h3>
   <div class="space-y-3"><div><label>Nom</label><input id="e-nom" value="${esc(e.nom)}" placeholder="Ex. : Cabinet du Dr …"></div>
   <div><label>Forme</label><select id="e-forme">${Object.entries(FORMES).map(([k, l]) => `<option value="${k}" ${k === e.forme ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
   <div><label>Adresse</label><input id="e-adr" value="${esc(e.adresse)}"></div>
   ${id ? `<label class="flex items-center gap-2"><input id="e-actif" type="checkbox" class="!w-auto" ${e.actif ? 'checked' : ''}> Actif</label>` : ''}</div>
   <div class="flex gap-2 mt-4"><button class="btn bg-slate-100 flex-1" onclick="closeDlg()">Annuler</button><button class="btn bg-teal-600 text-white flex-1" onclick="enregistrerEmployeur('${id}')">Enregistrer</button></div>`);
}
async function enregistrerEmployeur(id) {
  const v = { nom: $('e-nom').value.trim(), forme: $('e-forme').value, adresse: $('e-adr').value.trim() };
  if (!v.nom) return alert('Le nom est obligatoire.');
  if (id) v.actif = $('e-actif').checked;
  const { error } = id ? await sb.from('employeurs').update(v).eq('id', id) : await sb.from('employeurs').insert(v);
  if (error) return erreur(error);
  closeDlg(); await apresAdmin('Employeur enregistré.');
}
async function enregistrerRegles() {
  const maj = {};
  for (const [k] of CHAMPS_REGLES) { const v = Number($('p-' + k).value); if (!(v > 0)) return alert('Valeur invalide : ' + k); maj[k] = v; }
  const { error } = await sb.from('parametres').update(maj).eq('id', 1);
  if (error) return erreur(error);
  await apresAdmin('Règles enregistrées.');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
const REGLES_HEBDO = ['max_semaine', 'moyenne_12s', 'repos_hebdo', 'heures_sup'];
function lignesHeures(du, au) {
  const EPJ = evtsParJour(), P = params();
  const al = R.alertes({ evtsParJour: EPJ, absences: S.abs, versions: S.versions, params: P, du, au, aujourdhui: auj() });
  const out = [];
  for (let d = du; d <= au; d = R.ajouterJours(d, 1)) {
    const a = R.analyserJour(EPJ[d] || []), abs = R.absencePour(S.abs, d), plan = R.agendaPour(S.versions, d);
    if (a.vide && !abs && !R.jourOuvre(S.versions, d)) continue;
    out.push({
      date: fdl(d), jour: R.JOURS_LONGS[R.jourSemaine(d) - 1], prevu: agendaTxt(plan), realise: plagesTxt(a.plages),
      pauses: plagesTxt(a.pauses), travail: a.vide ? '' : a.complet ? R.duree(a.travail) : 'incomplet', heures: a.vide ? '' : (a.travail / 60).toFixed(2).replace('.', ','),
      absence: abs ? abs.type : '', alertes: al.filter(x => x.jour === d && !REGLES_HEBDO.includes(x.regle)).map(x => R.LIBELLES_REGLES[x.regle]).join(', '),
    });
  }
  return { out, al };
}
function lignesSaisies(du, au) {
  const ev = S.evts.filter(e => e.jour >= du && e.jour <= au).sort((a, b) => a.jour.localeCompare(b.jour) || a.heure.localeCompare(b.heure) || a.saisi_le.localeCompare(b.saisi_le));
  const lignes = ev.map(e => ({
    jour: fdl(e.jour), quoi: R.TYPES_EVT[e.type], heure: hm(e.heure), origine: R.SOURCES[e.source], motif: e.motif || '',
    saisi: fdt(e.saisi_le), par: nom(e.saisi_par), annule: fdt(e.annule_le), annulePar: e.annule_par ? nom(e.annule_par) : '', motifAnnul: e.motif_annulation || '',
  }));
  for (const a of S.abs.filter(a => a.au >= du && a.du <= au)) lignes.push({
    jour: fdl(a.du) + (a.au !== a.du ? ' au ' + fdl(a.au) : ''), quoi: 'Absence : ' + a.type, heure: '', origine: 'Déclaration', motif: a.note || '',
    saisi: fdt(a.saisi_le), par: nom(a.saisi_par), annule: fdt(a.annule_le), annulePar: a.annule_par ? nom(a.annule_par) : '', motifAnnul: a.motif_annulation || '',
  });
  return lignes;
}
function telecharger(nomFichier, contenu, type) {
  const url = URL.createObjectURL(new Blob([contenu], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: nomFichier });
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const csv = (entetes, lignes) => '﻿' + [entetes, ...lignes].map(l => l.map(v => {
  const s = String(v ?? ''); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}).join(';')).join('\r\n');
function charger(src) {
  return new Promise((ok, ko) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => ko(new Error('chargement de ' + src)); document.head.appendChild(s); });
}

async function exporter(format) {
  const du = $('x-du').value, au = $('x-au').value;
  if (!du || !au || au < du) return alert('Période invalide.');
  await assurer(du);
  const n = nom(S.sel), base = `pointage-${n.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-')}-${du}-${au}`;
  if (format === 'csv-heures') {
    const { out } = lignesHeures(du, au);
    return telecharger(base + '-heures.csv', csv(['Date', 'Jour', 'Prévu (agenda type)', 'Plages réalisées', 'Pauses', 'Travaillé', 'Heures (décimal)', 'Absence', 'Alertes'],
      out.map(r => [r.date, r.jour, r.prevu, r.realise, r.pauses, r.travail, r.heures, r.absence, r.alertes])), 'text/csv;charset=utf-8');
  }
  if (format === 'csv-journal') {
    return telecharger(base + '-saisies.csv', csv(['Jour concerné', 'Élément', 'Heure', 'Origine', 'Motif / note', 'Saisi le', 'Saisi par', 'Annulé le', 'Annulé par', 'Motif d’annulation'],
      lignesSaisies(du, au).map(r => [r.jour, r.quoi, r.heure, r.origine, r.motif, r.saisi, r.par, r.annule, r.annulePar, r.motifAnnul])), 'text/csv;charset=utf-8');
  }
  try {
    if (!window.jspdf) { await charger(JSPDF); await charger(AUTOTABLE); }
  } catch (e) { return erreur(e); }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const teal = [15, 118, 110], P = params(), emp = employeurDe(S.sel), c = contratDe(S.sel);
  doc.setFontSize(15); doc.setTextColor(...teal); doc.text(`Relevé des heures de travail – ${n}`, 14, 16);
  doc.setFontSize(9); doc.setTextColor(60);
  doc.text(`Employeur : ${emp?.nom || ''}${emp?.adresse ? ' – ' + emp.adresse : ''}`, 14, 22);
  doc.text(`${c?.poste ? c.poste + ' · ' : ''}Période du ${fdl(du)} au ${fdl(au)} · Durée contractuelle : ${P.heures_hebdo} h par semaine · Édité le ${fdt(new Date())} par ${S.moi.nom}`, 14, 27);
  const { out, al } = lignesHeures(du, au);
  doc.autoTable({
    startY: 32, head: [['Date', 'Jour', 'Prévu', 'Réalisé', 'Pauses', 'Travaillé', 'Absence', 'Alertes']],
    body: out.map(r => [r.date, r.jour, r.prevu, r.realise, r.pauses, r.travail, r.absence, r.alertes]),
    styles: { fontSize: 7.5, cellPadding: 1.4 }, headStyles: { fillColor: teal }, columnStyles: { 7: { textColor: [159, 18, 57] } },
  });
  const sems = [];
  for (let l = R.lundi(du); l <= au; l = R.ajouterJours(l, 7)) {
    const s = R.semaine({ lundi: l, evtsParJour: evtsParJour(), absences: S.abs, versions: S.versions, params: P });
    sems.push([`Du ${fdl(l)} au ${fdl(R.ajouterJours(l, 6))}`, R.duree(s.travail), R.duree(s.prevu), R.duree(s.attendu), s.heuresSup ? R.duree(s.heuresSup) : '', String(s.joursAbsence || '')]);
  }
  doc.autoTable({ startY: doc.lastAutoTable.finalY + 6, head: [['Semaine', 'Travaillé', 'Prévu (agenda)', 'Attendu (contrat)', 'Heures sup', 'Jours d’absence']], body: sems, styles: { fontSize: 8 }, headStyles: { fillColor: teal } });
  doc.autoTable({
    startY: doc.lastAutoTable.finalY + 6, head: [['Alertes de la période', '']],
    body: al.length ? al.map(x => [fdl(x.jour) + ' · ' + R.LIBELLES_REGLES[x.regle], x.message]) : [['Aucune alerte', 'Les règles contrôlées ont été respectées sur la période.']],
    styles: { fontSize: 8 }, headStyles: { fillColor: teal }, columnStyles: { 0: { cellWidth: 70 } },
  });
  let y = doc.lastAutoTable.finalY + 12;
  if (y > 180) { doc.addPage(); y = 20; }
  doc.setFontSize(9); doc.setTextColor(60);
  doc.text('Visa du salarié :', 14, y); doc.text('Visa de l’employeur :', 150, y);

  doc.addPage();
  doc.setFontSize(13); doc.setTextColor(...teal); doc.text('Journal des saisies et des modifications', 14, 16);
  doc.setFontSize(8.5); doc.setTextColor(60);
  doc.text('Heure de saisie et auteur enregistrés par le serveur. Une heure n’est jamais effacée : une correction l’annule avec un motif et en ajoute une nouvelle.', 14, 22);
  doc.autoTable({
    startY: 27, head: [['Jour', 'Élément', 'Heure', 'Origine', 'Motif / note', 'Saisi le', 'Par', 'Annulé le', 'Par', 'Motif d’annulation']],
    body: lignesSaisies(du, au).map(r => [r.jour, r.quoi, r.heure, r.origine, r.motif, r.saisi, r.par, r.annule, r.annulePar, r.motifAnnul]),
    styles: { fontSize: 7, cellPadding: 1.2 }, headStyles: { fillColor: teal },
  });
  const nb = doc.getNumberOfPages();
  for (let i = 1; i <= nb; i++) { doc.setPage(i); doc.setFontSize(7); doc.setTextColor(120); doc.text(`${emp?.nom || ''} – ${n} – du ${fdl(du)} au ${fdl(au)} – page ${i} / ${nb}`, 14, 203); }
  doc.save(base + '.pdf');
}

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
Object.assign(window, {
  S, R, seConnecter, mdpOublie, enregistrerMdp, seDeconnecter, setTab, choisirEmployeur, choisirSalarie, render, closeDlg,
  pointer, dlgJour, ajouterEvt, annulerEvt, semainePrec, ajouterAbs, annulerAbs, choisirMois,
  majPlage, suppPlage, ajoutPlage, enregistrerAgenda, enregistrerContrat, chargerJournal, exporter,
  inviter, dlgRattacher, rattacher, finResponsable, basculerActif, dlgEmployeur, enregistrerEmployeur, enregistrerRegles,
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.moi && S.sel) recharger(); });
sb.auth.onAuthStateChange((evt, session) => {
  if (evt === 'PASSWORD_RECOVERY') vNouveauMdp();
  if (evt === 'SIGNED_IN' && !S.moi) demarrer(session);
  if (evt === 'SIGNED_OUT') { S.moi = null; demarrage = null; vConnexion(); }
});
sb.auth.getSession().then(({ data }) => { if (!S.moi) demarrer(data.session); });
