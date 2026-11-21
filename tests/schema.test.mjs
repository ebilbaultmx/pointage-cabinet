// Tests des droits d'accès sur une vraie base Postgres (PGlite) : npm install && npm run test:schema
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import test from 'node:test';
import assert from 'node:assert/strict';
const db = new PGlite();
const sql = fs.readFileSync(new URL('../supabase/migrations/0001_schema.sql', import.meta.url), 'utf8').replace(/create extension[^;]+;/, '');
await db.exec(`create role anon; create role authenticated; create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true),'')::uuid $$;
grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
grant usage on schema public to authenticated;
alter default privileges in schema public grant all on tables to authenticated;`);
await db.exec(sql);
const u = n => `0000000${n}-0000-0000-0000-000000000000`;
const ADM = u(1), L = u(2), DX = u(3), SB = u(4), M = u(5);
const CA = 'aaaaaaaa-0000-0000-0000-000000000000', CB = 'bbbbbbbb-0000-0000-0000-000000000000', SCM = 'cccccccc-0000-0000-0000-000000000000';
await db.exec(`insert into auth.users values ('${ADM}'),('${L}'),('${DX}'),('${SB}'),('${M}');
insert into profils(id,nom,email,admin) values ('${ADM}','Armelle','a@x',true),('${L}','Laura','l@x',false),('${DX}','Dr X','x@x',false),('${SB}','Sam','s@x',false),('${M}','Marie','m@x',false);
insert into employeurs(id,nom,forme) values ('${CA}','Cabinet A','cabinet'),('${CB}','Cabinet B','cabinet'),('${SCM}','SCM','scm');
insert into membres(profil,employeur,role) values ('${ADM}','${CA}','responsable'),('${L}','${CA}','salarie'),('${DX}','${CB}','responsable'),('${SB}','${CB}','salarie'),
 ('${ADM}','${SCM}','responsable'),('${DX}','${SCM}','responsable'),('${M}','${SCM}','salarie');`);
let ok = 0, ko = 0;
async function as(uid, q, attendu) {
  let res, err;
  try { await db.exec(`set role authenticated; set test.uid='${uid}';`); res = (await db.query(q)); } catch (e) { err = e.message; }
  await db.exec('reset role;');
  const bon = attendu === 'erreur' ? !!err : attendu === 'vide' ? (!err && res.affectedRows === 0) : !err;
  bon ? ok++ : (ko++, console.log('ÉCART', attendu, ':', q, '->', err || ('lignes ' + res.affectedRows)));
  return res?.rows;
}
const ins = (s, src, motif = null, jour = '2026-11-02') => `insert into evenements(salarie,jour,type,heure,source,motif) values ('${s}','${jour}','arrivee','08:30','${src}',${motif ? `'${motif}'` : 'null'})`;
await as(L, ins(L, 'pointage'));
await as(SB, ins(SB, 'saisie'));
await as(M, ins(M, 'saisie'));
await as(DX, ins(M, 'correction', 'oubli'));                 // DX gère la SCM
await as(DX, ins(L, 'correction', 'oubli'), 'erreur');       // mais pas le cabinet A
await as(ADM, ins(SB, 'correction', 'oubli'));               // admin : partout
await as(L, ins(SB, 'saisie'), 'erreur');
await as(L, ins(L, 'correction', 'x'), 'erreur');            // pas d'auto-correction
await as(ADM, ins(ADM, 'correction', 'x'), 'erreur');        // l'admin ne corrige pas ses propres heures
let r = await as(L, `select distinct salarie from evenements`); (r.length === 1 && r[0].salarie === L) ? ok++ : (ko++, console.log('ÉCART : Laura voit', r));
r = await as(DX, `select distinct salarie from evenements order by 1`); (r.map(x => x.salarie).join() === [SB, M].sort().join()) ? ok++ : (ko++, console.log('ÉCART : Dr X voit', r));
r = await as(ADM, `select count(distinct salarie)::int n from evenements`); r[0].n === 3 ? ok++ : (ko++, console.log('ÉCART admin', r));
await as(DX, `update evenements set motif_annulation='x' where salarie='${L}'`, 'vide');
await as(DX, `update evenements set motif_annulation='erreur' where salarie='${M}' and source='saisie'`);
// profils visibles
r = await as(L, `select nom from profils order by nom`); console.log('Laura voit les profils :', r.map(x => x.nom).join(', '));
r = await as(M, `select nom from profils order by nom`); console.log('Marie voit les profils :', r.map(x => x.nom).join(', '));
r = await as(L, `select nom from employeurs`); console.log('Laura voit les employeurs :', r.map(x => x.nom).join(', '));
r = await as(DX, `select nom from employeurs order by nom`); console.log('Dr X voit les employeurs :', r.map(x => x.nom).join(', '));
// employeurs / membres
await as(DX, `insert into employeurs(nom) values ('Pirate')`, 'erreur');
await as(ADM, `insert into employeurs(nom) values ('Cabinet C')`);
await as(DX, `update membres set heures_hebdo=28 where profil='${SB}'`);
await as(DX, `update membres set employeur='${CA}' where profil='${SB}'`, 'erreur');
await as(DX, `update membres set heures_hebdo=20 where profil='${L}'`, 'vide');
await as(DX, `insert into membres(profil,employeur,role) values ('${DX}','${CA}','responsable')`, 'erreur');
await as(ADM, `insert into membres(profil,employeur,role) values ('${L}','${CB}','salarie')`, 'erreur'); // deux employeurs actifs
await as(L, `insert into profils(id,nom,email) values ('${u(9)}','x','x')`, 'erreur');
await as(L, `update parametres set max_jour_min=900`, 'vide');
await as(ADM, `update parametres set max_jour_min=600`);
await as(L, `update profils set admin=true where id='${L}'`, 'vide');
// agenda
await as(DX, `insert into agenda_versions(salarie,valable_du,plages) values ('${M}','2026-11-01','{}')`);
await as(DX, `insert into agenda_versions(salarie,valable_du,plages) values ('${L}','2026-11-01','{}')`, 'erreur');
await as(M, `insert into agenda_versions(salarie,valable_du,plages) values ('${M}','2026-11-01','{}')`, 'erreur');
// absences
await as(L, `insert into absences(salarie,type,du,au) values ('${L}','Congés payés','2026-12-01','2026-12-02')`);
await as(DX, `insert into absences(salarie,type,du,au) values ('${L}','Congés payés','2026-12-01','2026-12-02')`, 'erreur');
// journal
r = await as(DX, `select distinct salarie from journal where salarie is not null`); console.log('Dr X voit le journal de :', r.length, 'personne(s)'); (!r.some(x => x.salarie === L)) ? ok++ : (ko++, console.log('ÉCART journal'));
await as(DX, `delete from journal`, 'erreur');
await db.exec(`select purger_donnees_anciennes()`); ok++;
console.log(`${ok} vérifications conformes, ${ko} écart(s)`);
test('droits d’accès entre employeurs', () => assert.equal(ko, 0));
