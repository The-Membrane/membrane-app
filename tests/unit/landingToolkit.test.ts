import { describe, expect, it } from 'vitest'

import { HERO_VARIANTS, TOOLKIT } from '@/components/Seniority/facts'
import { toolkitDemo } from '@/components/Seniority/toolkitModel'
import { AT_RISK_SUBTEXT, inAppNotice } from '@/lib/positionAlerts'

// The landing's instrument panel (owner direction 2026-10-27, Q26-S1). The numbers come from
// lib/positionAlerts, so these checks pin the demo to the alert engine and the copy to the
// Q26 claim rules (R27, R29, Q26-alert-M2, Q26-S1).

describe('toolkitDemo', () => {
  const demo = toolkitDemo()

  it('puts the demo position inside the at-risk line, so the real notice renders', () => {
    expect(demo.model.state).toBe('at-risk')
    const notice = inAppNotice(demo.model)
    expect(notice?.step).toBe('at-risk')
    expect(notice?.subtext).toBe(AT_RISK_SUBTEXT.text)
  })

  it('orders the ladder from the highest price down: alert, now, line, no-timer price', () => {
    expect(demo.rungs.map((r) => r.id)).toEqual(['at-risk', 'now', 'line', 'immediate'])
    const prices = demo.rungs.map((r) => r.priceUsd)
    expect([...prices].sort((a, b) => b - a)).toEqual(prices)
  })

  it('draws the at-risk rung 3% above the line and the no-timer rung from the window', () => {
    const at = (id: string) => demo.rungs.find((r) => r.id === id)!.priceUsd
    const line = at('line')
    expect(line).toBeCloseTo(95000 * 0.98, 6)
    // at-risk: oracle within 3% of the liquidation price => line = p * (1 - 0.03)
    expect(at('at-risk') * (1 - 0.03)).toBeCloseTo(line, 6)
    expect(at('immediate')).toBeCloseTo(demo.model.immediatePriceUsd!, 6)
    expect(at('immediate')).toBeLessThan(line)
  })

  it('fills the R29 explainer with the ladder prices', () => {
    expect(demo.explainer).toContain('$93,100')
    expect(demo.explainer).toContain('$89,519')
    expect(demo.explainer).toContain('Past liquidations often came well before the 8 hours ended.')
  })
})

describe('landing copy rules', () => {
  const served = HERO_VARIANTS.d
  const suiteCopy = [
    served.headline,
    served.sub,
    served.bridge.line,
    TOOLKIT.title,
    TOOLKIT.health.line,
    TOOLKIT.timer.line,
    ...TOOLKIT.index.map((t) => t.line),
    ...demoLabels(),
  ].join(' \n ')

  function demoLabels() {
    return toolkitDemo().rungs.map((r) => r.label)
  }

  it('never promises time in hand or states the window as a percentage (R29, Q26-alert-M2)', () => {
    expect(suiteCopy).not.toMatch(/you have (8|eight) hours/i)
    expect(suiteCopy).not.toMatch(/\b4\s?%/)
    expect(suiteCopy).not.toMatch(/a further drop/i)
    expect(suiteCopy).not.toMatch(/nothing sells/i)
  })

  it('shows no probability, odds figure or confidence number', () => {
    expect(suiteCopy).not.toMatch(/\d+(\.\d+)?\s?% (chance|probability|accura|confiden)/i)
    expect(suiteCopy).not.toMatch(/accura(te|cy)/i)
  })

  it('marks sizing as coming and gives it no link and no figure', () => {
    const sizing = TOOLKIT.index.find((t) => t.id === 'sizing')!
    expect(sizing.status).toBe('coming')
    expect(sizing.href).toBeUndefined()
    expect(sizing.line).not.toMatch(/\$\d/)
    expect(served.sub).toMatch(/is next/)
  })

  it('labels the preview tools as preview and links every built tool', () => {
    expect(TOOLKIT.health.status).toBe('preview')
    for (const t of [TOOLKIT.health, TOOLKIT.timer, ...TOOLKIT.index]) {
      if (t.status !== 'coming') expect(t.href).toMatch(/^\//)
    }
  })
})
