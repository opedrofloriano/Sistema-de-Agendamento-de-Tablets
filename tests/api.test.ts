import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { FIXED_NOW, client, devLogin, reservationBody, startApp, type TestApp } from './helpers.ts';

let t: TestApp;
let ana: ReturnType<typeof client>;
let bruno: ReturnType<typeof client>;
let coord: ReturnType<typeof client>;

before(async () => {
  t = await startApp({}, { now: FIXED_NOW });
  ana = client(t.base, await devLogin(t.base, 'Ana Ribeiro', 'ana@escola.edu.br'));
  bruno = client(t.base, await devLogin(t.base, 'Bruno Lima', 'bruno@escola.edu.br'));
  coord = client(t.base, await devLogin(t.base, 'Carla Coordenação', 'carla@escola.edu.br', true));
});
after(() => t.close());

test('sem sessão, a API responde 401 e a interface manda para o login', async () => {
  const api = await fetch(`${t.base}/api/me`);
  assert.equal(api.status, 401);
  const page = await fetch(`${t.base}/`, { redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.match(page.headers.get('location') ?? '', /^\/auth\/login/);
});

test('/api/me devolve usuário, papel e regras da escola', async () => {
  const me = await ana.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.name, 'Ana Ribeiro');
  assert.equal(me.body.user.role, 'professor');
  assert.deepEqual(me.body.config.units, [
    { name: 'Castelo II', tablets: 30 },
    { name: 'Floresta', tablets: 30 },
  ]);
  assert.equal((await coord.get('/api/me')).body.user.role, 'coordenacao');
});

test('POST sem o cabeçalho X-Requested-With é recusado (proteção contra CSRF)', async () => {
  const me = await ana.get('/api/me');
  assert.equal(me.status, 200);
  const res = await fetch(`${t.base}/api/reservations`, {
    method: 'POST',
    headers: { Cookie: (await devLogin(t.base, 'Ana Ribeiro', 'ana@escola.edu.br')), 'Content-Type': 'application/json' },
    body: JSON.stringify(reservationBody()),
  });
  assert.equal(res.status, 403);
});

test('cria reserva, lista na semana e nunca passa de 30 tablets', async () => {
  const a = await ana.post('/api/reservations', reservationBody({ quantity: 15, startTime: '07:50', endTime: '09:30' }));
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(a.body.reservation.teacher, 'Ana Ribeiro');

  const b = await bruno.post('/api/reservations', reservationBody({ quantity: 15, startTime: '08:40', endTime: '10:40' }));
  assert.equal(b.status, 201);

  const full = await bruno.post('/api/reservations', reservationBody({ quantity: 1, startTime: '08:45', endTime: '09:20' }));
  assert.equal(full.status, 409);
  assert.equal(full.body.field, 'quantity');
  assert.match(full.body.error, /Todos os tablets/);

  const avail = await ana.get('/api/availability?unit=Castelo%20II&start=2026-10-21T08:45:00&end=2026-10-21T09:20:00');
  assert.deepEqual(avail.body, { unit: 'Castelo II', free: 0, total: 30 });
  const later = await ana.get('/api/availability?unit=Castelo%20II&start=2026-10-21T09:30:00&end=2026-10-21T10:40:00');
  assert.equal(later.body.free, 15);

  // O Castelo II está lotado, mas a Floresta tem os próprios 30 tablets.
  const floresta = await ana.get('/api/availability?unit=Floresta&start=2026-10-21T08:45:00&end=2026-10-21T09:20:00');
  assert.deepEqual(floresta.body, { unit: 'Floresta', free: 30, total: 30 });
  const fl = await bruno.post(
    '/api/reservations',
    reservationBody({ unit: 'Floresta', quantity: 30, startTime: '08:40', endTime: '09:30' }),
  );
  assert.equal(fl.status, 201, JSON.stringify(fl.body));
  const unknown = await ana.get('/api/availability?unit=Outra&start=2026-10-21T08:45:00&end=2026-10-21T09:20:00');
  assert.equal(unknown.status, 400);

  const list = await ana.get('/api/reservations?from=2026-10-19&to=2026-10-23');
  assert.equal(list.body.reservations.length, 3);
});

test('professor não consegue reservar em nome de outra pessoa; a coordenação consegue', async () => {
  const p = await ana.post('/api/reservations', reservationBody({ teacher: 'Outro Nome', date: '2026-10-22' }));
  assert.equal(p.body.reservation.teacher, 'Ana Ribeiro');
  const c = await coord.post('/api/reservations', reservationBody({ teacher: 'Daniel Souza', date: '2026-10-22', startTime: '13:00', endTime: '13:50' }));
  assert.equal(c.body.reservation.teacher, 'Daniel Souza');
});

test('só quem criou ou a coordenação cancelam', async () => {
  const r = await ana.post('/api/reservations', reservationBody({ date: '2026-10-23', title: 'Para cancelar' }));
  const id = r.body.reservation.id;
  const denied = await bruno.post(`/api/reservations/${id}/cancel`);
  assert.equal(denied.status, 403);
  assert.match(denied.body.error, /Ana Ribeiro ou a coordenação/);
  const ok = await coord.post(`/api/reservations/${id}/cancel`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.reservation.status, 'cancelada');
  const again = await ana.post(`/api/reservations/${id}/cancel`);
  assert.equal(again.status, 409);

  const audit = t.app.db.raw.prepare('SELECT action, user_name FROM audit_log WHERE reservation_id = ? ORDER BY id').all(id);
  assert.deepEqual(audit.map((a) => `${a.action}:${a.user_name}`), ['criar:Ana Ribeiro', 'cancelar:Carla Coordenação']);
});

test('dados inválidos voltam com mensagem e campo', async () => {
  const res = await ana.post('/api/reservations', reservationBody({ date: '2026-10-24' }));
  assert.equal(res.status, 422);
  assert.equal(res.body.field, 'date');
  const bad = await fetch(`${t.base}/api/reservations`, {
    method: 'POST',
    headers: { Cookie: await devLogin(t.base, 'Ana Ribeiro', 'ana@escola.edu.br'), 'X-Requested-With': 'agendamento', 'Content-Type': 'application/json' },
    body: '{quebrado',
  });
  assert.equal(bad.status, 400);
});

test('busca encontra reservas sem diferenciar maiúsculas', async () => {
  const res = await ana.get('/api/reservations?q=aula de');
  assert.ok(res.body.reservations.length >= 1);
});

test('20 reservas simultâneas de 10 tablets: só 3 cabem', async () => {
  const body = reservationBody({ date: '2026-10-26', startTime: '14:40', endTime: '15:30', quantity: 10 });
  const results = await Promise.all(Array.from({ length: 20 }, () => bruno.post('/api/reservations', body)));
  assert.equal(results.filter((r) => r.status === 201).length, 3);
  assert.equal(results.filter((r) => r.status === 409).length, 17);
});

test('cabeçalhos de segurança presentes', async () => {
  const res = await fetch(`${t.base}/healthz`);
  assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});
