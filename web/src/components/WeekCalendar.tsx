import { useMemo, type CSSProperties } from 'react';
import {
  STATUS_LABEL,
  displayStatus,
  formatLongDate,
  formatTime,
  gmtLabel,
  minutesOfDay,
  minutesToTime,
  nextWeekday,
  pad2,
  parseLocal,
  sameDay,
  toDateKey,
  weekDays,
} from '../../../shared/rules.ts';
import type { Reservation } from '../../../shared/types.ts';
import { useMediaQuery } from '../hooks.ts';

const HOUR_HEIGHT = 64;
const RIGHT_GUTTER = 16;
const px = (minutes: number) => (minutes / 60) * HOUR_HEIGHT;

/** Distribui reservas que se sobrepõem em colunas lado a lado. */
export function layoutLanes(items: Pick<Reservation, 'id' | 'start' | 'end'>[]): Map<string, { lane: number; lanes: number }> {
  const sorted = items
    .map((r) => ({ id: r.id, start: parseLocal(r.start).getTime(), end: parseLocal(r.end).getTime() }))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const result = new Map<string, { lane: number; lanes: number }>();
  let group: { id: string; lane: number }[] = [];
  let laneEnds: number[] = [];
  let groupEnd = -Infinity;
  const flush = () => {
    for (const g of group) result.set(g.id, { lane: g.lane, lanes: laneEnds.length });
    group = [];
    laneEnds = [];
  };
  for (const item of sorted) {
    if (item.start >= groupEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= item.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(item.end);
    } else {
      laneEnds[lane] = item.end;
    }
    group.push({ id: item.id, lane });
    groupEnd = Math.max(groupEnd, item.end);
  }
  flush();
  return result;
}

interface WeekCalendarProps {
  selectedDate: Date;
  reservations: Reservation[];
  now: Date;
  dayStartMinutes: number;
  dayEndMinutes: number;
  unitIndex: (unit: string) => number;
  onCreateAt: (day: Date, hour: number) => void;
  onSelect: (r: Reservation) => void;
  onSelectDay: (day: Date) => void;
}

export function WeekCalendar(props: WeekCalendarProps) {
  const { selectedDate, reservations, now, dayStartMinutes, dayEndMinutes } = props;
  const dayView = useMediaQuery('(max-width: 720px)');
  const week = useMemo(() => weekDays(selectedDate), [selectedDate]);
  const selected = nextWeekday(selectedDate);
  const columns = dayView ? week.filter((d) => sameDay(d, selected)) : week;

  const firstHour = Math.floor(dayStartMinutes / 60);
  const lastHour = Math.ceil(dayEndMinutes / 60);
  const hours = Array.from({ length: lastHour - firstHour }, (_, i) => firstHour + i);
  const gridStart = firstHour * 60;

  const byDay = useMemo(() => {
    const map = new Map<string, Reservation[]>();
    for (const r of reservations) {
      const key = r.start.slice(0, 10);
      map.set(key, [...(map.get(key) ?? []), r]);
    }
    return map;
  }, [reservations]);

  const nowMinutes = minutesOfDay(now);
  const nowVisible = nowMinutes >= gridStart && nowMinutes <= lastHour * 60;
  const style = {
    '--hour-height': `${HOUR_HEIGHT}px`,
    '--day-height': `${hours.length * HOUR_HEIGHT}px`,
  } as CSSProperties;

  return (
    <div className="calendar-scroll">
      <div className={`week-calendar ${dayView ? 'is-day-view' : ''}`} style={style}>
        <div className="calendar-head">
          <div className="time-gutter-label">{gmtLabel(now)}</div>
          {week.map((d) => {
            const isSelected = dayView && sameDay(d, selected);
            const cls = `day-heading ${sameDay(d, now) ? 'is-today' : ''} ${isSelected ? 'is-selected' : ''}`;
            const content = (
              <>
                <span>{d.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '')}</span>
                <strong>{d.getDate()}</strong>
              </>
            );
            return dayView ? (
              <button
                key={toDateKey(d)}
                type="button"
                className={cls}
                aria-pressed={isSelected}
                aria-label={formatLongDate(d)}
                onClick={() => props.onSelectDay(d)}
              >
                {content}
              </button>
            ) : (
              <div key={toDateKey(d)} className={cls}>
                {content}
              </div>
            );
          })}
        </div>

        <div className="calendar-body">
          <div className="time-gutter" aria-hidden="true">
            {hours.map((h) => (
              <div key={h} className="time-label">
                {pad2(h)}:00
              </div>
            ))}
          </div>

          {columns.map((day) => {
            const key = toDateKey(day);
            const items = byDay.get(key) ?? [];
            const lanes = layoutLanes(items);
            return (
              <div key={key} className="day-column" role="group" aria-label={formatLongDate(day)}>
                {hours.map((h) => {
                  const past = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h + 1) <= now;
                  return (
                    <button
                      key={h}
                      type="button"
                      className="hour-cell"
                      disabled={past}
                      title={past ? 'Horário encerrado' : `Reservar às ${pad2(h)}:00`}
                      aria-label={past ? undefined : `Nova reserva em ${formatLongDate(day)}, ${pad2(h)}:00`}
                      onClick={() => props.onCreateAt(day, h)}
                    />
                  );
                })}

                {/* Fora do horário de reserva (ex.: depois das 18:20), a grade aparece bloqueada. */}
                {dayStartMinutes > gridStart && (
                  <div className="closed-hours" style={{ top: 0, height: `${px(dayStartMinutes - gridStart)}px` }} aria-hidden="true" />
                )}
                {dayEndMinutes < lastHour * 60 && (
                  <div
                    className="closed-hours"
                    style={{ top: `${px(dayEndMinutes - gridStart)}px`, height: `${px(lastHour * 60 - dayEndMinutes)}px` }}
                    title={`Reservas só até ${minutesToTime(dayEndMinutes)}`}
                    aria-hidden="true"
                  />
                )}

                {sameDay(day, now) && nowVisible && (
                  <div className="now-line" style={{ top: `${px(nowMinutes - gridStart)}px` }} aria-hidden="true" />
                )}

                {items.map((r) => {
                  const start = parseLocal(r.start);
                  const end = parseLocal(r.end);
                  const from = Math.max(minutesOfDay(start), gridStart);
                  const to = Math.min(minutesOfDay(end), lastHour * 60);
                  if (to <= from) return null;
                  const { lane, lanes: laneCount } = lanes.get(r.id) ?? { lane: 0, lanes: 1 };
                  const height = Math.max(26, px(to - from) - 3);
                  const status = displayStatus(r, now);
                  const compact = height < 52;
                  const narrow = laneCount > 1;
                  const tight = laneCount >= 3;
                  const range = `${formatTime(start)} – ${formatTime(end)}`;
                  const cardStyle: CSSProperties = {
                    top: `${px(from - gridStart) + 1}px`,
                    height: `${height}px`,
                    left: `calc((100% - ${RIGHT_GUTTER}px) * ${lane / laneCount} + 2px)`,
                    width: `calc((100% - ${RIGHT_GUTTER}px) / ${laneCount} - 3px)`,
                  };
                  return (
                    <button
                      key={r.id}
                      type="button"
                      className={`event-card unit-${props.unitIndex(r.unit) % 4} status-${status} ${compact ? 'is-compact' : ''} ${narrow ? 'is-narrow' : ''} ${tight ? 'is-tight' : ''}`}
                      style={cardStyle}
                      onClick={() => props.onSelect(r)}
                      title={`${r.title}\n${range} · ${r.quantity} tablets\n${r.teacher} · ${r.unit}`}
                      aria-label={`${r.title}, ${range}, ${r.teacher}, ${r.unit}, ${r.quantity} tablets, ${STATUS_LABEL[status]}`}
                    >
                      {compact ? (
                        <span className="event-line">
                          {narrow ? null : <strong>{formatTime(start)} </strong>}
                          {r.title}
                        </span>
                      ) : (
                        <>
                          <span className="event-time">{narrow ? formatTime(start) : range}</span>
                          <span className="event-title">{r.title}</span>
                          <span className="event-meta">
                            {r.quantity} tablets{narrow ? '' : ` · ${r.teacher}`}
                          </span>
                        </>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
