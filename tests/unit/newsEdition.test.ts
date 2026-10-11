// THE NEWS EDITION'S GATES (owner rulings T20 / Q11, landing lane 2026-10-11).
//
//   1. Copy: the masthead's lines come from copy sources, never typed into the page.
//   2. The index: one entry per numbered section, in order, with no new titles.
//   3. Figures: big numbers are Redaction (owner ruling 2026-10-11, "make the big
//      numbers redaction, I like how the 4% looks"), every other figure JetBrains Mono.
//   4. The palette: the night edition is the ruled lamplight table, green means money,
//      and the layer can only match while a .news-edition root is mounted.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  EDITION_LABEL,
  NEWS_FIGURE,
  NEWS_FONT,
  NEWS_SECTIONS,
  ONE_DAY_TITLE,
  sectionKicker,
  shortAddress,
  splitFigures,
  WORDMARK_FIT,
} from '@/components/NewsEdition/tokens'
import { fmtLocalDateline, fmtLocalIsoDate } from '@/components/Simulator/localClock'
import {
  CARRY_CLAIMS,
  CARRY_SPREAD_LINE,
  GUARANTEE,
  LANDING_PASTE_PROMPT,
  LANDING_TAGLINE,
} from '@/lib/position-sim/guarantee'
import {
  OCT10_PRICE_PATH,
  OCT10_SCALE_LINE,
  OCT10_STAKES,
  OCT10_STAKES_LINE,
  OCT10_TOTALS,
} from '@/lib/position-sim/oct10Totals'

const css = readFileSync(join(process.cwd(), 'styles/news-edition.css'), 'utf8')

/** Every capture-group-1 match of `re` in `text`. */
function captures(text: string, re: RegExp): string[] {
  const out: string[] = []
  for (const m of text.matchAll(re)) out.push(m[1])
  return out
}

/** The declarations inside the first rule whose selector is exactly `selector`. */
function block(selector: string): string {
  const at = css.indexOf(`${selector} {`)
  if (at < 0) throw new Error(`no rule for ${selector}`)
  const open = css.indexOf('{', at)
  return css.slice(open + 1, css.indexOf('}', open))
}

function props(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of body.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim()
  }
  return out
}

const NIGHT = props(block(":root:not([data-membrane-theme='light']):has(.news-edition)"))
const DAY = props(block(":root[data-membrane-theme='light']:has(.news-edition)"))

describe('masthead copy', () => {
  it('the tagline is the owner line, built on the guarantee name', () => {
    expect(LANDING_TAGLINE).toBe('4%. Cross the line with time to spare.')
    expect(LANDING_TAGLINE.startsWith(GUARANTEE.name)).toBe(true)
  })

  it('the paste prompt is the meta description opener', () => {
    expect(LANDING_PASTE_PROMPT).toBe('Paste any Aave, Spark, Morpho or Compound position')
  })

  it('the rail alert card is the stakes line, split, not retyped', () => {
    expect(OCT10_STAKES_LINE).toBe(
      `${OCT10_STAKES.headline} · ${OCT10_STAKES.date} · ${OCT10_STAKES.accounts}`,
    )
    expect(OCT10_STAKES.headline).toBe(
      `$${Math.round(OCT10_TOTALS.aaveClosedUsd / 1e6)}M of loans liquidated on Aave`,
    )
  })

  it("the price-path box and FinePrint's standing line share one source", () => {
    expect(`The price path is measured: ${OCT10_PRICE_PATH.source}, ${OCT10_PRICE_PATH.window}.`).toBe(
      'The price path is measured: 1-minute Chainlink rounds, 10-11 Oct 2025.',
    )
  })

  it('the scale subline opens with its money figure, so the figure can be set green', () => {
    expect(OCT10_SCALE_LINE.result.startsWith(OCT10_SCALE_LINE.figure)).toBe(true)
  })

  it("the verdict's carry line names the same covered days as the first carry claim", () => {
    const days = (t: string) => /curators cover (\d+) days of yield/.exec(t)?.[1]
    expect(days(CARRY_SPREAD_LINE)).toBeDefined()
    expect(days(CARRY_SPREAD_LINE)).toBe(days(CARRY_CLAIMS[0]))
  })

  it('the dateline is the reader-zone long date', () => {
    expect(fmtLocalDateline(Date.UTC(2026, 9, 10, 12), 'UTC')).toBe('Saturday, October 10, 2026')
    // Late evening in Los Angeles is already the next day in UTC.
    expect(fmtLocalDateline(Date.UTC(2026, 9, 11, 3), 'America/Los_Angeles')).toBe(
      'Saturday, October 10, 2026',
    )
  })

  it("the rail's capacity date is the reader-zone day, not the UTC day", () => {
    const lateEveningLA = Date.UTC(2026, 9, 11, 3) // 8 PM PDT on 10 Oct
    expect(fmtLocalIsoDate(lateEveningLA, 'UTC')).toBe('2026-10-11')
    expect(fmtLocalIsoDate(lateEveningLA, 'America/Los_Angeles')).toBe('2026-10-10')
  })

  it('names both editions', () => {
    expect(EDITION_LABEL).toEqual({ light: 'Day edition', dark: 'Night edition' })
  })
})

describe('the wordmark', () => {
  // The masthead's centre column is 496px at a 1280px viewport and 380px at its tightest
  // (a 1016px viewport); the measured advance is in WORDMARK_FIT's doc comment.
  const cqi = Number(/([\d.]+)cqi/.exec(WORDMARK_FIT.size)?.[1]) / 100
  const fallbackCap = Number(/(\d+)px\)$/.exec(WORDMARK_FIT.fallback)?.[1])

  it('sizes "Membrane" by its column so it never wraps', () => {
    expect(cqi * WORDMARK_FIT.advanceEm).toBeLessThan(1)
    expect(cqi * WORDMARK_FIT.advanceEm).toBeGreaterThan(0.9)
  })

  it('caps the no-container-query fallback inside the widest one-line column', () => {
    expect(fallbackCap * WORDMARK_FIT.advanceEm).toBeLessThanOrEqual(496)
  })
})

describe('the index', () => {
  it('numbers its six sections 01–06 with unique anchors', () => {
    expect(NEWS_SECTIONS.map((s) => s.number)).toEqual(['01', '02', '03', '04', '05', '06'])
    expect(new Set(NEWS_SECTIONS.map((s) => s.id)).size).toBe(NEWS_SECTIONS.length)
    expect(NEWS_SECTIONS.map((s) => s.id)).toEqual([
      'verdict',
      'oneday',
      'guarantee',
      'history',
      'product',
      'fine',
    ])
  })

  it('reuses the existing section titles', () => {
    expect(NEWS_SECTIONS.find((s) => s.id === 'oneday')?.title).toBe(ONE_DAY_TITLE)
    expect(ONE_DAY_TITLE).toBe('One day. Same accounts.')
    expect(sectionKicker('guarantee')).toBe('03 · The guarantee')
  })

  it('shortens an address the way the verdict kicker prints it', () => {
    expect(shortAddress('0x7AdA0000000000000000000000000000000d142')).toBe('0x7AdA…d142')
  })
})

describe('figure faces (owner ruling 2026-10-11)', () => {
  const src = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')

  it('display figures are Redaction 700, lining and tabular', () => {
    expect(NEWS_FIGURE.display.fontFamily).toBe(NEWS_FONT.display)
    expect(NEWS_FIGURE.display.fontFamily.startsWith("'Redaction News'")).toBe(true)
    expect(NEWS_FIGURE.display.fontWeight).toBe(700)
    expect(NEWS_FIGURE.display.sx.fontVariantNumeric).toBe('lining-nums tabular-nums')
  })

  it('every other figure stays JetBrains Mono, tabular', () => {
    expect(NEWS_FIGURE.text.fontFamily).toBe(NEWS_FONT.mono)
    expect(NEWS_FIGURE.text.sx.fontVariantNumeric).toBe('tabular-nums')
  })

  it('a headline keeps its figures in Redaction: Figures never switches to Mono', () => {
    const index = src('components/NewsEdition/index.tsx')
    const at = index.indexOf('export const Figures')
    const figures = index.slice(at, index.indexOf('\nexport ', at + 1))
    expect(at).toBeGreaterThan(-1)
    expect(figures).toContain('NEWS_FIGURE.display')
    expect(figures).not.toContain('NEWS_FONT.mono')
  })

  it('every display-figure site on the landing uses the display face', () => {
    for (const f of [
      'components/Simulator/VerdictHero.tsx', // big figure
      'components/Simulator/HeroChart.tsx', // the one-day protected figure
      'components/Simulator/GuaranteeBlock.tsx', // the scale line's figure
      'components/Simulator/HistoryProof.tsx', // the history total and its tiles
      'components/Simulator/CarrySection.tsx', // tracked-strategies tile
      'components/Simulator/ComparisonPanel.tsx', // end equity per engine
      'components/Simulator/DeploymentSection.tsx', // detected capital, rates in force
      'components/Strats/StratsBoard.tsx', // tracked books and header stats
    ]) {
      expect(src(f), f).toContain('NEWS_FIGURE.display')
    }
  })
})

describe('splitFigures', () => {
  const figures = (t: string) =>
    splitFigures(t)
      .filter((r) => r.figure)
      .map((r) => r.text)

  it('round-trips every input exactly', () => {
    for (const t of [
      'Aave V3 closed $12,345 of this loan at 9:14 PM EDT',
      'Membrane would have closed $3,210 42 minutes later.',
      'Membrane would have closed $0 and sold nothing.',
      'Aave V3 charges this carry −$1,234/yr a year.',
      '',
    ]) {
      expect(
        splitFigures(t)
          .map((r) => r.text)
          .join(''),
      ).toBe(t)
    }
  })

  it('finds money, clocks and counts — and leaves "V3" alone', () => {
    expect(figures('Aave V3 closed $12,345 of this loan at 9:14 PM EDT')).toEqual([
      '$12,345',
      '9:14 PM EDT',
    ])
    expect(figures('Membrane would have closed $3,210 42 minutes later.')).toEqual(['$3,210', '42'])
    expect(figures('fixed −$1,234/yr and $1.2B kept')).toEqual(['−$1,234/yr', '$1.2B'])
    expect(figures('at 4:19 PM GMT+2.')).toEqual(['4:19 PM GMT+2'])
  })
})

describe('the palette', () => {
  it('night is the lamplight ruling, hex for hex', () => {
    expect(NIGHT).toMatchObject({
      '--news-paper': '#1a1817',
      '--news-card': '#262321',
      '--news-raised': '#2c2926',
      '--news-ink': '#f2e8dc',
      '--news-ink-2': '#dcd0c2',
      '--news-muted': '#a89d92',
      '--news-rule': '#3d3835',
      '--news-accent': '#e3c27a',
      '--news-up': '#9cc97a',
      '--news-cta': '#9cc97a',
      '--news-on-cta': '#1a120c',
      '--news-danger': '#ef7a6b',
      '--news-risk': '#e5764f',
      '--news-warning': '#f39c3e',
      '--news-info': '#46d39a',
    })
  })

  it('never sets pure white text at night', () => {
    expect(NIGHT['--news-ink'].toLowerCase()).not.toMatch(/^#fff(fff)?$/)
  })

  it('green means money: profit is never the section-head colour', () => {
    expect(NIGHT['--news-up']).not.toBe(NIGHT['--news-accent'])
    expect(NIGHT['--m-success']).toBe('var(--news-up)')
    expect(NIGHT['--m-primary']).toBe('var(--news-accent)')
    expect(DAY['--news-up']).toBe('var(--m-success)')
  })

  it('day is Parchment by reference and bridges nothing', () => {
    expect(DAY['--news-paper']).toBe('var(--m-bg-primary)')
    expect(DAY['--news-ink']).toBe('var(--m-text-primary)')
    expect(Object.keys(DAY).filter((k) => k.startsWith('--m-'))).toEqual([])
  })

  it('bridges every app colour token at night', () => {
    const themes = readFileSync(join(process.cwd(), 'styles/themes.css'), 'utf8')
    const appTokens = new Set(captures(themes, /(--m-[\w-]+)\s*:/g))
    for (const t of appTokens) expect(NIGHT[t], t).toBeDefined()
  })

  it('only ever matches while a .news-edition root is mounted', () => {
    const selectors = captures(
      css.replace(/\/\*[\s\S]*?\*\//g, ''),
      /([^{}]+)\{[^}]*--m-[\w-]+\s*:/g,
    ).map((x) => x.trim())
    expect(selectors.length).toBeGreaterThan(0)
    for (const s of selectors) expect(s).toContain('.news-edition')
  })
})
