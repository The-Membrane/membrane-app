import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { GLOSSARY_GROUPS, GLOSSARY_TERMS, buildDefinedTermSet } from '@/components/Glossary/terms'
import { COOLDOWN_EXPOSED_SECONDS, COVERAGE_CAUTION, COVERAGE_CLEAR } from '@/components/Radar/radarLogic'

const alarmRulesSrc = fs.readFileSync(path.resolve(__dirname, '../../scripts/lib/alarmRules.mjs'), 'utf8')
// Every rule in alarmRules.mjs is introduced by a `// --- rule: <kind> (` header.
const ALARM_KINDS = Array.from(alarmRulesSrc.matchAll(/\/\/ --- rule: ([a-z_]+) \(/g)).map((m) => m[1])

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

  it('verdict thresholds match radarLogic', () => {
    expect(COVERAGE_CLEAR).toBe(10)
    expect(COVERAGE_CAUTION).toBe(1)
    expect(COOLDOWN_EXPOSED_SECONDS).toBe(86_400)
    const def = (id: string) => GLOSSARY_TERMS.find((t) => t.id === id)!.definition
    expect(def('clear')).toContain('10x')
    expect(def('exposed')).toContain('1x')
    expect(def('exposed')).toContain('1 day')
  })

  it('builds a DefinedTermSet with one DefinedTerm per entry, anchored', () => {
    const set = buildDefinedTermSet('https://example.test', 'ethereum')
    expect(set['@type']).toBe('DefinedTermSet')
    expect(set.hasDefinedTerm).toHaveLength(GLOSSARY_TERMS.length)
    expect(set.hasDefinedTerm[0].url).toBe(`https://example.test/ethereum/glossary#${GLOSSARY_TERMS[0].id}`)
  })
})
