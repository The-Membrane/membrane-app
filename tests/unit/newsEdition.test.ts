// THE NEWS EDITION'S GATES (owner rulings T20 / Q11, landing lane 2026-10-11).
//
//   1. Copy: the masthead's lines come from copy sources, never typed into the page.
//   2. The index: one entry per numbered section, in order, with no new titles.
//   3. Figures: a Redaction headline sets every number in JetBrains Mono.
//   4. The palette: the night edition is the ruled lamplight table, green means money,
//      and the layer can only match while a .news-edition root is mounted.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  EDITION_LABEL,
  NEWS_SECTIONS,
  ONE_DAY_TITLE,
  sectionKicker,
  shortAddress,
  splitFigures,
} from '@/components/NewsEdition/tokens'
import { fmtLocalDateline } from '@/components/Simulator/localClock'
import { GUARANTEE, LANDING_PASTE_PROMPT, LANDING_TAGLINE } from '@/lib/position-sim/guarantee'
import {
  OCT10_PRICE_PATH,
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

  it('the dateline is the reader-zone long date', () => {
    expect(fmtLocalDateline(Date.UTC(2026, 9, 10, 12), 'UTC')).toBe('Saturday, October 10, 2026')
    // Late evening in Los Angeles is already the next day in UTC.
    expect(fmtLocalDateline(Date.UTC(2026, 9, 11, 3), 'America/Los_Angeles')).toBe(
      'Saturday, October 10, 2026',
    )
  })

  it('names both editions', () => {
    expect(EDITION_LABEL).toEqual({ light: 'Day edition', dark: 'Night edition' })
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
