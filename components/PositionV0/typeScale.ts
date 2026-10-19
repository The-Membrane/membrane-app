// The /position page's type scale and caps tracking (DESIGN_RULES §1): at most five steps —
// Mono 11 / 13, Redaction 22 and the big figure (40 on a phone since round 7, 76 from 768px; the size
// FORECAST_VISUALS.md sets for the forecast number, shared by the hero price so the page
// keeps one big step) — and one caps tracking value, .12em. Nothing on the page sets a
// size outside this table.

//
// Owner, Q27 round 7: on a phone the page read "way too chunky". Below 768px every step but
// the label comes down one notch (body 12, head 19, big figure 40); desktop is unchanged.
export const TYPE = {
  label: '11px',
  body: { base: '12px', md: '13px' },
  head: { base: '19px', md: '22px' },
  hero: { base: '40px', md: '76px' },
} as const

/** The same steps as numbers, for SVG text (which takes no responsive object): the desktop values. */
export const TYPE_PX = { label: 11, body: 13 } as const

/** Desktop body as a plain string, for a value already split by breakpoint. */
export const BODY_MD = `${TYPE_PX.body}px`

export const CAPS = { textTransform: 'uppercase' as const, letterSpacing: '0.12em' }
