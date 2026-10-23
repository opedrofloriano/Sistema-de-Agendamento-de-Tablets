// Login com a conta Microsoft da escola (Microsoft Entra ID, OpenID Connect).
//
// Fluxo: /auth/login → página da Microsoft → /auth/callback → sessão em cookie HttpOnly.
// - Authorization Code com PKCE, state e nonce.
// - O id_token é validado aqui: assinatura RS256 com as chaves públicas (JWKS) do tenant,
//   emissor, audiência, tenant, validade e nonce.
// - Papel de coordenação: App role (recomendado), grupo do Entra ou lista de e-mails.
//
// Em AUTH_MODE=dev existe uma tela de login falsa para testes locais. Ela é recusada em produção.

import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature } from 'node:crypto';
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

export function roleFromClaims(
  claims: IdTokenClaims,
  entra: EntraConfig,
  coordinatorEmails: string[],
  tiEmails: string[] = [],
): UserRole {
  const email = (claims.preferred_username ?? claims.email ?? '').toLowerCase();
  // TI tem precedência: quem é das duas equipes vê tudo.
  if (claims.roles?.includes(entra.tiAppRole)) return 'ti';
  if (claims.groups?.some((g) => entra.tiGroupIds.includes(g))) return 'ti';
  if (email && tiEmails.includes(email)) return 'ti';
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

  async currentUser(req: IncomingMessage): Promise<User | null> {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    return sid ? this.db.getSessionUser(sid) : null;
  }

  private async startSession(res: ServerResponse, user: User): Promise<void> {
    await this.db.upsertUser(user);
    const sid = randomToken(32);
    const ttlMs = this.cfg.sessionHours * 3600 * 1000;
    await this.db.createSession(sid, user.id, ttlMs);
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

  private async clearSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (sid) await this.db.deleteSession(sid);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.secure ? '; Secure' : ''}`);
  }

  /** GET /auth/login */
  async login(url: URL, res: ServerResponse): Promise<void> {
    const returnTo = safeReturnTo(url.searchParams.get('returnTo'));
    if (this.cfg.authMode === 'dev') {
      sendHtml(res, 200, devLoginPage(returnTo));
      return;
    }
    if (this.cfg.authMode === 'piloto') {
      sendHtml(res, 200, pilotLoginPage(returnTo));
      return;
    }
    const entra = this.cfg.entra as EntraConfig;
    const state = randomToken(24);
    const nonce = randomToken(24);
    const verifier = randomToken(48);
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    await this.db.saveLoginState(state, nonce, verifier, returnTo, LOGIN_TTL_MS);
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
    const saved = state ? await this.db.takeLoginState(state) : null;
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
      await this.startSession(res, {
        id: claims.oid,
        name: (claims.name ?? email) || 'Usuário',
        email,
        role: roleFromClaims(claims, entra, this.cfg.coordinatorEmails, this.cfg.tiEmails),
      });
      res.writeHead(302, { Location: saved.returnTo, 'Cache-Control': 'no-store' });
      res.end();
    } catch (err) {
      console.error('[auth] falha no callback:', err);
      sendHtml(res, 401, messagePage('Não foi possível entrar', 'O login não pôde ser confirmado. Tente de novo; se continuar, fale com a TI.', true));
    }
  }

  /** POST /auth/dev-login (somente AUTH_MODE=dev) */
  async devLogin(form: URLSearchParams, res: ServerResponse): Promise<void> {
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
    const chosen = form.get('role');
    const role: UserRole =
      chosen === 'ti' || this.cfg.tiEmails.includes(email)
        ? 'ti'
        : chosen === 'coordenacao' || form.get('coord') === 'on' || this.cfg.coordinatorEmails.includes(email)
          ? 'coordenacao'
          : 'professor';
    await this.startSession(res, { id: `dev:${email}`, name, email, role });
    res.writeHead(303, { Location: safeReturnTo(form.get('returnTo')) });
    res.end();
  }

  /**
   * POST /auth/pilot-login (somente AUTH_MODE=piloto).
   * Todos digitam o nome e o código de acesso da escola. Quem informa a senha da coordenação
   * entra como coordenação; senha errada não entra (não vira professor por engano).
   */
  async pilotLogin(form: URLSearchParams, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.cfg.authMode !== 'piloto' || !this.cfg.pilot) {
      sendHtml(res, 404, messagePage('Página não encontrada', ''));
      return;
    }
    const returnTo = safeReturnTo(form.get('returnTo'));
    const origin = req.headers.origin;
    if (origin && origin !== new URL(this.cfg.baseUrl).origin) {
      sendHtml(res, 403, messagePage('Requisição recusada', 'Abra o sistema pelo endereço oficial e tente de novo.', true));
      return;
    }
    const ip = clientIp(req);
    if (loginLimiter.blocked(ip)) {
      sendHtml(res, 429, pilotLoginPage(returnTo, 'Muitas tentativas erradas. Espere 15 minutos e tente de novo.'));
      return;
    }
    const name = (form.get('name') ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const code = (form.get('code') ?? '').trim();
    const coordPassword = (form.get('coordPassword') ?? '').trim();
    if (!name) {
      sendHtml(res, 400, pilotLoginPage(returnTo, 'Informe seu nome.'));
      return;
    }
    if (!sameSecret(code, this.cfg.pilot.accessCode)) {
      loginLimiter.fail(ip);
      sendHtml(res, 401, pilotLoginPage(returnTo, 'Código de acesso incorreto.', name));
      return;
    }
    let role: UserRole = 'professor';
    if (coordPassword) {
      // Um campo só: a senha diz se é coordenação ou TI.
      const { tiPassword, coordinatorPassword } = this.cfg.pilot;
      if (tiPassword && sameSecret(coordPassword, tiPassword)) role = 'ti';
      else if (sameSecret(coordPassword, coordinatorPassword)) role = 'coordenacao';
      else {
        loginLimiter.fail(ip);
        sendHtml(res, 401, pilotLoginPage(returnTo, 'Senha incorreta. Se você é professor(a), deixe esse campo em branco.', name));
        return;
      }
    }
    loginLimiter.reset(ip);
    // O mesmo nome (sem diferença de acento ou maiúscula) é sempre a mesma pessoa.
    const key = name.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
    await this.startSession(res, { id: `piloto:${key}`, name, email: '', role });
    res.writeHead(303, { Location: returnTo });
    res.end();
  }

  /** POST /auth/logout → { redirect } */
  async logout(req: IncomingMessage, res: ServerResponse): Promise<{ redirect: string }> {
    await this.clearSession(req, res);
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
input[type=text],input[type=email],input[type=password],select{height:40px;border:1px solid var(--line);border-radius:8px;padding:0 12px;background:transparent;color:inherit;font:inherit}
.check{display:flex;align-items:center;gap:8px;font-weight:400}
button,a.btn{display:inline-flex;align-items:center;justify-content:center;height:40px;padding:0 18px;border:0;border-radius:8px;background:var(--accent);color:var(--on);font:inherit;font-weight:600;font-size:14px;text-decoration:none;cursor:pointer;width:100%}
.warn{font-size:12.5px;background:#fef7e0;color:#7a4b00;border-radius:8px;padding:8px 10px}
@media(prefers-color-scheme:dark){.warn{background:#3a2f12;color:#fdd663}}
.err{color:#c5221f}`;

function messagePage(title: string, text: string, retry = false): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Agendamento de Tablets</title><style>${PAGE_STYLE}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(text)}</p>${retry ? '<a class="btn" href="/auth/login">Entrar de novo</a>' : ''}</main></body></html>`;
}

/** Compara segredos em tempo constante (não revela quantos caracteres acertaram). */
function sameSecret(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** IP de quem acessa. Atrás do proxy da hospedagem, vem no X-Forwarded-For. */
function clientIp(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || 'desconhecido';
}

/** Bloqueia por 15 minutos depois de 10 tentativas erradas do mesmo IP. */
class LoginLimiter {
  private readonly fails = new Map<string, { count: number; until: number }>();
  private readonly max = 10;
  private readonly windowMs = 15 * 60 * 1000;
  blocked(ip: string): boolean {
    const f = this.fails.get(ip);
    if (!f) return false;
    if (Date.now() > f.until) {
      this.fails.delete(ip);
      return false;
    }
    return f.count >= this.max;
  }
  fail(ip: string): void {
    const now = Date.now();
    const f = this.fails.get(ip);
    if (!f || now > f.until) this.fails.set(ip, { count: 1, until: now + this.windowMs });
    else f.count += 1;
  }
  reset(ip: string): void {
    this.fails.delete(ip);
  }
}
export const loginLimiter = new LoginLimiter();

function pilotLoginPage(returnTo: string, error = '', name = ''): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Entrar · Agendamento de Tablets</title><style>${PAGE_STYLE}
.hint{font-size:12.5px;color:var(--muted);margin:-8px 0 14px}details{margin:4px 0 16px}summary{cursor:pointer;font-size:13px;color:var(--accent);font-weight:600}details label{margin-top:12px}</style></head>
<body><main><h1>Agendamento de Tablets</h1><p>Entre com seu nome e o código de acesso que a escola passou.</p>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/auth/pilot-login">
<input type="hidden" name="returnTo" value="${esc(returnTo)}">
<label for="name">Seu nome<input id="name" name="name" type="text" required maxlength="80" autocomplete="name" value="${esc(name)}"></label>
<p class="hint">Use sempre o mesmo nome: é por ele que o sistema sabe quais reservas são suas.</p>
<label for="code">Código de acesso<input id="code" name="code" type="password" required autocomplete="off"></label>
<details><summary>Sou da coordenação ou da TI</summary>
<label for="coordPassword">Senha da coordenação ou da TI<input id="coordPassword" name="coordPassword" type="password" autocomplete="off"></label></details>
<button type="submit">Entrar</button></form></main></body></html>`;
}

function devLoginPage(returnTo: string, error = ''): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Entrar · Agendamento de Tablets</title><style>${PAGE_STYLE}</style></head>
<body><main><h1>Entrar</h1><p class="warn">Modo de desenvolvimento: este login não confere senha. Em produção, o acesso é pela conta Microsoft da escola.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/auth/dev-login">
<input type="hidden" name="returnTo" value="${esc(returnTo)}">
<label for="name">Nome<input id="name" name="name" type="text" required maxlength="80" autocomplete="name"></label>
<label for="email">E-mail<input id="email" name="email" type="email" required maxlength="120" autocomplete="email"></label>
<label for="role">Perfil<select id="role" name="role"><option value="professor">Professor(a)</option><option value="coordenacao">Coordenação</option><option value="ti">TI</option></select></label>
<button type="submit">Entrar</button></form></main></body></html>`;
}
