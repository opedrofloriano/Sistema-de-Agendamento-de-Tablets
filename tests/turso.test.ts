// O sistema inteiro rodando com o banco na Turso (simulada), como na Render grátis.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../server/app.ts';
import { loadConfig } from '../server/config.ts';
import { TursoSql } from '../server/sql.ts';
import { client, FIXED_NOW, reservationBody, startApp, type TestApp } from './helpers.ts';
import { startTursoMock, type TursoMock } from './turso-mock.ts';

let turso: TursoMock;
let t: TestApp;
const env = () => ({
  AUTH_MODE: 'piloto',
  NODE_ENV: 'production',
  ACCESS_CODE: 'escola2026',
  COORDINATOR_PASSWORD: 'coordena-segredo',
  DATABASE_URL: turso.url,
  DATABASE_AUTH_TOKEN: turso.token,
});

async function login(base: string, name: string, coord = false) {
  const body = new URLSearchParams({ name, code: 'escola2026', returnTo: '/' });
  if (coord) body.set('coordPassword', 'coordena-segredo');
  const res = await fetch(`${base}/auth/pilot-login`, { method: 'POST', body, redirect: 'manual' });
  assert.equal(res.status, 303);
  return client(base, (res.headers.get('set-cookie') ?? '').split(';')[0]);
}

before(async () => {
  turso = await startTursoMock();
  t = await startApp(env(), { now: FIXED_NOW });
});
after(async () => {
  await t.close();
  await turso.close();
});

test('o servidor usa a Turso quando DATABASE_URL está definido', () => {
  assert.equal(t.app.db.kind, 'turso');
  assert.ok(turso.requests > 0, 'criou as tabelas pela API');
});

test('reservas, conflito, disponibilidade e permissões funcionam pela Turso', async () => {
  const ana = await login(t.base, 'Ana Ribeiro');
  const bruno = await login(t.base, 'Bruno Lima');
  const coord = await login(t.base, 'Carla', true);

  const a = await ana.post('/api/reservations', reservationBody({ quantity: 20, notes: 'Levar carregadores' }));
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(a.body.reservation.quantity, 20);
  const over = await bruno.post('/api/reservations', reservationBody({ quantity: 11 }));
  assert.equal(over.status, 409);
  assert.match(over.body.error, /apenas 10 tablets livres da unidade Castelo II/);
  const ok = await bruno.post('/api/reservations', reservationBody({ quantity: 10 }));
  assert.equal(ok.status, 201);
  const fl = await bruno.post('/api/reservations', reservationBody({ unit: 'Castelo I', quantity: 30 }));
  assert.equal(fl.status, 201, 'a outra unidade tem os próprios 30');

  const avail = await ana.get('/api/availability?unit=Castelo%20II&start=2026-10-21T08:40:00&end=2026-10-21T09:30:00');
  assert.deepEqual(avail.body, { unit: 'Castelo II', free: 0, total: 30 });

  const list = await ana.get('/api/reservations?from=2026-10-19&to=2026-10-23');
  assert.equal(list.body.reservations.length, 3);
  const mine = list.body.reservations.find((r: { id: string }) => r.id === a.body.reservation.id);
  assert.equal(mine.notes, 'Levar carregadores');
  assert.equal(typeof mine.quantity, 'number');

  assert.equal((await bruno.post(`/api/reservations/${a.body.reservation.id}/cancel`)).status, 403);
  assert.equal((await coord.post(`/api/reservations/${a.body.reservation.id}/cancel`)).status, 200);
  const search = await ana.get('/api/reservations?q=aula');
  assert.ok(search.body.reservations.length >= 2);
});

test('20 reservas simultâneas de 10 tablets pela Turso: só 3 cabem', async () => {
  const c = await login(t.base, 'Daniel');
  const body = reservationBody({ date: '2026-10-26', startTime: '13:00', endTime: '13:50', quantity: 10 });
  const results = await Promise.all(Array.from({ length: 20 }, () => c.post('/api/reservations', body)));
  assert.equal(results.filter((r) => r.status === 201).length, 3, results.map((r) => r.status).join(','));
  assert.equal(results.filter((r) => r.status === 409).length, 17);
});

test('as reservas continuam depois de o servidor reiniciar (como na Render grátis)', async () => {
  await t.close();
  t = await startApp(env(), { now: FIXED_NOW });
  const ana = await login(t.base, 'Ana Ribeiro');
  const list = await ana.get('/api/reservations?from=2026-10-26&to=2026-10-26');
  assert.equal(list.body.reservations.length, 3);
});

test('token errado da Turso impede o servidor de subir, com mensagem clara', async () => {
  const cfg = loadConfig({ ...env(), DATABASE_AUTH_TOKEN: 'errado', DATABASE_PATH: '/tmp/nao-usado.db' }, process.cwd());
  await assert.rejects(() => createApp(cfg), /Turso respondeu 401/);
});

test('aceita o endereço libsql:// que a Turso mostra', async () => {
  const seen: string[] = [];
  const fake: typeof fetch = async (input) => {
    seen.push(String(input));
    return new Response(JSON.stringify({ baton: null, base_url: null, results: [{ type: 'ok', response: { type: 'execute', result: { cols: [], rows: [] } } }, { type: 'ok', response: { type: 'close' } }] }));
  };
  await new TursoSql('libsql://agenda-pedro.turso.io', 'tok', fake).run('SELECT 1');
  assert.equal(seen[0], 'https://agenda-pedro.turso.io/v2/pipeline');
});
