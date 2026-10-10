import { sha256, stringToHex } from 'viem'
import {
  agreeHolderExitCapacityQuotes,
  buildHolderExitCapacityQuote,
} from '@/lib/carry/holderExitCapacity'
import type { HolderExitAssessment } from '@/lib/carry/holderExitAssessment'
import type { MorphoV2HolderForecastQuestion } from '@/lib/carry/morphoV2HolderForecastBinding'
import { MORPHO_V2_PILOT } from '@/lib/carry/morphoV2HolderTimeProcess'
import { encodeMorphoV2ProtocolEvidencePair } from '@/lib/carry/morphoV2ProtocolEvidenceCodec'
import { createMorphoV2ProtocolCapacityFixture } from './morphoV2ProtocolCapacityFixture'

const OWNER = `0x${'b'.repeat(40)}`
const hash = (text: string) => sha256(stringToHex(text)).slice(2)

export function createMorphoV2HolderForecastFixture(horizonHours = 24) {
  const { pair, expected } = createMorphoV2ProtocolCapacityFixture()
  const question: MorphoV2HolderForecastQuestion = {
    routeKey: MORPHO_V2_PILOT.routeKey,
    destination: MORPHO_V2_PILOT.destination,
    requestedHolderAddress: OWNER,
    requestedRaw: '1000000',
    requestedAssetAddress: MORPHO_V2_PILOT.asset,
    requestedAssetDecimals: 6,
    horizonHours,
    asOfMs: expected.asOfMs,
  }
  const assessment = {
    status: 'assessed',
    routeKey: question.routeKey,
    destinationAddress: question.destination,
    owner: OWNER,
    request: {
      assetsRaw: question.requestedRaw,
      assetAddress: question.requestedAssetAddress,
      horizonHours,
    },
    source: { ...expected.source, originValidation: 'single_provider' },
    stages: [
      {
        name: 'withdrawal',
        status: 'reverted',
        relatedToRequest: true,
        amountRaw: question.requestedRaw,
        assetAddress: question.requestedAssetAddress,
      },
    ],
    finalPayout: {
      status: 'unassessed',
      amountRaw: null,
      assetAddress: question.requestedAssetAddress,
    },
    forecast: {
      status: 'unvalidated',
      futureExit: null,
      exitDurationHours: null,
      prospectiveValidated: false,
    },
  } as HolderExitAssessment
  const quote = buildHolderExitCapacityQuote(
    assessment,
    {
      entitlementRaw: '2000000',
      quotedMaxWithdrawRaw: '0',
      quotedMaxWithdrawStatus: 'quoted',
      effectiveLimitRaw: null,
      withdrawalsPaused: null,
    },
    question.asOfMs,
  )!
  if (!quote) throw Error('saved_holder_quote_invalid')
  const capacityAgreement = agreeHolderExitCapacityQuotes(
    { host: expected.originHosts[0], quote },
    { host: expected.originHosts[1], quote },
    question.asOfMs,
  )!
  const compact = encodeMorphoV2ProtocolEvidencePair(pair, expected, hash)!
  if (!compact) throw Error('saved_protocol_pair_invalid')
  const response = {
    capacityAgreement,
    morphoV2CurrentProtocolCapacityEvidence: compact,
  }
  return { question, pair, expected, compact, capacityAgreement, response }
}
