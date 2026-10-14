// The /position page's type scale and caps tracking (DESIGN_RULES §1): at most five steps —
// Mono 11 / 13, Redaction 22 and the big figure (52 on a phone, 76 from 768px; the size
// FORECAST_VISUALS.md sets for the forecast number, shared by the hero price so the page
// keeps one big step) — and one caps tracking value, .12em. Nothing on the page sets a
// size outside this table.

export const TYPE = {
  label: '11px',
  body: '13px',
  head: '22px',
  hero: { base: '52px', md: '76px' },
} as const

/** The same steps as numbers, for SVG text (which takes no responsive object). */
export const TYPE_PX = { label: 11, body: 13 } as const

export const CAPS = { textTransform: 'uppercase' as const, letterSpacing: '0.12em' }
