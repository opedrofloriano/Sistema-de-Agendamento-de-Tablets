// Modo piloto: entrada com nome + código de acesso; coordenação com senha.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { loadConfig } from '../server/config.ts';
import { client, FIXED_NOW, reservationBody, startApp, type TestApp } from './helpers.ts';

const CODE = 'escola2026';
const COORD = 'coordena-segredo';
let t: TestApp;

before(async () => {
  t = await startApp({ AUTH_MODE: 'piloto', NODE_ENV: 'production', ACCESS_CODE: CODE, COORDINATOR_PASSWORD: COORD }, { now: FIXED_NOW });
});
after(() => t.close());

async function login(fields: Record<string, string>, ip = '10.0.0.1') {
  const res = await fetch(`${t.base}/auth/pilot-login`, {
    method: 'POST',
    body: new URLSearchParams({ returnTo: '/', ...fields }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': ip },
    redirect: 'manual',
  });
  const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? null;
  return { status: res.status, cookie, html: res.status === 303 ? '' : await res.text() };
}

test('a configuração exige código e senha fortes e diferentes', () => {
  const base = { AUTH_MODE: 'piloto', NODE_ENV: 'production' };
  assert.throws(() => loadConfig({ ...base, COORDINATOR_PASSWORD: COORD }), /ACCESS_CODE/);
  assert.throws(() => loadConfig({ ...base, ACCESS_CODE: CODE, COORDINATOR_PASSWORD: '123' }), /COORDINATOR_PASSWORD/);
  assert.throws(() => loadConfig({ ...base, ACCESS_CODE: 'mesmo-valor', COORDINATOR_PASSWORD: 'mesmo-valor' }), /diferentes/);
  assert.equal(loadConfig({ ...base, ACCESS_CODE: CODE, COORDINATOR_PASSWORD: COORD }).authMode, 'piloto');
  assert.equal(loadConfig({ ...base, ACCESS_CODE: CODE, COORDINATOR_PASSWORD: COORD, RENDER_EXTERNAL_URL: 'https://x.onrender.com' }).baseUrl, 'https://x.onrender.com');
});

test('a tela de entrada pede nome e código, sem caixa de coordenação livre', async () => {
  const page = await (await fetch(`${t.base}/auth/login`)).text();
  assert.match(page, /Código de acesso/);
  assert.match(page, /Senha da coordenação/);
  assert.doesNotMatch(page, /name="coord"/);
});

test('professor entra com o código; código errado não entra', async () => {
  const wrong = await login({ name: 'Ana Ribeiro', code: 'errado' }, '10.0.0.2');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.cookie, null);
  const ok = await login({ name: 'Ana Ribeiro', code: CODE });
  assert.equal(ok.status, 303);
  const me = await client(t.base, ok.cookie ?? '').get('/api/me');
  assert.equal(me.body.user.role, 'professor');
  assert.equal(me.body.user.name, 'Ana Ribeiro');
  assert.equal(me.body.authMode, 'piloto');
});

test('coordenação só com a senha certa; senha errada não vira professor', async () => {
  const bad = await login({ name: 'Carla', code: CODE, coordPassword: 'chute' }, '10.0.0.3');
  assert.equal(bad.status, 401);
  assert.equal(bad.cookie, null);
  const ok = await login({ name: 'Carla', code: CODE, coordPassword: COORD });
  assert.equal((await client(t.base, ok.cookie ?? '').get('/api/me')).body.user.role, 'coordenacao');
});

test('o mesmo nome é a mesma pessoa, com ou sem acento e maiúscula', async () => {
  const a = client(t.base, (await login({ name: 'José Lima', code: CODE })).cookie ?? '');
  const r = await a.post('/api/reservations', reservationBody({ date: '2026-10-22' }));
  assert.equal(r.status, 201);
  const b = client(t.base, (await login({ name: '  jose   LIMA ', code: CODE })).cookie ?? '');
  assert.equal((await b.post(`/api/reservations/${r.body.reservation.id}/cancel`)).status, 200);
  const other = client(t.base, (await login({ name: 'Outra Pessoa', code: CODE })).cookie ?? '');
  const r2 = await a.post('/api/reservations', reservationBody({ date: '2026-10-23' }));
  assert.equal((await other.post(`/api/reservations/${r2.body.reservation.id}/cancel`)).status, 403);
});

test('10 tentativas erradas bloqueiam o IP por 15 minutos', async () => {
  for (let i = 0; i < 10; i += 1) assert.equal((await login({ name: 'X', code: 'errado' }, '10.9.9.9')).status, 401);
  const blocked = await login({ name: 'X', code: CODE }, '10.9.9.9');
  assert.equal(blocked.status, 429);
  assert.equal((await login({ name: 'Y', code: CODE }, '10.9.9.8')).status, 303);
});

test('login vindo de outro site é recusado', async () => {
  const res = await fetch(`${t.base}/auth/pilot-login`, {
    method: 'POST',
    body: new URLSearchParams({ name: 'A', code: CODE }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://site-malicioso.example' },
    redirect: 'manual',
  });
  assert.equal(res.status, 403);
});

test('as rotas de outros modos de login não existem no piloto', async () => {
  assert.equal((await fetch(`${t.base}/auth/dev-login`, { method: 'POST', body: 'name=a&email=a@a', redirect: 'manual' })).status, 404);
  assert.equal((await fetch(`${t.base}/auth/callback?code=x&state=y`)).status, 404);
});
