// Dois processos do servidor usando o mesmo arquivo de banco, recebendo reservas ao mesmo tempo.
// Garante que o bloqueio da transação vale entre processos, não só dentro de um.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { addDays, nextWeekday, toDateKey } from '../shared/rules.ts';
import { client, devLogin, reservationBody } from './helpers.ts';

const dir = mkdtempSync(join(tmpdir(), 'tablets-mp-'));
const ports = [41871, 41872];
const procs: ChildProcess[] = [];

function startServer(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/main.ts'], {
      env: {
        ...process.env,
        AUTH_MODE: 'dev',
        NODE_ENV: 'test',
        PORT: String(port),
        HOST: '127.0.0.1',
        DATABASE_PATH: join(dir, 'shared.db'),
        PUBLIC_DIR: join(dir, 'public'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    procs.push(child);
    child.stdout?.on('data', (d: Buffer) => {
      if (d.toString().includes('Agendamento de Tablets em')) resolve();
    });
    child.on('exit', (code) => reject(new Error(`servidor saiu com código ${code}`)));
  });
}

before(async () => {
  await startServer(ports[0]);
  await startServer(ports[1]);
});
after(() => {
  for (const p of procs) p.kill();
  rmSync(dir, { recursive: true, force: true });
});

test('dois servidores, mesmo banco, 12 reservas simultâneas de 10 tablets: só 3 cabem', async () => {
  const bases = ports.map((p) => `http://127.0.0.1:${p}`);
  const cookie = await devLogin(bases[0], 'Ana Ribeiro', 'ana@escola.edu.br');
  // A sessão fica no banco, então o mesmo cookie vale nos dois servidores.
  const clients = bases.map((b) => client(b, cookie));
  const date = toDateKey(nextWeekday(addDays(new Date(), 7)));
  const body = reservationBody({ date, startTime: '13:00', endTime: '13:50', quantity: 10 });

  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => clients[i % 2].post('/api/reservations', body)));
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 201).length, 3, statuses.join(','));
  assert.equal(statuses.filter((s) => s === 409).length, 9, statuses.join(','));

  const avail = await clients[1].get(`/api/availability?unit=Castelo%20II&start=${date}T13:00:00&end=${date}T13:50:00`);
  assert.equal(avail.body.free, 0);
});
