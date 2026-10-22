// THE NEWS EDITION — tokens, section registry and the figure splitter.
//
// Owner rulings (membrane-board): T20 (newspaper style, built in the app's own fonts and
// colours; night edition = "lamplight"), Q11 (every surface that signs nothing is news),
// T31 (signing surfaces are a ledger slip — not this page). The CSS that defines the
// --news-* properties is styles/news-edition.css; this file only names them for TSX.
//
// Pure TypeScript, no React: the unit tests import it in a node environment.

import { TYPOGRAPHY } from '@/helpers/typography'

/**
 * The newspaper roles. Each resolves inside a mounted `.news-edition` root (day =
 * Parchment, night = lamplight). Outside one they are undefined, so only news-edition
 * code may use them.
 */
export const NEWS = {
  paper: 'var(--news-paper)',
  card: 'var(--news-card)',
  raised: 'var(--news-raised)',
  ink: 'var(--news-ink)',
  ink2: 'var(--news-ink-2)',
  muted: 'var(--news-muted)',
  rule: 'var(--news-rule)',
  ruleStrong: 'var(--news-rule-strong)',
  /** Section heads, kickers, links. Day moss, night champagne gold. */
  accent: 'var(--news-accent)',
  /** Money: profit, gains, "you keep", protected-debt bars. Never the accent. */
  up: 'var(--news-up)',
  cta: 'var(--news-cta)',
  onCta: 'var(--news-on-cta)',
  danger: 'var(--news-danger)',
  risk: 'var(--news-risk)',
  warning: 'var(--news-warning)',
  info: 'var(--news-info)',
} as const

/**
 * Chart series. The fallback keeps a shared chart (CrossingChart also renders on the
 * carry page) on its app colour wherever the edition is not mounted.
 */
export const NEWS_CHART = {
  primary: (fallback: string) => `var(--news-chart, ${fallback})`,
  secondary: (fallback: string) => `var(--news-chart-2, ${fallback})`,
} as const

/**
 * TYPE. Redaction sets headlines, the wordmark and the big numbers, in its true bold
 * ('Redaction News' is the same files with the 700 face declared;
 * styles/news-edition.css). JetBrains Mono sets body text and every other figure.
 */
export const NEWS_FONT = {
  display: "'Redaction News', 'Redaction', Georgia, 'Times New Roman', serif",
  mono: TYPOGRAPHY.fontMono,
} as const

/**
 * FIGURES: which face sets a number. Owner ruling 2026-10-11 ("make the big numbers
 * redaction, I like how the 4% looks") replaces T20's "every figure is JetBrains Mono".
 *
 *   display  Redaction 700. A figure at display size: the figures inside the verdict
 *            headline (h1), the big-figure blocks (VerdictHero's big figure, the one-day
 *            protected figure, the history total and headline figure), the scale line
 *            and its figure, and the main value of a KPI or stat tile. The "4%." mark
 *            is already Redaction and stays as it is.
 *   text     JetBrains Mono. Everything else: figures in body text, tables, captions,
 *            chips and stamps, chart axes and labels, rail-card meta lines, the
 *            dateline, and the comparison bars' end labels.
 *
 * Both ask for tabular numerals; display adds lining. Redaction 700 ships no tnum or
 * lnum feature (its GSUB has frac, locl, numr, sups only), so in Redaction the request
 * is inert and the digits stay proportional. It still takes effect on the Georgia
 * fallback during the font swap, whose default digits are old-style.
 *
 * Spread one into a Chakra Text. A money figure keeps its money colour (NEWS.up, or
 * SEMANTIC_COLORS.success, which the night bridge maps to the same token).
 */
export const NEWS_FIGURE = {
  display: {
    fontFamily: NEWS_FONT.display,
    fontWeight: 700,
    sx: { fontVariantNumeric: 'lining-nums tabular-nums' },
  },
  text: {
    fontFamily: NEWS_FONT.mono,
    sx: { fontVariantNumeric: 'tabular-nums' },
  },
} as const

/**
 * THE WORDMARK FIT. "Membrane" in Redaction 700 (public/fonts/redaction/redaction-700.woff2,
 * unitsPerEm 1000) advances 5.216em by its hmtx widths, 5.196em after the font's GPOS kern
 * pairs and 5.116em with the wordmark's −0.01em tracking. At the old 112px that is 573px
 * of ink in a 496px column (1280px viewport), so it broke as "Membra / ne".
 *
 * The masthead column is a size container (NewsMasthead), so the size follows the column:
 * 18.5cqi sets the raw advance at 96.5% of the column (5.216 × 0.185), whatever the
 * viewport. Over 375–1440px the column runs 343–673px. The 112px cap binds only above a
 * 605px column (a 637–705px viewport, where the wordmark has a line to itself) and the
 * 40px floor never does (40 × 5.216 = 209px). `fallback` is for a
 * browser without container queries: 6.8vw keeps the raw advance within 99.2% of the
 * column at its tightest point (a 1063px viewport with a 15px scrollbar and 32px of
 * outer padding, a 380px column), capped at 92px, which fits the widest 496px column.
 */
export const WORDMARK_FIT = {
  advanceEm: 5.216,
  size: 'clamp(40px, 18.5cqi, 112px)',
  fallback: 'clamp(40px, 6.8vw, 92px)',
} as const

/** The masthead's edition line, by the app's theme mode (owner ruling T20). */
export const EDITION_LABEL = { light: 'Day edition', dark: 'Night edition' } as const

/** HeroChart's own title. The news edition prints it as the index entry instead. */
export const ONE_DAY_TITLE = 'One day. Same accounts.'

export type NewsSectionId = 'verdict' | 'oneday' | 'guarantee' | 'history' | 'product' | 'fine'

/**
 * THE INDEX ("In this edition") and the numbered kickers. No new copy: every title is
 * an existing section title on this page —
 *   The verdict        VerdictHero ("THE VERDICT, AS THE HERO"; the history table's verdict column)
 *   One day. Same…     HeroChart's own title (ONE_DAY_TITLE)
 *   The guarantee      GUARANTEE, lib/position-sim/guarantee.ts ("THE NAMED GUARANTEE")
 *   Your own history   HistoryProof ("what the delay would have done to your own history")
 *   The product        CarrySection ("the product")
 *   Fine print         FinePrint (Simulator.tsx "7 — FINE PRINT")
 * The run keeps its existing unnumbered title, as on the canvas.
 */
export const NEWS_SECTIONS: ReadonlyArray<{ id: NewsSectionId; number: string; title: string }> = [
  { id: 'verdict', number: '01', title: 'The verdict' },
  { id: 'oneday', number: '02', title: ONE_DAY_TITLE },
  { id: 'guarantee', number: '03', title: 'The guarantee' },
  { id: 'history', number: '04', title: 'Your own history' },
  { id: 'product', number: '05', title: 'The product' },
  { id: 'fine', number: '06', title: 'Fine print' },
]

/** "03 · The guarantee". Unknown ids throw: a kicker with no index entry is a bug. */
export function sectionKicker(id: NewsSectionId): string {
  const s = NEWS_SECTIONS.find((x) => x.id === id)
  if (!s) throw new Error(`no news section ${id}`)
  return `${s.number} · ${s.title}`
}

/** "0x7AdA…d142" */
export const shortAddress = (a: string): string =>
  a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a

// ---------------------------------------------------------------------------------
// FIGURES IN HEADLINES
// ---------------------------------------------------------------------------------

const SP = '[\\s\\u00a0\\u202f]'
/** A word that merely contains a digit ("V3", "sUSDe2") is text, not a figure. */
const WORD_WITH_DIGIT = '[A-Za-z][A-Za-z0-9]*\\d[A-Za-z0-9]*'
/** 1,234 or 1.2 — a thousands comma only between digit groups, so "$3,210, then" stops
 *  before the sentence's own comma. */
const DIGITS = '\\d+(?:,\\d{3})*(?:\\.\\d+)?'
const MONEY = `[−+\\-]?\\$${DIGITS}[KMB]?(?:/yr)?`
const CLOCK = `\\d{1,2}:\\d{2}${SP}?[AP]M(?:${SP}(?:GMT[+\\-−]\\d{1,2}(?::\\d{2})?|[A-Z]{2,5}))?`
const NUMBER = `[−+]?${DIGITS}%?`
const FIGURE_RE = new RegExp(`(${WORD_WITH_DIGIT})|(${MONEY}|${CLOCK}|${NUMBER})`, 'g')

export interface Run {
  text: string
  figure: boolean
}

/**
 * Splits a sentence into text and figure runs, so a headline can mark its figures:
 * bold, never broken across a line, and on a chip when asked (Figures, index.tsx). The
 * figure runs stay in the headline's own face, Redaction (NEWS_FIGURE.display; owner
 * ruling 2026-10-11). Joining the runs' text always gives back the input exactly.
 */
export function splitFigures(text: string): Run[] {
  const runs: Run[] = []
  let last = 0
  const push = (t: string, figure: boolean) => {
    if (!t) return
    const prev = runs[runs.length - 1]
    if (prev && prev.figure === figure && !figure) prev.text += t
    else runs.push({ text: t, figure })
  }
  for (const m of text.matchAll(FIGURE_RE)) {
    const at = m.index ?? 0
    push(text.slice(last, at), false)
    push(m[0], m[2] !== undefined)
    last = at + m[0].length
  }
  push(text.slice(last), false)
  return runs
}
