import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  readHolderExitAssessment,
  type HolderExitAssessment,
} from '@/lib/carry/holderExitAssessment'
import {
  agreeHolderExitCapacityQuotes,
  buildHolderExitCapacityQuote,
  selectedHolderExitCapacity,
  type HolderExitCapacityFacts,
} from '@/lib/carry/holderExitCapacity'
import { readMorphoExitQuote } from '@/lib/carry/morphoExitQuote'

vi.mock('@/lib/carry/morphoExitQuote', async (original) => ({
  ...(await original<typeof import('@/lib/carry/morphoExitQuote')>()),
  readMorphoExitQuote: vi.fn(),
}))

const NOW = Date.parse('2026-10-07T12:00:00.000Z')
const input = {
  routeKey: 'USDC → VaultV2 [USDC]',
  destinationAddress: '0x0026038a7fefef439d94bd99b4a10017e839d3a7' as const,
  owner: '0x0000000000000000000000000000000000000001' as const,
  assetsRaw: '1000000',
  horizonHours: 24,
  chainId: 1 as const,
}
const asset = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const
const source = {
  chainId: 1 as const,
  blockNumber: 26000000,
  blockHash: `0x${'a'.repeat(64)}` as `0x${string}`,
  blockTime: new Date(NOW - 60000).toISOString(),
  originValidation: 'single_provider' as const,
}
const sourceHolderPosition = {
  sharesRaw: '9000000000000000000000',
  shareDecimals: 18,
  method: 'balance_of_owner_at_source' as const,
}
function fixture() {
  const assessment: HolderExitAssessment = {
    status: 'assessed',
    routeKey: input.routeKey,
    destinationAddress: input.destinationAddress,
    owner: input.owner,
    request: { assetsRaw: input.assetsRaw, assetAddress: asset, horizonHours: 24 },
    source,
    stages: [
      {
        name: 'withdrawal',
        status: 'reverted',
        assetAddress: asset,
        amountRaw: input.assetsRaw,
        relatedToRequest: true,
      },
    ],
    finalPayout: { status: 'unassessed', assetAddress: asset, amountRaw: null },
    forecast: {
      status: 'unvalidated',
      futureExit: null,
      exitDurationHours: null,
      prospectiveValidated: false,
    },
  }
  const facts: HolderExitCapacityFacts = {
    entitlementRaw: '9000000000',
    quotedMaxWithdrawRaw: '2000000',
    quotedMaxWithdrawStatus: 'quoted',
    effectiveLimitRaw: null,
    withdrawalsPaused: null,
    sourceHolderPosition: { ...sourceHolderPosition },
  }
  return { assessment, facts }
}
function agree(first: unknown, second: unknown = first) {
  return agreeHolderExitCapacityQuotes(
    { host: 'one.example', quote: first },
    { host: 'two.example', quote: second },
    NOW,
  )
}
function binding(quote: NonNullable<ReturnType<typeof buildHolderExitCapacityQuote>>) {
  return {
    routeKey: input.routeKey,
    destination: input.destinationAddress,
    owner: input.owner,
    requestedRaw: quote.requestedRaw,
    asset,
    assetDecimals: 6,
    currentSource: quote.source,
    asOfMs: NOW,
  }
}

describe('Morpho native source holder position metadata', () => {
  afterEach(() => vi.restoreAllMocks())

  it('preserves native S and units when Q withdrawal simulation reverts, without extra reads', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    vi.mocked(readMorphoExitQuote).mockResolvedValueOnce({
      routeKey: input.routeKey,
      source,
      vault: {
        address: input.destinationAddress,
        assetAddress: asset,
        assetDecimals: 6,
        shareDecimals: 18,
      },
      position: {
        sharesRaw: sourceHolderPosition.sharesRaw,
        previewRedeemAssetsRaw: '9000000000',
        maxWithdrawQuote: { status: 'quoted', amountRaw: '2000000' },
      },
      request: { assetsRaw: input.assetsRaw },
      simulation: { status: 'evm_revert', reason: 'unknown_execution_constraint' },
    } as never)
    const request = vi.fn().mockResolvedValue('0x')
    const assessment = await readHolderExitAssessment({ morpho: { request } } as never, input, {
      includeCapacityFacts: true,
    })
    expect(assessment.stages[0].status).toBe('reverted')
    expect(assessment.capacityQuote).toMatchObject({
      sourceHolderPosition,
      entitlementRaw: '9000000000',
      requestedRaw: input.assetsRaw,
      successfulRequestedRawLowerBound: null,
      forecastValidated: false,
      holderExecutableExit: false,
      prospectiveValidated: false,
    })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith({
      method: 'eth_getCode',
      params: [input.owner, { blockHash: source.blockHash, requireCanonical: true }],
    })
  })

  it('keeps source S and full E independent of requested assets and request shares', () => {
    const { assessment, facts } = fixture()
    const first = buildHolderExitCapacityQuote(assessment, facts, NOW)!
    assessment.request.assetsRaw = '2000000'
    assessment.request.sharesRaw = '1'
    const second = buildHolderExitCapacityQuote(assessment, facts, NOW)!
    expect(first.sourceHolderPosition).toEqual(sourceHolderPosition)
    expect(second.sourceHolderPosition).toEqual(sourceHolderPosition)
    expect(second.entitlementRaw).toBe('9000000000')
    expect(second.requestedRaw).toBe('2000000')
    const agreement = agree(second)!
    expect(selectedHolderExitCapacity(agreement, binding(second))).toEqual(agreement)
  })

  it.each([
    { sharesRaw: '00' },
    { sharesRaw: '01' },
    { sharesRaw: '-1' },
    { sharesRaw: '+1' },
    { sharesRaw: '1.0' },
    { sharesRaw: ' 1' },
    { sharesRaw: '1e3' },
    { sharesRaw: (1n << 256n).toString() },
    { shareDecimals: -1 },
    { shareDecimals: 37 },
    { shareDecimals: 1.5 },
    { shareDecimals: '18' },
    { method: 'preview_redeem_full_position' },
    { extra: 'untrusted' },
    { sharesRaw: undefined },
  ])('rejects invalid nested metadata at construction and reconstruction: %j', (change) => {
    const { assessment, facts } = fixture()
    const quote = buildHolderExitCapacityQuote(assessment, facts, NOW)!
    const altered = { ...sourceHolderPosition, ...change }
    expect(
      buildHolderExitCapacityQuote(
        assessment,
        { ...facts, sourceHolderPosition: altered } as HolderExitCapacityFacts,
        NOW,
      ),
    ).toBeNull()
    expect(agree({ ...quote, sourceHolderPosition: altered })).toBeNull()
  })

  it.each([null, undefined, [], '9000', {}])(
    'rejects a present malformed position: %j',
    (position) => {
      const { assessment, facts } = fixture()
      expect(
        buildHolderExitCapacityQuote(
          assessment,
          { ...facts, sourceHolderPosition: position } as HolderExitCapacityFacts,
          NOW,
        ),
      ).toBeNull()
    },
  )

  it.each(['0', ((1n << 256n) - 1n).toString()])(
    'accepts canonical uint256 boundary S=%s',
    (sharesRaw) => {
      const { assessment, facts } = fixture()
      facts.sourceHolderPosition!.sharesRaw = sharesRaw
      const quote = buildHolderExitCapacityQuote(assessment, facts, NOW)!
      expect(quote.sourceHolderPosition!.sharesRaw).toBe(sharesRaw)
      expect(agree(quote)).not.toBeNull()
    },
  )

  it('requires exact cross-origin S, units and presence and rejects agreement metadata tampering', () => {
    const { assessment, facts } = fixture()
    const quote = buildHolderExitCapacityQuote(assessment, facts, NOW)!
    for (const position of [
      { ...sourceHolderPosition, sharesRaw: '1' },
      { ...sourceHolderPosition, shareDecimals: 6 },
    ])
      expect(agree(quote, { ...quote, sourceHolderPosition: position })).toBeNull()
    const { sourceHolderPosition: _position, ...legacy } = quote
    expect(agree(quote, legacy)).toBeNull()
    expect(agree(legacy, quote)).toBeNull()
    const agreement = agree(quote)!
    agreement.quote.sourceHolderPosition!.sharesRaw = '1'
    expect(selectedHolderExitCapacity(agreement, binding(quote))).toBeNull()
    expect(quote.sourceHolderPosition).toEqual(sourceHolderPosition)
  })

  it('keeps legacy absent-field quotes selectable without adding metadata or authority', () => {
    const { assessment, facts } = fixture()
    delete facts.sourceHolderPosition
    const quote = buildHolderExitCapacityQuote(assessment, facts, NOW)!
    expect(Object.hasOwn(quote, 'sourceHolderPosition')).toBe(false)
    const agreement = agree(quote)!
    expect(selectedHolderExitCapacity(agreement, binding(quote))).toEqual(agreement)
    expect(agreement.quote.forecastValidated).toBe(false)
    expect(agreement.quote.holderExecutableExit).toBe(false)
  })
})
