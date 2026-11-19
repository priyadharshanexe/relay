/**
 * Ink (dark, the default) or paper (light). The choice is stored per browser and applied as
 * data-theme on <html>; public/theme.js applies it again before the next page
 * load draws, so there is no flash of the wrong theme.
 */
import { useState } from "react";

export type Theme = "light" | "dark";

const KEY = "relay.theme";

export function storedTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Not saved, but applied for this visit.
  }
}

/** The current theme, and a function that switches to the other one. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(storedTheme);
  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
  }
  return [theme, toggle];
}
