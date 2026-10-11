import identities from './morpho-v2-asset-identities.json'
import {
  morphoV2PinnedProtocolHistory,
  MORPHO_V2_PROTOCOL_CAPACITY_HISTORY_PIN,
} from './morphoV2ProtocolCapacityHistoryPins'

// Metadata selection only. Raw replay remains a separate server responsibility.
// No payload approval flag, profile clone or caller configuration creates authority.
declare const trustedProfileBrand: unique symbol
type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T
type ProfileMetadata = {
  id: string
  subject: {
    routeKey: string
    destination: string
    asset: string
    assetDecimals: number
    shareDecimals: number
  }
  configured: {
    adapter: string
    morpho: string
    irm: string
    marketId: string
    liquidityData: string
    allocationIds: string[]
  }
  runtimeIdentities: {
    key: string
    codeHash: string
    proxyInspection: string
    implementationAddress: null
    implementationCodeHash: null
  }[]
  nativeHistory: {
    schema: string
    index?: { path: string; sha256: string }
    references: { path: string; sha256: string; schema?: string }[]
    captureReceiptSha256?: string
    qualification: {
      semantics: string
      fixedSharesRaw: string | null
      originalOwner: string | null
      olderPastOwnerProven: false
      anchors: {
        role?: string
        chainId: number
        blockNumber: string | number
        blockHash: string
        blockTime: string
      }[]
    }
  }
  claims: {
    sourceImplementationEquivalence: false
    executionValidated: false
    calibratedProbability: false
    forecastValidated: false
    liveAttached: false
  }
}
export type MorphoV2TrustedProfile = DeepReadonly<ProfileMetadata> & {
  readonly [trustedProfileBrand]: true
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
const claims = {
  sourceImplementationEquivalence: false,
  executionValidated: false,
  calibratedProbability: false,
  forecastValidated: false,
  liveAttached: false,
} as const
const usdcHistory = morphoV2PinnedProtocolHistory()
const usdc: ProfileMetadata = {
  id: 'morpho_v2_usdc_reviewed_protocol_history',
  subject: { ...usdcHistory.subject },
  configured: structuredClone(usdcHistory.configured),
  runtimeIdentities: structuredClone(usdcHistory.runtimeIdentities),
  nativeHistory: {
    schema: 'morpho_v2_adapter_capacity_capture_v1',
    references: [
      {
        path: 'data/research/venue-signals/morpho-v2-protocol-capacity-history-pilot-2026-10-07T15-32.frame.json',
        sha256: MORPHO_V2_PROTOCOL_CAPACITY_HISTORY_PIN.frameSha256,
      },
      {
        path: 'data/research/venue-signals/morpho-v2-adapter-capacity-pilot-2026-10-07T15-32.json',
        sha256: MORPHO_V2_PROTOCOL_CAPACITY_HISTORY_PIN.rawFileSha256,
      },
    ],
    captureReceiptSha256: MORPHO_V2_PROTOCOL_CAPACITY_HISTORY_PIN.captureReceiptSha256,
    qualification: {
      semantics: 'protocol_prongs_only_no_same_S_historical_Ea_quotes',
      fixedSharesRaw: null,
      originalOwner: null,
      olderPastOwnerProven: false,
      anchors: usdcHistory.history.points.map((point) => ({ ...point.source })),
    },
  },
  claims,
}
// Reviewed static projection from the USDT 03-plan and externally pinned native
// archive index. Large plans/receipts are paths and pins, never browser imports.
const usdt: ProfileMetadata = {
  id: 'morpho_v2_usdt_reviewed_joint_history',
  subject: {
    routeKey: 'USDT → VaultV2 [USDT]',
    destination: '0x23f5e9c35820f4bab695ac1f19c203cc3f8e1e11',
    asset: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    assetDecimals: 6,
    shareDecimals: 18,
  },
  configured: {
    adapter: '0x6c5d5d47a39fe9f8ca14731a9a42bd31d64fb40d',
    morpho: '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb',
    irm: '0x870ac11d48b15db9a138cf899d20f13f79ba00bc',
    marketId: '0x26b178d49895f80ca3c39b2745efc4cd9adcddfcc73dae93e531e86977ec4d96',
    liquidityData:
      '0x000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec7000000000000000000000000a3931d71877c0e7a3148cb7eb4463524fec27fbd0000000000000000000000001c7dbd66df93594ba08af8e72c75ba2004d92f9c000000000000000000000000870ac11d48b15db9a138cf899d20f13f79ba00bc0000000000000000000000000000000000000000000000000d645e6320408000',
    allocationIds: [
      '0xae24ee5060e52617daf39855191a6b07eb5921e80260e655a7948b507fa3956c',
      '0xfd9acd163f0d4649924d505d13bfcd4c89dbd19a2dd51654859a1b1a5249773a',
      '0x2a766077cb5f8efbbaab5ed8266e66ffa66693facf33c1e36a09910cc921c542',
    ],
  },
  runtimeIdentities: [
    {
      key: 'vault',
      codeHash: '0xd3e8fb4da2e312d233b8bf884a7e5f4f4fa8bdd4531dcaa4448791251a1b1f5a',
      proxyInspection: 'unknown_direct_or_custom',
      implementationAddress: null,
      implementationCodeHash: null,
    },
    {
      key: 'asset',
      codeHash: '0xb44fb4e949d0f78f87f79ee46428f23a2a5713ce6fc6e0beb3dda78c2ac1ea55',
      proxyInspection: 'unknown_direct_or_custom',
      implementationAddress: null,
      implementationCodeHash: null,
    },
    {
      key: 'adapter',
      codeHash: '0xa5811d7f90c98bef56c5570cb5c724c34e594aad7af2b7b690082158567b7542',
      proxyInspection: 'unknown_direct_or_custom',
      implementationAddress: null,
      implementationCodeHash: null,
    },
    {
      key: 'blue',
      codeHash: '0xfa259fa317198f88f5fa3c119f06c066295dbcd47d715e0a30e1bcf94c02ef8c',
      proxyInspection: 'unknown_direct_or_custom',
      implementationAddress: null,
      implementationCodeHash: null,
    },
    {
      key: 'irm',
      codeHash: '0x73b578a0cd95d0d6e77f85a3945a670a9b8679670f8fc190ca97e89a1f07f6cd',
      proxyInspection: 'unknown_direct_or_custom',
      implementationAddress: null,
      implementationCodeHash: null,
    },
  ],
  nativeHistory: {
    schema: 'morpho_usdt_joint_history_native_archive_index_v1',
    index: {
      path: 'data/research/venue-signals/morpho-usdt-joint-history-evidence-2026-10-08/evidence-index.json',
      sha256: '86502ec749eeffd2336344fdc2eebb2e5c6752f28a1bf8f0901943bf8cbf8b7b',
    },
    references: [
      {
        path: 'data/research/venue-signals/morpho-usdt-joint-history-evidence-2026-10-08/seed-aug24-25/plan.json',
        sha256: 'edd9b9cc6194b9155452408c354ed99b02d568f9ae04a32e5d6a91a202f50e9f',
        schema: 'morpho_usdt_prior_history_32_prongs_fixed_plan_v1',
      },
      {
        path: 'data/research/venue-signals/morpho-usdt-joint-history-evidence-2026-10-08/seed-aug24-25/accepted-receipt.json',
        sha256: '615a5763bf6d85a71c84a0c6734c48d073b106b5d3b7ffd37288efe781e1c5e0',
      },
      {
        path: 'data/research/venue-signals/morpho-usdt-joint-history-evidence-2026-10-08/aug26-27/plan.json',
        sha256: '9a4fc4b9231df97b24561bdaacaecc7067724b0de77706a4345fab93677b1d7a',
        schema: 'morpho_usdt_prior_history_32_prongs_fixed_plan_v1',
      },
      {
        path: 'data/research/venue-signals/morpho-usdt-joint-history-evidence-2026-10-08/aug26-27/accepted-receipt.json',
        sha256: 'c5b1a7e852abea043c3de73dd9633d86b07ea534641092e2ecdd8e45bf72314d',
      },
      {
        path: 'data/research/venue-signals/morpho-usdt-joint-history-evidence-2026-10-08/aug28-29/plan.json',
        sha256: 'ee2cff0ffa2ba35d01534ca03e8521968089f491ee710872de62d8852ee5fd54',
        schema: 'morpho_usdt_prior_history_32_prongs_fixed_plan_v1',
      },
      {
        path: 'data/research/venue-signals/morpho-usdt-joint-history-evidence-2026-10-08/aug28-29/accepted-receipt.json',
        sha256: '656648c20752ebdb659d03230c675ce7818f1b63cb95bf3681d0325e43f9f46b',
      },
      {
        path: 'data/research/venue-signals/morpho-usdt-joint-history-evidence-2026-10-08/aug30/plan.json',
        sha256: 'a98d988f8921bce5c1a742361ffaaa3a320373a675a7454a452ff424c28b3a6c',
        schema: 'morpho_usdt_prior_history_32_prongs_fixed_plan_v1',
      },
      {
        path: 'data/research/venue-signals/morpho-usdt-joint-history-evidence-2026-10-08/aug30/accepted-receipt.json',
        sha256: '3ee31cdfc6fdfa45d3787662f5ff43bd8bb5001b4d4a7adba953f95b5f6151f4',
      },
    ],
    qualification: {
      semantics: 'hypothetical_native_previewRedeem_same_original_full_S_at_older_anchors',
      fixedSharesRaw: '10437267800221756345625',
      originalOwner: '0x9d0c15f186be64ab0e9bf579d091be2c3b0c1eac',
      olderPastOwnerProven: false,
      anchors: [
        {
          role: 'history',
          chainId: 1,
          blockNumber: 25828483,
          blockHash: '0x45e78487511b3b9a431e516e784de488c8315cc4315c33acfdba8a8926988f81',
          blockTime: '2026-08-24T23:59:59.000Z',
        },
        {
          role: 'history',
          chainId: 1,
          blockNumber: 25835657,
          blockHash: '0x8643113fc704a773c275b8fa53084941e5db67ff9a35336602e691ee56d75e5a',
          blockTime: '2026-08-25T23:59:59.000Z',
        },
        {
          role: 'history',
          chainId: 1,
          blockNumber: 25842829,
          blockHash: '0x94aad9c666f9e74404dc80662127154cef6bb0cc9b28e583b20cd2108154aa55',
          blockTime: '2026-08-26T23:59:59.000Z',
        },
        {
          role: 'history',
          chainId: 1,
          blockNumber: 25850009,
          blockHash: '0x69999ae658e1c3d736f9f883896d37709cf633ba3d9cc48e0efa693c639ce522',
          blockTime: '2026-08-27T23:59:59.000Z',
        },
        {
          role: 'history',
          chainId: 1,
          blockNumber: 25857181,
          blockHash: '0xefb45989f13d48f0a7953da6db003a8676241949531189b69cd25543b6ebc6a2',
          blockTime: '2026-08-28T23:59:59.000Z',
        },
        {
          role: 'history',
          chainId: 1,
          blockNumber: 25864358,
          blockHash: '0x372e0f63f0ff0efb4fc4566a26e9ff27e03ee0b5ddfb3506f2fcea208809b9cf',
          blockTime: '2026-08-29T23:59:59.000Z',
        },
        {
          role: 'history',
          chainId: 1,
          blockNumber: 25871535,
          blockHash: '0xd28e5051104d6f578ddde8d76a17300bc6f0d3a2b31e36d5a6844bd66aa87e5b',
          blockTime: '2026-08-30T23:59:59.000Z',
        },
      ],
    },
  },
  claims: {
    sourceImplementationEquivalence: false,
    executionValidated: false,
    calibratedProbability: false,
    forecastValidated: false,
    liveAttached: false,
  },
}

// Observed protocol metadata only. Research S=1e18 and zero captured owner
// shares do not establish a current holder entitlement or historical ownership.
// Native archive paths and source pins belong to the server adapter.
const ausd: ProfileMetadata = {
  id: 'morpho_v2_ausd_observed_protocol_history',
  subject: {
    routeKey: 'AUSD \u2192 VaultV2 [AUSD]',
    destination: '0x32401b9fb79065bc15949de0bd43927492f02f0c',
    asset: '0x00000000efe302beaa2b3e6e1b18d08d69a9012a',
    assetDecimals: 6,
    shareDecimals: 18,
  },
  configured: {
    adapter: '0xa8f4330c0f834bbf1a332fad40bdcca28b5f18bf',
    morpho: '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb',
    irm: '0x870ac11d48b15db9a138cf899d20f13f79ba00bc',
    marketId: '0x13bf541e28081feeaea6f7894e2a9e7e3fae09f3bef554aeecba013020ef88ef',
    liquidityData:
      '0x00000000000000000000000000000000efe302beaa2b3e6e1b18d08d69a9012a0000000000000000000000000b2b2b2076d95dda7817e785989fe353fe955ef90000000000000000000000003eba81c6fce96c106843f893fd60e288af7a362e000000000000000000000000870ac11d48b15db9a138cf899d20f13f79ba00bc0000000000000000000000000000000000000000000000000cb2bba6f17b8000',
    allocationIds: [
      '0x7290aedda9609e3576c88ae58d1e52c9af8bb4cd9efd572197231d861cd4eb33',
      '0xac30d3dcc7d09d4afc67c1345b1a911ca144e38deba909b49b9657f12321aadf',
      '0xf501557a0ceb6589f0d209179e4459e3fdae923055e15a34de2d231271fc950d',
    ],
  },
  runtimeIdentities: [
    {
      key: 'vault',
      codeHash: '0xa1c249850fed77a482699b5414c432b9bf23b61fc4efe991488c936568a1f87d',
      proxyInspection: 'runtime_observed_no_deployed_source_equivalence',
      implementationAddress: null,
      implementationCodeHash: null,
    },
    {
      key: 'asset',
      codeHash: '0x4d91c4f4b6c82a4802d641b9f0698ff096beb3d4c4028a3b25b0d92aab2fc51e',
      proxyInspection: 'runtime_observed_no_deployed_source_equivalence',
      implementationAddress: null,
      implementationCodeHash: null,
    },
    {
      key: 'adapter',
      codeHash: '0xb917a1983885cef6f90c4b8bfc98f3359f3ff201ab1330a7ee47cb5630686194',
      proxyInspection: 'runtime_observed_no_deployed_source_equivalence',
      implementationAddress: null,
      implementationCodeHash: null,
    },
    {
      key: 'blue',
      codeHash: '0xfa259fa317198f88f5fa3c119f06c066295dbcd47d715e0a30e1bcf94c02ef8c',
      proxyInspection: 'runtime_observed_no_deployed_source_equivalence',
      implementationAddress: null,
      implementationCodeHash: null,
    },
    {
      key: 'irm',
      codeHash: '0x73b578a0cd95d0d6e77f85a3945a670a9b8679670f8fc190ca97e89a1f07f6cd',
      proxyInspection: 'runtime_observed_no_deployed_source_equivalence',
      implementationAddress: null,
      implementationCodeHash: null,
    },
  ],
  nativeHistory: {
    schema: 'morpho_v2_multi_asset_observed_protocol_history_v1',
    references: [],
    qualification: {
      semantics: 'protocol_prongs_only_research_S_is_not_holder_entitlement',
      fixedSharesRaw: null,
      originalOwner: null,
      olderPastOwnerProven: false,
      anchors: [
        {
          chainId: 1,
          blockNumber: '26100913',
          blockHash: '0x2fe9266ceaaea215d32a4c5e0701f3c287705f2b976844cf3131534a814aa272',
          blockTime: '2026-10-01T23:59:59.000Z',
        },
        {
          chainId: 1,
          blockNumber: '26108081',
          blockHash: '0x9f430d0cc4301a9f8ea0315223c2ed6e66373f6454baac771cac7449d725ba37',
          blockTime: '2026-10-02T23:59:59.000Z',
        },
      ],
    },
  },
  claims: {
    sourceImplementationEquivalence: false,
    executionValidated: false,
    calibratedProbability: false,
    forecastValidated: false,
    liveAttached: false,
  },
}

const eurcv: ProfileMetadata = {
  id: 'morpho_v2_eurcv_observed_protocol_history',
  subject: {
    routeKey: 'EURCV \u2192 VaultV2 [EURCV]',
    destination: '0xbeef0c075da5d01112ae5cf34d257074fb5ddb2f',
    asset: '0x5f7827fdeb7c20b443265fc2f40845b715385ff2',
    assetDecimals: 18,
    shareDecimals: 18,
  },
  configured: {
    adapter: '0x5e3aca36fe2361e1866752ad74cb429f64cdcf1a',
    morpho: '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb',
    irm: '0x870ac11d48b15db9a138cf899d20f13f79ba00bc',
    marketId: '0x82053fe2fc3a3d6cb856458948e9c3589e76f20f3a2079606739b517587267ce',
    liquidityData:
      '0x0000000000000000000000005f7827fdeb7c20b443265fc2f40845b715385ff2000000000000000000000000cbb7c0000ab88b473b1f5afd9ef808440eed33bf000000000000000000000000ba75fd248bf33d669d4c5adf25d3e32779656e47000000000000000000000000870ac11d48b15db9a138cf899d20f13f79ba00bc0000000000000000000000000000000000000000000000000bef55718ad60000',
    allocationIds: [
      '0x84978ece5c7c80eb480e7fba2aa63569500d42dd3631e099ed9051cd7b3cd1ea',
      '0x13ff47043c4f28ff9eb52ff2a760b64b77707c842acabb83558f6415c9cb4797',
      '0xcd47d3134574f1195745ace11b26538c2ff452a186fc3b175a422fc000918686',
    ],
  },
  runtimeIdentities: [
    {
      key: 'vault',
      codeHash: '0x2e630a46febc2ccfef2b5c23cba80915a1972d8600157dd860402dd43482a6aa',
      proxyInspection: 'runtime_observed_no_deployed_source_equivalence',
      implementationAddress: null,
      implementationCodeHash: null,
    },
    {
      key: 'asset',
      codeHash: '0x5e4dcb0bb1910f6429e5fe91678990088a51c6d1cfe1b31d05fb9d948cc7867c',
      proxyInspection: 'runtime_observed_no_deployed_source_equivalence',
      implementationAddress: null,
      implementationCodeHash: null,
    },
    {
      key: 'adapter',
      codeHash: '0xf0caa51fdc8a2d8ed6d69704ad9f37ef6d6bd85bb25fc9a082b63b2d54e09f89',
      proxyInspection: 'runtime_observed_no_deployed_source_equivalence',
      implementationAddress: null,
      implementationCodeHash: null,
    },
    {
      key: 'blue',
      codeHash: '0xfa259fa317198f88f5fa3c119f06c066295dbcd47d715e0a30e1bcf94c02ef8c',
      proxyInspection: 'runtime_observed_no_deployed_source_equivalence',
      implementationAddress: null,
      implementationCodeHash: null,
    },
    {
      key: 'irm',
      codeHash: '0x73b578a0cd95d0d6e77f85a3945a670a9b8679670f8fc190ca97e89a1f07f6cd',
      proxyInspection: 'runtime_observed_no_deployed_source_equivalence',
      implementationAddress: null,
      implementationCodeHash: null,
    },
  ],
  nativeHistory: {
    schema: 'morpho_v2_multi_asset_observed_protocol_history_v1',
    references: [],
    qualification: {
      semantics: 'protocol_prongs_only_research_S_is_not_holder_entitlement',
      fixedSharesRaw: null,
      originalOwner: null,
      olderPastOwnerProven: false,
      anchors: [
        {
          chainId: 1,
          blockNumber: '26100913',
          blockHash: '0x2fe9266ceaaea215d32a4c5e0701f3c287705f2b976844cf3131534a814aa272',
          blockTime: '2026-10-01T23:59:59.000Z',
        },
        {
          chainId: 1,
          blockNumber: '26108081',
          blockHash: '0x9f430d0cc4301a9f8ea0315223c2ed6e66373f6454baac771cac7449d725ba37',
          blockTime: '2026-10-02T23:59:59.000Z',
        },
      ],
    },
  },
  claims: {
    sourceImplementationEquivalence: false,
    executionValidated: false,
    calibratedProbability: false,
    forecastValidated: false,
    liveAttached: false,
  },
}

const link: ProfileMetadata = {
  id: 'morpho_v2_link_observed_protocol_history',
  subject: {
    routeKey: 'LINK \u2192 VaultV2 [LINK]',
    destination: '0x610f5b68bd1eed68af649a3fd3dc2caa1ee4ae7e',
    asset: '0x514910771af9ca656af840dff83e8264ecf986ca',
    assetDecimals: 18,
    shareDecimals: 18,
  },
  configured: {
    adapter: '0xd237ccbda4606fd866f82f23417fe05e8e0345bc',
    morpho: '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb',
    irm: '0x870ac11d48b15db9a138cf899d20f13f79ba00bc',
    marketId: '0x987134eb4716fc3dee2cb9ca8d8fba692389f7e43c717db4fe0cedaf287816e9',
    liquidityData:
      '0x000000000000000000000000514910771af9ca656af840dff83e8264ecf986ca000000000000000000000000911d86c72155c33993d594b0ec7e6206b4c803da000000000000000000000000833b6db67987ac248d4bd1195b91dd953e6db6d1000000000000000000000000870ac11d48b15db9a138cf899d20f13f79ba00bc0000000000000000000000000000000000000000000000000cb2bba6f17b8000',
    allocationIds: [
      '0x1d9f150bbb105c36efd2843d83722f87048246f800ebf5d1996885304b31e2a2',
      '0x09aeb1d0e74b62a2564cbd21f125073bc57c1be82cc7156b6a7018bb7ccf4f2f',
      '0xcfca92d07506358d69e55fe3bfe108065b9222f2bce531eb85771a46ed0bc163',
    ],
  },
  runtimeIdentities: [
    {
      key: 'vault',
      codeHash: '0xcddbd3f6937d03a42eb201dc2194697b082b3e26162c55f84fcd06d231781967',
      proxyInspection: 'runtime_observed_no_deployed_source_equivalence',
      implementationAddress: null,
      implementationCodeHash: null,
    },
    {
      key: 'asset',
      codeHash: '0x77c633ba07c8cb94cd4864092fd8b31e31cf9d065f6fb6acf617298bc0008785',
      proxyInspection: 'runtime_observed_no_deployed_source_equivalence',
      implementationAddress: null,
      implementationCodeHash: null,
    },
    {
      key: 'adapter',
      codeHash: '0x599e3f77fdbcc502d987014b2362140968827a4110daea4616c89ce4d97c721c',
      proxyInspection: 'runtime_observed_no_deployed_source_equivalence',
      implementationAddress: null,
      implementationCodeHash: null,
    },
    {
      key: 'blue',
      codeHash: '0xfa259fa317198f88f5fa3c119f06c066295dbcd47d715e0a30e1bcf94c02ef8c',
      proxyInspection: 'runtime_observed_no_deployed_source_equivalence',
      implementationAddress: null,
      implementationCodeHash: null,
    },
    {
      key: 'irm',
      codeHash: '0x73b578a0cd95d0d6e77f85a3945a670a9b8679670f8fc190ca97e89a1f07f6cd',
      proxyInspection: 'runtime_observed_no_deployed_source_equivalence',
      implementationAddress: null,
      implementationCodeHash: null,
    },
  ],
  nativeHistory: {
    schema: 'morpho_v2_multi_asset_observed_protocol_history_v1',
    references: [],
    qualification: {
      semantics: 'protocol_prongs_only_research_S_is_not_holder_entitlement',
      fixedSharesRaw: null,
      originalOwner: null,
      olderPastOwnerProven: false,
      anchors: [
        {
          chainId: 1,
          blockNumber: '26100913',
          blockHash: '0x2fe9266ceaaea215d32a4c5e0701f3c287705f2b976844cf3131534a814aa272',
          blockTime: '2026-10-01T23:59:59.000Z',
        },
        {
          chainId: 1,
          blockNumber: '26108081',
          blockHash: '0x9f430d0cc4301a9f8ea0315223c2ed6e66373f6454baac771cac7449d725ba37',
          blockTime: '2026-10-02T23:59:59.000Z',
        },
      ],
    },
  },
  claims: {
    sourceImplementationEquivalence: false,
    executionValidated: false,
    calibratedProbability: false,
    forecastValidated: false,
    liveAttached: false,
  },
}

const profiles = [usdc, usdt, ausd, eurcv, link].map(
  (profile) => freeze(profile) as MorphoV2TrustedProfile,
)
const trustedInstances = new WeakSet<object>(profiles)
const canonicalAddress = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value)

/** Exact app-owned subject selection; destination and asset must be canonical lowercase. */
export function resolveMorphoV2TrustedProfile(
  routeKey: unknown,
  destination: unknown,
  asset: unknown,
): MorphoV2TrustedProfile | null {
  if (typeof routeKey !== 'string' || !canonicalAddress(destination) || !canonicalAddress(asset))
    return null
  return (
    profiles.find(
      (profile) =>
        profile.subject.routeKey === routeKey &&
        profile.subject.destination === destination &&
        profile.subject.asset === asset &&
        identities.entries.some(
          (identity) => identity.vault === destination && identity.asset === asset,
        ),
    ) ?? null
  )
}

/** Identity of a private registered instance; even an exact serialized clone is metadata only. */
export function isAppOwnedMorphoV2TrustedProfile(value: unknown): value is MorphoV2TrustedProfile {
  return value !== null && typeof value === 'object' && trustedInstances.has(value)
}
