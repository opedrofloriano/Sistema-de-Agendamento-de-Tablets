// Painel da coordenação e da TI: uso dos tablets, quem mais usa, pendências e (só TI) a área técnica.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ROLE_LABEL,
  addDays,
  displayStatus,
  formatTime,
  parseLocal,
  startOfDay,
  startOfWeek,
  toDateKey,
} from '../../../shared/rules.ts';
import type { PanelStats } from '../../../shared/stats.ts';
import type { AdminUser, AppConfig, AuditEntry, Reservation, SystemInfo, User } from '../../../shared/types.ts';
import { api } from '../api.ts';
import {
  ActivityIcon,
  CalendarCheckIcon,
  ChartIcon,
  ClockIcon,
  DownloadIcon,
  GaugeIcon,
  RefreshIcon,
  ShieldIcon,
  TabletIcon,
  UsersIcon,
} from '../icons.tsx';
import { ColumnChart, Meter, PanelCard, ShareBars, fmtHours, fmtNumber, fmtPct } from './charts.tsx';
import { ReservationDetails } from './ReservationDetails.tsx';

type RangeId = 'semana' | '30d' | 'mes' | '90d';
const RANGES: { id: RangeId; label: string; previous: string }[] = [
  { id: 'semana', label: 'Esta semana', previous: 'semana anterior' },
  { id: '30d', label: 'Últimos 30 dias', previous: '30 dias anteriores' },
  { id: 'mes', label: 'Este mês', previous: 'mês anterior' },
  { id: '90d', label: 'Últimos 90 dias', previous: '90 dias anteriores' },
];

function rangeFor(id: RangeId, now: Date): { from: Date; to: Date; prevFrom: Date; prevTo: Date } {
  const today = startOfDay(now);
  if (id === 'semana') {
    const mon = startOfWeek(today);
    return { from: mon, to: addDays(mon, 4), prevFrom: addDays(mon, -7), prevTo: addDays(mon, -3) };
  }
  if (id === 'mes') {
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    const last = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    const prevFirst = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    return { from: first, to: last, prevFrom: prevFirst, prevTo: addDays(first, -1) };
  }
  const days = id === '30d' ? 30 : 90;
  const from = addDays(today, -(days - 1));
  return { from, to: today, prevFrom: addDays(from, -days), prevTo: addDays(from, -1) };
}

const shortDate = (d: Date) => d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
const whenLabel = (r: Reservation) => {
  const s = parseLocal(r.start);
  const day = s.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }).replace('.', '');
  return `${day} · ${formatTime(s)}–${formatTime(parseLocal(r.end))}`;
};

const ACTION_LABEL: Record<string, string> = { criar: 'Criou', cancelar: 'Cancelou', devolver: 'Registrou devolução' };

function auditDetail(e: AuditEntry): string {
  try {
    const d = JSON.parse(e.details || '{}') as { quantity?: number; start?: string; teacher?: string };
    if (!d.quantity || !d.start) return '';
    const s = parseLocal(d.start);
    return `${d.quantity} tablets · ${shortDate(s)} ${formatTime(s)}`;
  } catch {
    return '';
  }
}

function uptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${m} min`;
}

/** Variação contra o período anterior, em texto (sem cor: subir não é bom nem ruim por si só). */
function Delta({ now, before, previous }: { now: number; before: number; previous: string }) {
  if (before === 0 && now === 0) return <small>Sem uso no período e no(a) {previous}</small>;
  if (before === 0) return <small>Nenhum uso no(a) {previous}</small>;
  const pct = ((now - before) / before) * 100;
  const arrow = Math.abs(pct) < 0.5 ? '=' : pct > 0 ? '↑' : '↓';
  return (
    <small>
      <b className="delta">
        {arrow} {fmtNumber(Math.abs(pct))}%
      </b>{' '}
      vs. {previous}
    </small>
  );
}

function csvOf(stats: PanelStats, unitLabel: string): string {
  const q = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const lines: string[] = [];
  const row = (...cells: (string | number)[]) => lines.push(cells.map(q).join(';'));
  row('Período', `${stats.from} a ${stats.to}`, 'Unidade', unitLabel);
  row('');
  row('Grupo', 'Nome', 'Reservas', 'Tablets·hora', '% do uso');
  for (const r of stats.byClass) row('Turma / sala', r.name, r.reservations, r.tabletHours, r.sharePct);
  for (const r of stats.byTeacher) row('Professor(a)', r.name, r.reservations, r.tabletHours, r.sharePct);
  for (const r of stats.byPeriod) row('Horário', r.label, r.reservations, r.tabletHours, '');
  for (const r of stats.byWeekday) row('Dia da semana', r.label, r.reservations, r.tabletHours, '');
  for (const u of stats.byUnit) row('Unidade', u.unit, u.reservations, u.tabletHours, `ocupação ${u.occupancyPct}%`);
  return '﻿' + lines.join('\r\n');
}

interface AdminPanelProps {
  user: User;
  config: AppConfig;
  now: Date;
  /** Avisa o App para recarregar a agenda depois de cancelar ou registrar devolução. */
  onChanged: (message: string) => void;
}

export function AdminPanel({ user, config, now, onChanged }: AdminPanelProps) {
  const isTi = user.role === 'ti';
  const [range, setRange] = useState<RangeId>('semana');
  const [unit, setUnit] = useState('');
  const [stats, setStats] = useState<PanelStats | null>(null);
  const [prev, setPrev] = useState<PanelStats | null>(null);
  const [pending, setPending] = useState<Reservation[]>([]);
  const [upcoming, setUpcoming] = useState<Reservation[]>([]);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Reservation | null>(null);
  const [tick, setTick] = useState(0);

  const dayKey = toDateKey(now);
  const r = useMemo(() => rangeFor(range, parseLocal(`${dayKey}T12:00`)), [range, dayKey]);
  const rangeInfo = RANGES.find((x) => x.id === range) ?? RANGES[0];

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const today = parseLocal(`${dayKey}T00:00`);
      const [s, p, pend, next] = await Promise.all([
        api.adminStats(toDateKey(r.from), toDateKey(r.to), unit),
        api.adminStats(toDateKey(r.prevFrom), toDateKey(r.prevTo), unit),
        api.pendingReturns(),
        api.listReservations(dayKey, toDateKey(addDays(today, 14))),
      ]);
      setStats(s);
      setPrev(p);
      setPending(pend);
      setUpcoming(next);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível carregar o painel.');
    } finally {
      setLoading(false);
    }
  }, [r, unit, dayKey]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  useEffect(() => {
    if (!isTi) return;
    let active = true;
    Promise.all([api.auditLog(40), api.adminUsers(), api.systemInfo()])
      .then(([a, u, s]) => {
        if (!active) return;
        setAudit(a);
        setUsers(u);
        setSystem(s);
      })
      .catch((err) => active && setError(err instanceof Error ? err.message : 'Não foi possível carregar a área da TI.'));
    return () => {
      active = false;
    };
  }, [isTi, tick]);

  const byUnitFilter = (x: Reservation) => !unit || x.unit === unit;
  const pendingList = pending.filter(byUnitFilter);
  const nextList = upcoming
    .filter((x) => x.status !== 'cancelada' && byUnitFilter(x) && parseLocal(x.end) > now)
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, 8);

  const unitIndex = (name: string) => Math.max(0, config.units.findIndex((u) => u.name === name));
  const periodText = `${shortDate(r.from)} a ${shortDate(r.to)}`;

  async function act(action: 'cancel' | 'return', id: string) {
    if (action === 'cancel') await api.cancelReservation(id);
    else await api.registerReturn(id);
    setSelected(null);
    setTick((t) => t + 1);
    onChanged(action === 'cancel' ? 'Reserva cancelada. Os tablets foram liberados.' : 'Devolução registrada.');
  }

  function download() {
    if (!stats) return;
    const blob = new Blob([csvOf(stats, unit || 'Todas')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `uso-tablets-${stats.from}-a-${stats.to}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const t = stats?.totals;
  const pt = prev?.totals;

  return (
    <div className="admin-panel" aria-busy={loading}>
      <div className="panel-filters" role="group" aria-label="Filtros do painel">
        <div className="segmented" role="radiogroup" aria-label="Período">
          {RANGES.map((x) => (
            <button key={x.id} type="button" role="radio" aria-checked={range === x.id} onClick={() => setRange(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
        <label className="panel-select">
          <span className="sr-only">Unidade</span>
          <select value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Unidade">
            <option value="">Todas as unidades</option>
            {config.units.map((u) => (
              <option key={u.name} value={u.name}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        <span className="panel-period">{periodText}</span>
        <div className="panel-filter-actions">
          <button type="button" className="chip-button" onClick={() => setTick((n) => n + 1)} aria-label="Atualizar painel">
            <RefreshIcon size={15} aria-hidden="true" /> <span>Atualizar</span>
          </button>
          <button type="button" className="chip-button" onClick={download} disabled={!stats}>
            <DownloadIcon size={15} aria-hidden="true" /> <span>Planilha (CSV)</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="error-banner" role="alert">
          {error}
          <button type="button" className="link-button" onClick={() => setTick((n) => n + 1)}>
            Tentar de novo
          </button>
        </div>
      )}

      <div className="panel-tiles">
        <article className="summary-card">
          <div className="summary-icon blue" aria-hidden="true">
            <CalendarCheckIcon size={19} />
          </div>
          <span>Reservas</span>
          <strong>{t ? fmtNumber(t.reservations) : '–'}</strong>
          {t && pt ? <Delta now={t.reservations} before={pt.reservations} previous={rangeInfo.previous} /> : <small>&nbsp;</small>}
          {t && t.cancelled > 0 && <small className="tile-note">{t.cancelled} cancelada{t.cancelled > 1 ? 's' : ''} (não contam)</small>}
        </article>
        <article className="summary-card">
          <div className="summary-icon green" aria-hidden="true">
            <TabletIcon size={19} />
          </div>
          <span title="Quantidade de tablets × horas de uso">Uso dos tablets</span>
          <strong>
            {t ? fmtNumber(t.tabletHours, 1) : '–'} <em>tablets·h</em>
          </strong>
          {t && pt ? <Delta now={t.tabletHours} before={pt.tabletHours} previous={rangeInfo.previous} /> : <small>&nbsp;</small>}
          <small className="tile-note">Ex.: 30 tablets por 1 hora = 30 tablets·h</small>
        </article>
        <article className="summary-card">
          <div className="summary-icon amber" aria-hidden="true">
            <GaugeIcon size={19} />
          </div>
          <span>Ocupação média</span>
          <strong>{t ? fmtPct(t.occupancyPct) : '–'}</strong>
          {t && pt ? <Delta now={t.occupancyPct} before={pt.occupancyPct} previous={rangeInfo.previous} /> : <small>&nbsp;</small>}
          <small className="tile-note">Dos tablets, de seg. a sex., das 07:00 às 18:20</small>
        </article>
        <article className="summary-card">
          <div className="summary-icon blue" aria-hidden="true">
            <UsersIcon size={19} />
          </div>
          <span>Professores que usaram</span>
          <strong>{t ? fmtNumber(t.teachers) : '–'}</strong>
          {t && pt ? <Delta now={t.teachers} before={pt.teachers} previous={rangeInfo.previous} /> : <small>&nbsp;</small>}
          {t && t.returned > 0 && <small className="tile-note">{t.returned} devoluções registradas</small>}
        </article>
      </div>

      <div className="panel-grid">
        <PanelCard
          className="span-4"
          title="Ocupação por unidade"
          subtitle="Quanto do acervo de cada unidade foi usado no período"
          icon={<GaugeIcon size={17} aria-hidden="true" />}
        >
          <ul className="unit-meters">
            {(stats?.byUnit ?? []).map((u) => (
              <li key={u.unit}>
                <div className="unit-meter-head">
                  <span className="peak-unit">
                    <span className={`unit-dot unit-${unitIndex(u.unit) % 4}`} aria-hidden="true" />
                    {u.unit}
                  </span>
                  <strong>{fmtPct(u.occupancyPct)}</strong>
                </div>
                <Meter pct={u.occupancyPct} tone={unitIndex(u.unit)} label={`Ocupação da unidade ${u.unit}`} />
                <small>
                  {fmtNumber(u.reservations)} reservas · {fmtHours(u.tabletHours)} · {u.tablets} tablets
                </small>
              </li>
            ))}
          </ul>
        </PanelCard>

        <PanelCard
          className="span-8"
          title="Horários de aula mais procurados"
          subtitle="Número de reservas que começam em cada horário"
          icon={<ClockIcon size={17} aria-hidden="true" />}
          table={
            stats && (
              <table className="panel-table">
                <thead>
                  <tr>
                    <th>Horário</th>
                    <th className="num">Reservas</th>
                    <th className="num">Tablets·h</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.byPeriod.map((p) => (
                    <tr key={p.id}>
                      <td>{p.label}</td>
                      <td className="num">{p.reservations}</td>
                      <td className="num">{fmtNumber(p.tabletHours, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          }
        >
          <ColumnChart
            unit="reservas"
            emptyText="Nenhuma reserva no período."
            data={(stats?.byPeriod ?? []).map((p) => ({
              key: p.id,
              short: p.short,
              label: p.label,
              value: p.reservations,
              extra: fmtHours(p.tabletHours),
            }))}
          />
        </PanelCard>

        <PanelCard
          className="span-6"
          title="Turmas / salas que mais usam"
          subtitle="% do uso total (tablets × horas)"
          icon={<ChartIcon size={17} aria-hidden="true" />}
          table={stats && <ShareTable rows={stats.byClass} first="Turma / sala" />}
        >
          <ShareBars
            label="Ranking de turmas e salas"
            emptyText="Nenhuma reserva no período."
            data={(stats?.byClass ?? []).map((c) => ({
              name: c.name,
              pct: c.sharePct,
              detail: `${c.reservations} reserva${c.reservations === 1 ? '' : 's'} · ${fmtHours(c.tabletHours)}`,
              rest: /^Outras \(\d+\)$/.test(c.name),
            }))}
          />
        </PanelCard>

        <PanelCard
          className="span-6"
          title="Professores que mais usam"
          subtitle="% do uso total (tablets × horas)"
          icon={<UsersIcon size={17} aria-hidden="true" />}
          table={stats && <ShareTable rows={stats.byTeacher} first="Professor(a)" />}
        >
          <ShareBars
            label="Ranking de professores"
            emptyText="Nenhuma reserva no período."
            data={(stats?.byTeacher ?? []).map((c) => ({
              name: c.name,
              pct: c.sharePct,
              detail: `${c.reservations} reserva${c.reservations === 1 ? '' : 's'} · ${fmtHours(c.tabletHours)}`,
              rest: /^Outros \(\d+\)$/.test(c.name),
            }))}
          />
        </PanelCard>

        <PanelCard
          className="span-4"
          title="Por dia da semana"
          subtitle="Número de reservas"
          icon={<CalendarCheckIcon size={17} aria-hidden="true" />}
          table={
            stats && (
              <table className="panel-table">
                <thead>
                  <tr>
                    <th>Dia</th>
                    <th className="num">Reservas</th>
                    <th className="num">Tablets·h</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.byWeekday.map((p) => (
                    <tr key={p.id}>
                      <td>{p.label}</td>
                      <td className="num">{p.reservations}</td>
                      <td className="num">{fmtNumber(p.tabletHours, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          }
        >
          <ColumnChart
            unit="reservas"
            emptyText="Nenhuma reserva no período."
            data={(stats?.byWeekday ?? []).map((p) => ({ key: p.id, short: p.short, label: p.label, value: p.reservations, extra: fmtHours(p.tabletHours) }))}
          />
        </PanelCard>

        <PanelCard
          className="span-8"
          title="Aguardando devolução"
          subtitle="Reservas que já terminaram e ainda não tiveram a devolução registrada (últimos 60 dias)"
          icon={<TabletIcon size={17} aria-hidden="true" />}
        >
          <ReservationTable
            list={pendingList}
            empty="Tudo devolvido. Nenhuma pendência."
            onOpen={setSelected}
            unitIndex={unitIndex}
          />
        </PanelCard>

        <PanelCard
          className="span-12"
          title="Próximas reservas"
          subtitle="Clique em uma reserva para ver os detalhes ou cancelar"
          icon={<CalendarCheckIcon size={17} aria-hidden="true" />}
        >
          <ReservationTable list={nextList} empty="Nenhuma reserva nos próximos 14 dias." onOpen={setSelected} unitIndex={unitIndex} />
        </PanelCard>
      </div>

      {isTi && (
        <section className="ti-area" aria-labelledby="ti-area-title">
          <header className="ti-area-head">
            <ShieldIcon size={18} aria-hidden="true" />
            <h2 id="ti-area-title">Área da TI</h2>
            <span>Só quem entra como TI vê esta parte</span>
          </header>

          <div className="panel-tiles ti-tiles">
            <article className="summary-card">
              <span>Banco de dados</span>
              <strong className="tile-text">
                {system ? { local: 'Arquivo local', turso: 'Turso (nuvem)', navegador: 'Navegador (demo)' }[system.database] : '–'}
              </strong>
              <small>{system ? `Fuso: ${system.timezone}` : ''}</small>
            </article>
            <article className="summary-card">
              <span>Forma de login</span>
              <strong className="tile-text">
                {system
                  ? { entra: 'Conta Microsoft', piloto: 'Código de acesso', dev: 'Teste (dev)', demo: 'Demonstração' }[system.authMode]
                  : '–'}
              </strong>
              <small>{system ? `Node ${system.nodeVersion}` : ''}</small>
            </article>
            <article className="summary-card">
              <span>No ar há</span>
              <strong className="tile-text">{system ? uptime(system.uptimeSeconds) : '–'}</strong>
              <small>Desde o último reinício do servidor</small>
            </article>
            <article className="summary-card">
              <span>Totais</span>
              <strong className="tile-text">{system ? `${fmtNumber(system.totals.reservations)} reservas` : '–'}</strong>
              <small>
                {system ? `${system.totals.users} pessoas · ${system.totals.activeSessions} sessões ativas` : ''}
              </small>
            </article>
          </div>

          <div className="panel-grid">
            <PanelCard className="span-7" title="Registro de atividades" subtitle="Últimas 40 ações" icon={<ActivityIcon size={17} aria-hidden="true" />}>
              <div className="panel-table-wrap">
                <table className="panel-table">
                  <thead>
                    <tr>
                      <th>Quando</th>
                      <th>Quem</th>
                      <th>Ação</th>
                      <th>Reserva</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(audit ?? []).map((e) => {
                      const at = parseLocal(e.at.slice(0, 19));
                      return (
                        <tr key={e.id}>
                          <td className="nowrap">
                            {shortDate(at)} {formatTime(at)}
                          </td>
                          <td>{e.userName}</td>
                          <td>
                            <span className={`action-pill action-${e.action}`}>{ACTION_LABEL[e.action] ?? e.action}</span>
                          </td>
                          <td>
                            {e.reservationTitle ?? '—'}
                            {auditDetail(e) && <small className="cell-sub">{auditDetail(e)}</small>}
                          </td>
                        </tr>
                      );
                    })}
                    {audit && audit.length === 0 && (
                      <tr>
                        <td colSpan={4} className="table-empty">
                          Nenhuma ação registrada ainda.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </PanelCard>

            <PanelCard className="span-5" title="Pessoas que já entraram" subtitle="Papel e total de reservas" icon={<UsersIcon size={17} aria-hidden="true" />}>
              <div className="panel-table-wrap">
                <table className="panel-table">
                  <thead>
                    <tr>
                      <th>Nome</th>
                      <th>Papel</th>
                      <th className="num">Reservas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(users ?? []).map((u) => (
                      <tr key={u.id}>
                        <td>
                          {u.name}
                          <small className="cell-sub">
                            {u.email || 'sem e-mail'} · último acesso {shortDate(parseLocal(u.updatedAt.slice(0, 19)))}
                          </small>
                        </td>
                        <td>
                          <span className={`role-pill role-${u.role}`}>{ROLE_LABEL[u.role]}</span>
                        </td>
                        <td className="num">{u.reservations}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </PanelCard>
          </div>
        </section>
      )}

      {selected && (
        <ReservationDetails
          key={selected.id}
          reservation={selected}
          now={now}
          canManage
          onClose={() => setSelected(null)}
          onCancel={(id) => act('cancel', id)}
          onReturn={(id) => act('return', id)}
        />
      )}
    </div>
  );
}

function ShareTable({ rows, first }: { rows: PanelStats['byClass']; first: string }) {
  return (
    <table className="panel-table">
      <thead>
        <tr>
          <th>{first}</th>
          <th className="num">Reservas</th>
          <th className="num">Tablets·h</th>
          <th className="num">% do uso</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name}>
            <td>{r.name}</td>
            <td className="num">{r.reservations}</td>
            <td className="num">{fmtNumber(r.tabletHours, 1)}</td>
            <td className="num">{fmtPct(r.sharePct)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ReservationTable(props: {
  list: Reservation[];
  empty: string;
  onOpen: (r: Reservation) => void;
  unitIndex: (unit: string) => number;
}) {
  if (!props.list.length) return <p className="chart-empty">{props.empty}</p>;
  const now = new Date();
  return (
    <div className="panel-table-wrap">
      <table className="panel-table is-clickable">
        <thead>
          <tr>
            <th>Atividade</th>
            <th>Professor(a)</th>
            <th>Quando</th>
            <th>Unidade</th>
            <th className="num">Tablets</th>
          </tr>
        </thead>
        <tbody>
          {props.list.map((r) => (
            <tr key={r.id}>
              <td>
                <button type="button" className="row-button" onClick={() => props.onOpen(r)}>
                  {r.title}
                </button>
                {r.className && <small className="cell-sub">{r.className}</small>}
              </td>
              <td>{r.teacher}</td>
              <td className="nowrap">
                {whenLabel(r)}
                {displayStatus(r, now) === 'em-andamento' && <small className="cell-sub">em andamento</small>}
              </td>
              <td className="nowrap">
                <span className={`unit-dot unit-${props.unitIndex(r.unit) % 4}`} aria-hidden="true" /> {r.unit}
              </td>
              <td className="num">{r.quantity}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
