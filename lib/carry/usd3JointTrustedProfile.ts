// App-owned reviewed historical metadata. This profile never authenticates unsigned evidence.
type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T
export type Usd3JointHistorySource = {
  chainId: 1
  blockNumber: number
  blockHash: string
  blockTime: string
  finalized: true
}
export type Usd3JointTrustedProfile = DeepReadonly<{
  id: 'usd3_joint_reviewed_native_history_v1'
  subject: {
    routeKey: string
    destination: string
    asset: string
    assetDecimals: 6
    shareDecimals: 6
  }
  runtimePins: { key: string; address: string; runtimeKeccak256: string }[]
  implementationSlot: string
  originHosts: string[]
  anchors: { cashIndex: number; source: Usd3JointHistorySource }[]
  originalBodySha256: string
  originalPlanSha256: string
  sourceImplementationEquivalence: false
}>
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
// Derived from independently archived 02-replayed-native-points.json, not a caller label.
const profile: Usd3JointTrustedProfile = freeze({
  id: 'usd3_joint_reviewed_native_history_v1',
  subject: {
    routeKey: 'USDC → USD3 [USDC]',
    destination: '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc',
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    assetDecimals: 6,
    shareDecimals: 6,
  },
  runtimePins: [
    {
      key: 'proxy_code',
      address: '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc',
      runtimeKeccak256: '0x555d07c74ed2459adbfda78d1aeac6dbaa8a9d1cfa4aeff7a469ac7338a57486',
    },
    {
      key: 'implementation_code',
      address: '0xd1f1c3f485063712873285bf4ef25ab068f13893',
      runtimeKeccak256: '0x2ecb24776c995e6504a108076a64380a8013318f748cf775ebebe79f1c64fc0c',
    },
    {
      key: 'delegate_code',
      address: '0xd377919fa87120584b21279a491f82d5265a139c',
      runtimeKeccak256: '0x15b3018d50c4988a5e21fdc9e87e7f9ace4789a4514a6235c93ff8657b952239',
    },
    {
      key: 'asset_code',
      address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      runtimeKeccak256: '0xd80d4b7c890cb9d6a4893e6b52bc34b56b25335cb13716e0d1d31383e6b41505',
    },
  ],
  implementationSlot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  originHosts: ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'],
  anchors: [
    {
      cashIndex: 115,
      source: {
        chainId: 1,
        blockNumber: 26079396,
        blockHash: '0x31868801c3f7242338e7f191929032c3fc9387e9ec07ace2c0264f13c7914bae',
        blockTime: '2026-09-28T23:59:59.000Z',
        finalized: true,
      },
    },
    {
      cashIndex: 116,
      source: {
        chainId: 1,
        blockNumber: 26086569,
        blockHash: '0x47f2ef87e05d0a9f6d4f9cc1c47cfa504b8dc94bb1a52a8b8f778a409328c250',
        blockTime: '2026-09-29T23:59:59.000Z',
        finalized: true,
      },
    },
    {
      cashIndex: 117,
      source: {
        chainId: 1,
        blockNumber: 26093737,
        blockHash: '0xcd26204e996dceb606ccf0bc6f5bf8ea6747a471df8be73b5855f01624d5d743',
        blockTime: '2026-09-30T23:59:59.000Z',
        finalized: true,
      },
    },
    {
      cashIndex: 118,
      source: {
        chainId: 1,
        blockNumber: 26100913,
        blockHash: '0x2fe9266ceaaea215d32a4c5e0701f3c287705f2b976844cf3131534a814aa272',
        blockTime: '2026-10-01T23:59:59.000Z',
        finalized: true,
      },
    },
  ],
  originalBodySha256: '5a60236ecbc570c51a35768d3f7ea4bc57b726393d0946f36a670d93a878427b',
  originalPlanSha256: '5d5ecf4b5b5d8a70fa356154eab23fb512ace6503877b259da95fe281257f60b',
  sourceImplementationEquivalence: false,
})
export function resolveUsd3JointTrustedProfile(
  routeKey: string,
  destination: string,
  asset: string,
): Usd3JointTrustedProfile | null {
  return routeKey === profile.subject.routeKey &&
    destination === profile.subject.destination &&
    asset === profile.subject.asset
    ? profile
    : null
}
