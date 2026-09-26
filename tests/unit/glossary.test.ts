import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { BLIND_SPOT_CLAUSES, GLOSSARY_GROUPS, GLOSSARY_TERMS, buildDefinedTermSet } from '@/components/Glossary/terms'
import { COVERAGE_CAUTION, COVERAGE_CLEAR } from '@/components/Radar/radarLogic'
import { BORROW_LTV_GAP, CURE_WINDOW_HOURS, MAX_THRESHOLD_TO_DELAY } from '@/lib/position-sim/membrane'
import { ALARM_THRESHOLDS, HEADROOM_BLIND_SIGNAL, UNCOVERED_SIGNALS } from '@/scripts/lib/alarmRules.mjs'

const alarmRulesSrc = fs.readFileSync(path.resolve(__dirname, '../../scripts/lib/alarmRules.mjs'), 'utf8')
// Every rule in alarmRules.mjs is introduced by a `// --- rule: <kind> (` header.
const ALARM_KINDS = Array.from(alarmRulesSrc.matchAll(/\/\/ --- rule: ([a-z_]+) \(/g)).map((m) => m[1])
const termsSrc = fs.readFileSync(path.resolve(__dirname, '../../components/Glossary/terms.ts'), 'utf8')
const def = (id: string) => GLOSSARY_TERMS.find((t) => t.id === id)!.definition

describe('glossary terms', () => {
  it('every anchor id is unique and URL-safe', () => {
    const ids = GLOSSARY_TERMS.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  })

  it('every alarm kind in alarmRules.mjs has an entry', () => {
    expect(ALARM_KINDS.length).toBeGreaterThanOrEqual(7)
    const covered = new Set(GLOSSARY_TERMS.map((t) => t.alarmKind).filter(Boolean))
    for (const kind of ALARM_KINDS) expect(covered, kind).toContain(kind)
  })

  it('names no alarm kind that alarmRules.mjs does not define', () => {
    for (const t of GLOSSARY_TERMS) if (t.alarmKind) expect(ALARM_KINDS).toContain(t.alarmKind)
  })

  it('carries the required legs, verdicts and tiers', () => {
    const ids = new Set(GLOSSARY_TERMS.map((t) => t.id))
    for (const id of [
      'instant-leg', 'cooldown-leg', 'flow-leg', 'clear', 'caution', 'exposed',
      'instant-tier', 'cooldown-tier', 'stranded', 'instant-swap-out-depth', 'blind-spot',
    ]) expect(ids, id).toContain(id)
  })

  it('every term belongs to a rendered group', () => {
    const groups = new Set(GLOSSARY_GROUPS.map((g) => g.id))
    for (const t of GLOSSARY_TERMS) expect(groups).toContain(t.group)
  })

  it('never uses "cooling" in user-facing text', () => {
    for (const t of GLOSSARY_TERMS) expect(`${t.term} ${t.definition}`.toLowerCase()).not.toContain('cooling')
  })

  it('verdict thresholds come from radarLogic', () => {
    expect(def('clear')).toContain(`${COVERAGE_CLEAR}x`)
    expect(def('caution')).toContain(`${COVERAGE_CAUTION}x`)
    expect(def('exposed')).toContain(`${COVERAGE_CAUTION}x`)
    expect(def('exposed')).toContain('1 day') // COOLDOWN_EXPOSED_SECONDS = 86_400
  })

  it('carries the liquidation terms, numbers from lib/position-sim/membrane.ts', () => {
    expect(def('liquidation-line')).toContain(`${CURE_WINDOW_HOURS}-hour window`)
    expect(def('window')).toContain(`${CURE_WINDOW_HOURS} hours`)
    const pct = (f: number) => `${Number((f * 100).toFixed(2))}`
    expect(def('window')).toContain(`${pct(BORROW_LTV_GAP)} percentage points`)
    expect(def('break-line')).toContain(`${pct(MAX_THRESHOLD_TO_DELAY)}%`)
    expect(GLOSSARY_TERMS.find((t) => t.id === 'window')!.term).toBe(`${CURE_WINDOW_HOURS}-hour window`)
  })

  it('builds a DefinedTermSet with one DefinedTerm per entry, anchored', () => {
    const set = buildDefinedTermSet('https://example.test', 'ethereum')
    expect(set['@type']).toBe('DefinedTermSet')
    expect(set.hasDefinedTerm).toHaveLength(GLOSSARY_TERMS.length)
    expect(set.hasDefinedTerm[0].url).toBe(`https://example.test/ethereum/glossary#${GLOSSARY_TERMS[0].id}`)
  })
})

// "Numbers come from the code; change the code and the glossary follows."
describe('glossary cannot drift from the code', () => {
  it('terms.ts code carries no numeric literal (every number is an imported constant)', () => {
    const code = termsSrc
      .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
      .replace(/\/\/.*$/gm, '') // line comments
    // The one allowed digit is display precision (Intl maximumFractionDigits), not a threshold.
    const digits = code
      .split('\n')
      .map((l) => l.replace(/maximumFractionDigits: \d+/, ''))
      .filter((l) => /\d/.test(l))
    expect(digits).toEqual([])
  })

  it('every alarm kind has a threshold block and a glossary term, and vice versa', () => {
    expect(Object.keys(ALARM_THRESHOLDS).sort()).toEqual([...ALARM_KINDS].sort())
    const covered = new Set(GLOSSARY_TERMS.map((t) => t.alarmKind).filter(Boolean))
    for (const kind of Object.keys(ALARM_THRESHOLDS)) expect(covered, kind).toContain(kind)
  })

  it('every alarm term states each of its thresholds', () => {
    for (const [kind, th] of Object.entries(ALARM_THRESHOLDS)) {
      const d = GLOSSARY_TERMS.find((t) => t.alarmKind === kind)!.definition
      for (const [k, v] of Object.entries(th as Record<string, number>)) expect(d, `${kind}.${k}`).toContain(String(v))
    }
  })

  it('the blind-spot term lists exactly the signals the code lists', () => {
    const known = new Set([...UNCOVERED_SIGNALS.map((u: { id: string }) => u.id), HEADROOM_BLIND_SIGNAL.id])
    for (const id of Object.keys(BLIND_SPOT_CLAUSES)) expect(known, `clause for unknown signal ${id}`).toContain(id)
    for (const id of known) expect(Object.keys(BLIND_SPOT_CLAUSES), `no clause for ${id}`).toContain(id)
    const blind = def('blind-spot')
    for (const id of known) expect(blind).toContain(BLIND_SPOT_CLAUSES[id])
    expect(blind.toLowerCase()).not.toContain('yield')
  })

  it('thin headroom says a depth-only venue is judged on swap-out depth', () => {
    expect(def('headroom-thin')).toContain('instant swap-out depth')
  })
})

