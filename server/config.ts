// Configuração do servidor: variáveis de ambiente (.env) + regras da escola (config/escola.json).

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_CONFIG } from '../shared/rules.ts';
import type { AppConfig, Unit } from '../shared/types.ts';

export interface EntraConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Normalmente https://login.microsoftonline.com (troque só para testes ou nuvens soberanas). */
  authorityBase: string;
  /** Papel do aplicativo (App role) que identifica a coordenação. */
  coordinatorAppRole: string;
  coordinatorGroupIds: string[];
  /** Papel do aplicativo (App role) que identifica a TI. */
  tiAppRole: string;
  tiGroupIds: string[];
  allowedGroupIds: string[];
}

export interface ServerConfig {
  nodeEnv: string;
  port: number;
  host: string;
  /** Endereço público do sistema, sem barra no fim. Ex.: https://tablets.escola.edu.br */
  baseUrl: string;
  dbPath: string;
  /** Banco na Turso (libsql://…). Quando preenchido, substitui o arquivo local `dbPath`. */
  databaseUrl?: string;
  databaseAuthToken?: string;
  publicDir: string;
  sessionHours: number;
  /** Quem pode exibir o sistema dentro de um iframe (CSP frame-ancestors). */
  frameAncestors: string;
  authMode: 'entra' | 'piloto' | 'dev';
  /** Modo piloto: código que todos digitam para entrar e senha da coordenação. */
  pilot: { accessCode: string; coordinatorPassword: string; tiPassword: string | null } | null;
  coordinatorEmails: string[];
  tiEmails: string[];
  entra: EntraConfig | null;
  app: AppConfig;
}

const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function loadSchoolConfig(path: string): AppConfig {
  if (!existsSync(path)) return DEFAULT_CONFIG;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<AppConfig> & {
    units?: unknown;
    totalTablets?: number;
  };
  // Formato antigo: "units": ["A", "B"] + "totalTablets": 30 → cada unidade com esse total.
  const units: Unit[] | undefined = Array.isArray(raw.units)
    ? raw.units.map((u) =>
        typeof u === 'string' ? { name: u, tablets: raw.totalTablets ?? 30 } : (u as Unit),
      )
    : undefined;
  const { totalTablets: _legacy, ...rest } = raw;
  const cfg: AppConfig = {
    ...DEFAULT_CONFIG,
    ...rest,
    units: units ?? DEFAULT_CONFIG.units,
    limits: { ...DEFAULT_CONFIG.limits, ...(raw.limits ?? {}) },
  };
  if (cfg.units.length === 0) throw new Error(`${path}: informe pelo menos uma unidade em "units".`);
  const names = new Set<string>();
  for (const u of cfg.units) {
    if (typeof u.name !== 'string' || !u.name.trim()) throw new Error(`${path}: toda unidade precisa de "name".`);
    if (names.has(u.name)) throw new Error(`${path}: unidade repetida (${u.name}).`);
    names.add(u.name);
    if (!Number.isInteger(u.tablets) || u.tablets < 1)
      throw new Error(`${path}: "tablets" da unidade ${u.name} precisa ser um inteiro maior que zero.`);
  }
  for (const p of cfg.periods) {
    if (!/^\d{2}:\d{2}$/.test(p.start) || !/^\d{2}:\d{2}$/.test(p.end) || p.start >= p.end)
      throw new Error(`${path}: horário de aula inválido (${p.id}).`);
  }
  if (cfg.dayStartMinutes >= cfg.dayEndMinutes)
    throw new Error(`${path}: dayStartMinutes precisa ser menor que dayEndMinutes.`);
  return cfg;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, root = process.cwd()): ServerConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const rawMode = (env.AUTH_MODE ?? 'entra').toLowerCase();
  const authMode = rawMode === 'dev' ? 'dev' : rawMode === 'piloto' || rawMode === 'pilot' ? 'piloto' : 'entra';
  if (authMode === 'dev' && nodeEnv === 'production')
    throw new Error('AUTH_MODE=dev não pode ser usado com NODE_ENV=production. Para uso real sem Microsoft, use AUTH_MODE=piloto.');

  let pilot: ServerConfig['pilot'] = null;
  if (authMode === 'piloto') {
    const accessCode = (env.ACCESS_CODE ?? '').trim();
    const coordinatorPassword = (env.COORDINATOR_PASSWORD ?? '').trim();
    if (accessCode.length < 6) throw new Error('AUTH_MODE=piloto: defina ACCESS_CODE com pelo menos 6 caracteres.');
    if (coordinatorPassword.length < 8)
      throw new Error('AUTH_MODE=piloto: defina COORDINATOR_PASSWORD com pelo menos 8 caracteres.');
    if (accessCode === coordinatorPassword)
      throw new Error('AUTH_MODE=piloto: ACCESS_CODE e COORDINATOR_PASSWORD precisam ser diferentes.');
    const tiPassword = (env.TI_PASSWORD ?? '').trim() || null;
    if (tiPassword !== null) {
      if (tiPassword.length < 8) throw new Error('AUTH_MODE=piloto: TI_PASSWORD precisa ter pelo menos 8 caracteres.');
      if (tiPassword === accessCode || tiPassword === coordinatorPassword)
        throw new Error('AUTH_MODE=piloto: TI_PASSWORD precisa ser diferente do código e da senha da coordenação.');
    }
    pilot = { accessCode, coordinatorPassword, tiPassword };
  }

  const port = Number(env.PORT ?? 3000);
  // Na Render, RENDER_EXTERNAL_URL já traz o endereço público com https.
  const baseUrl = (env.BASE_URL ?? env.RENDER_EXTERNAL_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');

  let entra: EntraConfig | null = null;
  if (authMode === 'entra') {
    const tenantId = env.ENTRA_TENANT_ID ?? '';
    const clientId = env.ENTRA_CLIENT_ID ?? '';
    const clientSecret = env.ENTRA_CLIENT_SECRET ?? '';
    const missing = [
      ['ENTRA_TENANT_ID', tenantId],
      ['ENTRA_CLIENT_ID', clientId],
      ['ENTRA_CLIENT_SECRET', clientSecret],
    ]
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length) throw new Error(`Faltam variáveis para o login Microsoft: ${missing.join(', ')}.`);
    entra = {
      tenantId,
      clientId,
      clientSecret,
      authorityBase: (env.ENTRA_AUTHORITY_BASE ?? 'https://login.microsoftonline.com').replace(/\/+$/, ''),
      coordinatorAppRole: env.ENTRA_COORDINATOR_APP_ROLE ?? 'Coordenacao',
      coordinatorGroupIds: list(env.ENTRA_COORDINATOR_GROUP_IDS),
      tiAppRole: env.ENTRA_TI_APP_ROLE ?? 'TI',
      tiGroupIds: list(env.ENTRA_TI_GROUP_IDS),
      allowedGroupIds: list(env.ENTRA_ALLOWED_GROUP_IDS),
    };
  }

  const app = loadSchoolConfig(resolve(root, env.SCHOOL_CONFIG ?? 'config/escola.json'));
  return {
    nodeEnv,
    port,
    host: env.HOST ?? '0.0.0.0',
    baseUrl,
    dbPath: resolve(root, env.DATABASE_PATH ?? 'data/agendamento.db'),
    databaseUrl: (env.DATABASE_URL ?? env.TURSO_DATABASE_URL ?? '').trim() || undefined,
    databaseAuthToken: (env.DATABASE_AUTH_TOKEN ?? env.TURSO_AUTH_TOKEN ?? '').trim() || undefined,
    publicDir: resolve(root, env.PUBLIC_DIR ?? 'dist/public'),
    sessionHours: Number(env.SESSION_HOURS ?? 12),
    frameAncestors: env.FRAME_ANCESTORS ?? "'self'",
    authMode,
    pilot,
    coordinatorEmails: list(env.COORDINATOR_EMAILS).map((e) => e.toLowerCase()),
    tiEmails: list(env.TI_EMAILS).map((e) => e.toLowerCase()),
    entra,
    app,
  };
}
