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
  allowedGroupIds: string[];
}

export interface ServerConfig {
  nodeEnv: string;
  port: number;
  host: string;
  /** Endereço público do sistema, sem barra no fim. Ex.: https://tablets.escola.edu.br */
  baseUrl: string;
  dbPath: string;
  publicDir: string;
  sessionHours: number;
  /** Quem pode exibir o sistema dentro de um iframe (CSP frame-ancestors). */
  frameAncestors: string;
  authMode: 'entra' | 'dev';
  coordinatorEmails: string[];
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
  const authMode = (env.AUTH_MODE ?? 'entra') === 'dev' ? 'dev' : 'entra';
  if (authMode === 'dev' && nodeEnv === 'production')
    throw new Error('AUTH_MODE=dev não pode ser usado com NODE_ENV=production.');

  const port = Number(env.PORT ?? 3000);
  const baseUrl = (env.BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');

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
    publicDir: resolve(root, env.PUBLIC_DIR ?? 'dist/public'),
    sessionHours: Number(env.SESSION_HOURS ?? 12),
    frameAncestors: env.FRAME_ANCESTORS ?? "'self'",
    authMode,
    coordinatorEmails: list(env.COORDINATOR_EMAILS).map((e) => e.toLowerCase()),
    entra,
    app,
  };
}
