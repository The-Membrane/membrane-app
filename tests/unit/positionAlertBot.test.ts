import { describe, expect, it } from 'vitest'

import {
  nextLevel,
  planPositionAlerts,
  positionMessage,
  rawLevel,
  type PositionRead,
} from '@/components/Radar/positionAlertLogic'
import { replyText } from '@/components/Radar/telegramLogic'

const A = '0x1111111111111111111111111111111111111111'
const read = (hf: number | null, debtUsd = 10_000): PositionRead => ({
  healthFactor: hf,
  distance: hf === null ? null : 1 - 1 / hf,
  liquidationPrice: hf === null ? null : 3000 / hf,
  mainCollateral: 'WETH',
  riskType: 'price',
  debtUsd,
})

describe('position alert levels', () => {
  it('maps HF and distance to the shipped thresholds', () => {
    expect(rawLevel(read(1.3))).toBe('ok')
    expect(rawLevel(read(1.14))).toBe('warn')
    expect(rawLevel(read(1.04))).toBe('critical')
    expect(rawLevel(read(1.02))).toBe('act-now') // distance 2 % < 3 %
    expect(rawLevel(read(null))).toBe('ok')
    expect(rawLevel(read(1.02, 0))).toBe('ok')
  })

  it('rises at once and falls only past the hysteresis band', () => {
    expect(nextLevel('ok', read(1.04))).toBe('critical')
    expect(nextLevel('critical', read(1.07))).toBe('critical') // < 1.05 + 0.03
    expect(nextLevel('critical', read(1.1))).toBe('warn') // clear of critical, not of warn
    expect(nextLevel('critical', read(1.2))).toBe('ok')
    expect(nextLevel('warn', read(1.16))).toBe('warn')
    expect(nextLevel('act-now', read(1.035))).toBe('act-now') // distance 3.4 % < 4 %
    expect(nextLevel('act-now', read(1.045))).toBe('critical')
    expect(nextLevel('warn', read(null))).toBe('ok')
  })

  it('messages on a rise and once on recovery, never on a fall between alert levels', () => {
    const up = positionMessage(A, 'ok', 'critical', read(1.04))!
    expect(up).toContain('CRITICAL')
    expect(up).toContain('Health factor 1.040')
    expect(up).toContain('/ethereum/liquidations?address=')
    expect(positionMessage(A, 'critical', 'warn', read(1.1))).toBeNull()
    expect(positionMessage(A, 'warn', 'ok', read(1.3))).toContain('Clear')
    expect(positionMessage(A, 'warn', 'ok', read(null))).toContain('no Aave V3 Ethereum debt')
  })

  it('plans per subscription and skips failed reads', () => {
    const subscriptions = [
      { id: 's1', chatId: 'c1', address: A },
      { id: 's2', chatId: 'c2', address: A },
      { id: 's3', chatId: 'c3', address: '0x2222222222222222222222222222222222222222' },
    ]
    const plan = planPositionAlerts({
      subscriptions,
      levels: { s2: 'critical' },
      reads: { [A]: read(1.04), '0x2222222222222222222222222222222222222222': null },
    })
    expect(plan.map((p) => [p.subscriptionId, p.prev, p.next])).toEqual([['s1', 'ok', 'critical']])
  })
})

describe('bot replies', () => {
  it('subscribes an address that Radar does not track to position alerts', () => {
    const t = replyText({ kind: 'subscribed_position', address: A })
    expect(t).toContain('Aave V3 Ethereum position is read every hour')
    expect(t).toContain('/stop')
  })
})
