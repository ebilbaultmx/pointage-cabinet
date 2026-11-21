-- Pointage du cabinet : schéma de données
-- À exécuter une fois dans Supabase > SQL Editor.
--
-- Organisation : plusieurs employeurs (cabinets de dentistes en nom propre, SCM…).
-- Chaque salarié est rattaché à un employeur ; chaque employeur a un ou plusieurs responsables
-- (le dentiste, les gérants de la SCM). Un administrateur gère l'ensemble.
--
-- Principe : rien ne s'efface et rien ne s'écrase.
--   - Une heure pointée ou saisie est une ligne de « evenements », jamais modifiée.
--   - Une correction annule la ligne fautive (avec motif) et en ajoute une nouvelle.
--   - L'heure de saisie et son auteur sont fixés par le serveur, pas par l'appareil.
--   - Toute écriture est recopiée dans « journal », que personne ne peut modifier.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Personnes, employeurs, rattachements
-- ---------------------------------------------------------------------------
create table public.profils (
  id        uuid primary key references auth.users on delete restrict,
  nom       text not null,
  email     text not null,
  admin     boolean not null default false,
  actif     boolean not null default true,
  cree_le   timestamptz not null default now()
);

create table public.employeurs (
  id        uuid primary key default gen_random_uuid(),
  nom       text not null,
  forme     text not null default 'cabinet' check (forme in ('cabinet', 'scm', 'autre')),
  adresse   text not null default '',
  actif     boolean not null default true,
  cree_le   timestamptz not null default now()
);

-- Rôle d'une personne chez un employeur : responsable (employeur, gérant) ou salarié
create table public.membres (
  id            uuid primary key default gen_random_uuid(),
  profil        uuid not null references public.profils,
  employeur     uuid not null references public.employeurs,
  role          text not null check (role in ('responsable', 'salarie')),
  poste         text not null default '',
  heures_hebdo  numeric(4,1) not null default 35,
  date_debut    date not null default current_date,
  date_fin      date,
  cree_le       timestamptz not null default now(),
  unique (profil, employeur, role)
);
-- Un salarié n'a qu'un employeur actif à la fois
create unique index un_employeur_par_salarie on public.membres (profil) where role = 'salarie' and date_fin is null;

-- ---------------------------------------------------------------------------
-- Fonctions d'aide, utilisées par les droits d'accès
-- ---------------------------------------------------------------------------
create or replace function public.est_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profils where id = auth.uid() and admin and actif)
$$;

-- L'utilisateur connecté peut-il gérer les heures de ce salarié ?
create or replace function public.peut_gerer(s uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select s is distinct from auth.uid() and (
    est_admin() or exists (
      select 1 from membres ms join membres mr on mr.employeur = ms.employeur
      where ms.profil = s and ms.role = 'salarie'
        and mr.profil = auth.uid() and mr.role = 'responsable' and mr.date_fin is null
        and exists (select 1 from profils p where p.id = auth.uid() and p.actif)))
$$;

-- Les deux personnes ont-elles un employeur en commun ? (pour afficher les noms)
create or replace function public.meme_employeur(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from membres a join membres b on a.employeur = b.employeur
                 where a.profil = auth.uid() and b.profil = p)
$$;

create or replace function public.responsable_de(e uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select est_admin() or exists (select 1 from membres where profil = auth.uid() and employeur = e
                                and role = 'responsable' and date_fin is null)
$$;

create or replace function public.maintenant_paris() returns timestamp
language sql stable as $$ select (now() at time zone 'Europe/Paris') $$;

-- ---------------------------------------------------------------------------
-- Règles légales (une seule ligne, communes à tous les employeurs)
-- ---------------------------------------------------------------------------
create table public.parametres (
  id                     int primary key default 1 check (id = 1),
  repos_quotidien_min    int not null default 660,   -- 11 h
  max_jour_min           int not null default 600,   -- 10 h
  max_semaine_min        int not null default 2880,  -- 48 h
  moyenne_12s_min        int not null default 2640,  -- 44 h en moyenne sur 12 semaines
  pause_seuil_min        int not null default 360,   -- pause due dès 6 h de travail
  pause_duree_min        int not null default 20,
  repos_hebdo_min        int not null default 2100,  -- 35 h (24 h + 11 h)
  tolerance_agenda_min   int not null default 15,
  alerte_employeur_h     int not null default 48,
  conservation_annees    int not null default 7,
  -- Envoi des emails (valeurs non secrètes ; la clé API reste dans les secrets des fonctions)
  email_expediteur       text not null default '',
  email_nom              text not null default 'Pointage du cabinet',
  app_url                text not null default '',
  modifie_le             timestamptz not null default now()
);
insert into public.parametres default values;

-- ---------------------------------------------------------------------------
-- Agenda type (planning prévu), versionné : on ajoute une version, on n'écrase pas
-- plages = {"1": [["08:30","12:30"],["14:00","17:00"]], ..., "7": []}  (1 = lundi)
-- ---------------------------------------------------------------------------
create table public.agenda_versions (
  id          uuid primary key default gen_random_uuid(),
  salarie     uuid not null references public.profils,
  valable_du  date not null,
  plages      jsonb not null,
  saisi_le    timestamptz not null default now(),
  saisi_par   uuid references public.profils
);
create index on public.agenda_versions (salarie, valable_du);

-- ---------------------------------------------------------------------------
-- Événements de pointage
-- ---------------------------------------------------------------------------
create table public.evenements (
  id                uuid primary key default gen_random_uuid(),
  salarie           uuid not null references public.profils,
  jour              date not null,
  type              text not null check (type in ('arrivee', 'pause', 'reprise', 'depart')),
  heure             time(0) not null,
  source            text not null check (source in ('pointage', 'saisie', 'correction')),
  motif             text,
  saisi_le          timestamptz not null default now(),
  saisi_par         uuid references public.profils,
  annule_le         timestamptz,
  annule_par        uuid references public.profils,
  motif_annulation  text
);
create index on public.evenements (salarie, jour);

-- ---------------------------------------------------------------------------
-- Absences
-- ---------------------------------------------------------------------------
create table public.absences (
  id                uuid primary key default gen_random_uuid(),
  salarie           uuid not null references public.profils,
  type              text not null,
  du                date not null,
  au                date not null check (au >= du),
  note              text not null default '',
  saisi_le          timestamptz not null default now(),
  saisi_par         uuid references public.profils,
  annule_le         timestamptz,
  annule_par        uuid references public.profils,
  motif_annulation  text
);
create index on public.absences (salarie, du, au);

-- ---------------------------------------------------------------------------
-- Journal d'audit : alimenté uniquement par déclencheur
-- ---------------------------------------------------------------------------
create table public.journal (
  id         bigint generated always as identity primary key,
  le         timestamptz not null default now(),
  par        uuid,
  table_nom  text not null,
  action     text not null,
  ligne_id   text,
  salarie    uuid,
  avant      jsonb,
  apres      jsonb
);
create index on public.journal (salarie, le);

-- Emails déjà envoyés (évite les doublons)
create table public.envois (
  id            bigint generated always as identity primary key,
  type          text not null,          -- rappel_salarie | alerte_retard | alerte_regle
  salarie       uuid not null references public.profils,
  cle           text not null,
  destinataire  text not null,
  envoye_le     timestamptz not null default now(),
  unique (type, salarie, cle, destinataire)
);

-- ---------------------------------------------------------------------------
-- Déclencheurs : contrôle des écritures
-- ---------------------------------------------------------------------------
create or replace function public.controle_evenement() returns trigger
language plpgsql security definer set search_path = public as $$
declare p timestamp := maintenant_paris();
begin
  if tg_op = 'INSERT' then
    new.saisi_le := now();
    new.saisi_par := auth.uid();
    new.annule_le := null; new.annule_par := null; new.motif_annulation := null;

    if new.salarie = auth.uid() then
      -- Le salarié sur ses propres heures : pointage ou saisie après coup
      if new.source = 'pointage' then
        -- L'heure d'un pointage est celle du serveur, pas celle du téléphone
        new.jour := p::date;
        new.heure := date_trunc('minute', p)::time;
      elsif new.source = 'saisie' then
        if new.jour > p::date or (new.jour = p::date and new.heure > p::time) then
          raise exception 'Impossible de saisir une heure future.';
        end if;
      else
        raise exception 'Seul un responsable peut corriger des heures.';
      end if;
    elsif peut_gerer(new.salarie) then
      if new.source <> 'correction' or coalesce(trim(new.motif), '') = '' then
        raise exception 'Une correction doit indiquer un motif.';
      end if;
    else
      raise exception 'Vous ne pouvez pas saisir les heures de cette personne.';
    end if;
    return new;
  end if;

  -- UPDATE : seule l'annulation est permise, une seule fois, par un responsable
  if not peut_gerer(old.salarie) then
    raise exception 'Seul un responsable peut annuler une heure.';
  end if;
  if old.annule_le is not null then
    raise exception 'Cette heure est déjà annulée.';
  end if;
  if coalesce(trim(new.motif_annulation), '') = '' then
    raise exception 'Une annulation doit indiquer un motif.';
  end if;
  if (new.salarie, new.jour, new.type, new.heure, new.source, new.motif, new.saisi_le, new.saisi_par)
     is distinct from
     (old.salarie, old.jour, old.type, old.heure, old.source, old.motif, old.saisi_le, old.saisi_par) then
    raise exception 'Une heure enregistrée ne peut pas être modifiée, seulement annulée.';
  end if;
  new.annule_le := now();
  new.annule_par := auth.uid();
  return new;
end $$;

create trigger controle_evenement before insert or update on public.evenements
  for each row execute function public.controle_evenement();

create or replace function public.controle_absence() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.saisi_le := now();
    new.saisi_par := auth.uid();
    new.annule_le := null; new.annule_par := null; new.motif_annulation := null;
    if new.salarie is distinct from auth.uid() and not peut_gerer(new.salarie) then
      raise exception 'Vous ne pouvez pas déclarer d''absence pour cette personne.';
    end if;
    return new;
  end if;
  if not peut_gerer(old.salarie) then raise exception 'Seul un responsable peut annuler une absence.'; end if;
  if old.annule_le is not null then raise exception 'Cette absence est déjà annulée.'; end if;
  if coalesce(trim(new.motif_annulation), '') = '' then
    raise exception 'Une annulation doit indiquer un motif.';
  end if;
  if (new.salarie, new.type, new.du, new.au, new.note, new.saisi_le, new.saisi_par)
     is distinct from (old.salarie, old.type, old.du, old.au, old.note, old.saisi_le, old.saisi_par) then
    raise exception 'Une absence enregistrée ne peut pas être modifiée, seulement annulée.';
  end if;
  new.annule_le := now();
  new.annule_par := auth.uid();
  return new;
end $$;

create trigger controle_absence before insert or update on public.absences
  for each row execute function public.controle_absence();

create or replace function public.controle_agenda() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.saisi_le := now();
  new.saisi_par := auth.uid();
  return new;
end $$;
create trigger controle_agenda before insert on public.agenda_versions
  for each row execute function public.controle_agenda();

create or replace function public.controle_parametres() returns trigger
language plpgsql as $$
begin new.id := 1; new.modifie_le := now(); return new; end $$;
create trigger controle_parametres before update on public.parametres
  for each row execute function public.controle_parametres();

-- Un responsable ne peut modifier que le contrat (heures, dates, poste) d'un salarié ;
-- le rattachement lui-même relève de l'administrateur.
create or replace function public.controle_membre() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not est_admin() and (new.profil, new.employeur, new.role) is distinct from (old.profil, old.employeur, old.role) then
    raise exception 'Seul l''administrateur peut changer un rattachement.';
  end if;
  return new;
end $$;
create trigger controle_membre before update on public.membres
  for each row execute function public.controle_membre();

-- Journal : recopie de chaque écriture
create or replace function public.journaliser() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  a jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  b jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  r jsonb := coalesce(b, a);
begin
  insert into journal (par, table_nom, action, ligne_id, salarie, avant, apres)
  values (auth.uid(), tg_table_name, lower(tg_op), r ->> 'id',
          coalesce(r ->> 'salarie', r ->> 'profil', case when tg_table_name = 'profils' then r ->> 'id' end)::uuid,
          a, b);
  return null;
end $$;

create trigger journal_evenements after insert or update on public.evenements
  for each row execute function public.journaliser();
create trigger journal_absences after insert or update on public.absences
  for each row execute function public.journaliser();
create trigger journal_agenda after insert on public.agenda_versions
  for each row execute function public.journaliser();
create trigger journal_parametres after update on public.parametres
  for each row execute function public.journaliser();
create trigger journal_profils after insert or update on public.profils
  for each row execute function public.journaliser();
create trigger journal_employeurs after insert or update on public.employeurs
  for each row execute function public.journaliser();
create trigger journal_membres after insert or update on public.membres
  for each row execute function public.journaliser();

-- ---------------------------------------------------------------------------
-- Droits d'accès (RLS). Aucune politique DELETE : personne ne supprime via l'app.
-- ---------------------------------------------------------------------------
alter table public.profils          enable row level security;
alter table public.employeurs       enable row level security;
alter table public.membres          enable row level security;
alter table public.parametres       enable row level security;
alter table public.agenda_versions  enable row level security;
alter table public.evenements       enable row level security;
alter table public.absences         enable row level security;
alter table public.journal          enable row level security;
alter table public.envois           enable row level security;

create policy lecture on public.profils for select to authenticated
  using (id = auth.uid() or est_admin() or meme_employeur(id));
create policy maj on public.profils for update to authenticated
  using (est_admin()) with check (est_admin());

create policy lecture on public.employeurs for select to authenticated
  using (est_admin() or exists (select 1 from membres m where m.employeur = employeurs.id and m.profil = auth.uid()));
create policy ajout on public.employeurs for insert to authenticated with check (est_admin());
create policy maj on public.employeurs for update to authenticated using (est_admin()) with check (est_admin());

create policy lecture on public.membres for select to authenticated
  using (profil = auth.uid() or est_admin() or responsable_de(employeur) or meme_employeur(profil));
create policy ajout on public.membres for insert to authenticated with check (est_admin());
create policy maj on public.membres for update to authenticated
  using (est_admin() or (role = 'salarie' and responsable_de(employeur)))
  with check (est_admin() or (role = 'salarie' and responsable_de(employeur)));

create policy lecture on public.parametres for select to authenticated using (true);
create policy maj on public.parametres for update to authenticated
  using (est_admin()) with check (est_admin());

create policy lecture on public.agenda_versions for select to authenticated
  using (salarie = auth.uid() or peut_gerer(salarie));
create policy ajout on public.agenda_versions for insert to authenticated
  with check (peut_gerer(salarie));

create policy lecture on public.evenements for select to authenticated
  using (salarie = auth.uid() or peut_gerer(salarie));
create policy ajout on public.evenements for insert to authenticated
  with check (salarie = auth.uid() or peut_gerer(salarie));
create policy annulation on public.evenements for update to authenticated
  using (peut_gerer(salarie)) with check (peut_gerer(salarie));

create policy lecture on public.absences for select to authenticated
  using (salarie = auth.uid() or peut_gerer(salarie));
create policy ajout on public.absences for insert to authenticated
  with check (salarie = auth.uid() or peut_gerer(salarie));
create policy annulation on public.absences for update to authenticated
  using (peut_gerer(salarie)) with check (peut_gerer(salarie));

create policy lecture on public.journal for select to authenticated
  using (salarie = auth.uid() or est_admin() or (salarie is not null and peut_gerer(salarie)));

create policy lecture on public.envois for select to authenticated
  using (salarie = auth.uid() or peut_gerer(salarie));

-- Ceinture et bretelles : retirer explicitement la suppression aux comptes connectés
revoke delete, truncate on public.evenements, public.absences, public.journal, public.agenda_versions,
  public.profils, public.parametres, public.envois, public.employeurs, public.membres
  from anon, authenticated;
revoke insert, update on public.journal, public.envois from anon, authenticated;
revoke insert on public.profils from anon, authenticated;  -- créés par la fonction « comptes »

-- ---------------------------------------------------------------------------
-- Purge au-delà de la durée de conservation (appelée par la tâche planifiée)
-- ---------------------------------------------------------------------------
create or replace function public.purger_donnees_anciennes() returns void
language plpgsql security definer set search_path = public as $$
declare limite date;
begin
  select (current_date - make_interval(years => conservation_annees))::date into limite from parametres;
  delete from evenements where jour < limite;
  delete from absences where au < limite;
  delete from agenda_versions v where valable_du < limite
    and exists (select 1 from agenda_versions w where w.salarie = v.salarie
                and w.valable_du > v.valable_du and w.valable_du <= limite);
  delete from envois where envoye_le < limite;
  delete from journal where le < limite;
  insert into journal (table_nom, action, apres)
  values ('purge', 'purge', jsonb_build_object('avant_le', limite));
end $$;
revoke execute on function public.purger_donnees_anciennes() from anon, authenticated, public;

-- Secret partagé entre la tâche planifiée et la fonction « rappels ».
-- Généré dans le coffre de Supabase (0002_planification.sql) : personne n'a à le manipuler.
create or replace function public.secret_cron() returns text
language sql stable security definer set search_path = public as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'
$$;
revoke execute on function public.secret_cron() from anon, authenticated, public;
grant execute on function public.secret_cron() to service_role;

-- ---------------------------------------------------------------------------
-- Durcissement (recommandations du contrôle de sécurité Supabase)
-- ---------------------------------------------------------------------------
alter function public.maintenant_paris() set search_path = public;
alter function public.controle_parametres() set search_path = public;
-- Fonctions de déclencheur : jamais appelées directement
revoke execute on function public.controle_evenement(), public.controle_absence(), public.controle_agenda(),
  public.controle_membre(), public.controle_parametres(), public.journaliser() from public, anon, authenticated;
-- Fonctions d'aide des droits d'accès : nécessaires aux comptes connectés, jamais aux visiteurs
revoke execute on function public.est_admin(), public.peut_gerer(uuid), public.meme_employeur(uuid),
  public.responsable_de(uuid), public.maintenant_paris() from public, anon;
grant execute on function public.est_admin(), public.peut_gerer(uuid), public.meme_employeur(uuid),
  public.responsable_de(uuid), public.maintenant_paris() to authenticated;
