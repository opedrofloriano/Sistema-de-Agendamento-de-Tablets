// Painel: quem pode ver o quê, e se as contas das estatísticas batem.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { computeStats, weekdaysBetween } from '../shared/stats.ts';
import { DEFAULT_CONFIG } from '../shared/rules.ts';
import { roleFromClaims } from '../server/auth.ts';
import { loadConfig } from '../server/config.ts';
import { FIXED_NOW, client, reservationBody, startApp, type TestApp } from './helpers.ts';

let t: TestApp;
let prof: ReturnType<typeof client>;
let bruno: ReturnType<typeof client>;
let coord: ReturnType<typeof client>;
let ti: ReturnType<typeof client>;

async function dev(base: string, name: string, email: string, role: string) {
  const res = await fetch(`${base}/auth/dev-login`, {
    method: 'POST',
    body: new URLSearchParams({ name, email, role, returnTo: '/' }),
    redirect: 'manual',
  });
  return client(base, (res.headers.get('set-cookie') ?? '').split(';')[0]);
}

before(async () => {
  t = await startApp({}, { now: FIXED_NOW });
  prof = await dev(t.base, 'Ana Ribeiro', 'ana@escola.edu.br', 'professor');
  bruno = await dev(t.base, 'Bruno Lima', 'bruno@escola.edu.br', 'professor');
  coord = await dev(t.base, 'Carla', 'carla@escola.edu.br', 'coordenacao');
  ti = await dev(t.base, 'Tiago TI', 'ti@escola.edu.br', 'ti');

  // Quarta, 21/10/2026
  assert.equal((await prof.post('/api/reservations', reservationBody({ quantity: 15, startTime: '08:40', endTime: '10:40', className: '8º ano A' }))).status, 201);
  assert.equal((await bruno.post('/api/reservations', reservationBody({ quantity: 10, startTime: '08:40', endTime: '09:30', className: '8º Ano A' }))).status, 201);
  assert.equal((await bruno.post('/api/reservations', reservationBody({ unit: 'Castelo I', quantity: 30, startTime: '13:00', endTime: '13:50', className: '9B' }))).status, 201);
  const cancelled = await bruno.post('/api/reservations', reservationBody({ unit: 'Castelo I', quantity: 5, startTime: '15:50', endTime: '16:40' }));
  assert.equal((await bruno.post(`/api/reservations/${cancelled.body.reservation.id}/cancel`)).status, 200);
});
after(() => t.close());

test('papéis: professor não vê o painel; coordenação vê; só a TI vê a área técnica', async () => {
  const q = '/api/admin/stats?from=2026-10-19&to=2026-10-23';
  assert.equal((await prof.get(q)).status, 403);
  assert.equal((await prof.get('/api/admin/pending')).status, 403);
  assert.equal((await coord.get(q)).status, 200);
  assert.equal((await coord.get('/api/admin/pending')).status, 200);
  for (const p of ['audit', 'users', 'system']) {
    assert.equal((await coord.get(`/api/admin/ti/${p}`)).status, 403, p);
    assert.equal((await prof.get(`/api/admin/ti/${p}`)).status, 403, p);
    assert.equal((await ti.get(`/api/admin/ti/${p}`)).status, 200, p);
  }
  assert.equal((await ti.get(q)).status, 200);
  assert.equal((await ti.get('/api/me')).body.user.role, 'ti');
});

test('as estatísticas batem com a conta feita à mão', async () => {
  const s = (await coord.get('/api/admin/stats?from=2026-10-19&to=2026-10-23')).body;
  // 15×2h + 10×50min + 30×50min = 30 + 8,33 + 25 = 63,3 tablets·hora
  assert.equal(s.totals.tabletHours, 63.3);
  assert.equal(s.totals.reservations, 3);
  assert.equal(s.totals.cancelled, 1);
  assert.equal(s.totals.teachers, 2);
  // "8º ano A" e "8º Ano A" são a mesma turma: 38,3 de 63,3 = 60,5%
  assert.deepEqual(s.byClass[0], { name: '8º ano A', reservations: 2, tabletHours: 38.3, sharePct: 60.5 });
  assert.deepEqual(s.byTeacher.map((r: { name: string; sharePct: number }) => [r.name, r.sharePct]), [['Bruno Lima', 52.6], ['Ana Ribeiro', 47.4]]);
  // Capacidade por unidade: 30 tablets × 11h20 × 5 dias = 1700 tablets·hora
  const castelo = s.byUnit.find((u: { unit: string }) => u.unit === 'Castelo II');
  assert.equal(castelo.occupancyPct, 2.3);
  assert.equal(s.byPeriod.find((p: { id: string }) => p.id === 'm3').reservations, 2);
  assert.equal(s.byPeriod.find((p: { id: string }) => p.id === 't1').reservations, 1);
  assert.equal(s.byWeekday[2].reservations, 3);

  const fl = (await coord.get('/api/admin/stats?from=2026-10-19&to=2026-10-23&unit=Castelo I')).body;
  assert.equal(fl.totals.tabletHours, 25);
  assert.equal(fl.byUnit.length, 1);
  assert.equal((await coord.get('/api/admin/stats?from=2026-10-19&to=2026-10-23&unit=Outra')).status, 400);
  assert.equal((await coord.get('/api/admin/stats?from=2025-01-01&to=2026-10-23')).status, 400);
});

test('pendências de devolução aparecem para a coordenação, e a TI também pode cancelar', async () => {
  const anaId = 'dev:ana@escola.edu.br';
  await t.app.db.transaction(async (tx) => {
    await tx.insertReservation({
      id: 'antiga-1', title: 'Aula passada', teacher: 'Ana Ribeiro', ownerId: anaId, unit: 'Castelo II', className: '',
      quantity: 12, start: '2026-10-19T08:40:00', end: '2026-10-19T09:30:00', status: 'confirmada', notes: '', createdAt: '2026-10-16T10:00:00',
    });
  });
  const pending = (await coord.get('/api/admin/pending')).body.reservations;
  assert.deepEqual(pending.map((r: { id: string }) => r.id), ['antiga-1']);
  assert.equal((await coord.post('/api/reservations/antiga-1/return')).status, 200);
  assert.equal((await coord.get('/api/admin/pending')).body.reservations.length, 0);

  const r = await prof.post('/api/reservations', reservationBody({ date: '2026-10-22', title: 'Para a TI cancelar' }));
  assert.equal((await ti.post(`/api/reservations/${r.body.reservation.id}/cancel`)).status, 200);
});

test('a TI vê registro de atividades, usuários e situação do sistema', async () => {
  const audit = (await ti.get('/api/admin/ti/audit?limit=5')).body.entries;
  assert.equal(audit.length, 5);
  assert.equal(audit[0].action, 'cancelar');
  assert.equal(audit[0].userName, 'Tiago TI');
  assert.equal(audit[0].reservationTitle, 'Para a TI cancelar');
  const users = (await ti.get('/api/admin/ti/users')).body.users;
  const bru = users.find((u: { name: string }) => u.name === 'Bruno Lima');
  assert.equal(bru.reservations, 2);
  assert.equal(users.find((u: { name: string }) => u.name === 'Tiago TI').role, 'ti');
  const sys = (await ti.get('/api/admin/ti/system')).body;
  assert.equal(sys.database, 'local');
  assert.equal(sys.authMode, 'dev');
  assert.ok(sys.totals.reservations >= 6);
  assert.ok(sys.totals.activeSessions >= 4);
});

test('coordenação e TI podem reservar em nome de outro professor', async () => {
  const r = await ti.post('/api/reservations', reservationBody({ date: '2026-10-23', teacher: 'Professora Convidada' }));
  assert.equal(r.body.reservation.teacher, 'Professora Convidada');
});

test('login piloto: a senha da TI entra como TI; a da coordenação, como coordenação', async () => {
  const p = await startApp({
    AUTH_MODE: 'piloto', NODE_ENV: 'production', ACCESS_CODE: 'escola2026', COORDINATOR_PASSWORD: 'coordena-segredo', TI_PASSWORD: 'ti-segredo-123',
  });
  try {
    const login = async (pw: string) => {
      const res = await fetch(`${p.base}/auth/pilot-login`, {
        method: 'POST', redirect: 'manual',
        body: new URLSearchParams({ name: 'X', code: 'escola2026', coordPassword: pw, returnTo: '/' }),
      });
      if (res.status !== 303) return res.status;
      return (await client(p.base, (res.headers.get('set-cookie') ?? '').split(';')[0]).get('/api/me')).body.user.role;
    };
    assert.equal(await login('ti-segredo-123'), 'ti');
    assert.equal(await login('coordena-segredo'), 'coordenacao');
    assert.equal(await login('chute-errado'), 401);
  } finally {
    await p.close();
  }
  const base = { AUTH_MODE: 'piloto', ACCESS_CODE: 'escola2026', COORDINATOR_PASSWORD: 'coordena-segredo' };
  assert.throws(() => loadConfig({ ...base, TI_PASSWORD: 'coordena-segredo' }), /diferente/);
  assert.throws(() => loadConfig({ ...base, TI_PASSWORD: 'curta' }), /8 caracteres/);
});

test('login Microsoft: papel "TI" vira TI, e tem precedência sobre coordenação', () => {
  const entra = {
    tenantId: 't', clientId: 'c', clientSecret: 's', authorityBase: 'x', coordinatorAppRole: 'Coordenacao',
    coordinatorGroupIds: [], tiAppRole: 'TI', tiGroupIds: ['g-ti'], allowedGroupIds: [],
  };
  const base = { iss: '', aud: '', tid: '', oid: 'o', exp: 0 };
  assert.equal(roleFromClaims({ ...base, roles: ['TI'] }, entra, []), 'ti');
  assert.equal(roleFromClaims({ ...base, roles: ['Coordenacao', 'TI'] }, entra, []), 'ti');
  assert.equal(roleFromClaims({ ...base, groups: ['g-ti'] }, entra, []), 'ti');
  assert.equal(roleFromClaims({ ...base, preferred_username: 'Suporte@escola.edu.br' }, entra, [], ['suporte@escola.edu.br']), 'ti');
  assert.equal(roleFromClaims({ ...base, roles: ['Coordenacao'] }, entra, []), 'coordenacao');
});

test('computeStats: dias úteis e "Outros" quando há mais professores que o limite', () => {
  assert.equal(weekdaysBetween('2026-10-19', '2026-10-25'), 5);
  assert.equal(weekdaysBetween('2026-10-01', '2026-10-31'), 22);
  const rs = Array.from({ length: 10 }, (_, i) => ({
    id: String(i), title: 'x', teacher: `Prof ${i}`, ownerId: 'o', unit: 'Castelo II', className: '', quantity: 1,
    start: '2026-10-21T08:00:00', end: '2026-10-21T09:00:00', status: 'confirmada' as const, notes: '', createdAt: '',
  }));
  const s = computeStats(rs, '2026-10-19', '2026-10-23', DEFAULT_CONFIG, undefined, 8);
  assert.equal(s.byTeacher.length, 9);
  assert.equal(s.byTeacher[8].name, 'Outros (2)');
  assert.equal(s.byTeacher[8].sharePct, 20);
  assert.equal(s.byClass[0].name, 'Sem turma informada');
  assert.ok(!s.byPeriod.some((p) => p.id === 'outro'), '08:00 cai dentro de um horário de aula');
  const late = computeStats([{ ...rs[0], start: '2026-10-21T18:30:00', end: '2026-10-21T19:00:00' }], '2026-10-19', '2026-10-23', DEFAULT_CONFIG);
  assert.equal(late.byPeriod.at(-1)?.id, 'outro');
});
