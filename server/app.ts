// Servidor HTTP: API, rotas de login e arquivos da interface. Só usa módulos do próprio Node.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import type { MeResponse, User } from '../shared/types.ts';
import { Auth, sendHtml } from './auth.ts';
import type { ServerConfig } from './config.ts';
import { Database } from './db.ts';
import { HttpError, ReservationService } from './reservations.ts';

const MAX_BODY = 16 * 1024;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Requisição grande demais.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json'))
    throw new HttpError(415, 'Envie os dados como JSON.');
  const text = await readBody(req);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'JSON inválido.');
  }
}

export interface AppHandle {
  server: Server;
  db: Database;
  close(): Promise<void>;
}

export function createApp(cfg: ServerConfig, options: { fetchFn?: typeof fetch; now?: () => Date } = {}): AppHandle {
  const db = new Database(cfg.dbPath);
  const auth = new Auth(cfg, db, options.fetchFn);
  const reservations = new ReservationService(db, cfg.app, options.now);

  const securityHeaders: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "form-action 'self'",
      "base-uri 'none'",
      `frame-ancestors ${cfg.frameAncestors}`,
    ].join('; '),
  };
  if (cfg.baseUrl.startsWith('https://')) securityHeaders['Strict-Transport-Security'] = 'max-age=31536000';

  function serveStatic(pathname: string, res: ServerResponse): void {
    const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
    let file = join(cfg.publicDir, rel);
    if (!file.startsWith(cfg.publicDir + sep) && file !== cfg.publicDir) {
      sendJson(res, 400, { error: 'Caminho inválido.' });
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(cfg.publicDir, 'index.html');
    if (!existsSync(file)) {
      sendHtml(res, 503, '<p>A interface ainda não foi gerada. Rode <code>npm run build</code>.</p>');
      return;
    }
    const isHtml = file.endsWith('.html');
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      // index.html nunca fica em cache; os demais arquivos têm hash no nome.
      'Cache-Control': isHtml ? 'no-store' : 'public, max-age=31536000, immutable',
    });
    createReadStream(file).pipe(res);
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL, user: User): Promise<void> {
    const method = req.method ?? 'GET';
    const path = url.pathname;

    if (method !== 'GET' && req.headers['x-requested-with'] !== 'agendamento')
      throw new HttpError(403, 'Requisição recusada.');

    if (method === 'GET' && path === '/api/me') {
      const body: MeResponse = { user, config: cfg.app, authMode: cfg.authMode };
      return sendJson(res, 200, body);
    }
    if (method === 'GET' && path === '/api/reservations') {
      const q = url.searchParams.get('q');
      if (q !== null) return sendJson(res, 200, { reservations: reservations.search(q) });
      const list = reservations.list(url.searchParams.get('from') ?? '', url.searchParams.get('to') ?? '');
      return sendJson(res, 200, { reservations: list });
    }
    if (method === 'GET' && path === '/api/availability') {
      return sendJson(
        res,
        200,
        reservations.availability(
          url.searchParams.get('unit') ?? '',
          url.searchParams.get('start') ?? '',
          url.searchParams.get('end') ?? '',
        ),
      );
    }
    if (method === 'POST' && path === '/api/reservations') {
      const created = reservations.create(user, await readJson(req));
      return sendJson(res, 201, { reservation: created });
    }
    const action = /^\/api\/reservations\/([\w-]{1,64})\/(cancel|return)$/.exec(path);
    if (method === 'POST' && action) {
      const [, id, verb] = action;
      const updated = verb === 'cancel' ? reservations.cancel(user, id) : reservations.registerReturn(user, id);
      return sendJson(res, 200, { reservation: updated });
    }
    throw new HttpError(404, 'Rota não encontrada.');
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    for (const [k, v] of Object.entries(securityHeaders)) res.setHeader(k, v);
    const url = new URL(req.url ?? '/', cfg.baseUrl);
    const method = req.method ?? 'GET';

    try {
      if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });

      if (url.pathname === '/auth/login' && method === 'GET') return auth.login(url, res);
      if (url.pathname === '/auth/callback' && method === 'GET') return await auth.callback(url, res);
      if (url.pathname === '/auth/dev-login' && method === 'POST') {
        const form = new URLSearchParams(await readBody(req));
        return auth.devLogin(form, res);
      }
      if (url.pathname === '/auth/logout' && method === 'POST') {
        if (req.headers['x-requested-with'] !== 'agendamento') throw new HttpError(403, 'Requisição recusada.');
        return sendJson(res, 200, auth.logout(req, res));
      }

      if (url.pathname.startsWith('/api/')) {
        const user = auth.currentUser(req);
        if (!user) return sendJson(res, 401, { error: 'Sua sessão terminou. Entre de novo.' });
        return await api(req, res, url, user);
      }

      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Método não permitido.');
      // A interface só abre para quem está logado.
      if (!auth.currentUser(req) && !/\.(js|css|svg|png|ico|map)$/.test(url.pathname)) {
        res.writeHead(302, { Location: `/auth/login?returnTo=${encodeURIComponent(url.pathname + url.search)}` });
        res.end();
        return;
      }
      return serveStatic(url.pathname, res);
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, err.field ? { error: err.message, field: err.field } : { error: err.message });
        return;
      }
      console.error('[erro]', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Erro interno. Tente de novo em instantes.' });
      else res.end();
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  return {
    server,
    db,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          db.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
