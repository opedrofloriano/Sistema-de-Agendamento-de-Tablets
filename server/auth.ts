// Login com a conta Microsoft da escola (Microsoft Entra ID, OpenID Connect).
//
// Fluxo: /auth/login → página da Microsoft → /auth/callback → sessão em cookie HttpOnly.
// - Authorization Code com PKCE, state e nonce.
// - O id_token é validado aqui: assinatura RS256 com as chaves públicas (JWKS) do tenant,
//   emissor, audiência, tenant, validade e nonce.
// - Papel de coordenação: App role (recomendado), grupo do Entra ou lista de e-mails.
//
// Em AUTH_MODE=dev existe uma tela de login falsa para testes locais. Ela é recusada em produção.

import { createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { User, UserRole } from '../shared/types.ts';
import type { EntraConfig, ServerConfig } from './config.ts';
import type { Database } from './db.ts';

export const SESSION_COOKIE = 'tablets_session';
const LOGIN_TTL_MS = 10 * 60 * 1000;

const b64url = (buf: Buffer): string => buf.toString('base64url');
const randomToken = (bytes = 32): string => b64url(randomBytes(bytes));

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Só aceita caminhos internos, para não virar um redirecionamento aberto. */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
}

// ------------------------------------------------------------------ JWT / JWKS

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  [k: string]: unknown;
}

export interface IdTokenClaims {
  iss: string;
  aud: string;
  tid: string;
  oid: string;
  exp: number;
  nbf?: number;
  nonce?: string;
  name?: string;
  preferred_username?: string;
  email?: string;
  roles?: string[];
  groups?: string[];
}

export class JwksCache {
  private keys = new Map<string, Jwk>();
  private fetchedAt = 0;
  private readonly url: string;
  private readonly fetchFn: typeof fetch;

  constructor(url: string, fetchFn: typeof fetch = fetch) {
    this.url = url;
    this.fetchFn = fetchFn;
  }

  private async refresh(): Promise<void> {
    const res = await this.fetchFn(this.url);
    if (!res.ok) throw new Error(`Não foi possível baixar as chaves do Microsoft Entra (${res.status}).`);
    const body = (await res.json()) as { keys: Jwk[] };
    this.keys = new Map(body.keys.filter((k) => k.kty === 'RSA').map((k) => [k.kid, k]));
    this.fetchedAt = Date.now();
  }

  async get(kid: string): Promise<Jwk> {
    const stale = Date.now() - this.fetchedAt > 60 * 60 * 1000;
    if (stale || !this.keys.has(kid)) await this.refresh();
    const key = this.keys.get(kid);
    if (!key) throw new Error('Chave de assinatura desconhecida no token.');
    return key;
  }
}

export async function verifyIdToken(
  token: string,
  entra: EntraConfig,
  jwks: JwksCache,
  expectedNonce: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<IdTokenClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Token mal formado.');
  const [h, p, s] = parts;
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { alg: string; kid: string };
  if (header.alg !== 'RS256' || !header.kid) throw new Error('Algoritmo de assinatura não aceito.');
  const jwk = await jwks.get(header.kid);
  const key = createPublicKey({ key: jwk, format: 'jwk' } as unknown as Parameters<typeof createPublicKey>[0]);
  const valid = verifySignature('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
  if (!valid) throw new Error('Assinatura do token inválida.');

  const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as IdTokenClaims;
  const issuer = `${entra.authorityBase}/${entra.tenantId}/v2.0`;
  const skew = 120;
  if (claims.iss !== issuer) throw new Error('Emissor do token inesperado.');
  if (claims.aud !== entra.clientId) throw new Error('Token emitido para outro aplicativo.');
  if (claims.tid !== entra.tenantId) throw new Error('Conta de outra organização.');
  if (typeof claims.exp !== 'number' || claims.exp + skew < nowSeconds) throw new Error('Token expirado.');
  if (typeof claims.nbf === 'number' && claims.nbf - skew > nowSeconds) throw new Error('Token ainda não é válido.');
  if (!claims.nonce || claims.nonce !== expectedNonce) throw new Error('Nonce do token não confere.');
  if (!claims.oid) throw new Error('Token sem identificação do usuário.');
  return claims;
}

export function roleFromClaims(claims: IdTokenClaims, entra: EntraConfig, coordinatorEmails: string[]): UserRole {
  const email = (claims.preferred_username ?? claims.email ?? '').toLowerCase();
  if (claims.roles?.includes(entra.coordinatorAppRole)) return 'coordenacao';
  if (claims.groups?.some((g) => entra.coordinatorGroupIds.includes(g))) return 'coordenacao';
  if (email && coordinatorEmails.includes(email)) return 'coordenacao';
  return 'professor';
}

// ------------------------------------------------------------------ rotas de autenticação

export class Auth {
  private readonly cfg: ServerConfig;
  private readonly db: Database;
  private readonly jwks: JwksCache | null;
  private readonly fetchFn: typeof fetch;

  constructor(cfg: ServerConfig, db: Database, fetchFn: typeof fetch = fetch) {
    this.cfg = cfg;
    this.db = db;
    this.fetchFn = fetchFn;
    this.jwks = cfg.entra
      ? new JwksCache(`${cfg.entra.authorityBase}/${cfg.entra.tenantId}/discovery/v2.0/keys`, fetchFn)
      : null;
  }

  private get secure(): boolean {
    return this.cfg.baseUrl.startsWith('https://');
  }

  private get redirectUri(): string {
    return `${this.cfg.baseUrl}/auth/callback`;
  }

  currentUser(req: IncomingMessage): User | null {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    return sid ? this.db.getSessionUser(sid) : null;
  }

  private startSession(res: ServerResponse, user: User): void {
    this.db.upsertUser(user);
    const sid = randomToken(32);
    const ttlMs = this.cfg.sessionHours * 3600 * 1000;
    this.db.createSession(sid, user.id, ttlMs);
    const attrs = [
      `${SESSION_COOKIE}=${sid}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(ttlMs / 1000)}`,
    ];
    if (this.secure) attrs.push('Secure');
    res.setHeader('Set-Cookie', attrs.join('; '));
  }

  private clearSession(req: IncomingMessage, res: ServerResponse): void {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (sid) this.db.deleteSession(sid);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.secure ? '; Secure' : ''}`);
  }

  /** GET /auth/login */
  login(url: URL, res: ServerResponse): void {
    const returnTo = safeReturnTo(url.searchParams.get('returnTo'));
    if (this.cfg.authMode === 'dev') {
      sendHtml(res, 200, devLoginPage(returnTo));
      return;
    }
    const entra = this.cfg.entra as EntraConfig;
    const state = randomToken(24);
    const nonce = randomToken(24);
    const verifier = randomToken(48);
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    this.db.saveLoginState(state, nonce, verifier, returnTo, LOGIN_TTL_MS);
    const authorize = new URL(`${entra.authorityBase}/${entra.tenantId}/oauth2/v2.0/authorize`);
    authorize.search = new URLSearchParams({
      client_id: entra.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      response_mode: 'query',
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    res.writeHead(302, { Location: authorize.toString(), 'Cache-Control': 'no-store' });
    res.end();
  }

  /** GET /auth/callback */
  async callback(url: URL, res: ServerResponse): Promise<void> {
    if (this.cfg.authMode !== 'entra' || !this.cfg.entra || !this.jwks) {
      sendHtml(res, 404, messagePage('Página não encontrada', 'Esta rota só existe com o login Microsoft ativo.'));
      return;
    }
    const entra = this.cfg.entra;
    const msError = url.searchParams.get('error');
    if (msError) {
      const desc = url.searchParams.get('error_description') ?? msError;
      sendHtml(res, 401, messagePage('Não foi possível entrar', `A Microsoft recusou o login: ${desc}`, true));
      return;
    }
    const state = url.searchParams.get('state') ?? '';
    const code = url.searchParams.get('code') ?? '';
    const saved = state ? this.db.takeLoginState(state) : null;
    if (!saved || !code) {
      sendHtml(res, 400, messagePage('O login expirou', 'Volte e tente entrar de novo.', true));
      return;
    }

    try {
      const tokenRes = await this.fetchFn(`${entra.authorityBase}/${entra.tenantId}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: entra.clientId,
          client_secret: entra.clientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: this.redirectUri,
          code_verifier: saved.verifier,
          scope: 'openid profile email',
        }).toString(),
      });
      const tokens = (await tokenRes.json()) as { id_token?: string; error_description?: string };
      if (!tokenRes.ok || !tokens.id_token) throw new Error(tokens.error_description ?? `Erro ${tokenRes.status} ao trocar o código.`);

      const claims = await verifyIdToken(tokens.id_token, entra, this.jwks, saved.nonce);
      if (entra.allowedGroupIds.length && !claims.groups?.some((g) => entra.allowedGroupIds.includes(g))) {
        sendHtml(res, 403, messagePage('Acesso não liberado', 'Sua conta não está no grupo autorizado a usar o agendamento. Fale com a TI.'));
        return;
      }
      const email = claims.preferred_username ?? claims.email ?? '';
      this.startSession(res, {
        id: claims.oid,
        name: (claims.name ?? email) || 'Usuário',
        email,
        role: roleFromClaims(claims, entra, this.cfg.coordinatorEmails),
      });
      res.writeHead(302, { Location: saved.returnTo, 'Cache-Control': 'no-store' });
      res.end();
    } catch (err) {
      console.error('[auth] falha no callback:', err);
      sendHtml(res, 401, messagePage('Não foi possível entrar', 'O login não pôde ser confirmado. Tente de novo; se continuar, fale com a TI.', true));
    }
  }

  /** POST /auth/dev-login (somente AUTH_MODE=dev) */
  devLogin(form: URLSearchParams, res: ServerResponse): void {
    if (this.cfg.authMode !== 'dev') {
      sendHtml(res, 404, messagePage('Página não encontrada', ''));
      return;
    }
    const name = (form.get('name') ?? '').trim().slice(0, 80);
    const email = (form.get('email') ?? '').trim().toLowerCase().slice(0, 120);
    if (!name || !email) {
      sendHtml(res, 400, devLoginPage(safeReturnTo(form.get('returnTo')), 'Preencha nome e e-mail.'));
      return;
    }
    const role: UserRole =
      form.get('coord') === 'on' || this.cfg.coordinatorEmails.includes(email) ? 'coordenacao' : 'professor';
    this.startSession(res, { id: `dev:${email}`, name, email, role });
    res.writeHead(303, { Location: safeReturnTo(form.get('returnTo')) });
    res.end();
  }

  /** POST /auth/logout → { redirect } */
  logout(req: IncomingMessage, res: ServerResponse): { redirect: string } {
    this.clearSession(req, res);
    if (this.cfg.authMode === 'entra' && this.cfg.entra) {
      const u = new URL(`${this.cfg.entra.authorityBase}/${this.cfg.entra.tenantId}/oauth2/v2.0/logout`);
      u.searchParams.set('post_logout_redirect_uri', `${this.cfg.baseUrl}/`);
      return { redirect: u.toString() };
    }
    return { redirect: '/auth/login' };
  }
}

// ------------------------------------------------------------------ páginas simples

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

const PAGE_STYLE = `
:root{color-scheme:light dark;--bg:#f8fafd;--card:#fff;--text:#202124;--muted:#5f6368;--line:#dadce0;--accent:#1a73e8;--on:#fff}
@media(prefers-color-scheme:dark){:root{--bg:#0b0b0d;--card:#141416;--text:#f4f4f5;--muted:#a1a1aa;--line:rgba(255,255,255,.12);--accent:#8ab4f8;--on:#0b1a33}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.5 Inter,"Segoe UI",Roboto,Arial,sans-serif;padding:16px}
main{width:min(420px,100%);background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px}
h1{font-size:22px;font-weight:500;margin:0 0 8px}p{color:var(--muted);margin:0 0 18px}
label{display:grid;gap:6px;font-size:13px;font-weight:500;margin-bottom:14px}
input[type=text],input[type=email]{height:40px;border:1px solid var(--line);border-radius:8px;padding:0 12px;background:transparent;color:inherit;font:inherit}
.check{display:flex;align-items:center;gap:8px;font-weight:400}
button,a.btn{display:inline-flex;align-items:center;justify-content:center;height:40px;padding:0 18px;border:0;border-radius:8px;background:var(--accent);color:var(--on);font:600 14px inherit;text-decoration:none;cursor:pointer;width:100%}
.warn{font-size:12.5px;background:#fef7e0;color:#7a4b00;border-radius:8px;padding:8px 10px}
@media(prefers-color-scheme:dark){.warn{background:#3a2f12;color:#fdd663}}
.err{color:#c5221f}`;

function messagePage(title: string, text: string, retry = false): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Agendamento de Tablets</title><style>${PAGE_STYLE}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(text)}</p>${retry ? '<a class="btn" href="/auth/login">Entrar de novo</a>' : ''}</main></body></html>`;
}

function devLoginPage(returnTo: string, error = ''): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Entrar · Agendamento de Tablets</title><style>${PAGE_STYLE}</style></head>
<body><main><h1>Entrar</h1><p class="warn">Modo de desenvolvimento: este login não confere senha. Em produção, o acesso é pela conta Microsoft da escola.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/auth/dev-login">
<input type="hidden" name="returnTo" value="${esc(returnTo)}">
<label for="name">Nome<input id="name" name="name" type="text" required maxlength="80" autocomplete="name"></label>
<label for="email">E-mail<input id="email" name="email" type="email" required maxlength="120" autocomplete="email"></label>
<label class="check" for="coord"><input id="coord" name="coord" type="checkbox"> Sou da coordenação</label>
<button type="submit">Entrar</button></form></main></body></html>`;
}
