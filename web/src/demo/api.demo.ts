// Versão de demonstração da API, para o arquivo HTML único (npm run build:demo).
// Roda inteira no navegador: as reservas ficam no localStorage e as regras são as mesmas
// do servidor (shared/rules.ts). Não há login real nem dados compartilhados entre pessoas.

import {
  DEFAULT_CONFIG,
  addDays,
  canBeCancelled,
  canRegisterReturn,
  displayStatus,
  freeTablets,
  isValidDate,
  nextWeekday,
  parseLocal,
  startOfDay,
  tabletsFor,
  toDateKey,
  toLocalIso,
  validateReservation,
} from '../../../shared/rules.ts';
import type { MeResponse, Reservation, ReservationInput, User } from '../../../shared/types.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly field?: string;
  constructor(status: number, message: string, field?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.field = field;
  }
}

const RES_KEY = 'tablets:demo:reservations';
const USER_KEY = 'tablets:demo:user';
const config = DEFAULT_CONFIG;
const wait = () => new Promise((r) => setTimeout(r, 120));

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* sem armazenamento: os dados valem só até recarregar */
  }
}

/** Dias úteis a partir de amanhã, para os exemplos caírem sempre no futuro. */
function workday(offset: number): string {
  let d = nextWeekday(addDays(startOfDay(new Date()), 1));
  for (let i = 0; i < offset; i += 1) d = nextWeekday(addDays(d, 1));
  return toDateKey(d);
}

function seed(): Reservation[] {
  const created = toLocalIso(new Date());
  const r = (id: string, title: string, teacher: string, unit: string, className: string, quantity: number, day: number, start: string, end: string): Reservation => ({
    id,
    title,
    teacher,
    ownerId: `demo:${teacher}`,
    unit,
    className,
    quantity,
    start: `${workday(day)}T${start}:00`,
    end: `${workday(day)}T${end}:00`,
    status: 'confirmada',
    notes: 'Dados fictícios para demonstração.',
    createdAt: created,
  });
  return [
    r('demo-1', 'Pesquisa orientada', 'Rafael Almeida', 'Floresta', '9º ano B', 15, 0, '07:50', '09:30'),
    r('demo-2', 'Atividade de Ciências', 'Mariana Costa', 'Castelo II', '8º ano A', 15, 0, '08:40', '10:40'),
    r('demo-3', 'Projeto de Robótica', 'Camila Souza', 'Castelo II', 'Ensino Médio', 15, 0, '08:40', '09:30'),
    r('demo-4', 'Leitura digital', 'Camila Souza', 'Castelo II', '5º ano A', 20, 1, '13:00', '14:40'),
    r('demo-5', 'Mapas interativos', 'Ana Ribeiro', 'Floresta', '6º ano B', 18, 1, '14:40', '15:30'),
    r('demo-6', 'Jogos de Matemática', 'Bruno Lima', 'Floresta', '7º ano A', 10, 2, '10:40', '11:30'),
  ];
}

function load(): Reservation[] {
  const saved = read<Reservation[]>(RES_KEY);
  if (Array.isArray(saved)) return saved;
  const fresh = seed();
  write(RES_KEY, fresh);
  return fresh;
}
const save = (list: Reservation[]) => write(RES_KEY, list);

export const demoUser = (): User | null => read<User>(USER_KEY);

export function demoLogin(name: string, coordinator: boolean): void {
  const clean = name.trim().slice(0, 80);
  write(USER_KEY, {
    id: `demo:${clean}`,
    name: clean,
    email: '',
    role: coordinator ? 'coordenacao' : 'professor',
  } satisfies User);
}

export function demoReset(): void {
  try {
    localStorage.removeItem(RES_KEY);
  } catch {
    /* nada a apagar */
  }
}

function requireUser(): User {
  const u = demoUser();
  if (!u) throw new ApiError(401, 'Entre para continuar.');
  return u;
}

const canManage = (u: User, r: Reservation) => u.role === 'coordenacao' || r.ownerId === u.id;

export const api = {
  async me(): Promise<MeResponse> {
    await wait();
    return { user: requireUser(), config, authMode: 'demo' };
  },

  async listReservations(from: string, to: string): Promise<Reservation[]> {
    await wait();
    const end = toLocalIso(addDays(parseLocal(`${to}T00:00`), 1));
    return load().filter((r) => r.start >= `${from}T00:00:00` && r.start < end);
  },

  async searchReservations(q: string): Promise<Reservation[]> {
    await wait();
    const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
    const term = norm(q.trim());
    if (term.length < 2) return [];
    return load().filter((r) => r.status !== 'cancelada' && norm(`${r.title} ${r.teacher} ${r.className}`).includes(term));
  },

  async availability(unit: string, start: string, end: string, _signal?: AbortSignal) {
    await wait();
    const total = tabletsFor(config, unit);
    const s = parseLocal(start);
    const e = parseLocal(end);
    if (!total || !isValidDate(s) || !isValidDate(e) || e <= s) throw new ApiError(400, 'Intervalo inválido.');
    return { unit, free: freeTablets(load(), unit, s, e, config), total };
  },

  async createReservation(input: ReservationInput): Promise<Reservation> {
    await wait();
    const user = requireUser();
    const data = { ...input, teacher: user.role === 'coordenacao' && input.teacher.trim() ? input.teacher : user.name };
    const list = load();
    const now = new Date();
    const result = validateReservation(data, list, now, config);
    if (!result.ok) throw new ApiError(result.conflict ? 409 : 422, result.error, result.field);
    const created: Reservation = {
      id: `local-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
      title: data.title.trim(),
      teacher: data.teacher.trim(),
      ownerId: user.id,
      unit: data.unit,
      className: data.className.trim(),
      quantity: data.quantity,
      start: toLocalIso(result.start),
      end: toLocalIso(result.end),
      status: 'confirmada',
      notes: data.notes.trim(),
      createdAt: toLocalIso(now),
    };
    save([...list, created]);
    return created;
  },

  async cancelReservation(id: string): Promise<Reservation> {
    await wait();
    const user = requireUser();
    const list = load();
    const r = list.find((x) => x.id === id);
    if (!r) throw new ApiError(404, 'Reserva não encontrada.');
    if (!canManage(user, r)) throw new ApiError(403, `Só ${r.teacher} ou a coordenação podem cancelar esta reserva.`);
    if (!canBeCancelled(displayStatus(r, new Date())))
      throw new ApiError(409, 'Só é possível cancelar reservas agendadas ou em andamento.');
    const updated: Reservation = { ...r, status: 'cancelada' };
    save(list.map((x) => (x.id === id ? updated : x)));
    return updated;
  },

  async registerReturn(id: string): Promise<Reservation> {
    await wait();
    const user = requireUser();
    const list = load();
    const r = list.find((x) => x.id === id);
    if (!r) throw new ApiError(404, 'Reserva não encontrada.');
    if (!canManage(user, r)) throw new ApiError(403, `Só ${r.teacher} ou a coordenação podem registrar a devolução.`);
    if (!canRegisterReturn(displayStatus(r, new Date())))
      throw new ApiError(409, 'A devolução só pode ser registrada depois do início da reserva.');
    const updated: Reservation = { ...r, status: 'devolvida' };
    save(list.map((x) => (x.id === id ? updated : x)));
    return updated;
  },

  async logout(): Promise<void> {
    try {
      localStorage.removeItem(USER_KEY);
    } catch {
      /* nada a apagar */
    }
    window.location.reload();
  },
};

