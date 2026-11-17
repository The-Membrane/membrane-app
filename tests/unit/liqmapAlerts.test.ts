import { describe, expect, it } from 'vitest'

import {
  evaluateRules,
  makeRule,
  MAX_RULES,
  newlyFired,
  parseStored,
  validRule,
} from '@/components/LiquidationMap/alertRulesLogic'

const A = '0x' + 'ab'.repeat(20)

describe('liquidation-map alert rules', () => {
  const rules = [
    makeRule('distance', 0.05, 1),
    makeRule('hf', 1.2, 2),
    makeRule('daysToHf1', 90, 3),
  ]

  it('fires only rules whose live value is below the threshold', () => {
    const f = evaluateRules(rules, { distance: 0.03, healthFactor: 1.25, daysToHf1: null })
    expect(f.map((x) => x.id)).toEqual([rules[0].id])
    expect(f[0].text).toBe('Distance to liquidation below 5.0%: now 3.0%')
  })

  it('treats missing data as not fired and the threshold itself as not crossed', () => {
    expect(evaluateRules(rules, { distance: null, healthFactor: 1.2, daysToHf1: 90 })).toEqual([])
  })

  it('is edge-triggered', () => {
    const now = evaluateRules(rules, { distance: 0.01, healthFactor: 1.1, daysToHf1: 10 })
    expect(newlyFired(new Set([rules[0].id]), now).map((x) => x.id)).toEqual([
      rules[1].id,
      rules[2].id,
    ])
  })

  it('validates rule ranges', () => {
    expect(validRule(makeRule('hf', 0.9))).toBe(false)
    expect(validRule(makeRule('distance', 0.6))).toBe(false)
    expect(validRule({ id: 'x', kind: 'apr', threshold: 1 })).toBe(false)
    expect(validRule(makeRule('daysToHf1', 30))).toBe(true)
  })

  it('parses stored rules defensively', () => {
    expect(parseStored(null)).toBeNull()
    expect(parseStored('{bad')).toBeNull()
    expect(parseStored(JSON.stringify({ address: 'nope', rules: [] }))).toBeNull()
    const many = Array.from({ length: 9 }, (_, i) => makeRule('hf', 1.5, i))
    const s = parseStored(
      JSON.stringify({ address: A, rules: [...many, { id: 'z', kind: 'hf', threshold: 0 }] }),
    )
    expect(s?.address).toBe(A)
    expect(s?.rules).toHaveLength(MAX_RULES)
  })
})
