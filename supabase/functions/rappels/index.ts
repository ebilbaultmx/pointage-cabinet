// Rappels et alertes par email. Appelée chaque heure par pg_cron ; n'agit qu'à 7 h (heure de Paris).
//
// - Salariée : chaque matin de jour ouvré, si des jours passés n'ont pas de saisie complète.
//   Aucun email le week-end ni pendant une absence (droit à la déconnexion).
// - Employeur : dès qu'un jour manquant atteint le délai réglé (48 h après la fin de la journée),
//   plus les dépassements de règles et les écarts avec l'agenda type, chacun signalé une seule fois.
//   L'employeur, ce sont les responsables rattachés à l'employeur du salarié (dentiste, gérants de SCM).
//
// Seul secret à renseigner (Supabase > Edge Functions > Secrets) : EMAIL_API_KEY (clé API Brevo).
// EMAIL_PROVIDER=resend permet de passer à Resend. L'expéditeur et l'adresse de la page sont lus
// dans la table « parametres » ; le secret de la tâche planifiée, dans le coffre (secret_cron()).
// SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont fournies automatiquement.

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import * as R from '../_shared/regles.js';

const env = (k: string, d = '') => Deno.env.get(k) ?? d;
const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
let CONF = { email_expediteur: '', email_nom: 'Pointage du cabinet', app_url: '' };

async function envoyer(a: string, sujet: string, texte: string) {
  const fournisseur = env('EMAIL_PROVIDER', 'brevo');
  const de = CONF.email_expediteur, nom = CONF.email_nom || 'Pointage du cabinet', APP_URL = CONF.app_url;
  const html = '<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1e293b">'
    + texte.split('\n').map(l => l ? `<p style="margin:0 0 8px">${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>` : '').join('')
    + (APP_URL ? `<p><a href="${APP_URL}" style="color:#0f766e">Ouvrir le pointage</a></p>` : '') + '</div>';
  const r = fournisseur === 'resend'
    ? await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${env('EMAIL_API_KEY')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: `${nom} <${de}>`, to: [a], subject: sujet, text: texte, html }),
      })
    : await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', headers: { 'api-key': env('EMAIL_API_KEY'), 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: { email: de, name: nom }, to: [{ email: a }], subject: sujet, textContent: texte, htmlContent: html }),
      });
  if (!r.ok) throw new Error(`Envoi à ${a} refusé (${r.status}) : ${await r.text()}`);
}

/** Enregistre l'envoi ; renvoie false s'il avait déjà eu lieu. */
async function marquer(type: string, salarie: string, cle: string, destinataire: string) {
  const { error } = await sb.from('envois').insert({ type, salarie, cle, destinataire });
  if (!error) return true;
  if (error.code === '23505') return false;
  throw error;
}
async function dejaEnvoye(type: string, salarie: string, cle: string, destinataire: string) {
  const { data } = await sb.from('envois').select('id').match({ type, salarie, cle, destinataire }).limit(1);
  return !!data?.length;
}

const fd = (s: string) => new Date(s + 'T12:00:00Z').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

Deno.serve(async req => {
  const { data: secret } = await sb.rpc('secret_cron');
  if (!secret || req.headers.get('x-cron-secret') !== secret)
    return new Response('Accès refusé', { status: 401 });
  const corps = await req.json().catch(() => ({}));
  const n = R.maintenantParis();
  if (!corps.force && Math.floor(n.minutes / 60) !== 7) return Response.json({ ignore: 'hors créneau', heure: n.heure });
  if (corps.purge || (n.jour.endsWith('-01-01'))) await sb.rpc('purger_donnees_anciennes');

  const aujourdhui = n.jour, rapport: string[] = [];
  const [{ data: regles }, { data: profils }, { data: membres }, { data: employeurs }] = await Promise.all([
    sb.from('parametres').select('*').eq('id', 1).single(),
    sb.from('profils').select('*').eq('actif', true),
    sb.from('membres').select('*'),
    sb.from('employeurs').select('*').eq('actif', true),
  ]);
  CONF = regles;
  if (!CONF.email_expediteur || !env('EMAIL_API_KEY')) return Response.json({ erreur: 'Envoi des emails non configuré (expéditeur ou clé API manquants).' }, { status: 500 });
  const actif = (m: any) => !m.date_fin || m.date_fin >= aujourdhui;
  const profil = (id: string) => (profils ?? []).find(p => p.id === id);
  const admins = (profils ?? []).filter(p => p.admin);
  const depuis = R.ajouterJours(aujourdhui, -100);

  for (const c of (membres ?? []).filter(m => m.role === 'salarie' && actif(m))) {
    const s = profil(c.profil), emp = (employeurs ?? []).find(e => e.id === c.employeur);
    if (!s || !emp) continue;
    // Destinataires des alertes : les responsables de l'employeur, à défaut l'administrateur
    let responsables = (membres ?? []).filter(m => m.employeur === c.employeur && m.role === 'responsable' && actif(m))
      .map(m => profil(m.profil)).filter(Boolean);
    if (!responsables.length) responsables = admins;
    const params = { ...regles, heures_hebdo: +c.heures_hebdo, date_debut: c.date_debut };
    const [{ data: evts }, { data: absences }, { data: versions }] = await Promise.all([
      sb.from('evenements').select('*').eq('salarie', s.id).gte('jour', depuis),
      sb.from('absences').select('*').eq('salarie', s.id).gte('au', depuis),
      sb.from('agenda_versions').select('*').eq('salarie', s.id),
    ]);
    const EPJ = R.parJour(evts ?? []), abs = absences ?? [], ver = versions ?? [];
    const manquants = R.joursManquants({ evtsParJour: EPJ, absences: abs, versions: ver, debut: c.date_debut, aujourdhui });
    const libelle = (m: { jour: string; motif: string }) => `- ${fd(m.jour)}${m.motif === 'incomplet' ? ' (journée incomplète)' : ''}`;

    // 1. Rappel à la salariée, les matins de jour ouvré où elle n'est pas absente
    if (manquants.length && R.jourOuvre(ver, aujourdhui) && !R.absencePour(abs, aujourdhui)
        && await marquer('rappel_salarie', s.id, aujourdhui, s.email)) {
      await envoyer(s.email, 'Rappel : horaires à compléter',
        `Bonjour ${s.nom.split(' ')[0]},\n\nVos horaires ne sont pas complets pour :\n${manquants.map(libelle).join('\n')}\n\nMerci de les compléter dans l'application de pointage.`);
      rapport.push(`rappel ${s.email} (${manquants.length} j)`);
    }

    // 2. Retards signalés à l'employeur
    const seuil = regles.alerte_employeur_h * 60;
    const enRetard = manquants.filter(m => (R.ecartJours(m.jour, aujourdhui) - 1) * 1440 + n.minutes >= seuil);
    // 3. Dépassements et écarts sur les 14 derniers jours (semaines terminées incluses)
    const al = R.alertes({ evtsParJour: EPJ, absences: abs, versions: ver, params, du: R.ajouterJours(aujourdhui, -14), au: R.ajouterJours(aujourdhui, -1), aujourdhui })
      .filter(a => a.niveau !== 'info' || a.regle === 'heures_sup');

    for (const e of responsables) {
      const retards: any[] = [], points: any[] = [];
      for (const m of enRetard) if (!await dejaEnvoye('alerte_retard', s.id, m.jour, e.email)) retards.push(m);
      for (const a of al) if (!await dejaEnvoye('alerte_regle', s.id, a.cle, e.email)) points.push(a);
      if (!retards.length && !points.length) continue;
      let texte = `Bonjour,\n\nPoint de suivi du temps de travail de ${s.nom} (${emp.nom}).\n`;
      if (retards.length) texte += `\nHoraires non complétés depuis plus de ${regles.alerte_employeur_h} h :\n${retards.map(libelle).join('\n')}\n`;
      if (points.length) texte += `\nPoints à vérifier :\n${points.map(a => `- ${fd(a.jour)} – ${R.LIBELLES_REGLES[a.regle]} : ${a.message}`).join('\n')}\n`;
      await envoyer(e.email, `Pointage de ${s.nom} : ${[retards.length && 'horaires manquants', points.length && 'points à vérifier'].filter(Boolean).join(' et ')}`, texte);
      for (const m of retards) await marquer('alerte_retard', s.id, m.jour, e.email);
      for (const a of points) await marquer('alerte_regle', s.id, a.cle, e.email);
      rapport.push(`alerte ${e.email} (${retards.length} retard(s), ${points.length} point(s))`);
    }
  }
  return Response.json({ ok: true, heure: n.heure, envois: rapport });
});
