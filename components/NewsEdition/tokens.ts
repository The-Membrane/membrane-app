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
 * TYPE. Redaction sets headlines and the wordmark only, in its true bold ('Redaction
 * News' is the same files with the 700 face declared; styles/news-edition.css).
 * JetBrains Mono sets body text and EVERY figure.
 */
export const NEWS_FONT = {
  display: "'Redaction News', 'Redaction', Georgia, 'Times New Roman', serif",
  mono: TYPOGRAPHY.fontMono,
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
 * Splits a sentence into text and figure runs, so a Redaction headline can set its
 * numbers in JetBrains Mono (owner ruling T20: figures are never Redaction). Joining
 * the runs' text always gives back the input exactly.
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
