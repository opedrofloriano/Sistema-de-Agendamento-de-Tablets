// Banco de dados SQLite (node:sqlite, embutido no Node 22+). Um arquivo só, sem servidor de banco.
// Toda gravação de reserva roda dentro de BEGIN IMMEDIATE, que bloqueia outras gravações
// até o COMMIT. Assim duas reservas feitas no mesmo instante nunca passam do total de tablets.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Reservation, ReservationStatus, User, UserRole } from '../shared/types.ts';

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    email       TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('professor','coordenacao')),
    updated_at  TEXT NOT NULL
  );
  CREATE TABLE sessions (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );
  CREATE INDEX sessions_expires ON sessions(expires_at);
  CREATE TABLE login_states (
    state       TEXT PRIMARY KEY,
    nonce       TEXT NOT NULL,
    verifier    TEXT NOT NULL,
    return_to   TEXT NOT NULL,
    expires_at  INTEGER NOT NULL
  );
  CREATE TABLE reservations (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    teacher       TEXT NOT NULL,
    owner_id      TEXT NOT NULL REFERENCES users(id),
    unit          TEXT NOT NULL,
    class_name    TEXT NOT NULL DEFAULT '',
    quantity      INTEGER NOT NULL CHECK (quantity > 0),
    start         TEXT NOT NULL,
    "end"         TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('confirmada','cancelada','devolvida')),
    notes         TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL,
    cancelled_at  TEXT,
    cancelled_by  TEXT REFERENCES users(id),
    returned_at   TEXT,
    returned_by   TEXT REFERENCES users(id)
  );
  CREATE INDEX reservations_start ON reservations(start);
  CREATE INDEX reservations_active ON reservations(status, unit, start, "end");
  CREATE TABLE audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    at              TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    user_name       TEXT NOT NULL,
    action          TEXT NOT NULL,
    reservation_id  TEXT,
    details         TEXT NOT NULL DEFAULT '{}'
  );
  `,
];

interface ReservationRow {
  id: string;
  title: string;
  teacher: string;
  owner_id: string;
  unit: string;
  class_name: string;
  quantity: number;
  start: string;
  end: string;
  status: ReservationStatus;
  notes: string;
  created_at: string;
}

const toReservation = (r: ReservationRow): Reservation => ({
  id: r.id,
  title: r.title,
  teacher: r.teacher,
  ownerId: r.owner_id,
  unit: r.unit,
  className: r.class_name,
  quantity: r.quantity,
  start: r.start,
  end: r.end,
  status: r.status,
  notes: r.notes,
  createdAt: r.created_at,
});

const RESERVATION_COLUMNS = `id, title, teacher, owner_id, unit, class_name, quantity, start, "end", status, notes, created_at`;

export class Database {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    const { user_version: version } = this.raw.prepare('PRAGMA user_version').get() as { user_version: number };
    for (let i = version; i < MIGRATIONS.length; i += 1) {
      this.transaction(() => {
        this.raw.exec(MIGRATIONS[i]);
        this.raw.exec(`PRAGMA user_version = ${i + 1}`);
      });
    }
  }

  /** Executa `fn` com o banco bloqueado para outras gravações (BEGIN IMMEDIATE). */
  transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.raw.close();
  }

  // ------------------------------------------------------------ usuários e sessões

  upsertUser(user: User): void {
    this.raw
      .prepare(
        `INSERT INTO users (id, name, email, role, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, email = excluded.email,
           role = excluded.role, updated_at = excluded.updated_at`,
      )
      .run(user.id, user.name, user.email, user.role, new Date().toISOString());
  }

  createSession(id: string, userId: string, ttlMs: number): void {
    const now = Date.now();
    this.raw.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    this.raw
      .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(id, userId, now, now + ttlMs);
  }

  getSessionUser(sessionId: string): User | null {
    const row = this.raw
      .prepare(
        `SELECT u.id, u.name, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id = ? AND s.expires_at > ?`,
      )
      .get(sessionId, Date.now()) as { id: string; name: string; email: string; role: UserRole } | undefined;
    return row ? { id: row.id, name: row.name, email: row.email, role: row.role } : null;
  }

  deleteSession(sessionId: string): void {
    this.raw.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }

  saveLoginState(state: string, nonce: string, verifier: string, returnTo: string, ttlMs: number): void {
    const now = Date.now();
    this.raw.prepare('DELETE FROM login_states WHERE expires_at < ?').run(now);
    this.raw
      .prepare('INSERT INTO login_states (state, nonce, verifier, return_to, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(state, nonce, verifier, returnTo, now + ttlMs);
  }

  /** Lê e apaga o estado de login (só pode ser usado uma vez). */
  takeLoginState(state: string): { nonce: string; verifier: string; returnTo: string } | null {
    return this.transaction(() => {
      const row = this.raw
        .prepare('SELECT nonce, verifier, return_to, expires_at FROM login_states WHERE state = ?')
        .get(state) as { nonce: string; verifier: string; return_to: string; expires_at: number } | undefined;
      if (!row) return null;
      this.raw.prepare('DELETE FROM login_states WHERE state = ?').run(state);
      if (row.expires_at < Date.now()) return null;
      return { nonce: row.nonce, verifier: row.verifier, returnTo: row.return_to };
    });
  }

  // ------------------------------------------------------------ reservas

  /** Reservas que começam entre `from` (inclusive) e `to` (exclusive). Datas em horário local. */
  listReservations(from: string, to: string): Reservation[] {
    const rows = this.raw
      .prepare(`SELECT ${RESERVATION_COLUMNS} FROM reservations WHERE start >= ? AND start < ? ORDER BY start`)
      .all(from, to) as unknown as ReservationRow[];
    return rows.map(toReservation);
  }

  /** Reservas confirmadas de uma unidade que se sobrepõem ao intervalo [from, to). */
  listOverlapping(unit: string, from: string, to: string): Reservation[] {
    const rows = this.raw
      .prepare(
        `SELECT ${RESERVATION_COLUMNS} FROM reservations
         WHERE status = 'confirmada' AND unit = ? AND start < ? AND "end" > ?`,
      )
      .all(unit, to, from) as unknown as ReservationRow[];
    return rows.map(toReservation);
  }

  searchReservations(term: string, limit = 50): Reservation[] {
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = this.raw
      .prepare(
        `SELECT ${RESERVATION_COLUMNS} FROM reservations
         WHERE status != 'cancelada'
           AND (title LIKE ?1 ESCAPE '\\' OR teacher LIKE ?1 ESCAPE '\\' OR class_name LIKE ?1 ESCAPE '\\')
         ORDER BY start LIMIT ?2`,
      )
      .all(like, limit) as unknown as ReservationRow[];
    return rows.map(toReservation);
  }

  getReservation(id: string): Reservation | null {
    const row = this.raw.prepare(`SELECT ${RESERVATION_COLUMNS} FROM reservations WHERE id = ?`).get(id) as
      | ReservationRow
      | undefined;
    return row ? toReservation(row) : null;
  }

  insertReservation(r: Reservation): void {
    this.raw
      .prepare(
        `INSERT INTO reservations (${RESERVATION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.title, r.teacher, r.ownerId, r.unit, r.className, r.quantity, r.start, r.end, r.status, r.notes, r.createdAt);
  }

  markCancelled(id: string, userId: string, at: string): void {
    this.raw
      .prepare(`UPDATE reservations SET status = 'cancelada', cancelled_at = ?, cancelled_by = ? WHERE id = ?`)
      .run(at, userId, id);
  }

  markReturned(id: string, userId: string, at: string): void {
    this.raw
      .prepare(`UPDATE reservations SET status = 'devolvida', returned_at = ?, returned_by = ? WHERE id = ?`)
      .run(at, userId, id);
  }

  audit(user: User, action: string, reservationId: string | null, details: object = {}): void {
    this.raw
      .prepare(
        'INSERT INTO audit_log (at, user_id, user_name, action, reservation_id, details) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(new Date().toISOString(), user.id, user.name, action, reservationId, JSON.stringify(details));
  }
}
