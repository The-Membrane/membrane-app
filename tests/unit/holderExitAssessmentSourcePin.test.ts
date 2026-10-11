import { afterEach, describe, expect, it, vi } from 'vitest'
import { DIRECT_SUPPLY_MARKETS } from '@/lib/carry/directSupplyMarketConstants'
import { readDirectSupplyExitQuote } from '@/lib/carry/directSupplyExitQuote'
import { readHolderExitAssessment } from '@/lib/carry/holderExitAssessment'
vi.mock('@/lib/carry/directSupplyExitQuote', async (original) => ({
  ...(await original<typeof import('@/lib/carry/directSupplyExitQuote')>()),
  readDirectSupplyExitQuote: vi.fn(),
}))
const market = DIRECT_SUPPLY_MARKETS.aaveV3Usdc
const input = {
  routeKey: market.routeKey,
  destinationAddress: market.destination,
  owner: '0x0000000000000000000000000000000000000001',
  assetsRaw: '1000000',
  horizonHours: 24,
} as const
const pin = {
  mode: 'internal_historical_finalized_block',
  blockNumber: 26139351n,
  blockHash: `0x${'a'.repeat(64)}`,
} as const
const clients = { direct: {}, apy: {}, morpho: {}, tracked: {} } as never
const quote = {
  source: {
    chainId: 1,
    blockNumber: Number(pin.blockNumber),
    blockHash: pin.blockHash,
    blockTime: '2026-10-07T08:35:35.000Z',
  },
  simulation: { status: 'success' },
}
afterEach(() => {
  vi.clearAllMocks()
})
describe('Aave internal source pin forwarding', () => {
  it('passes exact owner/Q and internal pin to independently verifying direct reader', async () => {
    vi.mocked(readDirectSupplyExitQuote).mockResolvedValue(quote as never)
    const result = await readHolderExitAssessment(clients, input, { directFinalizedBlock: pin })
    expect(readDirectSupplyExitQuote).toHaveBeenCalledWith(
      clients.direct,
      {
        routeKey: input.routeKey,
        destinationAddress: input.destinationAddress,
        owner: input.owner,
        assetsRaw: input.assetsRaw,
      },
      expect.any(Function),
      pin,
      {},
    )
    expect(result.source.blockTime).toBe(quote.source.blockTime)
    expect(result.finalPayout).toMatchObject({
      assetAddress: market.underlying.toLowerCase(),
      status: 'simulated',
      amountRaw: input.assetsRaw,
    })
  })
  it('passes exact owner/Q and no source pin or optional capacity flags for unpinned callers', async () => {
    vi.mocked(readDirectSupplyExitQuote).mockResolvedValue(quote as never)
    await readHolderExitAssessment(clients, input)
    expect(readDirectSupplyExitQuote).toHaveBeenCalledWith(
      clients.direct,
      {
        routeKey: input.routeKey,
        destinationAddress: input.destinationAddress,
        owner: input.owner,
        assetsRaw: input.assetsRaw,
      },
      expect.any(Function),
      undefined,
      {},
    )
  })
  it('rejects a cross-route pin before any executor call', async () => {
    const other = DIRECT_SUPPLY_MARKETS.compoundV3Usdc
    await expect(
      readHolderExitAssessment(
        clients,
        { ...input, routeKey: other.routeKey, destinationAddress: other.destination },
        { directFinalizedBlock: pin },
      ),
    ).rejects.toThrow('holder_exit_source_pin_invalid')
    expect(readDirectSupplyExitQuote).not.toHaveBeenCalled()
  })
  it.each([
    { ...pin, blockNumber: ['26139351'] },
    { ...pin, blockHash: [pin.blockHash] },
    { ...pin, blockNumber: 9007199254740992n },
    { ...pin, mode: 'client_finalized' },
  ])('rejects malformed internal pin case %#', async (invalid) => {
    await expect(
      readHolderExitAssessment(clients, input, { directFinalizedBlock: invalid } as never),
    ).rejects.toThrow('holder_exit_source_pin_invalid')
    expect(readDirectSupplyExitQuote).not.toHaveBeenCalled()
  })
})
