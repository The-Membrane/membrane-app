// Static application policy: archived native runtime identities, authenticated cash
// headers. Matching unsigned claims does not establish original capture authority.
export type FluidUsdcBridgeJointTrustedProfile = {
  profileId: string
  routeKey: string
  destination: string
  asset: string
  assetDecimals: 6
  shareDecimals: 18
  feeBps: 5
  maxHistoricalGapSeconds: 91800
  runtimeCodeHashes: Readonly<Record<string, string>>
  originHosts: readonly string[]
  anchors: readonly {
    cashIndex: number
    source: {
      chainId: 1
      blockNumber: number
      blockHash: string
      blockTime: string
      finalized: true
    }
  }[]
}
const freeze = <T>(v: T): T => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze)
    Object.freeze(v)
  }
  return v
}
const PROFILE: FluidUsdcBridgeJointTrustedProfile = freeze({
  profileId: 'fluid-usdc-bridge-native-six-runtimes-sept21-oct2-v1',
  routeKey: 'USDC → FluidBridgeAggregatorProxy [USDC]',
  destination: '0x273da948aca9261043fbdb2a857bc255ecc29012',
  asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  assetDecimals: 6,
  shareDecimals: 18,
  feeBps: 5,
  maxHistoricalGapSeconds: 91800,
  originHosts: ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'],
  runtimeCodeHashes: {
    '0x273da948aca9261043fbdb2a857bc255ecc29012':
      '0xe271f71213f15998e1d3d3a5bec2ae0ca9d0e217a9b4467b3aa0d3b386e2394b',
    '0xe16ccc91a8134d428e7b6240177f9e2b227b9743':
      '0x2156d45a268d405a90e3b7ae68fb2a5e8635b2e767da5307f90883118cad06ef',
    '0x9fb7b4477576fe5b32be4c1843afb1e55f251b33':
      '0x131b2014b67d86e5a1fcd6be7b6817b76ae9ac1663266f88366e526666297828',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
      '0xd80d4b7c890cb9d6a4893e6b52bc34b56b25335cb13716e0d1d31383e6b41505',
    '0x52aa899454998be5b000ad077a46bbe360f4e497':
      '0xb3a458c72a3a0b3aa773f2c3e21d0eadfb06dacdc4568f447d9019d1c1451c35',
    '0xca13a15de31235a37134b4717021c35a3cf25c60':
      '0x829e8cee7a7e6ab662ef024f33dc249ab3e2cf2f5029dd6ecf3607068985c04c',
  },
  anchors: [
    {
      cashIndex: 108,
      source: {
        chainId: 1,
        blockNumber: 26029315,
        blockHash: '0x065f2c6e83a394e43d5d044d5318a644db87f62f654156dd7e950817e17ad711',
        blockTime: '2026-09-21T23:59:59.000Z',
        finalized: true,
      },
    },
    {
      cashIndex: 109,
      source: {
        chainId: 1,
        blockNumber: 26036463,
        blockHash: '0x90c9091979457d268afed15d3cf334ed6079e70d4fbec1291a98a313f57c91dc',
        blockTime: '2026-09-22T23:59:59.000Z',
        finalized: true,
      },
    },
    {
      cashIndex: 110,
      source: {
        chainId: 1,
        blockNumber: 26043610,
        blockHash: '0xbd28e7ee4e2d775b0b083daa61386acad8ecb4b85a9462cd2b306ce68fbf0e88',
        blockTime: '2026-09-23T23:59:59.000Z',
        finalized: true,
      },
    },
    {
      cashIndex: 111,
      source: {
        chainId: 1,
        blockNumber: 26050748,
        blockHash: '0x1d7b814c6ba082c73ca37825ba61db84d02984f1f767b114fddecd55456ba269',
        blockTime: '2026-09-24T23:59:59.000Z',
        finalized: true,
      },
    },
    {
      cashIndex: 112,
      source: {
        chainId: 1,
        blockNumber: 26057904,
        blockHash: '0xbb95ecc279a68df05a23fe4537046f3d4c129535059f55399293791370e20fb6',
        blockTime: '2026-09-25T23:59:59.000Z',
        finalized: true,
      },
    },
    {
      cashIndex: 113,
      source: {
        chainId: 1,
        blockNumber: 26065069,
        blockHash: '0xb4e0fe4909fd2d5628301ab0483cb6c7f0dd30ffaa661d8fd888510ff3757998',
        blockTime: '2026-09-26T23:59:59.000Z',
        finalized: true,
      },
    },
    {
      cashIndex: 114,
      source: {
        chainId: 1,
        blockNumber: 26072221,
        blockHash: '0x2680b61b94bf2651ac4603f6d93b5b2815f515f81d4a3077e65103f0fc82dc14',
        blockTime: '2026-09-27T23:59:59.000Z',
        finalized: true,
      },
    },
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
    {
      cashIndex: 119,
      source: {
        chainId: 1,
        blockNumber: 26108081,
        blockHash: '0x9f430d0cc4301a9f8ea0315223c2ed6e66373f6454baac771cac7449d725ba37',
        blockTime: '2026-10-02T23:59:59.000Z',
        finalized: true,
      },
    },
  ],
})
export function resolveFluidUsdcBridgeJointTrustedProfile(
  routeKey: unknown,
  destination: unknown,
  asset: unknown,
): FluidUsdcBridgeJointTrustedProfile | null {
  return routeKey === PROFILE.routeKey &&
    destination === PROFILE.destination &&
    asset === PROFILE.asset
    ? PROFILE
    : null
}
