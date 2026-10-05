import { describe, expect, it } from 'vitest'

import type { LogFilter } from '@/lib/exitQueue/decode'
import { emptyLedger } from '@/lib/exitQueue/ledger'
import { syncVenue, type ChainReader, type SyncOptions } from '@/lib/exitQueue/sync'
import type { RawLog } from '@/lib/exitQueue/types'
import { ABI } from '@/lib/exitQueue/venues'

import { addr, def, mkLog, tsOf } from './exitQueueFixtures'

/** An in-memory chain: logs by address, and view functions as (signature, args, block) → value. */
function fakeChain(
  logs: RawLog[],
  views: (sig: string, args: unknown[], block: number) => unknown,
) {
  const calls: string[] = []
  const reader: ChainReader = {
    async getLogs(filter: LogFilter, from: number, to: number) {
      const t0 = filter.topics[0] as string[]
      return logs.filter(
        (l) =>
          l.address.toLowerCase() === filter.address.toLowerCase() &&
          l.blockNumber >= from &&
          l.blockNumber <= to &&
          t0.includes(l.topics[0]) &&
          filter.topics.every(
            (t, i) => i === 0 || t == null || (Array.isArray(t) ? t : [t]).includes(l.topics[i]),
          ),
      )
    },
    async call(_address, sig, args, block) {
      calls.push(sig.split('(')[0].replace('function ', ''))
      const v = views(sig, args, block)
      if (v === undefined) throw new Error(`no view ${sig}`)
      return v
    },
    async blockTs(block) {
      return tsOf(block)
    },
  }
  return { reader, calls }
}

const opts = (anchorBlock: number, o: Partial<SyncOptions> = {}): SyncOptions => ({
  anchor: { block: anchorBlock, ts: tsOf(anchorBlock) },
  days: 1,
  chunkBlocks: 1_000,
  maxChunks: 100,
  bisectCalls: 100,
  retentionDays: 120,
  ...o,
})

describe('syncVenue: ether.fi (finalization without an event)', () => {
  const etherfi = def('etherfi-weeth')
  const q = etherfi.contracts.queue
  const ANCHOR = 20_000
  const START = ANCHOR - 7_200
  const logs = [
    mkLog(
      q,
      ABI.etherfi.created,
      { requestId: 50, amountOfEEth: 10n, shareOfEEth: 9n, owner: addr(1) },
      { block: START + 100 },
    ),
    mkLog(
      q,
      ABI.etherfi.created,
      { requestId: 51, amountOfEEth: 20n, shareOfEEth: 18n, owner: addr(2) },
      { block: START + 200 },
    ),
    mkLog(
      q,
      ABI.etherfi.claimed,
      { requestId: 50, amountOfEEth: 10n, shareOfEEth: 9n, owner: addr(1) },
      { block: START + 5_000 },
    ),
  ]
  // lastFinalizedRequestId: 49 until START+4_321, then 50.
  const views = (sig: string, _args: unknown[], block: number) => {
    if (sig.includes('lastFinalizedRequestId')) return block >= START + 4_321 ? 50 : 49
    if (sig.includes('nextRequestId')) return 52
    if (sig.includes('paused')) return false
    return undefined
  }

  it('bisects lastFinalizedRequestId to the exact block and measures the wait', async () => {
    const { reader } = fakeChain(logs, views)
    const { ledger, complete } = await syncVenue(
      etherfi,
      emptyLedger('etherfi-weeth'),
      reader,
      opts(ANCHOR),
    )
    expect(complete).toBe(true)
    expect(ledger.requests['50']).toMatchObject({
      finalizedBlock: START + 4_321,
      finalizedVia: 'bisect',
      claimedBlock: START + 5_000,
    })
    expect(ledger.requests['51'].finalizedTs).toBeNull()
    const snap = ledger.snapshots.at(-1)!
    expect(snap).toMatchObject({ depthCount: 1, depthAmount: '20', depthSource: 'ledger' })
    expect(snap.extra).toMatchObject({ amountIsLowerBound: false, ledgerOpen: 1 })
    expect(ledger.coverage).toMatchObject({ fromBlock: START, throughBlock: ANCHOR })
  })

  it('resumes from the cursor: a second pass with no new blocks changes nothing but reads', async () => {
    const { reader } = fakeChain(logs, views)
    const first = (await syncVenue(etherfi, emptyLedger('etherfi-weeth'), reader, opts(ANCHOR)))
      .ledger
    const requests = JSON.stringify(first.requests)
    const again = await syncVenue(etherfi, first, reader, opts(ANCHOR))
    expect(again.logs).toBe(0)
    expect(JSON.stringify(again.ledger.requests)).toBe(requests)
  })

  it('without an archive baseline it still dates finalization from the first request id', async () => {
    const { reader } = fakeChain(logs, (sig, args, block) => {
      // The baseline block is out of this endpoint's state window.
      if (sig.includes('lastFinalizedRequestId') && block < START)
        throw new Error('missing trie node')
      return views(sig, args, block)
    })
    const { ledger } = await syncVenue(etherfi, emptyLedger('etherfi-weeth'), reader, opts(ANCHOR))
    expect(ledger.requests['50']).toMatchObject({
      finalizedBlock: START + 4_321,
      finalizedVia: 'bisect',
    })
    expect(ledger.cursors).toMatchObject({
      lastFinalizedRequestId: '50',
      lastFinalizedBlock: String(ANCHOR),
    })
  })

  it('a failed read at the scan end keeps the cursor block, so the next run still finds the exact change', async () => {
    // Run 1 scans to START + 4_900, past the finalization at START + 4_321, but the
    // read at its last block fails. Run 2 must bisect from run 1's baseline block,
    // not from its own start (where the counter had already moved).
    const firstEnd = START + 4_900
    let down = true
    const { reader } = fakeChain(logs, (sig, args, block) => {
      if (down && sig.includes('lastFinalizedRequestId') && block === firstEnd)
        throw new Error('timeout')
      return views(sig, args, block)
    })
    const first = (
      await syncVenue(etherfi, emptyLedger('etherfi-weeth'), reader, {
        ...opts(firstEnd),
        days: 2,
      })
    ).ledger
    expect(first.requests['50'].finalizedTs).toBeNull()
    expect(first.cursors.lastFinalizedBlock).toBe(String(firstEnd - 2 * 7_200 - 1))
    down = false
    const second = (await syncVenue(etherfi, first, reader, opts(ANCHOR))).ledger
    expect(second.requests['50']).toMatchObject({
      finalizedBlock: START + 4_321,
      finalizedVia: 'bisect',
    })
  })

  it('stops at --max-chunks with a consistent partial coverage', async () => {
    const { reader } = fakeChain(logs, views)
    const r = await syncVenue(
      etherfi,
      emptyLedger('etherfi-weeth'),
      reader,
      opts(ANCHOR, { maxChunks: 2 }),
    )
    expect(r.complete).toBe(false)
    expect(r.ledger.coverage?.throughBlock).toBe(START - 1 + 2 * 1_000)
    expect(r.ledger.requests['50']).toBeDefined()
  })
})

describe('syncVenue: Kelp (unlock read at the event block)', () => {
  const kelp = def('kelp-rseth')
  const q = kelp.contracts.queue
  const ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  const ANCHOR = 20_000
  const START = ANCHOR - 7_200

  it('reads nextLockedNonce at each AssetUnlocked block, then matches the claim', async () => {
    const logs = [
      mkLog(
        q,
        ABI.kelp.queued,
        { withdrawer: addr(1), asset: ETH, rsETHUnstaked: 30n, userNonce: 7n },
        { block: START + 10 },
      ),
      mkLog(
        q,
        ABI.kelp.queued,
        { withdrawer: addr(2), asset: ETH, rsETHUnstaked: 40n, userNonce: 8n },
        { block: START + 20 },
      ),
      mkLog(
        q,
        ABI.kelp.unlocked,
        { asset: ETH, rsEthAmount: 30n, assetAmount: 30n, rsEThPrice: 1n, assetPrice: 1n },
        { block: START + 3_000 },
      ),
      mkLog(
        q,
        ABI.kelp.finalized,
        { withdrawer: addr(1), asset: ETH, amountBurned: 30n, amountReceived: 31n },
        { block: START + 3_500 },
      ),
      mkLog(q, ABI.kelp.delayBlocks, { withdrawalDelayBlocks: 0n }, { block: START + 6_000 }),
    ]
    const { reader, calls } = fakeChain(logs, (sig, _args, block) => {
      if (sig.includes('nextLockedNonce')) return block >= START + 3_000 ? 8n : 7n
      if (sig.includes('nextUnusedNonce')) return 9n
      if (sig.includes('withdrawalDelayBlocks')) return block >= START + 6_000 ? 0n : 57_600n
      if (sig.includes('paused')) return false
      return undefined
    })
    const { ledger } = await syncVenue(kelp, emptyLedger('kelp-rseth'), reader, opts(ANCHOR))
    expect(ledger.requests[`${ETH}:7`]).toMatchObject({
      finalizedBlock: START + 3_000,
      finalizedVia: 'read_at_event',
      claimedBlock: START + 3_500,
    })
    expect(ledger.requests[`${ETH}:8`].finalizedTs).toBeNull()
    expect(calls.filter((c) => c === 'nextLockedNonce').length).toBeGreaterThan(0)
    // The delay change came with an event, so the end-of-run read diff does not repeat it.
    expect(ledger.changes).toEqual([
      expect.objectContaining({
        param: 'withdrawalDelayBlocks',
        from: 57_600,
        to: 0,
        source: 'event',
      }),
    ])
  })
})

describe('syncVenue: Kelp reconciliation', () => {
  it('an unlock whose read failed is settled at the scan end as an upper bound, and counted', async () => {
    const kelp = def('kelp-rseth')
    const q = kelp.contracts.queue
    const ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    const ANCHOR = 20_000
    const START = ANCHOR - 7_200
    const logs = [
      mkLog(
        q,
        ABI.kelp.queued,
        { withdrawer: addr(1), asset: ETH, rsETHUnstaked: 30n, userNonce: 7n },
        { block: START + 10 },
      ),
      mkLog(
        q,
        ABI.kelp.unlocked,
        { asset: ETH, rsEthAmount: 30n, assetAmount: 30n, rsEThPrice: 1n, assetPrice: 1n },
        { block: START + 3_000 },
      ),
    ]
    const { reader } = fakeChain(logs, (sig, _args, block) => {
      if (sig.includes('nextLockedNonce')) {
        if (block === START + 3_000) throw new Error('Archive requests require a personal token')
        return block >= START + 3_000 ? 8n : 7n
      }
      if (sig.includes('nextUnusedNonce')) return 8n
      if (sig.includes('withdrawalDelayBlocks')) return 0n
      if (sig.includes('paused')) return false
      return undefined
    })
    const { ledger } = await syncVenue(kelp, emptyLedger('kelp-rseth'), reader, opts(ANCHOR))
    expect(ledger.requests[`${ETH}:7`]).toMatchObject({
      finalizedBlock: ANCHOR,
      finalizedVia: 'bracket',
    })
    expect(ledger.readAnomalies).toBe(1)
  })
})

describe('syncVenue: sUSDe (baseline cooldown read before the scan)', () => {
  it('dates maturity with the cooldown in force at the first scanned block', async () => {
    const susde = def('ethena-susde')
    const ANCHOR = 20_000
    const START = ANCHOR - 7_200
    const logs = [
      mkLog(
        susde.contracts.vault,
        ABI.ethena.withdraw,
        {
          sender: addr(1),
          receiver: susde.contracts.silo,
          owner: addr(1),
          assets: 100n,
          shares: 90n,
        },
        { block: START + 1 },
      ),
    ]
    const { reader } = fakeChain(logs, (sig) => {
      if (sig.includes('cooldownDuration')) return 86_400
      if (sig.includes('balanceOf')) return 100n
      return undefined
    })
    const { ledger } = await syncVenue(susde, emptyLedger('ethena-susde'), reader, opts(ANCHOR))
    const [r] = Object.values(ledger.requests)
    expect(r.finalizedTs).toBe(tsOf(START + 1) + 86_400)
    expect(ledger.snapshots.at(-1)).toMatchObject({
      depthAmount: '100',
      depthCount: 1,
      depthSource: 'onchain',
    })
  })
})

describe('syncVenue: silent parameter change', () => {
  it('logs a state_diff when a read changes between runs with no event', async () => {
    const lido = def('lido-steth')
    let bunker = false
    const { reader } = fakeChain([], (sig) => {
      if (sig.includes('isBunkerModeActive')) return bunker
      if (sig.includes('isPaused')) return false
      if (sig.includes('unfinalized')) return 0n
      return undefined
    })
    const first = (await syncVenue(lido, emptyLedger('lido-steth'), reader, opts(10_000))).ledger
    bunker = true
    const second = (await syncVenue(lido, first, reader, opts(10_500))).ledger
    expect(second.changes).toEqual([
      expect.objectContaining({
        param: 'bunkerMode',
        from: false,
        to: true,
        source: 'state_diff',
        sinceBlock: 10_000,
      }),
    ])
  })

  it('refuses the beacon venue (recorded from the Beacon API instead)', async () => {
    const { reader } = fakeChain([], () => undefined)
    await expect(
      syncVenue(def('beacon-exit'), emptyLedger('beacon-exit'), reader, opts(1)),
    ).rejects.toThrow(/beacon/)
  })
})
