import { formatTime, type UnitPeak } from '../../../shared/rules.ts';
import type { Unit } from '../../../shared/types.ts';
import { CalendarCheckIcon, GaugeIcon, TabletIcon } from '../icons.tsx';

interface SummaryCardsProps {
  weekCount: number;
  filtered: boolean;
  /** Pico de uso da semana, um por unidade (cada unidade tem o próprio acervo). */
  peaks: UnitPeak[];
  units: Unit[];
}

export function SummaryCards({ weekCount, filtered, peaks, units }: SummaryCardsProps) {
  const anyFull = peaks.some((p) => p.quantity >= p.tablets);
  const total = units.reduce((sum, u) => sum + u.tablets, 0);
  const sameSize = units.every((u) => u.tablets === units[0]?.tablets);

  return (
    <div className="summary-grid">
      <article className="summary-card">
        <div className="summary-icon blue" aria-hidden="true">
          <CalendarCheckIcon size={19} />
        </div>
        <span>Reservas nesta semana</span>
        <strong>{weekCount}</strong>
        <small>{filtered ? 'Com os filtros aplicados' : 'Canceladas não entram na conta'}</small>
      </article>

      <article className="summary-card">
        <div className={`summary-icon ${anyFull ? 'red' : 'amber'}`} aria-hidden="true">
          <GaugeIcon size={19} />
        </div>
        <span>Maior uso simultâneo</span>
        <ul className="peak-list">
          {peaks.map((p, i) => {
            const full = p.quantity >= p.tablets;
            const when = p.at ? `${p.at.toLocaleDateString('pt-BR', { weekday: 'long' })}, ${formatTime(p.at)}` : 'sem reservas';
            return (
              <li key={p.unit} className={full ? 'is-full' : ''}>
                <span className="peak-unit">
                  <span className={`unit-dot unit-${i % 4}`} aria-hidden="true" />
                  {p.unit}
                </span>
                <span className="peak-value">
                  <b>{p.quantity}</b> de {p.tablets}
                </span>
                <small>
                  {when}
                  {full ? ' · lotado' : ''}
                </small>
              </li>
            );
          })}
        </ul>
      </article>

      <article className="summary-card">
        <div className="summary-icon green" aria-hidden="true">
          <TabletIcon size={19} />
        </div>
        <span>Tablets no acervo</span>
        <strong>{total}</strong>
        <small>
          {sameSize && units.length > 1
            ? `${units[0].tablets} em cada unidade`
            : units.map((u) => `${u.name}: ${u.tablets}`).join(' · ')}
        </small>
      </article>
    </div>
  );
}
