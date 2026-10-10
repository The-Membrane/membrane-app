import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import identities from '@/lib/carry/morpho-v2-asset-identities.json'
import { resolveIssuedHolderExitSubject } from '@/lib/carry/holderExitMechanisms'
import { morphoV2PinnedProtocolHistory } from '@/lib/carry/morphoV2ProtocolCapacityHistoryPins'
import {
  isAppOwnedMorphoV2TrustedProfile,
  resolveMorphoV2TrustedProfile,
} from '@/lib/carry/morphoV2TrustedProfiles'

const usdcKeys = [
  'USDC → VaultV2 [USDC]',
  '0x0026038a7fefef439d94bd99b4a10017e839d3a7',
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
] as const
const usdtKeys = [
  'USDT → VaultV2 [USDT]',
  '0x23f5e9c35820f4bab695ac1f19c203cc3f8e1e11',
  '0xdac17f958d2ee523a2206206994597c13d831ec7',
] as const

describe('app-owned Morpho V2 reviewed profile metadata', () => {
  it.each([usdcKeys, usdtKeys])(
    'matches a canonical issued subject and asset identity: %s',
    (...keys) => {
      const profile = resolveMorphoV2TrustedProfile(...keys)!
      expect(profile).not.toBeNull()
      expect(isAppOwnedMorphoV2TrustedProfile(profile)).toBe(true)
      const subject = resolveIssuedHolderExitSubject(keys[0], keys[1])!
      expect(subject).not.toBeNull()
      expect(subject.canonicalFinalAsset).toMatchObject({ address: keys[2], decimals: 6 })
      expect(
        identities.entries.some((entry) => entry.vault === keys[1] && entry.asset === keys[2]),
      ).toBe(true)
      expect(profile.subject).toMatchObject({ assetDecimals: 6, shareDecimals: 18 })
      expect(profile.runtimeIdentities.map((identity) => identity.key)).toEqual([
        'vault',
        'asset',
        'adapter',
        'blue',
        'irm',
      ])
      expect(profile.claims).toEqual({
        sourceImplementationEquivalence: false,
        executionValidated: false,
        calibratedProbability: false,
        forecastValidated: false,
        liveAttached: false,
      })
    },
  )

  it('derives USDC configuration and five runtime hashes from the shipped full frame', () => {
    const profile = resolveMorphoV2TrustedProfile(...usdcKeys)!
    const history = morphoV2PinnedProtocolHistory()
    expect(profile.subject).toEqual(history.subject)
    expect(profile.configured).toEqual(history.configured)
    expect(profile.runtimeIdentities).toEqual(history.runtimeIdentities)
    expect(profile.nativeHistory.qualification.fixedSharesRaw).toBeNull()
    expect(profile.nativeHistory.qualification.semantics).toBe(
      'protocol_prongs_only_no_same_S_historical_Ea_quotes',
    )
  })

  it('matches reviewed USDT plan configuration without claiming historical ownership or source equivalence', () => {
    const profile = resolveMorphoV2TrustedProfile(...usdtKeys)!
    const plan = JSON.parse(
      readFileSync(
        'data/research/venue-signals/morpho-usdt-protocol-prong-evidence-2026-10-08/03-plan.json',
        'utf8',
      ),
    )
    const { owner: _owner, ...subject } = plan.subject
    expect(profile.subject).toEqual(subject)
    for (const key of ['adapter', 'morpho', 'irm', 'marketId', 'liquidityData'] as const)
      expect(profile.configured[key]).toBe(plan.configured[key])
    expect(profile.configured.allocationIds).toEqual(plan.allocationIds)
    for (const identity of profile.runtimeIdentities)
      expect(identity.codeHash).toBe(plan.configured.runtimeHashes[identity.key])
    expect(profile.nativeHistory.qualification).toMatchObject({
      fixedSharesRaw: '10437267800221756345625',
      semantics: 'hypothetical_native_previewRedeem_same_original_full_S_at_older_anchors',
      olderPastOwnerProven: false,
    })
    expect(profile.nativeHistory.qualification.anchors).toHaveLength(7)
  })

  it.each([usdcKeys, usdtKeys])(
    'pins complete native history references outside browser imports: %s',
    (...keys) => {
      const profile = resolveMorphoV2TrustedProfile(...keys)!
      const refs = [...profile.nativeHistory.references]
      if (profile.nativeHistory.index) refs.push(profile.nativeHistory.index)
      for (const reference of refs) {
        const bytes = readFileSync(reference.path)
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(reference.sha256)
        if ('schema' in reference && reference.schema)
          expect(JSON.parse(bytes.toString('utf8')).schema).toBe(reference.schema)
      }
    },
  )

  it.each([
    [usdcKeys[0], usdtKeys[1], usdcKeys[2]],
    [usdtKeys[0], usdcKeys[1], usdtKeys[2]],
    [usdcKeys[0], usdcKeys[1], usdtKeys[2]],
    [usdtKeys[0], usdtKeys[1], usdcKeys[2]],
    ['unknown_protocol', usdcKeys[1], usdcKeys[2]],
    [usdcKeys[0], usdcKeys[1].toUpperCase(), usdcKeys[2]],
    [usdcKeys[0], usdcKeys[1], usdcKeys[2].toUpperCase()],
    [usdcKeys[0], null, usdcKeys[2]],
  ])('rejects cross-profile and noncanonical subject keys: %j', (route, destination, asset) => {
    expect(resolveMorphoV2TrustedProfile(route, destination, asset)).toBeNull()
  })

  it('does not promote other registered vaults, payload approval flags, clones or substitutions', () => {
    const other = identities.entries.find(
      (entry) => entry.asset === usdcKeys[2] && entry.vault !== usdcKeys[1],
    )!
    expect(resolveMorphoV2TrustedProfile(usdcKeys[0], other.vault, other.asset)).toBeNull()
    const profile = resolveMorphoV2TrustedProfile(...usdcKeys)!
    expect(isAppOwnedMorphoV2TrustedProfile(structuredClone(profile))).toBe(false)
    expect(isAppOwnedMorphoV2TrustedProfile({ ...profile, approved: true, trusted: true })).toBe(
      false,
    )
    for (const candidate of [
      { ...profile, subject: { ...profile.subject, assetDecimals: 18 } },
      { ...profile, subject: { ...profile.subject, shareDecimals: 6 } },
      { ...profile, configured: resolveMorphoV2TrustedProfile(...usdtKeys)!.configured },
      {
        ...profile,
        runtimeIdentities: resolveMorphoV2TrustedProfile(...usdtKeys)!.runtimeIdentities,
      },
    ])
      expect(isAppOwnedMorphoV2TrustedProfile(candidate)).toBe(false)
    expect(Object.isFrozen(profile)).toBe(true)
    expect(Object.isFrozen(profile.subject)).toBe(true)
    expect(Object.isFrozen(profile.runtimeIdentities[0])).toBe(true)
    expect(resolveMorphoV2TrustedProfile(...usdcKeys)).toBe(profile)
  })
})
