import { useEffect, useState } from 'react';
import { ROLE_LABEL, addDays, isStaff, isWeekend, sameDay, startOfWeek, toDateKey } from '../../../shared/rules.ts';
import type { Unit, User } from '../../../shared/types.ts';
import { ChevronLeftIcon, ChevronRightIcon, LogOutIcon } from '../icons.tsx';

const WEEKDAYS = [
  { short: 'Seg', long: 'segunda' },
  { short: 'Ter', long: 'terça' },
  { short: 'Qua', long: 'quarta' },
  { short: 'Qui', long: 'quinta' },
  { short: 'Sex', long: 'sexta' },
  { short: 'Sáb', long: 'sábado' },
  { short: 'Dom', long: 'domingo' },
];

interface SidebarProps {
  open: boolean;
  selectedDate: Date;
  today: Date;
  units: Unit[];
  hiddenUnits: Set<string>;
  weekCountByUnit: Map<string, number>;
  user: User;
  onSelectDate: (d: Date) => void;
  onToggleUnit: (unit: string) => void;
  onLogout: () => void;
}

export function Sidebar(props: SidebarProps) {
  const { selectedDate, today } = props;
  const [month, setMonth] = useState(() => new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1));
  useEffect(() => {
    setMonth(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1));
  }, [selectedDate]);

  const gridStart = startOfWeek(month);
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const selectedWeek = toDateKey(startOfWeek(selectedDate));
  const monthName = month.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  const title = monthName.charAt(0).toUpperCase() + monthName.slice(1);

  return (
    <aside id="sidebar" className={`sidebar ${props.open ? 'is-open' : ''}`} aria-label="Calendário e filtros">
      <div className="mini-calendar">
        <div className="mini-heading">
          <strong aria-live="polite">{title}</strong>
          <div>
            <button
              type="button"
              className="mini-nav"
              aria-label="Mês anterior"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
            >
              <ChevronLeftIcon size={16} />
            </button>
            <button
              type="button"
              className="mini-nav"
              aria-label="Próximo mês"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
            >
              <ChevronRightIcon size={16} />
            </button>
          </div>
        </div>
        <div className="mini-grid">
          {WEEKDAYS.map((w) => (
            <abbr key={w.long} className="mini-weekday" title={w.long}>
              {w.short}
            </abbr>
          ))}
          {days.map((d) => {
            const inWeek = toDateKey(startOfWeek(d)) === selectedWeek && !isWeekend(d);
            const cls = [
              'mini-day',
              d.getMonth() !== month.getMonth() ? 'muted' : '',
              isWeekend(d) ? 'weekend' : '',
              inWeek ? 'in-week' : '',
              sameDay(d, selectedDate) ? 'selected' : '',
              sameDay(d, today) ? 'today' : '',
            ].join(' ');
            return (
              <button
                key={toDateKey(d)}
                type="button"
                className={cls}
                aria-label={d.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}
                aria-current={sameDay(d, today) ? 'date' : undefined}
                onClick={() => props.onSelectDate(d)}
              >
                {d.getDate()}
              </button>
            );
          })}
        </div>
      </div>

      <section className="sidebar-section">
        <h2>Unidades</h2>
        {props.units.map(({ name }, i) => (
          <label key={name} className="unit-filter">
            <input type="checkbox" checked={!props.hiddenUnits.has(name)} onChange={() => props.onToggleUnit(name)} />
            <span className={`unit-dot unit-${i % 4}`} aria-hidden="true" />
            <span className="unit-name">{name}</span>
            <span className="unit-count" aria-label={`${props.weekCountByUnit.get(name) ?? 0} reservas nesta semana`}>
              {props.weekCountByUnit.get(name) ?? 0}
            </span>
          </label>
        ))}
      </section>

      <section className="sidebar-section user-card" aria-label="Sua conta">
        <h2>Você</h2>
        <div className="user-row">
          <span className="user-avatar" aria-hidden="true">
            {initials(props.user.name)}
          </span>
          <span className="user-info">
            <strong>{props.user.name}</strong>
            <span>{ROLE_LABEL[props.user.role]}</span>
          </span>
        </div>
        <p className="profile-hint">
          {isStaff(props.user.role)
            ? `Você pode cancelar qualquer reserva, reservar em nome de outros professores e ver o Painel${props.user.role === 'ti' ? ', incluindo a área técnica' : ''}.`
            : 'Você pode cancelar só as reservas feitas por você.'}
        </p>
        <button type="button" className="logout-button" onClick={props.onLogout}>
          <LogOutIcon size={15} aria-hidden="true" /> Sair
        </button>
      </section>

      <section className="sidebar-help">
        <h2>Como funciona</h2>
        <p>
          Clique em um horário livre da agenda para reservar. Cada unidade tem os próprios tablets (
          {props.units.map((u) => `${u.tablets} no ${u.name}`).join(', ')}); a reserva de uma não ocupa os da outra.
        </p>
      </section>
    </aside>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}
