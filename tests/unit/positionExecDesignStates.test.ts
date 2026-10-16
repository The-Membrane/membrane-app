// components/PositionV0/dev/slipStates.ts — the design-states page's fixtures build every
// state through the real state machine, from the captured real reads.

import { describe, expect, it } from 'vitest'

import { DESIGN_STATES } from '@/components/PositionV0/dev/slipStates'

const by = (k: string) => DESIGN_STATES.find((s) => s.key === k)!

describe('design states', () => {
  it('has every state the owner asked for, once', () => {
    expect(DESIGN_STATES.map((s) => s.key)).toEqual([
      'reading',
      'ready',
      'no-wallet',
      'wrong-wallet',
      'wrong-chain',
      'balance',
      'paused',
      'cap',
      'spark-stable',
      'signing',
      'pending',
      'still-waiting',
      'settled',
      'reverted',
      'replaced',
      'approval-standing',
    ])
  })
  it('each state shows the button and stamp the machine gives it', () => {
    const want: Record<string, [string, string]> = {
      reading: ['DRAFT', 'wait'],
      ready: ['DRAFT', 'sign'],
      'no-wallet': ['DRAFT', 'connect'],
      'wrong-wallet': ['DRAFT', 'wait'],
      'wrong-chain': ['DRAFT', 'switch'],
      balance: ['DRAFT', 'wait'],
      paused: ['DRAFT', 'wait'],
      cap: ['DRAFT', 'wait'],
      'spark-stable': ['DRAFT', 'wait'],
      signing: ['SUBMITTED', 'wait'],
      pending: ['PENDING 1/2', 'wait'],
      'still-waiting': ['PENDING 2/2 · STILL WAITING', 'wait'],
      settled: ['SETTLED', 'close'],
      reverted: ['FAILED · GAS SPENT', 'retry'],
      replaced: ['REPLACED', 'retry'],
      'approval-standing': ['FAILED · GAS SPENT', 'retry'],
    }
    for (const s of DESIGN_STATES)
      expect([s.key, s.sheet.stamp, s.sheet.button.kind]).toEqual([s.key, ...want[s.key]])
  })
  it('names the block each blocked state shows', () => {
    expect(by('balance').sheet.notice).toMatch(/^Balance .* short of /)
    expect(by('paused').sheet.notice).toBe('Reserve is paused')
    expect(by('cap').sheet.notice).toMatch(/^Supply cap reached: room 0\.00 WETH/)
    expect(by('spark-stable').sheet.notice).toMatch(/is stable-rate, not repaid here$/)
    expect(by('wrong-wallet').sheet.notice).toMatch(/^Connect the wallet that holds this position/)
    expect(by('approval-standing').sheet.notice).toMatch(
      /is still standing\. It lets Aave V3 take up to/,
    )
  })
  it('labels every state that is not the read as captured', () => {
    for (const s of DESIGN_STATES) {
      if (['reading', 'ready', 'no-wallet', 'balance', 'signing'].includes(s.key)) continue
      expect(s.forced, s.key).toBeTruthy()
    }
  })
})
