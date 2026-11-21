// Création des comptes depuis l'application, réservée à l'administrateur.
// Invite la personne par email (elle choisit son mot de passe), crée son profil et son rattachement.
// L'identité de l'appelant est vérifiée ici même (getUser + profil administrateur).
//
// Corps attendu : { email, nom, employeur, role: 'responsable' | 'salarie', poste?, heures_hebdo?, date_debut?, admin? }

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const env = (k: string) => Deno.env.get(k) ?? '';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const reponse = (corps: unknown, status = 200) => Response.json(corps, { status, headers: cors });

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

  // 1. Qui appelle ? Seul un administrateur actif peut créer des comptes.
  const jeton = (req.headers.get('Authorization') ?? '').replace(/^Bearer /, '');
  const { data: appelant } = await sb.auth.getUser(jeton);
  if (!appelant?.user) return reponse({ erreur: 'Connexion requise.' }, 401);
  const { data: admin } = await sb.from('profils').select('id, nom, admin, actif').eq('id', appelant.user.id).maybeSingle();
  if (!admin?.admin || !admin.actif) return reponse({ erreur: 'Réservé à l’administrateur.' }, 403);

  // 2. Contrôle de la demande
  const d = await req.json().catch(() => ({}));
  const email = String(d.email ?? '').trim().toLowerCase(), nom = String(d.nom ?? '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !nom) return reponse({ erreur: 'Nom et email valides requis.' }, 400);
  if (!['responsable', 'salarie'].includes(d.role)) return reponse({ erreur: 'Rôle invalide.' }, 400);
  const { data: employeur } = await sb.from('employeurs').select('id, nom').eq('id', d.employeur).maybeSingle();
  if (!employeur) return reponse({ erreur: 'Employeur inconnu.' }, 400);

  // 3. Compte d'authentification : on invite, ou on retrouve la personne si elle existe déjà
  let id: string | undefined;
  const { data: existant } = await sb.from('profils').select('id').eq('email', email).maybeSingle();
  if (existant) id = existant.id;
  else {
    const { data: conf } = await sb.from('parametres').select('app_url').eq('id', 1).maybeSingle();
    const { data: inv, error } = await sb.auth.admin.inviteUserByEmail(email, { redirectTo: conf?.app_url || undefined });
    if (error) return reponse({ erreur: 'Invitation impossible : ' + error.message }, 400);
    id = inv.user.id;
    const { error: e2 } = await sb.from('profils').insert({ id, nom, email, admin: !!d.admin });
    if (e2) return reponse({ erreur: e2.message }, 400);
  }

  // 4. Rattachement à l'employeur
  const { error: e3 } = await sb.from('membres').insert({
    profil: id, employeur: employeur.id, role: d.role, poste: String(d.poste ?? ''),
    heures_hebdo: Number(d.heures_hebdo) || 35, date_debut: d.date_debut || new Date().toISOString().slice(0, 10),
  });
  if (e3) return reponse({ erreur: e3.code === '23505' ? 'Cette personne a déjà ce rôle, ou est déjà salariée d’un autre employeur.' : e3.message }, 400);

  // Les écritures ci-dessus passent par le service : on trace qui les a demandées.
  await sb.from('journal').insert({
    par: admin.id, table_nom: 'comptes', action: existant ? 'rattachement' : 'invitation', salarie: id,
    apres: { email, nom, employeur: employeur.nom, role: d.role },
  });
  return reponse({ ok: true, id, invite: !existant });
});
