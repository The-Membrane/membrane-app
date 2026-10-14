// The /position page's type scale and caps tracking (DESIGN_RULES §1): at most five steps —
// Mono 11 / 13, Redaction 22 and the hero (40 on a phone, 56 from 768px) — and one caps
// tracking value, .12em. Nothing on the page sets a size outside this table.

export const TYPE = {
  label: '11px',
  body: '13px',
  head: '22px',
  hero: { base: '40px', md: '56px' },
} as const

export const CAPS = { textTransform: 'uppercase' as const, letterSpacing: '0.12em' }
