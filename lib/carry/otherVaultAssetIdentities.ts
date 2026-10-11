import manifest from './other-vault-asset-identities.json'

const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/

export type OtherVaultExitMechanics = 'async_queue' | 'cooldown_required' | 'unassessed'
export type OtherVaultIdentityEvidence = {
  asset: string
  evidenceKind:
    | 'official_deployment_documentation'
    | 'fluid_factory_computed_and_listed'
    | 'verified_deployed_source'
  evidenceUrl: string
  exitMechanics: OtherVaultExitMechanics
}

const vaultAssetIdentities = new Map<string, OtherVaultIdentityEvidence>()

if (
  manifest.schemaVersion !== 1 ||
  manifest.chainId !== 1 ||
  manifest.cohortId !== 'aug-2026-ab-vault-routes' ||
  manifest.entries.length !== 11
) {
  throw new Error('other_vault_asset_identity_manifest_invalid')
}

for (const entry of manifest.entries) {
  if (
    !ADDRESS.test(entry.vault) ||
    !ADDRESS.test(entry.asset) ||
    vaultAssetIdentities.has(entry.vault) ||
    !entry.evidenceUrl.startsWith('https://') ||
    !['async_queue', 'cooldown_required', 'unassessed'].includes(entry.exitMechanics) ||
    ![
      'official_deployment_documentation',
      'fluid_factory_computed_and_listed',
      'verified_deployed_source',
    ].includes(entry.evidenceKind)
  ) {
    throw new Error('other_vault_asset_identity_entry_invalid')
  }
  if (entry.evidenceKind === 'fluid_factory_computed_and_listed') {
    if (
      entry.factory !== '0x54b91a0d94cb471f37f949c60f7fa7935b551d03' ||
      entry.verificationBlock !== 26079829 ||
      !HASH.test(entry.verificationBlockHash ?? '')
    ) {
      throw new Error('other_vault_factory_evidence_invalid')
    }
  }
  if (entry.evidenceKind === 'verified_deployed_source') {
    if (
      entry.vault !== '0x0af56afbddcb140323445bd7211ba90e54e5fd1c' ||
      entry.asset !== '0x59bc9fae5d62b19d4f8d07d758047acb9ee19d34' ||
      entry.implementation !== '0x41695d3304e38bc806f077a3541c5cd34f8f034b' ||
      entry.aToken !== '0x01e69a58ca3ddc695820ce6f66fbdf3fa55d0545' ||
      entry.verificationBlock !== 26080019 ||
      entry.verificationBlockHash !==
        '0xcba995492763cfa851b8de0ceabaf5fab922887d52eb5ee05a05c88c3332366e'
    ) {
      throw new Error('other_vault_deployed_source_evidence_invalid')
    }
  }
  vaultAssetIdentities.set(entry.vault, {
    asset: entry.asset,
    evidenceKind: entry.evidenceKind as OtherVaultIdentityEvidence['evidenceKind'],
    evidenceUrl: entry.evidenceUrl,
    exitMechanics: entry.exitMechanics as OtherVaultExitMechanics,
  })
}

/** Historical cohort membership is separate; this only checks the vault's recorded asset(). */
export function checkOtherVaultAssetIdentity(vault: string, observedAsset: string) {
  const evidence = vaultAssetIdentities.get(vault.toLowerCase())
  if (!evidence) return null
  return {
    ...evidence,
    match: evidence.asset === observedAsset.toLowerCase(),
  }
}

export function otherVaultIdentityCount() {
  return vaultAssetIdentities.size
}
