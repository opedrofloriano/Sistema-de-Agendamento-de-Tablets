import { useEffect, useState } from 'react';

const THEME_KEY = 'tablets:theme';
export type ThemePreference = 'system' | 'light' | 'dark';
const ORDER: ThemePreference[] = ['system', 'light', 'dark'];

export const THEME_LABEL: Record<ThemePreference, string> = {
  system: 'Tema automático (segue o aparelho)',
  light: 'Tema claro',
  dark: 'Tema escuro',
};

function readTheme(): ThemePreference {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

/** Tema escolhido pelo usuário. O primeiro desenho é ajustado por theme-init.js, sem piscar. */
export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(readTheme);
  useEffect(() => {
    const root = document.documentElement;
    if (preference === 'system') delete root.dataset.theme;
    else root.dataset.theme = preference;
    try {
      if (preference === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, preference);
    } catch {
      /* armazenamento indisponível: o tema vale só nesta visita */
    }
  }, [preference]);
  const next = ORDER[(ORDER.indexOf(preference) + 1) % ORDER.length];
  return { preference, next, cycle: () => setPreference(next) };
}

/** Hora atual, atualizada a cada minuto. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    try {
      return window.matchMedia(query).matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** Valor que só muda depois de `ms` sem alterações. */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

/** Remove acentos e caixa, para a busca achar "ciencias" em "Ciências". */
export const normalizeSearch = (s: string): string =>
  s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
