// Datas e regras de reserva. Usado pela interface (para mostrar avisos na hora)
// e pelo servidor (que é quem decide de verdade, dentro de uma transação).
// Todas as datas são tratadas no horário local: no servidor, o fuso vem de TZ
// (config/escola.json → timezone); no navegador, do aparelho.

import type { AppConfig, ClassPeriod, Reservation, ReservationInput } from './types.ts';

/** Nomes das unidades, na ordem da configuração. */
export const unitNames = (config: AppConfig): string[] => config.units.map((u) => u.name);

/** Tablets do acervo de uma unidade (0 se a unidade não existe). */
export const tabletsFor = (config: AppConfig, unit: string): number =>
  config.units.find((u) => u.name === unit)?.tablets ?? 0;

/** Soma dos acervos de todas as unidades. */
export const totalTablets = (config: AppConfig): number => config.units.reduce((sum, u) => sum + u.tablets, 0);

export const DEFAULT_PERIODS: ClassPeriod[] = [
  { id: 'm1', label: '1º horário (manhã)', start: '07:00', end: '07:50' },
  { id: 'm2', label: '2º horário (manhã)', start: '07:50', end: '08:40' },
  { id: 'm3', label: '3º horário (manhã)', start: '08:40', end: '09:30' },
  { id: 'm4', label: '4º horário (manhã)', start: '09:50', end: '10:40' },
  { id: 'm5', label: '5º horário (manhã)', start: '10:40', end: '11:30' },
  { id: 'm6', label: '6º horário (manhã)', start: '11:30', end: '12:20' },
  { id: 't1', label: '1º horário (tarde)', start: '13:00', end: '13:50' },
  { id: 't2', label: '2º horário (tarde)', start: '13:50', end: '14:40' },
  { id: 't3', label: '3º horário (tarde)', start: '14:40', end: '15:30' },
  { id: 't4', label: '4º horário (tarde)', start: '15:50', end: '16:40' },
  { id: 't5', label: '5º horário (tarde)', start: '16:40', end: '17:30' },
  { id: 't6', label: '6º horário (tarde)', start: '17:30', end: '18:20' },
];

export const DEFAULT_CONFIG: AppConfig = {
  units: [
    { name: 'Castelo I', tablets: 30 },
    { name: 'Castelo II', tablets: 30 },
  ],
  periods: DEFAULT_PERIODS,
  dayStartMinutes: 7 * 60,
  dayEndMinutes: 18 * 60 + 20,
  minDurationMinutes: 15,
  timezone: 'America/Sao_Paulo',
  limits: { title: 80, teacher: 80, className: 40, notes: 500 },
};

// ---------------------------------------------------------------- datas

export const pad2 = (n: number): string => String(n).padStart(2, '0');

/** AAAA-MM-DD */
export const toDateKey = (d: Date): string =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** AAAA-MM-DDTHH:MM:00 no horário local. */
export const toLocalIso = (d: Date): string =>
  `${toDateKey(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:00`;

const LOCAL_ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Lê AAAA-MM-DDTHH:MM[:SS] como horário local. Datas impossíveis viram Invalid Date. */
export function parseLocal(value: string): Date {
  const m = LOCAL_ISO.exec(value);
  if (!m) return new Date(Number.NaN);
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const date = new Date(y, mo - 1, d, h, mi, s || 0);
  const same =
    date.getFullYear() === y &&
    date.getMonth() === mo - 1 &&
    date.getDate() === d &&
    date.getHours() === h &&
    date.getMinutes() === mi;
  return same ? date : new Date(Number.NaN);
}

export const combine = (date: string, time: string): Date => parseLocal(`${date}T${time}`);
export const isValidDate = (d: Date): boolean => Number.isFinite(d.getTime());
export const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d: Date, n: number): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** Segunda-feira da semana de `d`. */
export const startOfWeek = (d: Date): Date => addDays(d, -((d.getDay() + 6) % 7));
export const isWeekend = (d: Date): boolean => d.getDay() === 0 || d.getDay() === 6;
/** O próprio dia, se for útil; senão, a segunda-feira seguinte. */
export function nextWeekday(d: Date): Date {
  const day = startOfDay(d);
  if (day.getDay() === 6) return addDays(day, 2);
  if (day.getDay() === 0) return addDays(day, 1);
  return day;
}
/** Segunda a sexta da semana de `d`. */
export const weekDays = (d: Date): Date[] => {
  const monday = startOfWeek(d);
  return Array.from({ length: 5 }, (_, i) => addDays(monday, i));
};
export const sameDay = (a: Date, b: Date): boolean => toDateKey(a) === toDateKey(b);

export function timeToMinutes(value: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : Number.NaN;
}
export const minutesToTime = (m: number): string => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
export const minutesOfDay = (d: Date): number => d.getHours() * 60 + d.getMinutes();
export const formatTime = (d: Date): string => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
export const formatLongDate = (d: Date): string =>
  d.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });

export function weekLabel(d: Date): string {
  const days = weekDays(d);
  const first = days[0];
  const last = days[4];
  const end = last.toLocaleDateString('pt-BR', { day: 'numeric', month: 'short', year: 'numeric' });
  if (first.getMonth() === last.getMonth()) return `${first.getDate()} – ${end}`;
  const sameYear = first.getFullYear() === last.getFullYear();
  const start = first.toLocaleDateString('pt-BR', {
    day: 'numeric',
    month: 'short',
    year: sameYear ? undefined : 'numeric',
  });
  return `${start} – ${end}`;
}

export function shortWeekLabel(d: Date): string {
  const days = weekDays(d);
  const month = (x: Date) => x.toLocaleDateString('pt-BR', { month: 'short' });
  const [first, last] = [days[0], days[4]];
  return first.getMonth() === last.getMonth()
    ? `${first.getDate()}–${last.getDate()} ${month(last)}`
    : `${first.getDate()} ${month(first)}–${last.getDate()} ${month(last)}`;
}

export function gmtLabel(d: Date = new Date()): string {
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '−';
  const h = Math.floor(Math.abs(offset) / 60);
  const m = Math.abs(offset) % 60;
  return `GMT${sign}${pad2(h)}${m ? `:${pad2(m)}` : ''}`;
}

// ---------------------------------------------------------------- situação

export type DisplayStatus =
  | 'agendada'
  | 'em-andamento'
  | 'aguardando-devolucao'
  | 'devolvida'
  | 'cancelada';

export const STATUS_LABEL: Record<DisplayStatus, string> = {
  agendada: 'Agendada',
  'em-andamento': 'Em andamento',
  'aguardando-devolucao': 'Aguardando devolução',
  devolvida: 'Devolvida',
  cancelada: 'Cancelada',
};

export const isActive = (r: Pick<Reservation, 'status'>): boolean => r.status === 'confirmada';

/** Situação que aparece para o usuário, a partir do status gravado e do horário atual. */
export function displayStatus(r: Pick<Reservation, 'status' | 'start' | 'end'>, now: Date): DisplayStatus {
  if (r.status === 'cancelada') return 'cancelada';
  if (r.status === 'devolvida') return 'devolvida';
  const start = parseLocal(r.start);
  const end = parseLocal(r.end);
  if (now < start) return 'agendada';
  if (now < end) return 'em-andamento';
  return 'aguardando-devolucao';
}

/** Coordenação e TI: gerenciam qualquer reserva e veem o painel. */
export const isStaff = (role: string): boolean => role === 'coordenacao' || role === 'ti';

export const ROLE_LABEL: Record<string, string> = { professor: 'Professor(a)', coordenacao: 'Coordenação', ti: 'TI' };

export const canBeCancelled = (s: DisplayStatus): boolean => s === 'agendada' || s === 'em-andamento';
export const canRegisterReturn = (s: DisplayStatus): boolean =>
  s === 'em-andamento' || s === 'aguardando-devolucao';

// ---------------------------------------------------------------- disponibilidade

type Slot = Pick<Reservation, 'id' | 'status' | 'start' | 'end' | 'quantity' | 'unit'>;

/**
 * Maior quantidade de tablets em uso ao mesmo tempo entre `from` e `to`,
 * somando as reservas confirmadas que se sobrepõem a esse intervalo.
 * Não separa por unidade: filtre a lista antes (veja `freeTablets`).
 */
export function peakUsage(reservations: Slot[], from: Date, to: Date, ignoreId?: string): number {
  const events: { at: number; delta: number }[] = [];
  for (const r of reservations) {
    if (!isActive(r) || r.id === ignoreId) continue;
    const s = Math.max(parseLocal(r.start).getTime(), from.getTime());
    const e = Math.min(parseLocal(r.end).getTime(), to.getTime());
    if (s < e) events.push({ at: s, delta: r.quantity }, { at: e, delta: -r.quantity });
  }
  // No mesmo instante, as devoluções (delta negativo) entram antes das retiradas.
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let current = 0;
  let peak = 0;
  for (const ev of events) {
    current += ev.delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

/** Tablets livres de uma unidade durante todo o intervalo. Reservas de outras unidades não contam. */
export function freeTablets(reservations: Slot[], unit: string, from: Date, to: Date, config: AppConfig): number {
  const sameUnit = reservations.filter((r) => r.unit === unit);
  return Math.max(0, tabletsFor(config, unit) - peakUsage(sameUnit, from, to));
}

export interface UnitPeak {
  unit: string;
  tablets: number;
  quantity: number;
  at: Date | null;
}

/** Momento de maior uso de cada unidade numa janela (ex.: a semana), para o card de resumo. */
export function busiestByUnit(reservations: Slot[], from: Date, to: Date, config: AppConfig): UnitPeak[] {
  return config.units.map((u) => ({
    unit: u.name,
    tablets: u.tablets,
    ...busiestMoment(
      reservations.filter((r) => r.unit === u.name),
      from,
      to,
    ),
  }));
}

/** Momento de maior uso numa janela. Passe só as reservas de uma unidade. */
export function busiestMoment(reservations: Slot[], from: Date, to: Date): { quantity: number; at: Date | null } {
  const starts = reservations
    .filter(isActive)
    .map((r) => parseLocal(r.start))
    .filter((d) => d >= from && d < to)
    .sort((a, b) => a.getTime() - b.getTime());
  let best: { quantity: number; at: Date | null } = { quantity: 0, at: null };
  for (const at of starts) {
    const q = peakUsage(reservations, at, new Date(at.getTime() + 60_000));
    if (q > best.quantity) best = { quantity: q, at };
  }
  return best;
}

// ---------------------------------------------------------------- validação

export type ValidationResult =
  | { ok: true; start: Date; end: Date }
  | { ok: false; error: string; field: keyof ReservationInput; conflict?: boolean };

/**
 * Confere uma reserva nova contra as regras da escola e contra as reservas existentes.
 * `existing` precisa conter pelo menos as reservas confirmadas que se sobrepõem ao horário.
 */
export function validateReservation(
  input: ReservationInput,
  existing: Slot[],
  now: Date,
  config: AppConfig,
): ValidationResult {
  const { limits } = config;
  const title = input.title.trim();
  const teacher = input.teacher.trim();
  if (!title) return { ok: false, error: 'Informe o título da atividade.', field: 'title' };
  if (!teacher) return { ok: false, error: 'Informe o nome do professor.', field: 'teacher' };
  if (title.length > limits.title)
    return { ok: false, error: `O título pode ter até ${limits.title} caracteres.`, field: 'title' };
  if (teacher.length > limits.teacher)
    return { ok: false, error: `O nome pode ter até ${limits.teacher} caracteres.`, field: 'teacher' };
  if (input.className.trim().length > limits.className)
    return { ok: false, error: `A turma pode ter até ${limits.className} caracteres.`, field: 'className' };
  if (input.notes.trim().length > limits.notes)
    return { ok: false, error: `As observações podem ter até ${limits.notes} caracteres.`, field: 'notes' };
  const unitTablets = tabletsFor(config, input.unit);
  if (unitTablets === 0) return { ok: false, error: 'Escolha uma unidade válida.', field: 'unit' };
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > unitTablets)
    return {
      ok: false,
      error: `A quantidade deve ser um número inteiro entre 1 e ${unitTablets}.`,
      field: 'quantity',
    };

  const start = combine(input.date, input.startTime);
  const end = combine(input.date, input.endTime);
  if (!isValidDate(start))
    return { ok: false, error: 'Informe uma data e um horário de início válidos.', field: 'date' };
  if (!isValidDate(end)) return { ok: false, error: 'Informe um horário de término válido.', field: 'endTime' };
  if (isWeekend(start))
    return { ok: false, error: 'As reservas são feitas apenas de segunda a sexta.', field: 'date' };
  if (end <= start) return { ok: false, error: 'O término precisa ser depois do início.', field: 'endTime' };
  if ((end.getTime() - start.getTime()) / 60_000 < config.minDurationMinutes)
    return {
      ok: false,
      error: `A reserva precisa durar pelo menos ${config.minDurationMinutes} minutos.`,
      field: 'endTime',
    };
  if (minutesOfDay(start) < config.dayStartMinutes || minutesOfDay(end) > config.dayEndMinutes)
    return {
      ok: false,
      error: `Escolha um horário entre ${minutesToTime(config.dayStartMinutes)} e ${minutesToTime(config.dayEndMinutes)}.`,
      field: 'startTime',
    };
  if (start < now) {
    const pastDay = startOfDay(start) < startOfDay(now);
    return pastDay
      ? { ok: false, error: 'Não é possível reservar em uma data que já passou.', field: 'date' }
      : { ok: false, error: 'Esse horário já começou. Escolha um horário futuro.', field: 'startTime' };
  }

  const free = freeTablets(existing, input.unit, start, end, config);
  const unitLabel = `da unidade ${input.unit}`;
  if (input.quantity > free) {
    return {
      ok: false,
      conflict: true,
      field: 'quantity',
      error:
        free <= 0
          ? `Todos os tablets ${unitLabel} já estão reservados em parte desse horário.`
          : `Há apenas ${free} ${free === 1 ? 'tablet livre' : 'tablets livres'} ${unitLabel} durante todo esse horário.`,
    };
  }
  return { ok: true, start, end };
}
