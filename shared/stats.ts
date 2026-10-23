// Estatísticas de uso para o Painel da coordenação e da TI.
// Medida principal: "tablets·hora" (quantidade × duração). Uma reserva de 30 tablets por 1 hora
// pesa o mesmo que 15 tablets por 2 horas. Reservas canceladas não contam como uso.

import { addDays, isWeekend, parseLocal, startOfDay, timeToMinutes } from './rules.ts';
import type { AppConfig, Reservation } from './types.ts';

export interface ShareRow {
  name: string;
  reservations: number;
  tabletHours: number;
  /** Porcentagem do uso total (tablets·hora) no período. */
  sharePct: number;
}

export interface UnitRow {
  unit: string;
  tablets: number;
  reservations: number;
  tabletHours: number;
  /** Tablets·hora usados ÷ tablets·hora disponíveis nos dias úteis do período. */
  occupancyPct: number;
}

export interface SlotRow {
  id: string;
  label: string;
  short: string;
  reservations: number;
  tabletHours: number;
}

export interface PanelStats {
  from: string;
  to: string;
  totals: {
    reservations: number;
    cancelled: number;
    returned: number;
    tabletHours: number;
    teachers: number;
    occupancyPct: number;
  };
  byUnit: UnitRow[];
  byClass: ShareRow[];
  byTeacher: ShareRow[];
  byPeriod: SlotRow[];
  byWeekday: SlotRow[];
}

const WEEKDAYS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex'];
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Dias úteis entre `from` e `to` (ambos AAAA-MM-DD, inclusive). */
export function weekdaysBetween(from: string, to: string): number {
  let d = startOfDay(parseLocal(`${from}T00:00`));
  const end = startOfDay(parseLocal(`${to}T00:00`));
  let n = 0;
  while (d <= end) {
    if (!isWeekend(d)) n += 1;
    d = addDays(d, 1);
  }
  return n;
}

const hoursOf = (r: Pick<Reservation, 'start' | 'end'>) =>
  Math.max(0, (parseLocal(r.end).getTime() - parseLocal(r.start).getTime()) / 3_600_000);

/** Agrupa e ordena por uso; o que passa de `top` vira uma linha "Outros". */
function share(groups: Map<string, { reservations: number; tabletHours: number }>, total: number, top: number, other: string): ShareRow[] {
  const rows = [...groups.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.tabletHours - a.tabletHours || b.reservations - a.reservations || a.name.localeCompare(b.name, 'pt-BR'));
  const head = rows.slice(0, top);
  const tail = rows.slice(top);
  if (tail.length) {
    head.push({
      name: `${other} (${tail.length})`,
      reservations: tail.reduce((s, r) => s + r.reservations, 0),
      tabletHours: tail.reduce((s, r) => s + r.tabletHours, 0),
    });
  }
  return head.map((r) => ({
    ...r,
    tabletHours: round1(r.tabletHours),
    sharePct: total > 0 ? round1((r.tabletHours / total) * 100) : 0,
  }));
}

/**
 * @param reservations reservas que começam entre `from` e `to` (inclusive), de qualquer status
 * @param unit quando informado, considera só essa unidade
 */
export function computeStats(
  reservations: Reservation[],
  from: string,
  to: string,
  config: AppConfig,
  unit?: string,
  top = 8,
): PanelStats {
  const inScope = reservations.filter((r) => !unit || r.unit === unit);
  const used = inScope.filter((r) => r.status !== 'cancelada');
  const totalHours = used.reduce((s, r) => s + r.quantity * hoursOf(r), 0);
  const days = weekdaysBetween(from, to);
  const dayHours = (config.dayEndMinutes - config.dayStartMinutes) / 60;

  const units = config.units.filter((u) => !unit || u.name === unit);
  const byUnit: UnitRow[] = units.map((u) => {
    const rs = used.filter((r) => r.unit === u.name);
    const th = rs.reduce((s, r) => s + r.quantity * hoursOf(r), 0);
    const capacity = u.tablets * dayHours * days;
    return {
      unit: u.name,
      tablets: u.tablets,
      reservations: rs.length,
      tabletHours: round1(th),
      occupancyPct: capacity > 0 ? round1((th / capacity) * 100) : 0,
    };
  });
  const capacityAll = units.reduce((s, u) => s + u.tablets, 0) * dayHours * days;

  const group = (key: (r: Reservation) => string) => {
    const m = new Map<string, { reservations: number; tabletHours: number }>();
    for (const r of used) {
      const k = key(r);
      const g = m.get(k) ?? { reservations: 0, tabletHours: 0 };
      g.reservations += 1;
      g.tabletHours += r.quantity * hoursOf(r);
      m.set(k, g);
    }
    return m;
  };

  // Turmas/salas e professores: mesmo nome com acento ou maiúscula diferente conta junto.
  const labeler = () => {
    const canon = new Map<string, string>();
    return (raw: string, fallback: string) => {
      const name = raw.trim().replace(/\s+/g, ' ') || fallback;
      const key = name.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
      if (!canon.has(key)) canon.set(key, name);
      return canon.get(key) as string;
    };
  };
  const classLabel = labeler();
  const teacherLabel = labeler();

  const periodOf = (r: Reservation) => {
    const m = parseLocal(r.start).getHours() * 60 + parseLocal(r.start).getMinutes();
    return config.periods.find((p) => timeToMinutes(p.start) <= m && m < timeToMinutes(p.end))?.id ?? 'outro';
  };
  const periodGroups = group(periodOf);
  const byPeriod: SlotRow[] = config.periods.map((p) => {
    const g = periodGroups.get(p.id) ?? { reservations: 0, tabletHours: 0 };
    const n = p.label.match(/^(\d+)º.*\((manhã|tarde|noite)\)/i);
    const short = n ? `${n[1]}º ${n[2].charAt(0).toUpperCase()}` : p.label;
    return { id: p.id, label: `${p.label} · ${p.start}–${p.end}`, short, reservations: g.reservations, tabletHours: round1(g.tabletHours) };
  });
  const outside = periodGroups.get('outro');
  if (outside) byPeriod.push({ id: 'outro', label: 'Fora dos horários de aula', short: 'Outro', reservations: outside.reservations, tabletHours: round1(outside.tabletHours) });

  const dayGroups = group((r) => String((parseLocal(r.start).getDay() + 6) % 7));
  const byWeekday: SlotRow[] = WEEKDAYS.map((d, i) => {
    const g = dayGroups.get(String(i)) ?? { reservations: 0, tabletHours: 0 };
    return { id: String(i), label: d, short: d, reservations: g.reservations, tabletHours: round1(g.tabletHours) };
  });

  return {
    from,
    to,
    totals: {
      reservations: used.length,
      cancelled: inScope.length - used.length,
      returned: inScope.filter((r) => r.status === 'devolvida').length,
      tabletHours: round1(totalHours),
      teachers: new Set(used.map((r) => teacherLabel(r.teacher, '—'))).size,
      occupancyPct: capacityAll > 0 ? round1((totalHours / capacityAll) * 100) : 0,
    },
    byUnit,
    byClass: share(group((r) => classLabel(r.className, 'Sem turma informada')), totalHours, top, 'Outras'),
    byTeacher: share(group((r) => teacherLabel(r.teacher, '—')), totalHours, top, 'Outros'),
    byPeriod,
    byWeekday,
  };
}
