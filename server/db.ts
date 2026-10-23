// Tabelas e consultas do sistema. Funciona igual com o arquivo SQLite local ou com a Turso
// (veja server/sql.ts). Toda gravação de reserva roda dentro de uma transação
// BEGIN IMMEDIATE, que bloqueia outras gravações até o COMMIT: assim duas reservas feitas
// no mesmo instante nunca passam do total de tablets da unidade.

import type { AdminUser, AuditEntry, Reservation, ReservationStatus, User, UserRole } from '../shared/types.ts';
import { LocalSql, TursoSql, type Sql, type SqlDriver } from './sql.ts';

/** Cada versão do banco é uma lista de comandos. Versões novas entram no fim. */
const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE users (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      email       TEXT NOT NULL,
      role        TEXT NOT NULL CHECK (role IN ('professor','coordenacao','ti')),
      updated_at  TEXT NOT NULL
    )`,
    `CREATE TABLE sessions (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id),
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL
    )`,
    `CREATE INDEX sessions_expires ON sessions(expires_at)`,
    `CREATE TABLE login_states (
      state       TEXT PRIMARY KEY,
      nonce       TEXT NOT NULL,
      verifier    TEXT NOT NULL,
      return_to   TEXT NOT NULL,
      expires_at  INTEGER NOT NULL
    )`,
    `CREATE TABLE reservations (
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
    )`,
    `CREATE INDEX reservations_start ON reservations(start)`,
    `CREATE INDEX reservations_active ON reservations(status, unit, start, "end")`,
    `CREATE TABLE audit_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      at              TEXT NOT NULL,
      user_id         TEXT NOT NULL,
      user_name       TEXT NOT NULL,
      action          TEXT NOT NULL,
      reservation_id  TEXT,
      details         TEXT NOT NULL DEFAULT '{}'
    )`,
  ],
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
  quantity: Number(r.quantity),
  start: r.start,
  end: r.end,
  status: r.status,
  notes: r.notes,
  createdAt: r.created_at,
});

const RESERVATION_COLUMNS = `id, title, teacher, owner_id, unit, class_name, quantity, start, "end", status, notes, created_at`;

export interface DatabaseOptions {
  /** Arquivo SQLite local (usado quando não há `url`). */
  path: string;
  /** Endereço do banco na Turso (libsql://… ou https://…). */
  url?: string;
  authToken?: string;
  fetchFn?: typeof fetch;
}

export class Database {
  private readonly q: Sql;
  private readonly driver: SqlDriver | null;

  private constructor(q: Sql, driver: SqlDriver | null) {
    this.q = q;
    this.driver = driver;
  }

  /** Abre o banco (local ou Turso) e cria/atualiza as tabelas. */
  static async open(opts: DatabaseOptions): Promise<Database> {
    const driver: SqlDriver = opts.url
      ? new TursoSql(opts.url, opts.authToken ?? '', opts.fetchFn)
      : new LocalSql(opts.path);
    const db = new Database(driver, driver);
    await db.migrate();
    return db;
  }

  get kind(): 'local' | 'turso' {
    return this.driver?.kind ?? 'local';
  }

  private async migrate(): Promise<void> {
    await this.q.run('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const row = await this.q.get<{ version: number }>('SELECT MAX(version) AS version FROM schema_version');
    const current = Number(row?.version ?? 0);
    for (let i = current; i < MIGRATIONS.length; i += 1) {
      await this.transaction(async (tx) => {
        for (const stmt of MIGRATIONS[i]) await tx.q.run(stmt);
        await tx.q.run('INSERT INTO schema_version (version) VALUES (?)', [i + 1]);
      });
    }
  }

  /**
   * Executa `fn` com o banco bloqueado para outras gravações (BEGIN IMMEDIATE).
   * Dentro de `fn`, use só o `tx` recebido (não o banco de fora), senão a operação espera para sempre.
   */
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    if (!this.driver) throw new Error('Transação aninhada não é suportada.');
    return this.driver.transaction((q) => fn(new Database(q, null)));
  }

  async close(): Promise<void> {
    await this.driver?.close();
  }

  /** Consulta livre, para relatórios e testes. */
  all<T>(sql: string, args: (string | number | null)[] = []): Promise<T[]> {
    return this.q.all<T>(sql, args);
  }

  // ------------------------------------------------------------ usuários e sessões

  async upsertUser(user: User): Promise<void> {
    await this.q.run(
      `INSERT INTO users (id, name, email, role, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, email = excluded.email,
         role = excluded.role, updated_at = excluded.updated_at`,
      [user.id, user.name, user.email, user.role, new Date().toISOString()],
    );
  }

  async createSession(id: string, userId: string, ttlMs: number): Promise<void> {
    const now = Date.now();
    await this.q.run('DELETE FROM sessions WHERE expires_at < ?', [now]);
    await this.q.run('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [
      id,
      userId,
      now,
      now + ttlMs,
    ]);
  }

  async getSessionUser(sessionId: string): Promise<User | null> {
    const row = await this.q.get<{ id: string; name: string; email: string; role: UserRole }>(
      `SELECT u.id, u.name, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ?`,
      [sessionId, Date.now()],
    );
    return row ? { id: row.id, name: row.name, email: row.email, role: row.role } : null;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.q.run('DELETE FROM sessions WHERE id = ?', [sessionId]);
  }

  async saveLoginState(state: string, nonce: string, verifier: string, returnTo: string, ttlMs: number): Promise<void> {
    const now = Date.now();
    await this.q.run('DELETE FROM login_states WHERE expires_at < ?', [now]);
    await this.q.run(
      'INSERT INTO login_states (state, nonce, verifier, return_to, expires_at) VALUES (?, ?, ?, ?, ?)',
      [state, nonce, verifier, returnTo, now + ttlMs],
    );
  }

  /** Lê e apaga o estado de login (só pode ser usado uma vez). */
  takeLoginState(state: string): Promise<{ nonce: string; verifier: string; returnTo: string } | null> {
    return this.transaction(async (tx) => {
      const row = await tx.q.get<{ nonce: string; verifier: string; return_to: string; expires_at: number }>(
        'SELECT nonce, verifier, return_to, expires_at FROM login_states WHERE state = ?',
        [state],
      );
      if (!row) return null;
      await tx.q.run('DELETE FROM login_states WHERE state = ?', [state]);
      if (Number(row.expires_at) < Date.now()) return null;
      return { nonce: row.nonce, verifier: row.verifier, returnTo: row.return_to };
    });
  }

  // ------------------------------------------------------------ reservas

  /** Reservas que começam entre `from` (inclusive) e `to` (exclusive). Datas em horário local. */
  async listReservations(from: string, to: string): Promise<Reservation[]> {
    const rows = await this.q.all<ReservationRow>(
      `SELECT ${RESERVATION_COLUMNS} FROM reservations WHERE start >= ? AND start < ? ORDER BY start`,
      [from, to],
    );
    return rows.map(toReservation);
  }

  /** Reservas confirmadas de uma unidade que se sobrepõem ao intervalo [from, to). */
  async listOverlapping(unit: string, from: string, to: string): Promise<Reservation[]> {
    const rows = await this.q.all<ReservationRow>(
      `SELECT ${RESERVATION_COLUMNS} FROM reservations
       WHERE status = 'confirmada' AND unit = ? AND start < ? AND "end" > ?`,
      [unit, to, from],
    );
    return rows.map(toReservation);
  }

  async searchReservations(term: string, limit = 50): Promise<Reservation[]> {
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await this.q.all<ReservationRow>(
      `SELECT ${RESERVATION_COLUMNS} FROM reservations
       WHERE status != 'cancelada'
         AND (title LIKE ? ESCAPE '\\' OR teacher LIKE ? ESCAPE '\\' OR class_name LIKE ? ESCAPE '\\')
       ORDER BY start LIMIT ?`,
      [like, like, like, limit],
    );
    return rows.map(toReservation);
  }

  async getReservation(id: string): Promise<Reservation | null> {
    const row = await this.q.get<ReservationRow>(`SELECT ${RESERVATION_COLUMNS} FROM reservations WHERE id = ?`, [id]);
    return row ? toReservation(row) : null;
  }

  async insertReservation(r: Reservation): Promise<void> {
    await this.q.run(`INSERT INTO reservations (${RESERVATION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      r.id,
      r.title,
      r.teacher,
      r.ownerId,
      r.unit,
      r.className,
      r.quantity,
      r.start,
      r.end,
      r.status,
      r.notes,
      r.createdAt,
    ]);
  }

  async markCancelled(id: string, userId: string, at: string): Promise<void> {
    await this.q.run(`UPDATE reservations SET status = 'cancelada', cancelled_at = ?, cancelled_by = ? WHERE id = ?`, [
      at,
      userId,
      id,
    ]);
  }

  async markReturned(id: string, userId: string, at: string): Promise<void> {
    await this.q.run(`UPDATE reservations SET status = 'devolvida', returned_at = ?, returned_by = ? WHERE id = ?`, [
      at,
      userId,
      id,
    ]);
  }

  /** Reservas confirmadas que já terminaram (tablets ainda não devolvidos), mais antigas primeiro. */
  async listPendingReturns(nowIso: string, sinceIso: string): Promise<Reservation[]> {
    const rows = await this.q.all<ReservationRow>(
      `SELECT ${RESERVATION_COLUMNS} FROM reservations
       WHERE status = 'confirmada' AND "end" <= ? AND start >= ? ORDER BY "end" LIMIT 200`,
      [nowIso, sinceIso],
    );
    return rows.map(toReservation);
  }

  async listAudit(limit: number): Promise<AuditEntry[]> {
    const rows = await this.q.all<{
      id: number;
      at: string;
      user_name: string;
      action: string;
      reservation_id: string | null;
      title: string | null;
      details: string;
    }>(
      `SELECT a.id, a.at, a.user_name, a.action, a.reservation_id, r.title, a.details
       FROM audit_log a LEFT JOIN reservations r ON r.id = a.reservation_id
       ORDER BY a.id DESC LIMIT ?`,
      [limit],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      at: r.at,
      userName: r.user_name,
      action: r.action,
      reservationId: r.reservation_id,
      reservationTitle: r.title,
      details: r.details,
    }));
  }

  async listUsers(): Promise<AdminUser[]> {
    const rows = await this.q.all<{ id: string; name: string; email: string; role: UserRole; updated_at: string; n: number }>(
      `SELECT u.id, u.name, u.email, u.role, u.updated_at,
         (SELECT COUNT(*) FROM reservations r WHERE r.owner_id = u.id AND r.status != 'cancelada') AS n
       FROM users u ORDER BY u.updated_at DESC LIMIT 500`,
    );
    return rows.map((r) => ({ id: r.id, name: r.name, email: r.email, role: r.role, updatedAt: r.updated_at, reservations: Number(r.n) }));
  }

  async counts(): Promise<{ reservations: number; users: number; activeSessions: number }> {
    const row = await this.q.get<{ r: number; u: number; s: number }>(
      `SELECT (SELECT COUNT(*) FROM reservations) AS r, (SELECT COUNT(*) FROM users) AS u,
              (SELECT COUNT(*) FROM sessions WHERE expires_at > ?) AS s`,
      [Date.now()],
    );
    return { reservations: Number(row?.r ?? 0), users: Number(row?.u ?? 0), activeSessions: Number(row?.s ?? 0) };
  }

  async audit(user: User, action: string, reservationId: string | null, details: object = {}): Promise<void> {
    await this.q.run(
      'INSERT INTO audit_log (at, user_id, user_name, action, reservation_id, details) VALUES (?, ?, ?, ?, ?, ?)',
      [new Date().toISOString(), user.id, user.name, action, reservationId, JSON.stringify(details)],
    );
  }
}
