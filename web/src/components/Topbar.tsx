import { THEME_LABEL, useTheme } from '../hooks.ts';
import {
  CalendarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  MenuIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  SearchIcon,
  SunIcon,
} from '../icons.tsx';

interface TopbarProps {
  weekLabel: string;
  shortWeekLabel: string;
  search: string;
  sidebarOpen: boolean;
  onSearchChange: (value: string) => void;
  onToggleSidebar: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
  onCreate: () => void;
  /** No Painel, a navegação de semanas e a busca não se aplicam. */
  mode?: 'agenda' | 'painel';
}

export function Topbar(props: TopbarProps) {
  const theme = useTheme();
  const ThemeIcon = theme.preference === 'dark' ? MoonIcon : theme.preference === 'light' ? SunIcon : MonitorIcon;

  return (
    <header className="topbar">
      <div className="brand">
        <button
          type="button"
          className="icon-button mobile-menu"
          aria-label={props.sidebarOpen ? 'Fechar filtros' : 'Abrir filtros'}
          aria-expanded={props.sidebarOpen}
          aria-controls="sidebar"
          onClick={props.onToggleSidebar}
        >
          <MenuIcon size={20} />
        </button>
        <div className="brand-mark" aria-hidden="true">
          <CalendarIcon size={22} />
        </div>
        <div className="brand-text">
          <strong>Tablets</strong>
          <span>Agendamento escolar</span>
        </div>
      </div>

      {props.mode === 'painel' ? (
        <div className="toolbar">
          <h1>Painel de uso</h1>
        </div>
      ) : (
      <nav className="toolbar" aria-label="Navegação da agenda">
        <button type="button" className="today-button" onClick={props.onToday}>
          Hoje
        </button>
        <button type="button" className="icon-button" aria-label="Semana anterior" onClick={props.onPrevious}>
          <ChevronLeftIcon size={21} />
        </button>
        <button type="button" className="icon-button" aria-label="Próxima semana" onClick={props.onNext}>
          <ChevronRightIcon size={21} />
        </button>
        <h1 aria-live="polite">
          <span className="week-long">{props.weekLabel}</span>
          <span className="week-short" aria-hidden="true">
            {props.shortWeekLabel}
          </span>
        </h1>
      </nav>
      )}

      {props.mode !== 'painel' && (
      <div className="search-box">
        <SearchIcon size={18} aria-hidden="true" />
        <input
          id="search"
          type="search"
          value={props.search}
          onChange={(e) => props.onSearchChange(e.target.value)}
          placeholder="Atividade, professor ou turma"
          title="Buscar por atividade, professor ou turma"
          aria-label="Buscar reservas por atividade, professor ou turma"
        />
        {props.search && (
          <button type="button" className="clear-search" aria-label="Limpar busca" onClick={() => props.onSearchChange('')}>
            <CloseIcon size={16} />
          </button>
        )}
      </div>
      )}

      <div className="topbar-actions">
        <button
          type="button"
          className="icon-button theme-button"
          onClick={theme.cycle}
          title={`${THEME_LABEL[theme.preference]}. Clique para: ${THEME_LABEL[theme.next].toLowerCase()}`}
          aria-label={`${THEME_LABEL[theme.preference]}. Mudar para ${THEME_LABEL[theme.next].toLowerCase()}`}
        >
          <ThemeIcon size={20} />
        </button>
        <button type="button" className="primary-button create-button" onClick={props.onCreate}>
          <PlusIcon size={19} aria-hidden="true" /> <span>Criar reserva</span>
        </button>
      </div>
    </header>
  );
}
