// Tests des règles : node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../supabase/functions/_shared/regles.js';

const P = { heures_hebdo: 35, date_debut: '2026-01-01', repos_quotidien_min: 660, max_jour_min: 600,
  max_semaine_min: 2880, moyenne_12s_min: 2640, pause_seuil_min: 360, pause_duree_min: 20,
  repos_hebdo_min: 2100, tolerance_agenda_min: 15 };
const e = (jour, type, heure, extra = {}) => ({ jour, type, heure, ...extra });
const journee = (jour, ...h) => {
  const types = ['arrivee', 'pause', 'reprise', 'depart'];
  if (h.length === 2) return [e(jour, 'arrivee', h[0]), e(jour, 'depart', h[1])];
  return h.map((x, i) => e(jour, i === 0 ? 'arrivee' : i === h.length - 1 ? 'depart' : types[1 + ((i - 1) % 2)], x));
};
const regles = (evts, extra = {}) => R.alertes({ evtsParJour: R.parJour(evts), absences: [], versions: [],
  params: P, du: '2026-11-02', au: '2026-11-08', aujourdhui: '2026-11-20', ...extra }).map(a => a.regle);

test('journée avec pauses multiples', () => {
  const a = R.analyserJour(journee('2026-11-02', '08:30', '10:30', '10:45', '12:30', '14:00', '18:00'));
  assert.equal(a.travail, 120 + 105 + 240);
  assert.equal(a.pauseMax, 90);
  assert.ok(a.complet);
});

test('coupure départ / arrivée comptée comme pause', () => {
  const a = R.analyserJour([...journee('2026-11-02', '08:30', '12:30'), ...journee('2026-11-02', '14:00', '18:00')]);
  assert.equal(a.travail, 480); assert.equal(a.pauseMax, 90); assert.ok(a.complet);
});

test('heure annulée ignorée', () => {
  const a = R.analyserJour([e('2026-11-02', 'arrivee', '07:00', { annule_le: 'x' }), ...journee('2026-11-02', '08:00', '12:00')]);
  assert.equal(a.travail, 240);
});

test('journée incomplète et incohérente', () => {
  assert.equal(R.analyserJour([e('d', 'arrivee', '08:00')]).complet, false);
  assert.ok(R.analyserJour([e('d', 'depart', '08:00')]).incoherent);
});

test('plus de 10 h et pause manquante', () => {
  const r = regles(journee('2026-11-02', '07:00', '18:00'));
  assert.ok(r.includes('max_jour')); assert.ok(r.includes('pause'));
});

test('6 h avec pause de 20 min : conforme', () => {
  const r = regles(journee('2026-11-02', '08:00', '11:00', '11:20', '14:20'));
  assert.ok(!r.includes('pause'));
});

test('repos quotidien de moins de 11 h', () => {
  const r = regles([...journee('2026-11-02', '09:00', '12:00', '13:00', '22:00'), ...journee('2026-11-03', '07:00', '12:00')]);
  assert.ok(r.includes('repos_quotidien'));
});

test('semaine de plus de 48 h et heures sup', () => {
  const ev = [];
  for (let i = 0; i < 5; i++) ev.push(...journee(R.ajouterJours('2026-11-02', i), '07:00', '12:00', '12:30', '17:30'));
  ev.push(...journee('2026-11-07', '08:00', '12:00', '12:30', '14:30'));
  const r = regles(ev);
  assert.ok(r.includes('max_semaine')); assert.ok(r.includes('heures_sup')); assert.ok(r.includes('repos_hebdo') === false);
});

test('semaine en cours non évaluée', () => {
  const ev = [];
  for (let i = 0; i < 6; i++) ev.push(...journee(R.ajouterJours('2026-11-16', i), '07:00', '12:00', '12:30', '17:30'));
  const r = regles(ev, { du: '2026-11-16', au: '2026-11-22', aujourdhui: '2026-11-21' });
  assert.ok(!r.includes('max_semaine'));
});

test('écart avec l’agenda type', () => {
  const versions = [{ valable_du: '2026-01-01', plages: { 1: [['08:30', '12:30'], ['14:00', '17:00']] } }];
  const r = regles([...journee('2026-11-02', '08:30', '12:30', '14:00', '18:00'), ...journee('2026-11-03', '09:00', '10:00')], { versions });
  assert.deepEqual(r.filter(x => x === 'agenda').length, 2); // lundi +1h, mardi non prévu
});

test('jours manquants : vide, incomplet, absence et week-end ignorés', () => {
  const evts = R.parJour([...journee('2026-11-16', '08:00', '17:00'), e('2026-11-17', 'arrivee', '08:00')]);
  const absences = [{ du: '2026-11-19', au: '2026-11-19', type: 'Congés payés' }];
  const m = R.joursManquants({ evtsParJour: evts, absences, versions: [], debut: '2026-11-16', aujourdhui: '2026-11-23' });
  assert.deepEqual(m, [{ jour: '2026-11-17', motif: 'incomplet' }, { jour: '2026-11-18', motif: 'vide' }, { jour: '2026-11-20', motif: 'vide' }]);
});

test('heures attendues réduites par une absence', () => {
  const s = R.semaine({ lundi: '2026-11-16', evtsParJour: {}, absences: [{ du: '2026-11-16', au: '2026-11-16' }], versions: [], params: P });
  assert.equal(s.attendu, 28 * 60);
});

test('heure de Paris', () => {
  assert.equal(R.maintenantParis(new Date('2026-07-01T05:30:00Z')).heure, '07:30');
  assert.equal(R.maintenantParis(new Date('2026-12-31T23:30:00Z')).jour, '2027-01-01');
});

test('repos hebdomadaire insuffisant si travail 7 jours sur 7', () => {
  const ev = [];
  for (let i = 0; i < 7; i++) ev.push(...journee(R.ajouterJours('2026-11-02', i), '09:00', '12:00'));
  assert.ok(regles(ev).includes('repos_hebdo'));
});
