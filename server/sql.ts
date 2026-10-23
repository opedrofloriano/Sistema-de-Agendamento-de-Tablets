// Acesso ao banco em duas versões com a mesma interface:
// - LocalSql: arquivo SQLite no próprio servidor (node:sqlite).
// - TursoSql: banco SQLite na nuvem da Turso (turso.tech), pela API HTTP deles.
//   Serve para hospedagens gratuitas que apagam os arquivos a cada reinício (ex.: Render grátis).
//
// As duas executam uma operação de cada vez (fila). Assim uma transação nunca se mistura
// com outra e a conferência dos tablets é feita sempre sobre dados atualizados.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type SqlValue = string | number | null;

export interface Sql {
  all<T>(sql: string, args?: SqlValue[]): Promise<T[]>;
  get<T>(sql: string, args?: SqlValue[]): Promise<T | undefined>;
  run(sql: string, args?: SqlValue[]): Promise<void>;
}

export interface SqlDriver extends Sql {
  /** Executa `fn` dentro de BEGIN IMMEDIATE … COMMIT (ROLLBACK se der erro). */
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: 'local' | 'turso';
}

/** Fila simples: uma operação de cada vez. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }
}

// ------------------------------------------------------------------ arquivo local

export class LocalSql implements SqlDriver {
  readonly kind = 'local' as const;
  private readonly db: DatabaseSync;
  private readonly mutex = new Mutex();

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  }

  private direct(): Sql {
    const db = this.db;
    return {
      all: async <T>(sql: string, args: SqlValue[] = []) => db.prepare(sql).all(...args) as T[],
      get: async <T>(sql: string, args: SqlValue[] = []) => db.prepare(sql).get(...args) as T | undefined,
      run: async (sql: string, args: SqlValue[] = []) => {
        db.prepare(sql).run(...args);
      },
    };
  }

  all<T>(sql: string, args?: SqlValue[]) {
    return this.mutex.lock(() => this.direct().all<T>(sql, args));
  }
  get<T>(sql: string, args?: SqlValue[]) {
    return this.mutex.lock(() => this.direct().get<T>(sql, args));
  }
  run(sql: string, args?: SqlValue[]) {
    return this.mutex.lock(() => this.direct().run(sql, args));
  }

  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
    return this.mutex.lock(async () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(this.direct());
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    });
  }

  async close(): Promise<void> {
    await this.mutex.lock(async () => this.db.close());
  }
}

// ------------------------------------------------------------------ Turso (HTTP)

type HranaValue =
  | { type: 'null' }
  | { type: 'integer'; value: string }
  | { type: 'float'; value: number }
  | { type: 'text'; value: string }
  | { type: 'blob'; base64: string };

interface HranaResult {
  cols: { name: string | null }[];
  rows: HranaValue[][];
}

interface PipelineResponse {
  baton: string | null;
  base_url: string | null;
  results: (
    | { type: 'ok'; response: { type: 'execute'; result: HranaResult } | { type: 'close' } }
    | { type: 'error'; error: { message: string; code?: string } }
  )[];
}

const encode = (v: SqlValue): HranaValue => {
  if (v === null) return { type: 'null' };
  if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  return { type: 'text', value: v };
};

const decode = (v: HranaValue): SqlValue => {
  switch (v.type) {
    case 'null':
      return null;
    case 'integer':
      return Number(v.value);
    case 'float':
      return Number(v.value);
    case 'text':
      return v.value;
    default:
      return null;
  }
};

export class TursoSql implements SqlDriver {
  readonly kind = 'turso' as const;
  private readonly url: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly mutex = new Mutex();

  /** `url` aceita libsql://… (como a Turso mostra) ou https://… */
  constructor(url: string, token: string, fetchFn: typeof fetch = fetch) {
    this.url = url.replace(/^libsql:\/\//, 'https://').replace(/\/+$/, '');
    this.token = token;
    this.fetchFn = fetchFn;
  }

  private async pipeline(
    stmts: { sql: string; args?: SqlValue[] }[],
    opts: { baton?: string | null; baseUrl?: string | null; close?: boolean } = {},
  ): Promise<{ results: HranaResult[]; baton: string | null; baseUrl: string | null }> {
    const requests: object[] = stmts.map((s) => ({
      type: 'execute',
      stmt: { sql: s.sql, args: (s.args ?? []).map(encode) },
    }));
    if (opts.close) requests.push({ type: 'close' });
    const base = opts.baseUrl ?? this.url;
    const res = await this.fetchFn(`${base}/v2/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ baton: opts.baton ?? null, requests }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Banco Turso respondeu ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    const body = (await res.json()) as PipelineResponse;
    const results: HranaResult[] = [];
    for (const r of body.results) {
      if (r.type === 'error') throw new Error(`Erro no banco Turso: ${r.error.message}`);
      if (r.response.type === 'execute') results.push(r.response.result);
    }
    return { results, baton: body.baton, baseUrl: body.base_url };
  }

  private static rows<T>(r: HranaResult): T[] {
    return r.rows.map((row) => {
      const obj: Record<string, SqlValue> = {};
      r.cols.forEach((c, i) => {
        obj[c.name ?? String(i)] = decode(row[i]);
      });
      return obj as T;
    });
  }

  private async once<T>(sql: string, args?: SqlValue[]): Promise<T[]> {
    const { results } = await this.pipeline([{ sql, args }], { close: true });
    return TursoSql.rows<T>(results[0]);
  }

  all<T>(sql: string, args?: SqlValue[]) {
    return this.mutex.lock(() => this.once<T>(sql, args));
  }
  async get<T>(sql: string, args?: SqlValue[]) {
    return (await this.all<T>(sql, args))[0];
  }
  async run(sql: string, args?: SqlValue[]) {
    await this.all(sql, args);
  }

  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
    return this.mutex.lock(async () => {
      const begin = await this.pipeline([{ sql: 'BEGIN IMMEDIATE' }]);
      let baton = begin.baton;
      let baseUrl = begin.baseUrl;
      const step = async <R>(sql: string, args?: SqlValue[]): Promise<R[]> => {
        const r = await this.pipeline([{ sql, args }], { baton, baseUrl });
        baton = r.baton;
        baseUrl = r.baseUrl ?? baseUrl;
        return TursoSql.rows<R>(r.results[0]);
      };
      const tx: Sql = {
        all: step,
        get: async <R>(sql: string, args?: SqlValue[]) => (await step<R>(sql, args))[0],
        run: async (sql: string, args?: SqlValue[]) => {
          await step(sql, args);
        },
      };
      try {
        const result = await fn(tx);
        await this.pipeline([{ sql: 'COMMIT' }], { baton, baseUrl, close: true });
        return result;
      } catch (err) {
        await this.pipeline([{ sql: 'ROLLBACK' }], { baton, baseUrl, close: true }).catch(() => undefined);
        throw err;
      }
    });
  }

  async close(): Promise<void> {
    await this.mutex.lock(async () => undefined);
  }
}
