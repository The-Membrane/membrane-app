import { describe, expect, it } from 'vitest'

import {
  applyEvents,
  emptyLedger,
  findChangePoints,
  pruneLedger,
  recordParamSample,
  setParamCursor,
} from '@/lib/exitQueue/ledger'
import type { LedgerEvent } from '@/lib/exitQueue/types'

import { addr, def, tsOf } from './exitQueueFixtures'

const at = (block: number, logIndex = 0) => ({ block, ts: tsOf(block), logIndex })
const req = (
  id: string,
  owner: string,
  amount: bigint,
  block: number,
  extra: Partial<LedgerEvent> = {},
) => ({ kind: 'request', id, owner, amount, ...at(block), ...extra }) as LedgerEvent
const ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const STETH = '0xae7ab96520de3a18e5e111b5eaab095312d7fe84'

describe('Lido ledger', () => {
  const events: LedgerEvent[] = [
    req('10', addr(1), 5n, 1_000),
    req('11', addr(2), 7n, 1_001),
    req('12', addr(3), 9n, 1_002),
    { kind: 'finalize_range', fromId: 9n, toId: 11n, ...at(1_100) },
    { kind: 'claim', id: '10', logId: 'c10', ...at(1_150) },
    { kind: 'claim', id: '3', logId: 'c3', ...at(1_150, 1) },
  ]

  it('finalizes the whole id range and records claims', () => {
    const l = applyEvents(emptyLedger('lido-steth'), def('lido-steth'), events)
    expect(l.requests['10']).toMatchObject({
      finalizedTs: tsOf(1_100),
      finalizedVia: 'event',
      claimedTs: tsOf(1_150),
    })
    expect(l.requests['11']).toMatchObject({ finalizedTs: tsOf(1_100), claimedTs: null })
    expect(l.requests['12']).toMatchObject({ finalizedTs: null })
    // Request 3 predates the ledger: its claim is counted, not invented.
    expect(l.unmatchedClaims).toBe(1)
  })

  it('is idempotent: applying the same events twice changes nothing', () => {
    const once = applyEvents(emptyLedger('lido-steth'), def('lido-steth'), events)
    const snapshot = JSON.stringify(once)
    const twice = applyEvents(
      once,
      def('lido-steth'),
      events.filter((e) => e.kind !== 'claim' || e.id !== '3'),
    )
    expect(JSON.stringify(twice)).toBe(snapshot)
  })

  it('applies events in block order regardless of input order', () => {
    const l = applyEvents(emptyLedger('lido-steth'), def('lido-steth'), [...events].reverse())
    expect(l.requests['10'].claimedTs).toBe(tsOf(1_150))
  })
})

describe('ether.fi ledger', () => {
  it('finalize_through is inclusive; invalidation cancels', () => {
    const l = applyEvents(emptyLedger('etherfi-weeth'), def('etherfi-weeth'), [
      req('100', addr(1), 1n, 1_000),
      req('101', addr(1), 1n, 1_001),
      req('102', addr(1), 1n, 1_002),
      { kind: 'finalize_through', throughId: 101n, via: 'bisect', ...at(1_050, 1e9) },
      { kind: 'remove', id: '102', txHash: '0xaa', ...at(1_060) },
    ])
    expect(l.requests['101']).toMatchObject({ finalizedTs: tsOf(1_050), finalizedVia: 'bisect' })
    expect(l.requests['102']).toMatchObject({ finalizedTs: null, cancelledTs: tsOf(1_060) })
  })
})

describe('claim without a seen finalization', () => {
  it('uses the claim time as an upper bound, labelled claim', () => {
    const l = applyEvents(emptyLedger('etherfi-weeth'), def('etherfi-weeth'), [
      req('7', addr(1), 1n, 1_000),
      { kind: 'claim', id: '7', logId: 'c7', ...at(1_500) },
    ])
    expect(l.requests['7']).toMatchObject({ finalizedTs: tsOf(1_500), finalizedVia: 'claim' })
  })
})

describe('Kelp ledger', () => {
  const base: LedgerEvent[] = [
    req(`${ETH}:5`, addr(1), 30n, 1_000, { asset: ETH } as never),
    req(`${ETH}:6`, addr(1), 40n, 1_001, { asset: ETH } as never),
    req(`${STETH}:5`, addr(1), 50n, 1_002, { asset: STETH } as never),
  ]

  it('unlock finalizes nonces below nextLockedNonce, per asset only', () => {
    const l = applyEvents(emptyLedger('kelp-rseth'), def('kelp-rseth'), [
      ...base,
      {
        kind: 'finalize_through',
        asset: ETH,
        throughId: 6n,
        exclusive: true,
        via: 'read_at_event',
        ...at(1_100),
      },
    ])
    expect(l.requests[`${ETH}:5`].finalizedTs).toBe(tsOf(1_100))
    expect(l.requests[`${ETH}:6`].finalizedTs).toBeNull()
    expect(l.requests[`${STETH}:5`].finalizedTs).toBeNull()
  })

  it('a claim pays the oldest unlocked request when the burned rsETH matches it', () => {
    const l = applyEvents(emptyLedger('kelp-rseth'), def('kelp-rseth'), [
      ...base,
      {
        kind: 'finalize_through',
        asset: ETH,
        throughId: 7n,
        exclusive: true,
        via: 'read_at_event',
        ...at(1_100),
      },
      { kind: 'claim_fifo', owner: addr(1), asset: ETH, amount: 30n, logId: 'k1', ...at(1_200) },
    ])
    expect(l.requests[`${ETH}:5`].claimedTs).toBe(tsOf(1_200))
    expect(l.requests[`${ETH}:6`].claimedTs).toBeNull()
    expect(l.unmatchedClaims).toBe(0)
  })

  it('negative control: an instant withdrawal (different amount) is not taken as a queue claim', () => {
    const l = applyEvents(emptyLedger('kelp-rseth'), def('kelp-rseth'), [
      ...base,
      {
        kind: 'finalize_through',
        asset: ETH,
        throughId: 7n,
        exclusive: true,
        via: 'read_at_event',
        ...at(1_100),
      },
      { kind: 'claim_fifo', owner: addr(1), asset: ETH, amount: 999n, logId: 'k1', ...at(1_200) },
    ])
    expect(Object.values(l.requests).every((r) => r.claimedTs == null)).toBe(true)
    expect(l.unmatchedClaims).toBe(1)
  })

  it('a claim before the unlock is unmatched', () => {
    const l = applyEvents(emptyLedger('kelp-rseth'), def('kelp-rseth'), [
      ...base,
      { kind: 'claim_fifo', owner: addr(1), asset: ETH, amount: 30n, logId: 'k1', ...at(1_050) },
    ])
    expect(l.requests[`${ETH}:5`].claimedTs).toBeNull()
    expect(l.unmatchedClaims).toBe(1)
  })
})

describe('sUSDe ledger', () => {
  const susde = def('sUSDe')
  const start = () => {
    const l = emptyLedger('sUSDe')
    setParamCursor(l, 'cooldownDuration', 86_400)
    return l
  }

  it('maturity = request time + the cooldown in force at the request', () => {
    const l = applyEvents(start(), susde, [req('a', addr(1), 100n, 1_000)])
    expect(l.requests.a).toMatchObject({
      finalizedTs: tsOf(1_000) + 86_400,
      finalizedVia: 'contract_rule',
    })
  })

  it("a second cooldown resets the owner's whole bucket (StakedUSDeV2 semantics)", () => {
    const l = applyEvents(start(), susde, [
      req('a', addr(1), 100n, 1_000),
      req('b', addr(1), 50n, 9_000),
    ])
    expect(l.requests.a.finalizedTs).toBe(tsOf(9_000) + 86_400)
    expect(l.requests.b.finalizedTs).toBe(tsOf(9_000) + 86_400)
  })

  it('a cooldown change applies to later requests only', () => {
    const l = applyEvents(start(), susde, [
      req('a', addr(1), 100n, 1_000),
      {
        kind: 'param',
        param: 'cooldownDuration',
        from: 86_400,
        to: 3_600,
        txHash: '0x1',
        ...at(1_001),
      },
      req('b', addr(2), 100n, 1_002),
    ])
    expect(l.requests.a.finalizedTs).toBe(tsOf(1_000) + 86_400)
    expect(l.requests.b.finalizedTs).toBe(tsOf(1_002) + 3_600)
    expect(l.changes).toEqual([
      expect.objectContaining({
        param: 'cooldownDuration',
        from: 86_400,
        to: 3_600,
        source: 'event',
      }),
    ])
  })

  it('an unstake transfer claims the matured bucket whose sum equals the amount', () => {
    const matured = tsOf(1_000) + 86_400 + 60
    const l = applyEvents(start(), susde, [
      req('a', addr(1), 100n, 1_000),
      req('b', addr(1), 50n, 1_000, { logIndex: 1 } as never),
      req('c', addr(2), 150n, 1_000, { logIndex: 2 } as never),
      {
        kind: 'claim_amount',
        receiver: addr(2),
        amount: 150n,
        logId: 'u1',
        block: 9_999,
        ts: matured,
        logIndex: 0,
      },
    ])
    // Two buckets sum to 150; the receiver decides.
    expect(l.requests.c.claimedTs).toBe(matured)
    expect(l.requests.a.claimedTs).toBeNull()
  })

  it('negative controls: wrong amount, or before maturity, stays unmatched', () => {
    const early = tsOf(1_000) + 3_600
    const l = applyEvents(start(), susde, [
      req('a', addr(1), 100n, 1_000),
      {
        kind: 'claim_amount',
        receiver: addr(1),
        amount: 101n,
        logId: 'u1',
        block: 99_999,
        ts: tsOf(99_999),
        logIndex: 0,
      },
      {
        kind: 'claim_amount',
        receiver: addr(1),
        amount: 100n,
        logId: 'u2',
        block: 1_001,
        ts: early,
        logIndex: 0,
      },
    ])
    expect(l.requests.a.claimedTs).toBeNull()
    expect(l.unmatchedClaims).toBe(2)
  })
})

describe('Maple ledger', () => {
  it('processed + removed in one tx = paid; removed alone = cancelled; manual clears the claim', () => {
    const l = applyEvents(emptyLedger('maple-syrupusdc'), def('maple-syrupusdc'), [
      req('1', addr(1), 10n, 1_000),
      req('2', addr(2), 10n, 1_000, { logIndex: 1 } as never),
      req('3', addr(3), 10n, 1_000, { logIndex: 2 } as never),
      { kind: 'process', id: '1', txHash: '0xp', ...at(1_010, 0) },
      { kind: 'remove', id: '1', txHash: '0xp', ...at(1_010, 1) },
      { kind: 'remove', id: '2', txHash: '0xq', ...at(1_011, 0) },
      { kind: 'process', id: '3', txHash: '0xr', ...at(1_012, 0) },
      { kind: 'remove', id: '3', txHash: '0xr', ...at(1_012, 1) },
      { kind: 'manual', id: '3', ...at(1_012, 2) },
    ])
    expect(l.requests['1']).toMatchObject({ finalizedTs: tsOf(1_010), claimedTs: tsOf(1_010) })
    expect(l.requests['2']).toMatchObject({ finalizedTs: null, cancelledTs: tsOf(1_011) })
    expect(l.requests['3']).toMatchObject({
      finalizedTs: tsOf(1_012),
      claimedTs: null,
      manual: true,
    })
  })

  it('a partial process, then a removal in a later tx, is a cancellation', () => {
    const l = applyEvents(emptyLedger('maple-syrupusdc'), def('maple-syrupusdc'), [
      req('4', addr(4), 10n, 1_000),
      { kind: 'process', id: '4', txHash: '0xp', ...at(1_010, 0) },
      { kind: 'remove', id: '4', txHash: '0xq', ...at(1_020, 0) },
    ])
    expect(l.requests['4']).toMatchObject({
      finalizedTs: null,
      claimedTs: null,
      cancelledTs: tsOf(1_020),
    })
  })
})

describe('parameter change log', () => {
  it('a silent change between reads is logged as state_diff with its block bracket', () => {
    const l = emptyLedger('kelp-rseth')
    recordParamSample(l, {
      block: 100,
      ts: 1,
      values: { withdrawalDelayBlocks: 57_600, paused: false },
    })
    const added = recordParamSample(l, {
      block: 200,
      ts: 2,
      values: { withdrawalDelayBlocks: 0, paused: false },
    })
    expect(added).toEqual([
      {
        param: 'withdrawalDelayBlocks',
        from: 57_600,
        to: 0,
        block: 200,
        ts: 2,
        source: 'state_diff',
        sinceBlock: 100,
      },
    ])
  })

  it('a change already announced by an event is not logged twice', () => {
    const l = emptyLedger('sUSDe')
    recordParamSample(l, { block: 100, ts: 1, values: { cooldownDuration: 604_800 } })
    applyEvents(l, def('sUSDe'), [
      {
        kind: 'param',
        param: 'cooldownDuration',
        from: 604_800,
        to: 86_400,
        txHash: '0x1',
        block: 150,
        ts: 2,
        logIndex: 0,
      },
    ])
    expect(
      recordParamSample(l, { block: 200, ts: 3, values: { cooldownDuration: 86_400 } }),
    ).toEqual([])
    expect(l.changes).toHaveLength(1)
  })

  it('a failed read (null) is not a change, and the next good read compares with the last good one', () => {
    const l = emptyLedger('lido-steth')
    recordParamSample(l, { block: 100, ts: 1, values: { paused: false } })
    expect(recordParamSample(l, { block: 200, ts: 2, values: { paused: null } })).toEqual([])
    expect(recordParamSample(l, { block: 300, ts: 3, values: { paused: false } })).toEqual([])
    expect(recordParamSample(l, { block: 400, ts: 4, values: { paused: true } })).toMatchObject([
      { from: false, to: true, sinceBlock: 300 },
    ])
  })
})

describe('findChangePoints', () => {
  // A counter that steps at blocks 1_337 and 1_900.
  const counter = (b: number) => BigInt(b >= 1_900 ? 3 : b >= 1_337 ? 2 : 1)
  const read = async (b: number) => counter(b)

  it('locates every change to the exact block', async () => {
    const points = await findChangePoints(
      read,
      { block: 1_000, value: 1n },
      { block: 2_000, value: 3n },
      { calls: 100 },
    )
    expect(points).toEqual([
      { block: 1_337, value: 2n },
      { block: 1_900, value: 3n },
    ])
  })

  it('reports a bracket when the call budget runs out', async () => {
    const points = await findChangePoints(
      read,
      { block: 1_000, value: 1n },
      { block: 2_000, value: 3n },
      { calls: 1 },
    )
    expect(points.some((p) => p.bracketFrom != null)).toBe(true)
    expect(points[points.length - 1].value).toBe(3n)
  })

  it('a failed historical read degrades to a bracket instead of failing the venue', async () => {
    const flaky = async (b: number) => {
      if (b < 1_500 && b !== 1_000) throw new Error('Archive requests require a personal token')
      return counter(b)
    }
    const points = await findChangePoints(
      flaky,
      { block: 1_000, value: 1n },
      { block: 2_000, value: 3n },
      { calls: 100 },
    )
    // The first change is only bracketed in (1_000, 1_500]; the second is still exact.
    expect(points).toEqual([
      { block: 1_500, value: 2n, bracketFrom: 1_000 },
      { block: 1_900, value: 3n },
    ])
  })

  it('an out-of-order read is retried; a one-off bad relay answer does not move the result', async () => {
    let served = 0
    const glitchy = async (b: number) => {
      served += 1
      return served === 1 ? 0n : counter(b) // the first answer is from a bad relay
    }
    const budget = { calls: 100, anomalies: 0 }
    const points = await findChangePoints(
      glitchy,
      { block: 1_000, value: 1n },
      { block: 2_000, value: 3n },
      budget,
    )
    expect(points).toEqual([
      { block: 1_337, value: 2n },
      { block: 1_900, value: 3n },
    ])
    expect(budget.anomalies).toBe(0)
  })

  it('a repeatedly out-of-order read brackets the interval and is counted', async () => {
    const budget = { calls: 100, anomalies: 0 }
    const points = await findChangePoints(
      async () => 9n,
      { block: 0, value: 1n },
      { block: 100, value: 3n },
      budget,
    )
    expect(points).toEqual([{ block: 100, value: 3n, bracketFrom: 0 }])
    expect(budget.anomalies).toBe(1)
  })
})

describe('pruneLedger', () => {
  it('drops finished requests past retention and keeps every open one', () => {
    const l = applyEvents(emptyLedger('lido-steth'), def('lido-steth'), [
      req('1', addr(1), 1n, 1_000),
      req('2', addr(1), 1n, 1_001),
      { kind: 'finalize_range', fromId: 1n, toId: 1n, ...at(1_010) },
      { kind: 'claim', id: '1', logId: 'c', ...at(1_020) },
    ])
    pruneLedger(l, tsOf(1_000) + 200 * 86_400, 120)
    expect(Object.keys(l.requests)).toEqual(['2'])
  })
})
