// Login Microsoft (Entra ID) testado contra um provedor simulado:
// o teste faz o papel da Microsoft, assinando tokens com uma chave RSA própria.

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startApp, type TestApp } from './helpers.ts';

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const AUTHORITY = 'https://login.microsoftonline.test';
const ISSUER = `${AUTHORITY}/${TENANT}/v2.0`;

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'chave-1', use: 'sig', alg: 'RS256' };
const { privateKey: otherKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
function signToken(claims: Record<string, unknown>, key = privateKey, kid = 'chave-1'): string {
  const head = b64({ alg: 'RS256', typ: 'JWT', kid });
  const body = b64(claims);
  const sig = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

/** O que o "provedor" vai responder na próxima troca de código. */
let nextToken: (nonce: string) => string = () => '';
let lastVerifierOk = false;
const pending = new Map<string, { nonce: string; challenge: string }>();

const fakeFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url === `${AUTHORITY}/${TENANT}/discovery/v2.0/keys`) {
    return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'Content-Type': 'application/json' } });
  }
  if (url === `${AUTHORITY}/${TENANT}/oauth2/v2.0/token`) {
    const form = new URLSearchParams(String(init?.body));
    const p = pending.get(form.get('code') ?? '');
    if (!p || form.get('client_secret') !== 'segredo' || form.get('client_id') !== CLIENT) {
      return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'código inválido' }), { status: 400 });
    }
    const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
    lastVerifierOk = challenge === p.challenge;
    if (!lastVerifierOk) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    return new Response(JSON.stringify({ id_token: nextToken(p.nonce) }), { headers: { 'Content-Type': 'application/json' } });
  }
  return new Response('não encontrado', { status: 404 });
};

let t: TestApp;
before(async () => {
  t = await startApp(
    {
      AUTH_MODE: 'entra',
      ENTRA_TENANT_ID: TENANT,
      ENTRA_CLIENT_ID: CLIENT,
      ENTRA_CLIENT_SECRET: 'segredo',
      ENTRA_AUTHORITY_BASE: AUTHORITY,
      ENTRA_COORDINATOR_GROUP_IDS: 'grupo-coord',
      COORDINATOR_EMAILS: 'diretora@escola.edu.br',
    },
    { fetchFn: fakeFetch },
  );
});
after(() => t.close());

const baseClaims = (nonce: string, over: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  aud: CLIENT,
  tid: TENANT,
  oid: 'oid-ana',
  name: 'Ana Ribeiro',
  preferred_username: 'ana@escola.edu.br',
  nonce,
  iat: Math.floor(Date.now() / 1000),
  nbf: Math.floor(Date.now() / 1000) - 10,
  exp: Math.floor(Date.now() / 1000) + 3600,
  ...over,
});

/** Faz o fluxo inteiro: /auth/login → "Microsoft" → /auth/callback. */
async function loginFlow(claims: (nonce: string) => Record<string, unknown>, opts: { key?: typeof privateKey; kid?: string } = {}) {
  const start = await fetch(`${t.base}/auth/login?returnTo=%2Fsemana`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get('location') ?? '');
  assert.equal(authorize.origin + authorize.pathname, `${AUTHORITY}/${TENANT}/oauth2/v2.0/authorize`);
  const q = authorize.searchParams;
  assert.equal(q.get('client_id'), CLIENT);
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(q.get('redirect_uri'), `${t.cfg.baseUrl}/auth/callback`);
  const code = `codigo-${Math.random()}`;
  pending.set(code, { nonce: q.get('nonce') ?? '', challenge: q.get('code_challenge') ?? '' });
  nextToken = (nonce) => signToken(claims(nonce), opts.key, opts.kid);
  const cb = await fetch(`${t.base}/auth/callback?code=${code}&state=${q.get('state')}`, { redirect: 'manual' });
  return { cb, state: q.get('state') ?? '', code };
}

async function me(cookieHeader: string | null) {
  const res = await fetch(`${t.base}/api/me`, { headers: { Cookie: (cookieHeader ?? '').split(';')[0] } });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

test('login completo cria sessão de professor e volta para a página pedida', async () => {
  const { cb } = await loginFlow((n) => baseClaims(n));
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('location'), '/semana');
  assert.equal(lastVerifierOk, true, 'PKCE conferido');
  const cookie = cb.headers.get('set-cookie');
  assert.match(cookie ?? '', /HttpOnly/);
  assert.match(cookie ?? '', /SameSite=Lax/);
  const res = await me(cookie);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.user, { id: 'oid-ana', name: 'Ana Ribeiro', email: 'ana@escola.edu.br', role: 'professor' });
  assert.equal(res.body.authMode, 'entra');
});

test('coordenação por App role, por grupo ou por e-mail', async () => {
  for (const extra of [
    { roles: ['Coordenacao'] },
    { groups: ['outro', 'grupo-coord'] },
    { preferred_username: 'Diretora@escola.edu.br', oid: 'oid-dir' },
  ]) {
    const { cb } = await loginFlow((n) => baseClaims(n, { oid: 'oid-x', ...extra }));
    const res = await me(cb.headers.get('set-cookie'));
    assert.equal(res.body.user.role, 'coordenacao', JSON.stringify(extra));
  }
});

test('tokens inválidos não entram', async () => {
  const bad: [string, (n: string) => Record<string, unknown>, { key?: typeof privateKey; kid?: string }?][] = [
    ['nonce errado', (n) => baseClaims(`${n}x`)],
    ['outro aplicativo', (n) => baseClaims(n, { aud: 'outro-app' })],
    ['outra organização', (n) => baseClaims(n, { tid: '99999999-0000-0000-0000-000000000000' })],
    ['emissor falso', (n) => baseClaims(n, { iss: 'https://falso.example/v2.0' })],
    ['expirado', (n) => baseClaims(n, { exp: Math.floor(Date.now() / 1000) - 3600 })],
    ['assinado com outra chave', (n) => baseClaims(n), { key: otherKey }],
    ['chave desconhecida', (n) => baseClaims(n), { kid: 'nao-existe' }],
  ];
  for (const [label, claims, opts] of bad) {
    const { cb } = await loginFlow(claims, opts);
    assert.equal(cb.status, 401, label);
    assert.equal(cb.headers.get('set-cookie'), null, label);
  }
});

test('state reutilizado ou inventado é recusado', async () => {
  const { cb, state, code } = await loginFlow((n) => baseClaims(n));
  assert.equal(cb.status, 302);
  const replay = await fetch(`${t.base}/auth/callback?code=${code}&state=${state}`, { redirect: 'manual' });
  assert.equal(replay.status, 400);
  const fake = await fetch(`${t.base}/auth/callback?code=x&state=inventado`, { redirect: 'manual' });
  assert.equal(fake.status, 400);
});

test('returnTo externo é ignorado (sem redirecionamento aberto)', async () => {
  const start = await fetch(`${t.base}/auth/login?returnTo=https%3A%2F%2Fmal.example`, { redirect: 'manual' });
  const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? '';
  const row = t.app.db.raw.prepare('SELECT return_to FROM login_states WHERE state = ?').get(state) as { return_to: string };
  assert.equal(row.return_to, '/');
});

test('sair apaga a sessão e devolve o endereço de saída da Microsoft', async () => {
  const { cb } = await loginFlow((n) => baseClaims(n));
  const cookie = (cb.headers.get('set-cookie') ?? '').split(';')[0];
  const out = await fetch(`${t.base}/auth/logout`, { method: 'POST', headers: { Cookie: cookie, 'X-Requested-With': 'agendamento' } });
  const body = (await out.json()) as { redirect: string };
  assert.match(body.redirect, new RegExp(`^${AUTHORITY}/${TENANT}/oauth2/v2.0/logout`));
  assert.equal((await me(cookie)).status, 401);
});

test('o login de desenvolvimento não existe com o login Microsoft ativo', async () => {
  const res = await fetch(`${t.base}/auth/dev-login`, { method: 'POST', body: 'name=x&email=x@x', redirect: 'manual' });
  assert.equal(res.status, 404);
});
