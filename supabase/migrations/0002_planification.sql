-- Planification des rappels : à exécuter APRÈS avoir déployé la fonction « rappels ».
-- Remplacer l'adresse du projet avant d'exécuter.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Le secret partagé est tiré au hasard par la base, rangé dans le coffre, et jamais affiché.
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'cron_secret');
select vault.create_secret('https://<VOTRE-PROJET>.supabase.co', 'project_url');

-- Toutes les heures à la 5e minute ; la fonction n'agit qu'à 7 h, heure de Paris
-- (cela évite d'avoir à gérer le passage à l'heure d'été).
select cron.schedule('rappels-pointage', '5 * * * *', $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/rappels',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body    := '{}'::jsonb)
$$);
