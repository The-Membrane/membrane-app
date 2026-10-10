import { describe, expect, it } from 'vitest'

import {
  checkOtherVaultAssetIdentity,
  otherVaultIdentityCount,
} from '@/lib/carry/otherVaultAssetIdentities'
import manifest from '@/lib/carry/other-vault-asset-identities.json'
import seed from '@/scripts/route-cohort/aug-2026-ab-vault-seed.json'

describe('independent August vault asset identities', () => {
  it('covers eleven exact vaults, including the two route uses of Fluid Lite USD', () => {
    expect(otherVaultIdentityCount()).toBe(11)
    const seeded = new Map(
      seed.positions.map((position) => [position.vault.toLowerCase(), position]),
    )
    for (const entry of manifest.entries) {
      expect(seeded.has(entry.vault)).toBe(true)
      expect(checkOtherVaultAssetIdentity(entry.vault, entry.asset)).toMatchObject({
        asset: entry.asset,
        match: true,
      })
    }
    const liteRoutes = new Set(
      seed.positions
        .filter(
          (position) =>
            position.vault.toLowerCase() === '0x273da948aca9261043fbdb2a857bc255ecc29012',
        )
        .flatMap((position) => position.routeIds),
    )
    expect(liteRoutes.has('USDT → FluidBridgeAggregatorProxy [USDC]')).toBe(true)
    expect(liteRoutes.has('USDC → FluidBridgeAggregatorProxy [USDC]')).toBe(true)
  })

  it('fails closed when a current asset differs', () => {
    expect(
      checkOtherVaultAssetIdentity(
        '0xd166337499e176bbc38a1fbd113ab144e5bd2df7',
        '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
      ),
    ).toMatchObject({ match: false, exitMechanics: 'async_queue' })
    expect(
      checkOtherVaultAssetIdentity(
        '0x4f827a63755855cdf3e8f3bcd20265c833f15033',
        '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
      ),
    ).toMatchObject({ match: true, exitMechanics: 'cooldown_required' })
    expect(
      checkOtherVaultAssetIdentity(
        '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc',
        '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      ),
    ).toMatchObject({ match: true })
    expect(
      checkOtherVaultAssetIdentity(
        '0x0af56afbddcb140323445bd7211ba90e54e5fd1c',
        '0x59bc9fae5d62b19d4f8d07d758047acb9ee19d34',
      ),
    ).toMatchObject({ match: true, evidenceKind: 'verified_deployed_source' })
  })
})
