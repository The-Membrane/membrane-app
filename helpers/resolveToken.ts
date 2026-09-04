/**
 * Resolve a SEMANTIC_COLORS token to a concrete color string.
 *
 * The tokens are `var(--m-*)` references (see styles/themes.css). CSS resolves
 * them automatically, but the Canvas 2D API and any code that PARSES a color
 * (hex math, alpha compositing) do not — Canvas silently ignores an
 * unresolvable fillStyle and keeps the previous one. Call this first.
 *
 * Resolution reads the computed value off <html>, so it follows the active
 * [data-theme]. Values are cached per theme and invalidated on theme change
 * (the `membrane-theme-change` event from hooks/useThemeMode.ts).
 */

const cache = new Map<string, string>()

if (typeof window !== 'undefined') {
  window.addEventListener('membrane-theme-change', () => cache.clear())
}

/**
 * `resolveColor('var(--m-danger)')` → `'#cf4034'` (or the light twin).
 * Non-var inputs (already-concrete colors) pass through untouched, so it is
 * safe to call unconditionally on any SEMANTIC_COLORS value.
 */
export function resolveColor(color: string): string {
  if (!color.startsWith('var(')) return color
  const cached = cache.get(color)
  if (cached) return cached
  if (typeof window === 'undefined') return '#000000' // SSR: never painted
  const name = color.slice(4, -1).trim()
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  if (!value) return '#000000'
  cache.set(color, value)
  return value
}
