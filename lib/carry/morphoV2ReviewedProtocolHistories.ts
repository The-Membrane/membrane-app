import usdtFrame from '@/data/research/venue-signals/morpho-usdt-reviewed-protocol-history-2026-10-08.frame.json'
import type { MorphoV2HolderTimeProcessInput } from './morphoV2HolderTimeProcess'
import {
  approveMorphoV2PinnedProtocolHistory,
  morphoV2PinnedProtocolHistory,
  type MorphoV2Sha256Text,
} from './morphoV2ProtocolCapacityHistoryPins'
import {
  isAppOwnedMorphoV2TrustedProfile,
  type MorphoV2TrustedProfile,
} from './morphoV2TrustedProfiles'

export type ReviewedMorphoV2ProtocolSubject = {
  routeKey: string
  destination: string
  asset: string
  assetDecimals: number
  shareDecimals: number
}

export type ReviewedMorphoV2ProtocolEvidence = Omit<
  MorphoV2HolderTimeProcessInput['history'],
  'subject' | 'history'
> & { subject: ReviewedMorphoV2ProtocolSubject }

export type ReviewedMorphoV2ProtocolCurrent = ReviewedMorphoV2ProtocolEvidence &
  Pick<MorphoV2HolderTimeProcessInput['current'], 'point' | 'readAtUtc'>

/** Asset-neutral protocol replay adapter. The historical fixed-S native quotes
 * remain explicit qualification metadata, never additional current-schema prongs. */
export type ReviewedMorphoV2ProtocolHistory = ReviewedMorphoV2ProtocolEvidence & {
  history: MorphoV2HolderTimeProcessInput['history']['history']
  nativeQualification?: typeof usdtFrame.nativeQualification
  protocolOnlyQualification?: {
    semantics: 'protocol_prongs_only_research_S_is_not_holder_entitlement'
    researchSharesRaw: string
    capturedCurrentOwnerSharesRaw: '0'
    historicalOwner: null
    historicalPastOwnershipProven: false
    arbitraryShareScalingApproved: false
    currentHolderEntitlementApproved: false
    MRaw: null
    authenticated: false
    executionValidated: false
    calibratedProbability: false
    forecastValidated: false
    coveragePromotion: false
    knowledgeCutoffSemantics: 'parent_observed_post_terminal_retention'
    originalTerminalPostRetentionQualified: false
    parentObservedPostRetentionWithinDeadline: true
  }
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

function exact(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      Object.keys(a).length === a.length &&
      Object.keys(b).length === b.length &&
      Array.from({ length: a.length }, (_, index) => index).every(
        (index) => Object.hasOwn(a, index) && Object.hasOwn(b, index) && exact(a[index], b[index]),
      )
    )
  if ((a !== null && typeof a === 'object') || (b !== null && typeof b === 'object'))
    return (
      a !== null &&
      typeof a === 'object' &&
      b !== null &&
      typeof b === 'object' &&
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every(
        (key) =>
          Object.hasOwn(b, key) &&
          exact((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
      )
    )
  return Object.is(a, b)
}

const trustedUsdt = freeze(structuredClone(usdtFrame)) as ReviewedMorphoV2ProtocolHistory

// Small reviewed app projections, never raw archive imports. Their fixed frame
// digests approve exact observational inputs only; native acquisition authority
// remains a separate server byte-pin check. Historical research Ea is omitted.
const trustedObserved: Readonly<Record<string, ReviewedMorphoV2ProtocolHistory>> = freeze({
  morpho_v2_ausd_observed_protocol_history: {
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
    sourceImplementationEquivalence: false,
    captureReceiptSha256: '6cfa0fef5a6c98e830c578a3b8550288475e72913d18e04c1e80049524b87bce',
    knowledgeCutoff: '2026-10-09T09:36:52.274Z',
    history: {
      points: [
        {
          source: {
            chainId: 1,
            blockNumber: '26100913',
            blockHash: '0x2fe9266ceaaea215d32a4c5e0701f3c287705f2b976844cf3131534a814aa272',
            blockTime: '2026-10-01T23:59:59.000Z',
          },
          status: 'two_origin_conditional_configured_adapter_prongs',
          prongs: {
            idleCashRaw: '0',
            blueCashRaw: '2939865172563',
            market: [
              '4271752603571',
              '4221092470436169233',
              '3901925371184',
              '3849779799533459188',
              '1790857727',
              '0',
            ],
            internalSharesRaw: '4221091469436169233',
            actualSharesRaw: '4221091469436169233',
            allowanceRaw:
              '115792089237316195423570985008687907853269984665640564039457584007913129639935',
            allocationsRaw: ['4947740942485', '4271751590557', '4271751590557'],
            borrowRateRaw: '2170304548',
            feeRecipient: '0x0000000000000000000000000000000000000000',
          },
        },
        {
          source: {
            chainId: 1,
            blockNumber: '26108081',
            blockHash: '0x9f430d0cc4301a9f8ea0315223c2ed6e66373f6454baac771cac7449d725ba37',
            blockTime: '2026-10-02T23:59:59.000Z',
          },
          status: 'two_origin_conditional_configured_adapter_prongs',
          prongs: {
            idleCashRaw: '0',
            blueCashRaw: '2773718685421',
            market: [
              '4272440663158',
              '4221092470436169233',
              '3913593378709',
              '3860611250356868671',
              '1790938283',
              '0',
            ],
            internalSharesRaw: '4221091469436169233',
            actualSharesRaw: '4221091469436169233',
            allowanceRaw:
              '115792089237316195423570985008687907853269984665640564039457584007913129639935',
            allocationsRaw: ['4947740942485', '4271751590557', '4271751590557'],
            borrowRateRaw: '2334130526',
            feeRecipient: '0x0000000000000000000000000000000000000000',
          },
        },
      ],
      elapsedSeconds: [86400],
    },
    protocolOnlyQualification: {
      semantics: 'protocol_prongs_only_research_S_is_not_holder_entitlement',
      researchSharesRaw: '1000000000000000000',
      capturedCurrentOwnerSharesRaw: '0',
      historicalOwner: null,
      historicalPastOwnershipProven: false,
      arbitraryShareScalingApproved: false,
      currentHolderEntitlementApproved: false,
      MRaw: null,
      authenticated: false,
      executionValidated: false,
      calibratedProbability: false,
      forecastValidated: false,
      coveragePromotion: false,
      knowledgeCutoffSemantics: 'parent_observed_post_terminal_retention',
      originalTerminalPostRetentionQualified: false,
      parentObservedPostRetentionWithinDeadline: true,
    },
  },
  morpho_v2_eurcv_observed_protocol_history: {
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
    sourceImplementationEquivalence: false,
    captureReceiptSha256: 'da7fe7519f8e0f6cdecc69d4aaf5d45587c23526244f76d67171e21d6fccd8fc',
    knowledgeCutoff: '2026-10-09T09:38:30.246Z',
    history: {
      points: [
        {
          source: {
            chainId: 1,
            blockNumber: '26100913',
            blockHash: '0x2fe9266ceaaea215d32a4c5e0701f3c287705f2b976844cf3131534a814aa272',
            blockTime: '2026-10-01T23:59:59.000Z',
          },
          status: 'two_origin_conditional_configured_adapter_prongs',
          prongs: {
            idleCashRaw: '94096945261485740608998883',
            blueCashRaw: '4413775157731961092475072',
            market: [
              '13348311665561954013519873',
              '12951261467065868946656657507596',
              '11722579895087046540036147',
              '11332081141880147908782680090099',
              '1790897027',
              '0',
            ],
            internalSharesRaw: '12951260589872886489122977221334',
            actualSharesRaw: '12951260589872886489122977221334',
            allowanceRaw:
              '115792089237316195423570985008687907853269984665640564039457584007913129639935',
            allocationsRaw: [
              '36022093867702283834102654',
              '16299933614626369363185734',
              '13348271399318067954281509',
            ],
            borrowRateRaw: '599092167',
            feeRecipient: '0x0000000000000000000000000000000000000000',
          },
        },
        {
          source: {
            chainId: 1,
            blockNumber: '26108081',
            blockHash: '0x9f430d0cc4301a9f8ea0315223c2ed6e66373f6454baac771cac7449d725ba37',
            blockTime: '2026-10-02T23:59:59.000Z',
          },
          status: 'two_origin_conditional_configured_adapter_prongs',
          prongs: {
            idleCashRaw: '94777313035420091829586598',
            blueCashRaw: '4233334755572415530763413',
            market: [
              '13153714676904121331091573',
              '12761876625244449270352266459516',
              '11722840377398767480771093',
              '11331756710506150090735996003291',
              '1790981075',
              '0',
            ],
            internalSharesRaw: '12761875748051466814210849895310',
            actualSharesRaw: '12761875748051466814210849895310',
            allowanceRaw:
              '115792089237316195423570985008687907853269984665640564039457584007913129639935',
            allocationsRaw: [
              '35986762194187076744123269',
              '16105673251169625352362432',
              '13153680253635742302350041',
            ],
            borrowRateRaw: '604686899',
            feeRecipient: '0x0000000000000000000000000000000000000000',
          },
        },
      ],
      elapsedSeconds: [86400],
    },
    protocolOnlyQualification: {
      semantics: 'protocol_prongs_only_research_S_is_not_holder_entitlement',
      researchSharesRaw: '1000000000000000000',
      capturedCurrentOwnerSharesRaw: '0',
      historicalOwner: null,
      historicalPastOwnershipProven: false,
      arbitraryShareScalingApproved: false,
      currentHolderEntitlementApproved: false,
      MRaw: null,
      authenticated: false,
      executionValidated: false,
      calibratedProbability: false,
      forecastValidated: false,
      coveragePromotion: false,
      knowledgeCutoffSemantics: 'parent_observed_post_terminal_retention',
      originalTerminalPostRetentionQualified: false,
      parentObservedPostRetentionWithinDeadline: true,
    },
  },
  morpho_v2_link_observed_protocol_history: {
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
    sourceImplementationEquivalence: false,
    captureReceiptSha256: '89a037c787d48159a04706b8284d311872705666479ac8955e8556bb47bc0008',
    knowledgeCutoff: '2026-10-09T09:40:06.740Z',
    history: {
      points: [
        {
          source: {
            chainId: 1,
            blockNumber: '26100913',
            blockHash: '0x2fe9266ceaaea215d32a4c5e0701f3c287705f2b976844cf3131534a814aa272',
            blockTime: '2026-10-01T23:59:59.000Z',
          },
          status: 'two_origin_conditional_configured_adapter_prongs',
          prongs: {
            idleCashRaw: '0',
            blueCashRaw: '25543724855887933314156',
            market: [
              '137379429624556366527852',
              '131541739664646844539613522908',
              '111836953544617483762993',
              '106510742027186217027472767924',
              '1790888375',
              '0',
            ],
            internalSharesRaw: '66072272754091587024720715835',
            actualSharesRaw: '66072272754091587024720715835',
            allowanceRaw:
              '115792089237316195423570985008687907853269984665640562104292661968311416156610',
            allocationsRaw: [
              '68991450295946256502828',
              '68991450295946256502828',
              '68991450295946256502828',
            ],
            borrowRateRaw: '3395417324',
            feeRecipient: '0x0000000000000000000000000000000000000000',
          },
        },
        {
          source: {
            chainId: 1,
            blockNumber: '26108081',
            blockHash: '0x9f430d0cc4301a9f8ea0315223c2ed6e66373f6454baac771cac7449d725ba37',
            blockTime: '2026-10-02T23:59:59.000Z',
          },
          status: 'two_origin_conditional_configured_adapter_prongs',
          prongs: {
            idleCashRaw: '0',
            blueCashRaw: '25556444244788108654662',
            market: [
              '137424117599869358154844',
              '131556126970918995218530105916',
              '111868922131030300049479',
              '106510742027186217027472767924',
              '1790978255',
              '0',
            ],
            internalSharesRaw: '66024407747108619117101004350',
            actualSharesRaw: '66024407747108619117101004350',
            allowanceRaw:
              '115792089237316195423570985008687907853269984665640562104242661968311416156610',
            allocationsRaw: [
              '68969391115520446842237',
              '68969391115520446842237',
              '68969391115520446842237',
            ],
            borrowRateRaw: '3318237824',
            feeRecipient: '0x0000000000000000000000000000000000000000',
          },
        },
      ],
      elapsedSeconds: [86400],
    },
    protocolOnlyQualification: {
      semantics: 'protocol_prongs_only_research_S_is_not_holder_entitlement',
      researchSharesRaw: '1000000000000000000',
      capturedCurrentOwnerSharesRaw: '0',
      historicalOwner: null,
      historicalPastOwnershipProven: false,
      arbitraryShareScalingApproved: false,
      currentHolderEntitlementApproved: false,
      MRaw: null,
      authenticated: false,
      executionValidated: false,
      calibratedProbability: false,
      forecastValidated: false,
      coveragePromotion: false,
      knowledgeCutoffSemantics: 'parent_observed_post_terminal_retention',
      originalTerminalPostRetentionQualified: false,
      parentObservedPostRetentionWithinDeadline: true,
    },
  },
})
const observedFrameDigests: Readonly<Record<string, string>> = Object.freeze({
  morpho_v2_ausd_observed_protocol_history:
    '213dac6cd0ae3894b83ef60087fe64474cf155b39c8e34f8a48d2ce37ed2edaf',
  morpho_v2_eurcv_observed_protocol_history:
    '7fe790f8fc30ee5c4564e92ab8eb5bf2c649d4cda11e44fd51e79a1e761da227',
  morpho_v2_link_observed_protocol_history:
    'c55f91d04a572971b820ca5fbb409a7d096b085840a0d0af9332e03162404547',
})

/** Byte pins of reviewed native artifacts, independent from candidate payloads.
 * The aggregate receipt identifier is the combined offline replay body identity;
 * the four original captures keep separate byte/body pins and actual clocks. */
export const MORPHO_V2_USDT_REVIEWED_PROTOCOL_HISTORY_PIN = freeze({
  framePath:
    'data/research/venue-signals/morpho-usdt-reviewed-protocol-history-2026-10-08.frame.json',
  frameSha256: '098cac9ed3b7b766019cd8bfba24ace3b7f515b4f151b328eba48523f1749b1a',
  index: {
    path: 'data/research/venue-signals/morpho-usdt-joint-history-evidence-2026-10-08/evidence-index.json',
    sha256: '86502ec749eeffd2336344fdc2eebb2e5c6752f28a1bf8f0901943bf8cbf8b7b',
  },
  combinedReplay: {
    path: 'data/research/venue-signals/morpho-usdt-joint-history-evidence-2026-10-08/analysis/combined-replay.json',
    sha256: '665d7e7de957363178afd6c7e74c269ffe68e7425888dd9aab4d38df3fe3241a',
    bodySha256: '7676f3e72e96fb57ccc4d8f92e82df257b7bb13912518635ad7ff3455706a9b7',
  },
  parentArchiveVerification: {
    path: 'data/research/venue-signals/morpho-usdt-joint-history-evidence-2026-10-08/parent-archive-verification.json',
    sha256: '05e77340ff721cd8c529a31bd9a352013ce1375c436072a66e55208301828fae',
  },
  captureReceiptSemantics: 'combined_offline_replay_receipt_not_single_capture',
  fixedSharesRaw: '10437267800221756345625',
  semantics: 'hypothetical_native_previewRedeem_same_original_full_S_at_older_anchors',
  olderPastOwnerProven: false,
  arbitraryShareScalingApproved: false,
  currentHolderEntitlementApproved: false,
})

/** Retained original capture identities and clocks; historical research only. */
export const MORPHO_V2_USDT_REVIEWED_PROTOCOL_HISTORY_PROVENANCE = freeze(
  structuredClone(usdtFrame.nativeQualification.provenance),
)

function coherent(profile: MorphoV2TrustedProfile, history: ReviewedMorphoV2ProtocolHistory) {
  return (
    exact(profile.subject, history.subject) &&
    exact(profile.configured, history.configured) &&
    exact(profile.runtimeIdentities, history.runtimeIdentities)
  )
}

/** Selection requires the private registered profile instance. Each result is a
 * disposable clone; an API payload or serialized profile cannot select history. */
export function reviewedMorphoV2ProtocolHistory(
  profile: MorphoV2TrustedProfile,
): ReviewedMorphoV2ProtocolHistory | null {
  if (!isAppOwnedMorphoV2TrustedProfile(profile)) return null
  const history =
    profile.id === 'morpho_v2_usdc_reviewed_protocol_history'
      ? morphoV2PinnedProtocolHistory()
      : profile.id === 'morpho_v2_usdt_reviewed_joint_history'
        ? structuredClone(trustedUsdt)
        : Object.hasOwn(trustedObserved, profile.id)
          ? structuredClone(trustedObserved[profile.id])
          : null
  return history && coherent(profile, history) ? history : null
}

/** Approval covers the exact complete fixed frame and its external literal pin.
 * It approves reviewed historical input only, never native authentication,
 * implementation equivalence, execution, calibration or a current holder claim. */
export function approveReviewedMorphoV2ProtocolHistory(
  profile: MorphoV2TrustedProfile,
  candidate: unknown,
  sha256Text: MorphoV2Sha256Text,
): boolean {
  try {
    if (!isAppOwnedMorphoV2TrustedProfile(profile)) return false
    if (profile.id === 'morpho_v2_usdc_reviewed_protocol_history') {
      const history = morphoV2PinnedProtocolHistory()
      return (
        coherent(profile, history) &&
        exact(structuredClone(candidate), history) &&
        approveMorphoV2PinnedProtocolHistory(candidate, sha256Text)
      )
    }
    if (Object.hasOwn(trustedObserved, profile.id)) {
      const history = trustedObserved[profile.id]
      return (
        coherent(profile, history) &&
        sha256Text(JSON.stringify(history)) === observedFrameDigests[profile.id] &&
        exact(structuredClone(candidate), history)
      )
    }
    return (
      profile.id === 'morpho_v2_usdt_reviewed_joint_history' &&
      coherent(profile, trustedUsdt) &&
      sha256Text(JSON.stringify(trustedUsdt)) ===
        MORPHO_V2_USDT_REVIEWED_PROTOCOL_HISTORY_PIN.frameSha256 &&
      exact(structuredClone(candidate), trustedUsdt)
    )
  } catch {
    return false
  }
}
