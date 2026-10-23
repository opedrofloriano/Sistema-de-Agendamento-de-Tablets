// Gráficos simples do Painel, feitos em HTML/CSS (sem biblioteca).
// Regras: uma cor por série, números em cor de texto, dica ao passar o mouse ou focar com o teclado,
// e sempre uma tabela equivalente para quem prefere ler os números.

import { useId, useState, type ReactNode } from 'react';

const fmt = (n: number, digits = 0) => n.toLocaleString('pt-BR', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
export const fmtNumber = fmt;
export const fmtPct = (n: number) => `${fmt(n, 1)}%`;
export const fmtHours = (n: number) => `${fmt(n, 1)} tablets·h`;

/** Escala "redonda" para o eixo: 0, passo, 2×passo… até cobrir o máximo. */
function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

export interface ColumnDatum {
  key: string;
  /** Rótulo curto embaixo da coluna. */
  short: string;
  /** Rótulo completo na dica e na tabela. */
  label: string;
  value: number;
  /** Linhas extras na dica, ex.: "12,5 tablets·h". */
  extra?: string;
}

/** Colunas verticais de uma série só. */
export function ColumnChart({ data, unit, emptyText }: { data: ColumnDatum[]; unit: string; emptyText: string }) {
  const [active, setActive] = useState<string | null>(null);
  const max = Math.max(0, ...data.map((d) => d.value));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const peak = data.find((d) => d.value === max && max > 0)?.key;
  const current = data.find((d) => d.key === active);
  const idx = current ? data.indexOf(current) : -1;

  if (max === 0) return <p className="chart-empty">{emptyText}</p>;

  return (
    <div className="col-chart" onMouseLeave={() => setActive(null)}>
      <div className="col-plot" style={{ ['--cols' as string]: data.length }}>
        {ticks.map((t) => (
          <div key={t} className="col-grid" style={{ bottom: `${(t / top) * 100}%` }}>
            <span>{fmt(t)}</span>
          </div>
        ))}
        <div className="col-bars">
          {data.map((d) => (
            <div
              key={d.key}
              className={`col-slot ${active === d.key ? 'is-active' : ''}`}
              tabIndex={0}
              role="img"
              aria-label={`${d.label}: ${fmt(d.value)} ${unit}${d.extra ? `, ${d.extra}` : ''}`}
              onMouseEnter={() => setActive(d.key)}
              onFocus={() => setActive(d.key)}
              onBlur={() => setActive(null)}
            >
              <div className="col-bar" style={{ height: `${(d.value / top) * 100}%` }}>
                {d.key === peak && <span className="col-peak">{fmt(d.value)}</span>}
              </div>
            </div>
          ))}
        </div>
        {current && (
          <div
            className={`chart-tip ${idx > data.length * 0.6 ? 'to-left' : ''}`}
            style={{ left: `${((idx + 0.5) / data.length) * 100}%`, bottom: `${Math.min(92, (current.value / top) * 100)}%` }}
            aria-hidden="true"
          >
            <strong>{current.label}</strong>
            <span>
              {fmt(current.value)} {unit}
            </span>
            {current.extra && <span>{current.extra}</span>}
          </div>
        )}
      </div>
      <div className="col-labels" style={{ ['--cols' as string]: data.length }} aria-hidden="true">
        {data.map((d) => (
          <span key={d.key} title={d.label}>
            {d.short}
          </span>
        ))}
      </div>
    </div>
  );
}

export interface ShareDatum {
  name: string;
  pct: number;
  detail: string;
  /** Linha que agrupa o restante ("Outros"): cor neutra. */
  rest?: boolean;
}

/** Ranking em barras horizontais com a porcentagem na ponta. */
export function ShareBars({ data, emptyText, label }: { data: ShareDatum[]; emptyText: string; label: string }) {
  if (!data.length) return <p className="chart-empty">{emptyText}</p>;
  const max = Math.max(...data.map((d) => d.pct), 1);
  return (
    <ol className="share-list" aria-label={label}>
      {data.map((d, i) => (
        <li key={d.name} className={d.rest ? 'is-rest' : ''} title={`${d.name}: ${fmtPct(d.pct)} · ${d.detail}`}>
          <span className="share-rank" aria-hidden="true">
            {d.rest ? '' : i + 1}
          </span>
          <span className="share-name">{d.name}</span>
          <span className="share-pct">{fmtPct(d.pct)}</span>
          <span className="share-track" aria-hidden="true">
            <span style={{ width: `${Math.max(1.5, (d.pct / max) * 100)}%` }} />
          </span>
          <span className="share-detail">{d.detail}</span>
        </li>
      ))}
    </ol>
  );
}

/** Barra de 0 a 100% (ocupação de uma unidade). */
export function Meter({ pct, tone, label }: { pct: number; tone: number; label: string }) {
  return (
    <span
      className={`meter tone-${tone % 2}`}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={label}
    >
      <span style={{ width: `${Math.min(100, Math.max(pct > 0 ? 1 : 0, pct))}%` }} />
    </span>
  );
}

/** Cartão do painel com título, ação opcional e alternância gráfico/tabela. */
export function PanelCard(props: {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  className?: string;
  table?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  const id = useId();
  return (
    <section className={`panel-card ${props.className ?? ''}`} aria-labelledby={id}>
      <header className="panel-card-head">
        <div>
          <h3 id={id}>
            {props.icon}
            {props.title}
          </h3>
          {props.subtitle && <p>{props.subtitle}</p>}
        </div>
        <div className="panel-card-actions">
          {props.action}
          {props.table && (
            <button type="button" className="chip-button" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
              {asTable ? 'Ver gráfico' : 'Ver tabela'}
            </button>
          )}
        </div>
      </header>
      {asTable ? <div className="panel-table-wrap">{props.table}</div> : props.children}
    </section>
  );
}
