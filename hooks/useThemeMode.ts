import { useCallback, useSyncExternalStore } from 'react'

/**
 * Theme mode state — Living Typeface dark (default) / Parchment light.
 *
 * Source of truth is the [data-membrane-theme] attribute on <html>, stamped
 * pre-paint by the inline script in pages/_document.tsx and persisted to
 * localStorage `membrane.theme`. All consumers (nav toggle, Logo variant,
 * canvas repaints) subscribe through the `membrane-theme-change` window event.
 *
 * The attribute is namespaced because Chakra's ColorModeProvider owns plain
 * [data-theme] and re-stamps it on hydration — a bare data-theme gets
 * clobbered back to Chakra's initialColorMode on every load.
 */

export type ThemeMode = 'dark' | 'light'

const STORAGE_KEY = 'membrane.theme'
const EVENT = 'membrane-theme-change'

const THEME_COLOR: Record<ThemeMode, string> = {
  dark: '#09090a',
  light: '#e7dfcc',
}

function readMode(): ThemeMode {
  if (typeof document === 'undefined') return 'dark'
  return document.documentElement.getAttribute('data-membrane-theme') === 'light' ? 'light' : 'dark'
}

export function setThemeMode(mode: ThemeMode) {
  document.documentElement.setAttribute('data-membrane-theme', mode)
  try {
    localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    // private mode / storage disabled: theme still applies for this page view
  }
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', THEME_COLOR[mode])
  window.dispatchEvent(new Event(EVENT))
}

function subscribe(onChange: () => void) {
  window.addEventListener(EVENT, onChange)
  return () => window.removeEventListener(EVENT, onChange)
}

export function useThemeMode(): { mode: ThemeMode; toggle: () => void; setMode: (m: ThemeMode) => void } {
  const mode = useSyncExternalStore(subscribe, readMode, () => 'dark' as ThemeMode)
  const toggle = useCallback(() => setThemeMode(readMode() === 'light' ? 'dark' : 'light'), [])
  return { mode, toggle, setMode: setThemeMode }
}
