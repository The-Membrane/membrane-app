/**
 * Risk Frontier components against the app design system (CLAUDE.md: Typography,
 * Spacing, Animations) and the review's accessibility findings. Static source checks —
 * the components have no DOM test harness — so a regression shows up as a failing line.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = path.resolve(__dirname, '../../components/RiskFrontier')
const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.tsx'))
  .map((f) => ({ f, src: readFileSync(path.join(DIR, f), 'utf8') }))

const hits = (re: RegExp) =>
  files.flatMap(({ f, src }) =>
    src
      .split('\n')
      .map((line, i) => ({ line, at: `${f}:${i + 1}` }))
      .filter(({ line }) => re.test(line))
      .map(({ at, line }) => `${at}  ${line.trim()}`),
  )

describe('risk frontier: design-system motion and type (CLAUDE.md)', () => {
  it('no glow: no text-shadow, and box-shadow only as an inset indicator bar', () => {
    expect(hits(/textShadow/)).toEqual([])
    expect(hits(/boxShadow=\{?[^}]*`0 0 /)).toEqual([])
  })

  it('no scale motion and no ambient (infinite) animation outside the computing indicators', () => {
    expect(hits(/scale\(|scaleX\(/)).toEqual([])
    // The only infinite animations are the two "computing" indicators, shown while pending.
    expect(hits(/infinite/).map((h) => h.split('  ')[0].split(':')[0])).toEqual([
      'RiskFrontier.tsx',
      'RiskFrontier.tsx',
    ])
  })

  it('no inline transition strings: transitions come from config/transitions', () => {
    expect(hits(/transition="/)).toEqual([])
  })

  it('no raw font sizes (11px label floor comes from TYPOGRAPHY) and no raw spacing strings', () => {
    expect(hits(/fontSize=["{]?\s*["']\d+px/)).toEqual([])
    expect(
      hits(/\b(m[tblrxy]?|p[tblrxy]?|gap|rowGap|columnGap|spacing)=["{]\s*["']-?\d+px["']/),
    ).toEqual([])
  })

  it('numbers never render in the display serif: only the page title uses it', () => {
    const serif = hits(/TYPOGRAPHY\.fontDisplay/)
    expect(serif).toHaveLength(1)
    expect(serif[0]).toMatch(/^RiskFrontier\.tsx:/)
  })
})

describe('risk frontier: accessibility and labels (review findings)', () => {
  it('one polite live region (the headline lead), not the status chip or the detail panel', () => {
    expect(hits(/aria-live/).map((h) => h.split(':')[0])).toEqual(['RiskFrontier.tsx'])
  })

  it('no contract field names as visible labels', () => {
    expect(hits(/label="liqDebtMinimum"|>liqDebtMinimum</)).toEqual([])
  })
})
