'use client';

import { Moon, Sun } from 'lucide-react';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { revealTheme } from './theme-reveal';

type Theme = 'dark' | 'light';
type ThemeContextValue = {
  theme: Theme;
  setTheme: (theme: Theme, origin?: { x: number; y: number }) => void;
};
const ThemeContext = createContext<ThemeContextValue>({
  theme: 'dark',
  setTheme: () => undefined,
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('dark');

  useEffect(() => {
    const saved = window.localStorage.getItem('jian-theme');
    if (saved === 'light' || saved === 'dark') setThemeState(saved);
  }, []);

  const setTheme = (next: Theme, origin = { x: window.innerWidth / 2, y: 0 }) => {
    if (next === theme) return;
    window.localStorage.setItem('jian-theme', next);
    revealTheme(origin, () => {
      flushSync(() => setThemeState(next));
      document.documentElement.dataset.theme = next;
    });
  };

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function ThemeSwitcher() {
  const { theme, setTheme } = useContext(ThemeContext);

  return (
    <fieldset className="theme-switcher">
      <legend className="sr-only">Theme</legend>
      <button
        type="button"
        className={theme === 'dark' ? 'active' : ''}
        onClick={(event) => setTheme('dark', { x: event.clientX, y: event.clientY })}
        aria-pressed={theme === 'dark'}
      >
        <Moon size={15} /> Dark
      </button>
      <button
        type="button"
        className={theme === 'light' ? 'active' : ''}
        onClick={(event) => setTheme('light', { x: event.clientX, y: event.clientY })}
        aria-pressed={theme === 'light'}
      >
        <Sun size={15} /> Light
      </button>
    </fieldset>
  );
}
