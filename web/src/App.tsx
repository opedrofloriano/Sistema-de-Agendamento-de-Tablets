import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  addDays,
  busiestByUnit,
  isWeekend,
  minutesOfDay,
  minutesToTime,
  nextWeekday,
  parseLocal,
  shortWeekLabel,
  startOfDay,
  startOfWeek,
  timeToMinutes,
  toDateKey,
  weekLabel,
} from '../../shared/rules.ts';
import type { AppConfig, MeResponse, Reservation, ReservationInput } from '../../shared/types.ts';
import { api } from './api.ts';
import { ReservationDetails } from './components/ReservationDetails.tsx';
import { ReservationForm } from './components/ReservationForm.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { SummaryCards } from './components/SummaryCards.tsx';
import { Topbar } from './components/Topbar.tsx';
import { WeekCalendar } from './components/WeekCalendar.tsx';
import { normalizeSearch, useDebounced, useNow } from './hooks.ts';
import { CalendarIcon, InfoIcon } from './icons.tsx';

const REFRESH_MS = 60_000;

/** Horário sugerido ao clicar numa hora da agenda: o horário de aula daquela hora, ou 1h. */
function slotForHour(config: AppConfig, hour: number) {
  const minutes = hour * 60;
  const period = config.periods.find((p) => timeToMinutes(p.start) <= minutes && minutes < timeToMinutes(p.end));
  if (period) return { startTime: period.start, endTime: period.end };
  return { startTime: minutesToTime(minutes), endTime: minutesToTime(Math.min(minutes + 60, config.dayEndMinutes)) };
}

/** Próximo horário de aula livre a partir de agora, para o botão "Criar reserva". */
function nextSlot(config: AppConfig, selected: Date, now: Date) {
  const today = startOfDay(now);
  let day = selected < today || isWeekend(selected) ? nextWeekday(now) : startOfDay(selected);
  for (let i = 0; i < 7; i += 1) {
    const isToday = day.getTime() === today.getTime();
    const period = config.periods.find((p) => !isToday || timeToMinutes(p.start) > minutesOfDay(now));
    if (period) return { date: day, startTime: period.start, endTime: period.end };
    day = nextWeekday(addDays(day, 1));
  }
  return { date: day, ...slotForHour(config, Math.floor(config.dayStartMinutes / 60)) };
}

interface FormState {
  key: number;
  date: Date;
  startTime: string;
  endTime: string;
}

export function App({ me }: { me: MeResponse }) {
  const { user, config } = me;
  const now = useNow();
  const [selectedDate, setSelectedDate] = useState(() => nextWeekday(new Date()));
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [hiddenUnits, setHiddenUnits] = useState<Set<string>>(() => new Set());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [formState, setFormState] = useState<FormState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [searchHit, setSearchHit] = useState<Reservation | null | undefined>(undefined);

  const weekStart = startOfWeek(selectedDate);
  const weekKey = toDateKey(weekStart);
  const weekEnd = addDays(weekStart, 5);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const monday = parseLocal(`${weekKey}T00:00`);
      setReservations(await api.listReservations(weekKey, toDateKey(addDays(monday, 4))));
      setLoadError('');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Não foi possível carregar as reservas.');
    } finally {
      setLoading(false);
    }
  }, [weekKey]);

  useEffect(() => {
    void load();
  }, [load]);

  // Atualiza sozinho para mostrar as reservas feitas por outros professores.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(''), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);

  const term = normalizeSearch(search);
  const visible = reservations.filter(
    (r) =>
      r.status !== 'cancelada' &&
      !hiddenUnits.has(r.unit) &&
      (!term || normalizeSearch(`${r.title} ${r.teacher} ${r.className}`).includes(term)),
  );
  const inWeek = (r: Reservation) => {
    const s = parseLocal(r.start);
    return s >= weekStart && s < weekEnd;
  };
  const weekVisible = visible.filter(inWeek);
  const peaks = useMemo(() => {
    const monday = parseLocal(`${weekKey}T00:00`);
    return busiestByUnit(reservations, monday, addDays(monday, 5), config);
  }, [reservations, weekKey, config]);

  const weekCountByUnit = new Map<string, number>();
  for (const r of reservations) {
    if (r.status === 'cancelada' || !inWeek(r)) continue;
    weekCountByUnit.set(r.unit, (weekCountByUnit.get(r.unit) ?? 0) + 1);
  }

  // Busca sem resultado nesta semana: procura em todas as semanas e oferece o atalho.
  const debouncedSearch = useDebounced(search.trim(), 300);
  const noResultsHere = !!term && weekVisible.length === 0;
  useEffect(() => {
    if (!noResultsHere || debouncedSearch.length < 2) {
      setSearchHit(undefined);
      return;
    }
    let active = true;
    api
      .searchReservations(debouncedSearch)
      .then((list) => {
        if (!active) return;
        const target = parseLocal(`${weekKey}T00:00`).getTime();
        const nearest = [...list].sort(
          (a, b) => Math.abs(parseLocal(a.start).getTime() - target) - Math.abs(parseLocal(b.start).getTime() - target),
        )[0];
        setSearchHit(nearest ?? null);
      })
      .catch(() => active && setSearchHit(null));
    return () => {
      active = false;
    };
  }, [noResultsHere, debouncedSearch, weekKey]);

  const selected = reservations.find((r) => r.id === selectedId) ?? null;
  const firstVisibleUnit = (config.units.find((u) => !hiddenUnits.has(u.name)) ?? config.units[0]).name;
  const canManage = (r: Reservation) => user.role === 'coordenacao' || r.ownerId === user.id;

  const openForm = (date: Date, startTime: string, endTime: string) =>
    setFormState((prev) => ({ key: (prev?.key ?? 0) + 1, date, startTime, endTime }));

  async function save(input: ReservationInput) {
    const created = await api.createReservation(input);
    setReservations((list) => [...list.filter((r) => r.id !== created.id), created]);
    setSelectedDate(parseLocal(created.start));
    setToast(`Reserva criada: ${created.quantity} tablets para “${created.title}”.`);
  }

  const replace = (updated: Reservation) => setReservations((list) => list.map((r) => (r.id === updated.id ? updated : r)));

  async function cancel(id: string) {
    replace(await api.cancelReservation(id));
    setToast('Reserva cancelada. Os tablets foram liberados.');
  }

  async function registerReturn(id: string) {
    replace(await api.registerReturn(id));
    setToast('Devolução registrada.');
  }

  const toggleUnit = (unit: string) =>
    setHiddenUnits((prev) => {
      const next = new Set(prev);
      if (next.has(unit)) next.delete(unit);
      else next.add(unit);
      return next;
    });


  return (
    <div className="app-shell">
      <Topbar
        weekLabel={weekLabel(selectedDate)}
        shortWeekLabel={shortWeekLabel(selectedDate)}
        search={search}
        sidebarOpen={sidebarOpen}
        onSearchChange={setSearch}
        onToggleSidebar={() => setSidebarOpen((o) => !o)}
        onPrevious={() => setSelectedDate((d) => addDays(d, -7))}
        onNext={() => setSelectedDate((d) => addDays(d, 7))}
        onToday={() => setSelectedDate(nextWeekday(new Date()))}
        onCreate={() => {
          const s = nextSlot(config, selectedDate, now);
          openForm(s.date, s.startTime, s.endTime);
        }}
      />

      <div className="app-layout">
        {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-hidden="true" />}
        <Sidebar
          open={sidebarOpen}
          selectedDate={selectedDate}
          today={now}
          units={config.units}
          hiddenUnits={hiddenUnits}
          weekCountByUnit={weekCountByUnit}
          user={user}
          onSelectDate={(d) => {
            setSelectedDate(d);
            setSidebarOpen(false);
          }}
          onToggleUnit={toggleUnit}
          onLogout={() => void api.logout()}
        />

        <main className="main-content">
          <div className="page-title">
            <div>
              <p className="eyebrow">AGENDA ESCOLAR</p>
              <h2>Agendamento de tablets</h2>
              <p>Consulte a semana e reserve os tablets para as suas aulas.</p>
            </div>
            {me.authMode !== 'entra' && (
              <div className="demo-label" title={me.authMode === 'demo' ? 'As reservas ficam salvas só neste navegador.' : undefined}>
                <InfoIcon size={16} aria-hidden="true" />{' '}
                {me.authMode === 'demo' ? 'Demonstração · dados só neste navegador' : 'Modo de desenvolvimento'}
              </div>
            )}
          </div>

          <SummaryCards
            weekCount={weekVisible.length}
            filtered={!!term || hiddenUnits.size > 0}
            peaks={peaks}
            units={config.units}
          />

          {loadError && (
            <div className="error-banner" role="alert">
              {loadError}
              <button type="button" className="link-button" onClick={() => void load()}>
                Tentar de novo
              </button>
            </div>
          )}

          <section className="calendar-panel" aria-busy={loading}>
            <div className="calendar-panel-heading">
              <div>
                <CalendarIcon size={20} aria-hidden="true" />
                <strong>Agenda semanal</strong>
              </div>
              <span>
                Segunda a sexta · {minutesToTime(config.dayStartMinutes)} às {minutesToTime(config.dayEndMinutes)}
              </span>
            </div>

            {noResultsHere && searchHit !== undefined && (
              <div className="search-hint" role="status">
                {searchHit ? (
                  <>
                    Nenhum resultado para “{search.trim()}” nesta semana.
                    <button type="button" className="link-button" onClick={() => setSelectedDate(parseLocal(searchHit.start))}>
                      Ir para {parseLocal(searchHit.start).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' })}
                    </button>
                  </>
                ) : (
                  <>Nenhuma reserva encontrada para “{search.trim()}”.</>
                )}
              </div>
            )}

            <WeekCalendar
              selectedDate={selectedDate}
              reservations={visible}
              now={now}
              dayStartMinutes={config.dayStartMinutes}
              dayEndMinutes={config.dayEndMinutes}
              unitIndex={(unit) => Math.max(0, config.units.findIndex((u) => u.name === unit))}
              onCreateAt={(day, hour) => {
                const s = slotForHour(config, hour);
                openForm(day, s.startTime, s.endTime);
              }}
              onSelect={(r) => setSelectedId(r.id)}
              onSelectDay={setSelectedDate}
            />
          </section>
        </main>
      </div>

      {formState && (
        <ReservationForm
          key={formState.key}
          config={config}
          user={user}
          initialDate={formState.date}
          initialStartTime={formState.startTime}
          initialEndTime={formState.endTime}
          initialUnit={firstVisibleUnit}
          onClose={() => setFormState(null)}
          onSave={save}
        />
      )}

      {selected && (
        <ReservationDetails
          key={selected.id}
          reservation={selected}
          now={now}
          canManage={canManage(selected)}
          onClose={() => setSelectedId(null)}
          onCancel={cancel}
          onReturn={registerReturn}
        />
      )}

      <div className="toast-region" role="status" aria-live="polite">
        {toast && <div className="toast">{toast}</div>}
      </div>
    </div>
  );
}
