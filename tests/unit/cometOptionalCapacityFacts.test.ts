import { describe, it, expect, vi } from 'vitest'
import { DIRECT_SUPPLY_MARKETS } from '@/lib/carry/directSupplyMarketConstants'
import { readDirectSupplyExitQuote } from '@/lib/carry/directSupplyExitQuote'
const m = DIRECT_SUPPLY_MARKETS.compoundV3Usdc,
  hash = `0x${'a'.repeat(64)}` as `0x${string}`
const block = { number: 26100000n, hash, timestamp: 1800000000n },
  now = Number(block.timestamp) * 1000 + 1000
const input = {
  routeKey: m.routeKey,
  destinationAddress: m.destination as `0x${string}`,
  owner: `0x${'b'.repeat(40)}` as `0x${string}`,
  assetsRaw: '1000000',
}
function client(pause: unknown) {
  const readContract = vi.fn(async (x: any) => {
    if (x.functionName === 'decimals') return 6
    if (x.functionName === 'baseToken') return m.underlying
    if (x.functionName === 'balanceOf') return 5000000n
    if (x.functionName === 'isWithdrawPaused') {
      if (pause instanceof Error) throw pause
      return pause
    }
    throw Error('unexpected read')
  })
  return {
    getChainId: async () => 1,
    getBlock: async () => block,
    request: async () => '0x',
    readContract,
    call: vi.fn(async () => ({ data: '0x' })),
  }
}
describe('optional pinned Comet withdraw pause read', () => {
  it('does not add a getter to normal direct quotes', async () => {
    const c = client(false)
    const r = await readDirectSupplyExitQuote(c as never, input, now)
    expect(r.cometFacts).toBeUndefined()
    expect(c.readContract).toHaveBeenCalledTimes(4)
  })
  it.each([true, false, null, 1, new Error('offline')])(
    'retains strict optional bool and preserves core withdrawal for %s',
    async (pause) => {
      const c = client(pause),
        r = await readDirectSupplyExitQuote(c as never, input, now, undefined, {
          includeCapacityFacts: true,
        })
      expect(r.cometFacts?.withdrawalsPaused).toBe(typeof pause === 'boolean' ? pause : null)
      expect(r.position.suppliedBalanceRaw).toBe('5000000')
      expect(r.simulation.status).toBe('success')
      expect(
        c.readContract.mock.calls.filter(([x]) => x.functionName === 'isWithdrawPaused'),
      ).toHaveLength(1)
      expect(
        c.readContract.mock.calls.every(
          ([x]) => x.blockHash === hash && x.requireCanonical === true,
        ),
      ).toBe(true)
    },
  )
})
