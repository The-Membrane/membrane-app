import { describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'

import type { HolderExitAssessment } from '@/lib/carry/holderExitAssessment'
import { buildHolderExitCapacityQuote, resolveHolderExitCapacitySubject } from '@/lib/carry/holderExitCapacity'
import {
  agreeMorphoV2NativeCapacity,
  bindMorphoV2NativeHolderAssessment,
  carryMorphoV2NativeHolderAssessment,
  completeMorphoV2NativeHolderObservation,
  readMorphoV2NativeHolderAtSource,
  resolveMorphoV2NativeHolderIdentity,
} from '@/lib/carry/morphoV2NativeHolderIdentity.server'
import { resolveMorphoV2TrustedProfile } from '@/lib/carry/morphoV2TrustedProfiles'
import identities from '@/lib/carry/morpho-v2-asset-identities.json'
import seed from '@/scripts/route-cohort/aug-2026-ab-vault-seed.json'

const NOW = Date.parse('2026-10-11T12:00:00.000Z')
const OWNER = '0x0000000000000000000000000000000000000001' as const
const UNKNOWN = '0x069662d2588fcac24b5c209456db965d151556f0' as const
const ROUTE = 'USDC → VaultV2 [USDC]'
const ASSET = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const
const SOURCE = { chainId: 1 as const, blockNumber: 26_200_000,
  blockHash: `0x${'a'.repeat(64)}` as `0x${string}`,
  blockTime: new Date(NOW - 60_000).toISOString(), finalized: true as const }
const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`

async function origin(options: { routeKey?: string; destination?: Address; asset?: Address;
  assetDecimals?: number; shareDecimals?: number; requestedRaw?: string; unitFault?: 'noncanonical' | 'wrong_source' | 'wrong_call' | 'wrong_asset' } = {}) {
  const routeKey = options.routeKey ?? ROUTE, destination = options.destination ?? UNKNOWN,
    asset = options.asset ?? ASSET, assetDecimals = options.assetDecimals ?? 6,
    shareDecimals = options.shareDecimals ?? 9, requestedRaw = options.requestedRaw ?? '1000000'
  const calls: unknown[] = []
  const client = { request: async ({ params }: { params: [{ to: string; data: string }, { blockHash: string; requireCanonical: true }] }) => {
    calls.push(structuredClone(params))
    const [{ to, data }] = params
    if (data === '0x38d52e0f') return word(BigInt(options.unitFault === 'wrong_asset' ? OWNER : asset))
    if (data === '0x313ce567') {
      if (options.unitFault === 'noncanonical') return '0x06'
      if (options.unitFault === 'wrong_source') params[1].blockHash = `0x${'b'.repeat(64)}`
      if (options.unitFault === 'wrong_call') params[0].to = OWNER
      return word(BigInt(to === asset ? assetDecimals : shareDecimals))
    }
    if (data.startsWith('0x70a08231')) return word(1000000000n)
    if (data.startsWith('0x4cdad506')) return word(9000000000n)
    throw new Error('unexpected_mock_rpc')
  } }
  const receipt = await readMorphoV2NativeHolderAtSource(client as never,
    { routeKey, destination, owner: OWNER, source: structuredClone(SOURCE) }, () => NOW - 3)
  const observation = completeMorphoV2NativeHolderObservation(receipt, NOW - 4, NOW - 1)!
  const a: HolderExitAssessment = {
    status: 'assessed', routeKey, destinationAddress: destination, owner: OWNER,
    request: { assetsRaw: requestedRaw, assetAddress: asset, horizonHours: 24 },
    source: { ...SOURCE, originValidation: 'single_provider' },
    stages: [{ name: 'withdrawal', status: 'reverted', relatedToRequest: true,
      assetAddress: asset, amountRaw: requestedRaw }],
    finalPayout: { status: 'unassessed', assetAddress: asset, amountRaw: null },
    forecast: { status: 'unvalidated', futureExit: null, exitDurationHours: null, prospectiveValidated: false },
    morphoHolderPositionObservation: observation,
  }
  a.capacityQuote = buildHolderExitCapacityQuote(a, { entitlementRaw: receipt.fullEaRaw,
    quotedMaxWithdrawRaw: null, quotedMaxWithdrawStatus: 'not_read', effectiveLimitRaw: null,
    withdrawalsPaused: null, sourceHolderPosition: { sharesRaw: receipt.sharesRaw,
      shareDecimals: receipt.shareDecimals, method: 'balance_of_owner_at_source' } }, NOW)!
  bindMorphoV2NativeHolderAssessment(a)
  return { assessment: a, receipt, client, calls }
}
async function pair() {
  const first = await origin(), second = await origin()
  return { first, second }
}
function agreement(first: HolderExitAssessment, second: HolderExitAssessment, asOfMs = NOW) {
  return agreeMorphoV2NativeCapacity({ host: 'one.example', assessment: first },
    { host: 'two.example', assessment: second }, asOfMs)
}

// These are synthetic current native reads, never live chain or future capacity evidence.
describe('Morpho required native holder identity independent of rich profiles', () => {
  it('keeps unknown-profile S and quoted Ea, with actual native units instead of share 18', async () => {
    expect(resolveMorphoV2TrustedProfile(ROUTE, UNKNOWN, ASSET)).toBeNull()
    const { first, second } = await pair(), capacity = agreement(first.assessment, second.assessment)!
    expect(resolveMorphoV2NativeHolderIdentity(first.assessment, second.assessment, capacity)).toEqual({
      routeKey: ROUTE, destination: UNKNOWN, asset: ASSET, assetDecimals: 6, shareDecimals: 9,
    })
    expect(capacity.quote).toMatchObject({ entitlementRaw: '9000000000', requestedRaw: '1000000',
      sourceHolderPosition: { sharesRaw: '1000000000', shareDecimals: 9 },
      holderExecutableExit: false, forecastValidated: false, futureCapacityValidated: false })
    expect(first.calls).toHaveLength(5)
    expect(Object.isFrozen(first.client)).toBe(false)
  })

  it('resolves every factory subject using registry units and independently observed share units', async () => {
    expect(identities.entries).toHaveLength(49)
    const destinations = new Set<string>()
    for (const [index, identity] of identities.entries.entries()) {
      const destination = identity.vault as Address
      expect(destinations.has(destination.toLowerCase())).toBe(false)
      destinations.add(destination.toLowerCase())
      const routeKeys = [...new Set(seed.positions
        .filter((entry) => entry.vault.toLowerCase() === destination.toLowerCase())
        .flatMap((entry) => entry.routeIds))]
        .filter((routeKey) => resolveHolderExitCapacitySubject(routeKey, destination) !== null)
      expect(routeKeys).toHaveLength(1)
      const routeKey = routeKeys[0], asset = identity.asset as Address,
        subject = resolveHolderExitCapacitySubject(routeKey, destination)!,
        assetDecimals = subject.canonicalFinalAsset!.decimals,
        shareDecimals = index % 37
      expect(subject.canonicalFinalAsset!.address.toLowerCase()).toBe(asset.toLowerCase())
      const first = await origin({ routeKey, destination, asset, assetDecimals, shareDecimals }),
        second = await origin({ routeKey, destination, asset, assetDecimals, shareDecimals }),
        capacity = agreement(first.assessment, second.assessment)!
      expect(capacity).not.toBeNull()
      expect(resolveMorphoV2NativeHolderIdentity(first.assessment, second.assessment, capacity))
        .toMatchObject({ routeKey, destination, asset, assetDecimals, shareDecimals })
    }
    expect(destinations.size).toBe(49)
  })

  it('rejects agreeing forged objects, copied receipts, and a new unapproved assessment reference', async () => {
    const { first, second } = await pair()
    const a = structuredClone(first.assessment), b = structuredClone(second.assessment)
    bindMorphoV2NativeHolderAssessment(a); bindMorphoV2NativeHolderAssessment(b)
    const metadataOnly = agreement(a, b)!
    expect(metadataOnly).not.toBeNull()
    expect(resolveMorphoV2NativeHolderIdentity(a, b, metadataOnly)).toBeNull()
    expect(completeMorphoV2NativeHolderObservation({ ...first.receipt }, NOW - 4, NOW - 1)).toBeNull()
    const copied = { ...first.assessment }
    bindMorphoV2NativeHolderAssessment(copied)
    expect(resolveMorphoV2NativeHolderIdentity(copied, second.assessment, metadataOnly)).toBeNull()
  })

  it('cannot rebind coherently edited Q on an already issued assessment reference', async () => {
    const { first, second } = await pair()
    for (const { assessment: a } of [first, second]) {
      a.request.assetsRaw = '2'
      a.capacityQuote!.requestedRaw = '2'
      bindMorphoV2NativeHolderAssessment(a)
    }
    const edited = agreement(first.assessment, second.assessment)!
    expect(edited).not.toBeNull()
    expect(resolveMorphoV2NativeHolderIdentity(first.assessment, second.assessment, edited)).toBeNull()

    // A genuine fresh source matching Q cannot transfer over either occupied target.
    const matching = await origin({ requestedRaw: '2' })
    carryMorphoV2NativeHolderAssessment(matching.assessment, first.assessment)
    bindMorphoV2NativeHolderAssessment(first.assessment)
    expect(resolveMorphoV2NativeHolderIdentity(first.assessment, second.assessment, edited)).toBeNull()
  })

  it.each(['native issuance', 'optional copy'] as const)(
    'cannot reassociate an occupied %s target after replacing its model and observation', async (issuance) => {
      const source = await origin(), peer = await origin(),
        original = await origin({ requestedRaw: '2', shareDecimals: 18 })
      const target = issuance === 'native issuance' ? original.assessment
        : carryMorphoV2NativeHolderAssessment(original.assessment,
            { ...original.assessment, morphoV2ProtocolCapacityObservation: null })
      // Preserve the target object reference while replacing its visible tuple and raw observation.
      Object.assign(target, source.assessment)
      const metadata = agreement(target, peer.assessment)!
      expect(metadata).not.toBeNull()
      expect(resolveMorphoV2NativeHolderIdentity(target, peer.assessment, metadata)).toBeNull()
      carryMorphoV2NativeHolderAssessment(source.assessment, target)
      bindMorphoV2NativeHolderAssessment(target)
      carryMorphoV2NativeHolderAssessment(source.assessment, target)
      expect(resolveMorphoV2NativeHolderIdentity(target, peer.assessment, metadata)).toBeNull()
      expect(resolveMorphoV2NativeHolderIdentity(source.assessment, peer.assessment,
        agreement(source.assessment, peer.assessment)!)).not.toBeNull()
    },
  )

  it.each(['route', 'destination', 'asset', 'asset_units', 'share_units', 'source', 'owner', 'Q', 'S', 'Ea', 'rawtrace', 'clock'] as const)(
    'rejects coherent edits after issuance to both objects: %s', async (fault) => {
      const { first, second } = await pair()
      for (const { assessment: a } of [first, second]) {
        const q = a.capacityQuote!, o = a.morphoHolderPositionObservation!
        if (fault === 'route') { a.routeKey = q.routeKey = o.routeKey = 'USDT → VaultV2 [USDT]' }
        if (fault === 'destination') { a.destinationAddress = q.destination = o.destination = OWNER }
        if (fault === 'asset') { a.request.assetAddress = q.asset = o.asset = OWNER }
        if (fault === 'asset_units') { q.assetDecimals = o.assetDecimals = 18 }
        if (fault === 'share_units') { q.sourceHolderPosition!.shareDecimals = o.shareDecimals = 18 }
        if (fault === 'source') { a.source.blockHash = q.source.blockHash = o.source.blockHash = `0x${'b'.repeat(64)}` }
        if (fault === 'owner') { a.owner = q.owner = '0x0000000000000000000000000000000000000002' }
        if (fault === 'Q') { a.request.assetsRaw = q.requestedRaw = '2' }
        if (fault === 'S') { q.sourceHolderPosition!.sharesRaw = '2'; o.traces[0].result = word(2n) as `0x${string}` }
        if (fault === 'Ea') { q.entitlementRaw = '2'; o.traces[1].result = word(2n) as `0x${string}` }
        if (fault === 'rawtrace') { o.traces[0].params[0].data = '0x' }
        if (fault === 'clock') { o.readAtUtc = new Date(NOW + 1).toISOString() }
      }
      const capacity = agreement(first.assessment, second.assessment)
      expect(capacity && resolveMorphoV2NativeHolderIdentity(first.assessment, second.assessment, capacity)).toBeFalsy()
    },
  )

  it.each(['noncanonical', 'wrong_source', 'wrong_call', 'wrong_asset'] as const)(
    'rejects malformed or misbound actual native unit trace: %s', async (unitFault) => {
      await expect(origin({ unitFault })).rejects.toThrow()
    },
  )

  it('refuses to mint or select server receipt authority in a browser context', async () => {
    const { first, second } = await pair(), capacity = agreement(first.assessment, second.assessment)!
    vi.stubGlobal('window', {})
    try {
      expect(resolveMorphoV2NativeHolderIdentity(first.assessment, second.assessment, capacity)).toBeNull()
      expect(completeMorphoV2NativeHolderObservation(first.receipt, NOW - 4, NOW - 1)).toBeNull()
      await expect(origin()).rejects.toThrow('morpho_native_holder_identity_invalid')
    } finally { vi.unstubAllGlobals() }
  })

  it('permits only a verified optional-field copy and rejects stale source agreement', async () => {
    const { first, second } = await pair()
    const copied = carryMorphoV2NativeHolderAssessment(first.assessment,
      { ...first.assessment, morphoV2ProtocolCapacityObservation: null })
    const capacity = agreement(copied, second.assessment)!
    expect(resolveMorphoV2NativeHolderIdentity(copied, second.assessment, capacity)).not.toBeNull()
    expect(agreement(copied, second.assessment, NOW + 31 * 60_000)).toBeNull()
  })
})
