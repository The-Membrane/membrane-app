/** Browser-safe metadata for the zero-adapter family. Registration is not execution authority. */
declare const idleProfileBrand: unique symbol
type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T
export type MorphoV2IdleSource = Readonly<{
  chainId: 1; blockNumber: string; blockHash: string; blockTime: string; finalized: true
}>
export type MorphoV2IdleIdentity = Readonly<{
  profileId: string; routeKey: string; destination: string; asset: string
  assetDecimals: number; shareDecimals: number
}>
export const MORPHO_V2_IDLE_CLAIMS = Object.freeze({
  researchOnly: true, authenticated: false, originalAuthority: false,
  historicalOwnership: false, historicalOwnedEntitlementMeasured: false,
  currentWalletControl: false, profileApproval: false, sourceImplementationEquivalence: false,
  holderExecutableExit: false, forecastEligibility: false, executionAuthority: false,
  forecastAuthority: false, calibrated: false, calibratedProbability: false,
  coveragePromotion: false, competingMRaw: null, MRaw: null,
} as const)
type Metadata = {
  id: string; familyKind: 'zero_adapter_idle'; identity: MorphoV2IdleIdentity
  configured: { liquidityAdapter: string; liquidityData: '0x' }
  runtimes: { vault: { bytes: number; codeHash: string }; asset: { bytes: number; codeHash: string } }
  history: {
    nativeDirectory: string; terminalFileSha256: string; reportFileSha256: string
    kind: 'pyusd_companion_v2' | 'rlusd_acceptance_v1'; nativeFiles: number; nativeBytes: number
    capsule: { bytes: number; sha256: string }; compactPanel: boolean
    normalization?: { directory: string; manifestSha256: string; factsSha256: string; rootReadbackSha256: string }
    companionDirectory: string; companionManifestSha256: string
    captureOwner: string; captureSharesRaw: string; verifiedReplayCompletedAtUtc: string | null
    historyAvailableAtUtc?: string; captureAvailableAtUtc?: string; rootNormalizationCompletedAtUtc?: string; independentReplayCompletedAtUtc?: null
    anchors: [MorphoV2IdleSource, MorphoV2IdleSource]
  }
  claims: typeof MORPHO_V2_IDLE_CLAIMS
}
export type MorphoV2IdleTrustedProfile = DeepReadonly<Metadata> & { readonly [idleProfileBrand]: true }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
const pyusd = freeze({
  id: 'morpho_v2_pyusd_b576_observed_idle_history', familyKind: 'zero_adapter_idle',
  identity: {
    profileId: 'morpho_v2_pyusd_b576_observed_idle_history', routeKey: 'PYUSD → VaultV2 [PYUSD]',
    destination: '0xb576765fb15505433af24fee2c0325895c559fb2',
    asset: '0x6c3ea9036406852006290770bedfcaba0e23a0e8', assetDecimals: 6, shareDecimals: 18,
  },
  configured: { liquidityAdapter: '0x0000000000000000000000000000000000000000', liquidityData: '0x' },
  runtimes: {
    vault: { bytes: 21808, codeHash: '0xd40a644ba3984c98bcffa15709271ecedf2ff7632d763fad84d7f924bd4f6acd' },
    asset: { bytes: 1506, codeHash: '0xbc22d0b1173d9ff26383e64a50a807afa931a2809a7b6bae3b051723a1a9ebe1' },
  },
  history: {
    nativeDirectory: 'data/research/venue-signals/pyusd-b576-idle-history-v2-2026-10-10T05-29-29.760Z-b9d9aa95-5eec-4e5d-92af-fd6b4d3d6091',
    terminalFileSha256: '37773ac59805072fc8b625bb15d199bf9e14f2a679e528629db1a50f4116360a',
    reportFileSha256: '09f5619b3f07d62a22bf56fb6732a6b4f0a7c6dc91f0781452372ed8d5cbc136',
    kind: 'pyusd_companion_v2', nativeFiles: 109, nativeBytes: 2335675,
    capsule: { bytes: 3926, sha256: '880b5424feaf11b8301bdbd560fde261999a31696acac7dccb039fbccc5ddfc6' }, compactPanel: true,
    companionDirectory: 'data/research/venue-signals/pyusd-b576-native-source-companion-2026-10-10-df9a74e4-df1d-4fa0-90b6-f8c46e19d1d4',
    companionManifestSha256: '6365044aa4e7814602d5ed499ff335d0a6b0d371ee0f56887486e41dbd66e25d',
    captureOwner: '0xf181e2cc93a47cb4903ac71c23ecb873726dc668', captureSharesRaw: '352805058661206444',
    verifiedReplayCompletedAtUtc: '2026-10-10T05:30:32.512Z',
    anchors: [
      { chainId: 1, blockNumber: '26100913', blockHash: '0x2fe9266ceaaea215d32a4c5e0701f3c287705f2b976844cf3131534a814aa272', blockTime: '2026-10-01T23:59:59.000Z', finalized: true },
      { chainId: 1, blockNumber: '26108081', blockHash: '0x9f430d0cc4301a9f8ea0315223c2ed6e66373f6454baac771cac7449d725ba37', blockTime: '2026-10-02T23:59:59.000Z', finalized: true },
    ],
  },
  claims: MORPHO_V2_IDLE_CLAIMS,
}) as unknown as MorphoV2IdleTrustedProfile
const rlusd = freeze({
  'id': 'rlusd-vault-v2-idle',
  'familyKind': 'zero_adapter_idle',
  'identity': {
    'profileId': 'rlusd-vault-v2-idle',
    'routeKey': 'RLUSD → VaultV2 [RLUSD]',
    'destination': '0x6dc58a0fdfc8d694e571dc59b9a52eeea780e6bf',
    'asset': '0x8292bb45bf1ee4d140127049757c2e0ff06317ed',
    'assetDecimals': 18,
    'shareDecimals': 18
  },
  'configured': {
    'liquidityAdapter': '0x0000000000000000000000000000000000000000',
    'liquidityData': '0x'
  },
  'runtimes': {
    'vault': {
      'bytes': 21808,
      'codeHash': '0x0b10d3ab9979405d0970771ee305d10e8c62ea4afd94a6176a7db3ecd97dfd9a'
    },
    'asset': {
      'bytes': 238,
      'codeHash': '0x23fd38dfee1f350e13b663717d03529920d67bb8f2582203b4b29b1e0bfd06b7'
    }
  },
  'history': {
    'nativeDirectory': 'data/research/venue-signals/morpho-v2-rlusd-idle-holder-capture-v1-2026-10-10T11-08-57.571Z-e1af086c-7e72-438f-bdf9-e33288db883e',
    'terminalFileSha256': 'e99907118fd622241bf3247bd313bb9f35d44168157ab81acdf002bdc8ca5bda',
    'reportFileSha256': '4eb38c922a8373f0aeb38e1a1dcb6e7a4f52b0e38380a27b60293e447fb59422',
    'kind': 'rlusd_acceptance_v1',
    'nativeFiles': 103,
    'nativeBytes': 1218251,
    'capsule': {
      'bytes': 4070,
      'sha256': '0c29a49b536f0948a2510b36e843996ed3eaf116653735ced57d66e8c81b9753'
    },
    'compactPanel': false,
    normalization: {'directory': 'data/research/venue-signals/rlusd-original-normalization-parent-acceptance-2026-10-10-be2d85c1-6a6f-4d85-8668-df16f95cbbc6', 'manifestSha256': '7d3428fd7d78ec283237dc33287d460e57a4e0feb94a573628b8395bf61be3e2', 'factsSha256': '331aa58c97ec974dc54b12f6763b9381d24b9840d7bcc176ff3e5cd3105fcaea', 'rootReadbackSha256': '330058d15bbe521fd2eb7b9e4856c66e521c1c364d804fef9103d250ef7da9b3'},
    'companionDirectory': 'data/research/venue-signals/morpho-v2-rlusd-parent-acceptance-2026-10-10-b095f724-549b-4b14-acdc-37618f5c7275',
    'companionManifestSha256': '4cbbb38337023d2212f250349c8e2bc12ff2e77205e5cf7f56b62847171127a0',
    'captureOwner': '0xe837770fc477522360cf620bc15ba34cb9e4a6d0',
    'captureSharesRaw': '3479286870294737294548835',
    'verifiedReplayCompletedAtUtc': null,
    'historyAvailableAtUtc': '2026-10-10T12:03:15.201Z',
    'captureAvailableAtUtc': '2026-10-10T11:09:11.001Z',
    'rootNormalizationCompletedAtUtc': '2026-10-10T12:03:15.201Z',
    'independentReplayCompletedAtUtc': null,
    'anchors': [
      {
        'chainId': 1,
        'blockNumber': '26100913',
        'blockHash': '0x2fe9266ceaaea215d32a4c5e0701f3c287705f2b976844cf3131534a814aa272',
        'blockTime': '2026-10-01T23:59:59.000Z',
        'finalized': true
      },
      {
        'chainId': 1,
        'blockNumber': '26108081',
        'blockHash': '0x9f430d0cc4301a9f8ea0315223c2ed6e66373f6454baac771cac7449d725ba37',
        'blockTime': '2026-10-02T23:59:59.000Z',
        'finalized': true
      }
    ]
  },
  claims: MORPHO_V2_IDLE_CLAIMS,
}) as unknown as MorphoV2IdleTrustedProfile
const profiles = [pyusd, rlusd] as const
const instances = new WeakSet<object>(profiles)
/** Exact tuple selection only; other PYUSD vaults and allocated profiles stay separate. */
export function resolveMorphoV2IdleTrustedProfile(routeKey: unknown, destination: unknown, asset: unknown): MorphoV2IdleTrustedProfile | null {
  return profiles.find(profile => routeKey === profile.identity.routeKey && destination === profile.identity.destination && asset === profile.identity.asset) ?? null
}
export function isAppOwnedMorphoV2IdleTrustedProfile(value: unknown): value is MorphoV2IdleTrustedProfile {
  return value !== null && typeof value === 'object' && instances.has(value)
}
