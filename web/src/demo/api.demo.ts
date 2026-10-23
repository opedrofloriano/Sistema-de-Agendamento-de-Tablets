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
  isStaff,
  isValidDate,
  nextWeekday,
  parseLocal,
  startOfDay,
  tabletsFor,
  toDateKey,
  toLocalIso,
  validateReservation,
} from '../../../shared/rules.ts';
import { computeStats, type PanelStats } from '../../../shared/stats.ts';
import type { AdminUser, AuditEntry, MeResponse, Reservation, ReservationInput, SystemInfo, User, UserRole } from '../../../shared/types.ts';

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
const AUDIT_KEY = 'tablets:demo:audit';
const STARTED = Date.now();
const config = DEFAULT_CONFIG;
const wait = () => new Promise((r) => setTimeout(r, 120));

// Alguns visualizadores (pré-visualização do WhatsApp, do e-mail ou do gerenciador de arquivos do
// celular) bloqueiam o armazenamento do navegador. Nesse caso, tudo fica numa cópia em memória:
// a demonstração funciona, mas os dados somem ao fechar a página.
const memory = new Map<string, string>();

function canPersist(): boolean {
  try {
    const k = 'tablets:demo:probe';
    localStorage.setItem(k, '1');
    const ok = localStorage.getItem(k) === '1';
    localStorage.removeItem(k);
    return ok;
  } catch {
    return false;
  }
}
/** false quando este navegador não guarda os dados entre uma visita e outra. */
export const storagePersists = canPersist();

function read<T>(key: string): T | null {
  let raw: string | null = memory.get(key) ?? null;
  if (storagePersists) {
    try {
      raw = localStorage.getItem(key) ?? raw;
    } catch {
      /* usa a memória */
    }
  }
  try {
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function write(key: string, value: unknown): void {
  const raw = JSON.stringify(value);
  memory.set(key, raw);
  if (!storagePersists) return;
  try {
    localStorage.setItem(key, raw);
  } catch {
    /* fica só na memória */
  }
}
function remove(key: string): void {
  memory.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {
    /* nada a apagar */
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
  // Histórico das últimas semanas, para o Painel ter o que mostrar.
  const past: Reservation[] = [];
  const people = ['Camila Souza', 'Mariana Costa', 'Rafael Almeida', 'Bruno Lima', 'Ana Ribeiro', 'Paulo Mendes', 'Juliana Prado'];
  const groups = ['8º ano A', '9º ano B', 'Ensino Médio', '5º ano A', '6º ano B', '7º ano A', 'Laboratório'];
  const acts = ['Pesquisa orientada', 'Quiz de revisão', 'Leitura digital', 'Jogos de Matemática', 'Produção de vídeo'];
  let s = 11;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const today = startOfDay(new Date());
  for (let off = 70; off >= 1; off -= 1) {
    const d = addDays(today, -off);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const per = config.periods.filter(() => rnd() < 0.3).slice(0, 4);
    per.forEach((p, i) => {
      const who = people[Math.min(people.length - 1, Math.floor(rnd() * rnd() * people.length * 1.6))];
      past.push({
        id: `hist-${off}-${i}`,
        title: acts[Math.floor(rnd() * acts.length)],
        teacher: who,
        ownerId: `demo:${who}`,
        unit: rnd() < 0.55 ? 'Castelo II' : 'Castelo I',
        className: groups[Math.min(groups.length - 1, Math.floor(rnd() * rnd() * groups.length * 1.5))],
        quantity: [8, 10, 12, 15, 20, 25][Math.floor(rnd() * 6)],
        start: `${toDateKey(d)}T${p.start}:00`,
        end: `${toDateKey(d)}T${p.end}:00`,
        status: off <= 2 && rnd() < 0.5 ? 'confirmada' : rnd() < 0.07 ? 'cancelada' : 'devolvida',
        notes: 'Dados fictícios para demonstração.',
        createdAt: created,
      });
    });
  }
  return [
    ...past,
    r('demo-1', 'Pesquisa orientada', 'Rafael Almeida', 'Castelo I', '9º ano B', 15, 0, '07:50', '09:30'),
    r('demo-2', 'Atividade de Ciências', 'Mariana Costa', 'Castelo II', '8º ano A', 15, 0, '08:40', '10:40'),
    r('demo-3', 'Projeto de Robótica', 'Camila Souza', 'Castelo II', 'Ensino Médio', 15, 0, '08:40', '09:30'),
    r('demo-4', 'Leitura digital', 'Camila Souza', 'Castelo II', '5º ano A', 20, 1, '13:00', '14:40'),
    r('demo-5', 'Mapas interativos', 'Ana Ribeiro', 'Castelo I', '6º ano B', 18, 1, '14:40', '15:30'),
    r('demo-6', 'Jogos de Matemática', 'Bruno Lima', 'Castelo I', '7º ano A', 10, 2, '10:40', '11:30'),
  ];
}

function load(): Reservation[] {
  const saved = read<Reservation[]>(RES_KEY);
  // Dados salvos antes da troca de nome da unidade (Floresta → Castelo I).
  if (Array.isArray(saved)) return saved.map((r) => (r.unit === 'Floresta' ? { ...r, unit: 'Castelo I' } : r));
  const fresh = seed();
  write(RES_KEY, fresh);
  return fresh;
}
const save = (list: Reservation[]) => write(RES_KEY, list);

export const demoUser = (): User | null => read<User>(USER_KEY);

export function demoLogin(name: string, role: UserRole): void {
  const clean = name.trim().slice(0, 80);
  write(USER_KEY, { id: `demo:${clean}`, name: clean, email: '', role } satisfies User);
}

function log(user: User, action: string, r: Reservation, details: object = {}): void {
  const list = read<AuditEntry[]>(AUDIT_KEY) ?? [];
  list.unshift({
    id: (list[0]?.id ?? 0) + 1,
    at: toLocalIso(new Date()),
    userName: user.name,
    action,
    reservationId: r.id,
    reservationTitle: r.title,
    details: JSON.stringify(details),
  });
  write(AUDIT_KEY, list.slice(0, 200));
}

function requireStaff(): User {
  const u = requireUser();
  if (!isStaff(u.role)) throw new ApiError(403, 'O painel é só para a coordenação e a TI.');
  return u;
}
function requireTi(): User {
  const u = requireUser();
  if (u.role !== 'ti') throw new ApiError(403, 'Esta área é só para a TI.');
  return u;
}

export function demoReset(): void {
  remove(RES_KEY);
  remove(AUDIT_KEY);
}

function requireUser(): User {
  const u = demoUser();
  if (!u) throw new ApiError(401, 'Entre para continuar.');
  return u;
}

const canManage = (u: User, r: Reservation) => isStaff(u.role) || r.ownerId === u.id;

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
    const data = { ...input, teacher: isStaff(user.role) && input.teacher.trim() ? input.teacher : user.name };
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
    log(user, 'criar', created, { quantity: created.quantity, start: created.start, end: created.end, teacher: created.teacher });
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
    log(user, 'cancelar', updated);
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
    log(user, 'devolver', updated);
    return updated;
  },

  async adminStats(from: string, to: string, unit: string): Promise<PanelStats> {
    await wait();
    requireStaff();
    const end = toLocalIso(addDays(parseLocal(`${to}T00:00`), 1));
    const list = load().filter((r) => r.start >= `${from}T00:00:00` && r.start < end);
    return computeStats(list, from, to, config, unit || undefined);
  },

  async pendingReturns(): Promise<Reservation[]> {
    await wait();
    requireStaff();
    const now = toLocalIso(new Date());
    const since = toLocalIso(addDays(new Date(), -60));
    return load()
      .filter((r) => r.status === 'confirmada' && r.end <= now && r.end >= since)
      .sort((a, b) => b.start.localeCompare(a.start));
  },

  async auditLog(limit = 40): Promise<AuditEntry[]> {
    await wait();
    requireTi();
    return (read<AuditEntry[]>(AUDIT_KEY) ?? []).slice(0, limit);
  },

  async adminUsers(): Promise<AdminUser[]> {
    await wait();
    const me = requireTi();
    const counts = new Map<string, number>();
    for (const r of load()) counts.set(r.ownerId, (counts.get(r.ownerId) ?? 0) + 1);
    const names = new Map<string, string>(load().map((r) => [r.ownerId, r.teacher]));
    names.set(me.id, me.name);
    const at = toLocalIso(new Date());
    return [...names.entries()].map(([id, name]) => ({
      id, name, email: '', role: id === me.id ? me.role : 'professor', updatedAt: at, reservations: counts.get(id) ?? 0,
    }));
  },

  async systemInfo(): Promise<SystemInfo> {
    await wait();
    requireTi();
    const list = load();
    return {
      authMode: 'demo',
      database: 'navegador',
      nodeVersion: '—',
      uptimeSeconds: Math.round((Date.now() - STARTED) / 1000),
      timezone: config.timezone,
      totals: { reservations: list.length, users: new Set(list.map((r) => r.ownerId)).size, activeSessions: 1 },
    };
  },

  async logout(): Promise<void> {
    remove(USER_KEY);
    if (storagePersists) window.location.reload();
    else window.dispatchEvent(new Event('demo-logout'));
  },
};

