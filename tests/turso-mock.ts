// Simulador da API HTTP da Turso (protocolo Hrana, POST /v2/pipeline), para testar o
// sistema sem acesso à internet. É rigoroso de propósito: recusa formatos de valor errados,
// baton desconhecido, token errado e comandos de outra conexão enquanto há uma transação aberta
// (como o banco real faria ao bloquear a gravação).

import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

type V = { type: string; value?: unknown; base64?: string };

function decodeArg(v: V): string | number | null {
  switch (v.type) {
    case 'null':
      return null;
    case 'integer':
      if (typeof v.value !== 'string' || !/^-?\d+$/.test(v.value)) throw new Error(`integer precisa ser string: ${JSON.stringify(v)}`);
      return Number(v.value);
    case 'float':
      if (typeof v.value !== 'number') throw new Error(`float precisa ser número: ${JSON.stringify(v)}`);
      return v.value;
    case 'text':
      if (typeof v.value !== 'string') throw new Error(`text precisa ser string: ${JSON.stringify(v)}`);
      return v.value;
    default:
      throw new Error(`tipo de valor não suportado: ${v.type}`);
  }
}

function encodeCell(v: unknown): V {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  if (typeof v === 'bigint') return { type: 'integer', value: v.toString() };
  return { type: 'text', value: String(v) };
}

export interface TursoMock {
  url: string;
  token: string;
  requests: number;
  close(): Promise<void>;
}

export async function startTursoMock(): Promise<TursoMock> {
  const token = randomBytes(16).toString('hex');
  const db = new DatabaseSync(':memory:');
  const streams = new Set<string>();
  /** Stream que está com transação aberta (só ela pode executar até fechar). */
  let txOwner: string | null = null;
  const state = { requests: 0 };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      state.requests += 1;
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method !== 'POST' || req.url !== '/v2/pipeline') return reply(404, { error: 'not found' });
      if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: 'unauthorized' });
      let body: { baton: string | null; requests: { type: string; stmt?: { sql: string; args?: V[] } }[] };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reply(400, { error: 'json inválido' });
      }
      let stream: string;
      if (body.baton) {
        if (!streams.has(body.baton)) return reply(400, { error: 'baton desconhecido' });
        streams.delete(body.baton);
        stream = body.baton.split('.')[0];
      } else {
        stream = randomBytes(6).toString('hex');
      }
      const results: unknown[] = [];
      let closed = false;
      for (const r of body.requests) {
        if (r.type === 'close') {
          closed = true;
          if (txOwner === stream) {
            db.exec('ROLLBACK');
            txOwner = null;
          }
          results.push({ type: 'ok', response: { type: 'close' } });
          continue;
        }
        if (r.type !== 'execute' || !r.stmt || typeof r.stmt.sql !== 'string') {
          results.push({ type: 'error', error: { message: `requisição inválida: ${JSON.stringify(r)}` } });
          continue;
        }
        if (txOwner && txOwner !== stream) {
          results.push({ type: 'error', error: { message: 'SQLITE_BUSY: database is locked', code: 'SQLITE_BUSY' } });
          continue;
        }
        try {
          const args = (r.stmt.args ?? []).map(decodeArg);
          const sql = r.stmt.sql.trim();
          const upper = sql.toUpperCase();
          if (upper.startsWith('BEGIN')) {
            db.exec(sql);
            txOwner = stream;
            results.push({ type: 'ok', response: { type: 'execute', result: { cols: [], rows: [], affected_row_count: 0, last_insert_rowid: null } } });
            continue;
          }
          if (upper === 'COMMIT' || upper === 'ROLLBACK') {
            db.exec(sql);
            txOwner = null;
            results.push({ type: 'ok', response: { type: 'execute', result: { cols: [], rows: [], affected_row_count: 0, last_insert_rowid: null } } });
            continue;
          }
          const stmt = db.prepare(sql);
          const cols = stmt.columns().map((c) => ({ name: c.name, decltype: c.type ?? null }));
          let rows: V[][] = [];
          let affected = 0;
          if (cols.length > 0) {
            const raw = stmt.all(...args) as Record<string, unknown>[];
            rows = raw.map((row) => cols.map((c) => encodeCell(row[c.name])));
          } else {
            affected = Number(stmt.run(...args).changes);
          }
          results.push({
            type: 'ok',
            response: { type: 'execute', result: { cols, rows, affected_row_count: affected, last_insert_rowid: null } },
          });
        } catch (err) {
          results.push({ type: 'error', error: { message: err instanceof Error ? err.message : String(err) } });
        }
      }
      let baton: string | null = null;
      if (!closed) {
        baton = `${stream}.${randomBytes(8).toString('hex')}`;
        streams.add(baton);
      }
      reply(200, { baton, base_url: null, results });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    get requests() {
      return state.requests;
    },
    set requests(_v: number) {},
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
