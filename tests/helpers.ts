import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type AppHandle } from '../server/app.ts';
import { loadConfig, type ServerConfig } from '../server/config.ts';

process.env.TZ = 'America/Sao_Paulo';

export interface TestApp {
  base: string;
  app: AppHandle;
  cfg: ServerConfig;
  close(): Promise<void>;
}

export async function startApp(
  env: Record<string, string> = {},
  options: { fetchFn?: typeof fetch; now?: () => Date } = {},
): Promise<TestApp> {
  const dir = mkdtempSync(join(tmpdir(), 'tablets-'));
  const cfg = loadConfig(
    { AUTH_MODE: 'dev', NODE_ENV: 'test', DATABASE_PATH: join(dir, 'test.db'), PUBLIC_DIR: join(dir, 'public'), ...env },
    process.cwd(),
  );
  const app = await createApp(cfg, options);
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    app,
    cfg,
    close: async () => {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Entra pelo login de desenvolvimento e devolve o cookie de sessão. */
export async function devLogin(base: string, name: string, email: string, coord = false): Promise<string> {
  const body = new URLSearchParams({ name, email, returnTo: '/' });
  if (coord) body.set('coord', 'on');
  const res = await fetch(`${base}/auth/dev-login`, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
  });
  const cookie = res.headers.get('set-cookie');
  if (res.status !== 303 || !cookie) throw new Error(`login falhou: ${res.status}`);
  return cookie.split(';')[0];
}

export function client(base: string, cookie: string) {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Cookie: cookie,
        'X-Requested-With': 'agendamento',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return {
    get: (path: string) => call('GET', path),
    post: (path: string, body?: unknown) => call('POST', path, body),
  };
}

export const reservationBody = (over: Record<string, unknown> = {}) => ({
  title: 'Aula de teste',
  teacher: '',
  unit: 'Castelo II',
  className: '8º ano A',
  quantity: 10,
  date: '2026-10-21',
  startTime: '08:40',
  endTime: '09:30',
  notes: '',
  ...over,
});

/** Terça-feira, 20/10/2026, 10:00 no horário da escola. */
export const FIXED_NOW = () => new Date(2026, 9, 20, 10, 0);
