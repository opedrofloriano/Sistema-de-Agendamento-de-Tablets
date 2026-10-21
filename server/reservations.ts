// Regras de negócio do lado do servidor. É aqui que a reserva é aceita ou recusada de verdade.

import { randomUUID } from 'node:crypto';
import {
  canBeCancelled,
  canRegisterReturn,
  displayStatus,
  freeTablets,
  isValidDate,
  parseLocal,
  tabletsFor,
  toLocalIso,
  validateReservation,
} from '../shared/rules.ts';
import type { AppConfig, Reservation, ReservationInput, User } from '../shared/types.ts';
import type { Database } from './db.ts';

export class HttpError extends Error {
  readonly status: number;
  readonly field?: string;
  constructor(status: number, message: string, field?: string) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Pode cancelar ou registrar devolução: quem criou a reserva ou a coordenação. */
export const canManage = (user: User, r: Pick<Reservation, 'ownerId'>): boolean =>
  user.role === 'coordenacao' || r.ownerId === user.id;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Converte o corpo da requisição em ReservationInput sem confiar em nenhum campo. */
export function parseInput(body: unknown): ReservationInput {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  return {
    title: str(b.title),
    teacher: str(b.teacher),
    unit: str(b.unit),
    className: str(b.className),
    quantity: typeof b.quantity === 'number' ? b.quantity : Number.NaN,
    date: str(b.date),
    startTime: str(b.startTime),
    endTime: str(b.endTime),
    notes: str(b.notes),
  };
}

export class ReservationService {
  private readonly db: Database;
  private readonly config: AppConfig;
  private readonly now: () => Date;

  constructor(db: Database, config: AppConfig, now: () => Date = () => new Date()) {
    this.db = db;
    this.config = config;
    this.now = now;
  }

  /** Reservas que começam entre as datas `from` e `to` (AAAA-MM-DD, ambas inclusive). */
  list(from: string, to: string): Reservation[] {
    if (!DATE.test(from) || !DATE.test(to)) throw new HttpError(400, 'Informe "from" e "to" no formato AAAA-MM-DD.');
    const end = parseLocal(`${to}T00:00`);
    if (!isValidDate(end) || !isValidDate(parseLocal(`${from}T00:00`))) throw new HttpError(400, 'Datas inválidas.');
    end.setDate(end.getDate() + 1);
    return this.db.listReservations(`${from}T00:00:00`, toLocalIso(end));
  }

  search(term: string): Reservation[] {
    const q = term.trim();
    if (q.length < 2) return [];
    return this.db.searchReservations(q.slice(0, 80));
  }

  /** Quantos tablets da unidade estão livres durante todo o intervalo. */
  availability(unit: string, start: string, end: string): { unit: string; free: number; total: number } {
    const total = tabletsFor(this.config, unit);
    if (total === 0) throw new HttpError(400, 'Unidade desconhecida.', 'unit');
    const s = parseLocal(start);
    const e = parseLocal(end);
    if (!isValidDate(s) || !isValidDate(e) || e <= s) throw new HttpError(400, 'Intervalo inválido.');
    const overlapping = this.db.listOverlapping(unit, toLocalIso(s), toLocalIso(e));
    return { unit, free: freeTablets(overlapping, unit, s, e, this.config), total };
  }

  create(user: User, body: unknown): Reservation {
    const input = parseInput(body);
    // Professores sempre reservam no próprio nome; a coordenação pode reservar para outra pessoa.
    if (user.role !== 'coordenacao' || !input.teacher.trim()) input.teacher = user.name;

    return this.db.transaction(() => {
      const dayStart = `${input.date}T00:00:00`;
      const dayEnd = `${input.date}T23:59:59`;
      const existing = DATE.test(input.date) ? this.db.listOverlapping(input.unit, dayStart, dayEnd) : [];
      const now = this.now();
      const result = validateReservation(input, existing, now, this.config);
      if (!result.ok) throw new HttpError(result.conflict ? 409 : 422, result.error, result.field);

      const reservation: Reservation = {
        id: randomUUID(),
        title: input.title.trim(),
        teacher: input.teacher.trim(),
        ownerId: user.id,
        unit: input.unit,
        className: input.className.trim(),
        quantity: input.quantity,
        start: toLocalIso(result.start),
        end: toLocalIso(result.end),
        status: 'confirmada',
        notes: input.notes.trim(),
        createdAt: toLocalIso(now),
      };
      this.db.insertReservation(reservation);
      this.db.audit(user, 'criar', reservation.id, {
        quantity: reservation.quantity,
        start: reservation.start,
        end: reservation.end,
        teacher: reservation.teacher,
      });
      return reservation;
    });
  }

  cancel(user: User, id: string): Reservation {
    return this.db.transaction(() => {
      const r = this.db.getReservation(id);
      if (!r) throw new HttpError(404, 'Reserva não encontrada. Ela pode ter sido removida.');
      if (!canManage(user, r))
        throw new HttpError(403, `Só ${r.teacher} ou a coordenação podem cancelar esta reserva.`);
      if (!canBeCancelled(displayStatus(r, this.now())))
        throw new HttpError(409, 'Só é possível cancelar reservas agendadas ou em andamento.');
      const at = toLocalIso(this.now());
      this.db.markCancelled(id, user.id, at);
      this.db.audit(user, 'cancelar', id);
      return { ...r, status: 'cancelada' };
    });
  }

  registerReturn(user: User, id: string): Reservation {
    return this.db.transaction(() => {
      const r = this.db.getReservation(id);
      if (!r) throw new HttpError(404, 'Reserva não encontrada. Ela pode ter sido removida.');
      if (!canManage(user, r))
        throw new HttpError(403, `Só ${r.teacher} ou a coordenação podem registrar a devolução.`);
      if (!canRegisterReturn(displayStatus(r, this.now())))
        throw new HttpError(409, 'A devolução só pode ser registrada depois do início da reserva.');
      const at = toLocalIso(this.now());
      this.db.markReturned(id, user.id, at);
      this.db.audit(user, 'devolver', id);
      return { ...r, status: 'devolvida' };
    });
  }
}
