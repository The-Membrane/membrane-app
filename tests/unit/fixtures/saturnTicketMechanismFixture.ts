import type { HolderExitAssessment } from '@/lib/carry/holderExitAssessment'
import type { HolderExitMechanicalRequest } from '@/lib/carry/holderExitMechanicalProjection'
// Explicitly synthetic current facts, not captured native receipts.
const now=Date.parse('2026-10-12T12:00:00.000Z')
export function saturnTicketFixture() {
  const request: HolderExitMechanicalRequest = { routeKey: 'AUSD → Staked USDat [USDat]',
    destinationAddress: '0xd166337499e176bbc38a1fbd113ab144e5bd2df7', owner: '0x0000000000000000000000000000000000000001',
    assetAddress: '0x00000000efe302beaa2b3e6e1b18d08d69a9012a', assetsRaw: '1000000', nowMs: now, horizonSeconds: 48 * 3600 }
  const assessment = { status: 'partial', routeKey: request.routeKey, destinationAddress: request.destinationAddress,
    owner: request.owner, request: { assetsRaw: request.assetsRaw, assetAddress: request.assetAddress, horizonHours: 48 },
    source: { chainId: 1, blockNumber: 26200000, blockHash: '0x' + 'a'.repeat(64), blockTime: new Date(now - 60000).toISOString(), originValidation: 'two_provider' },
    stages: [{ name: 'existing_ticket_claim', assetAddress: '0x' + 'b'.repeat(40), status: 'unassessed', amountRaw: null, relatedToRequest: false }],
    finalPayout: { assetAddress: request.assetAddress, status: 'unassessed', amountRaw: null },
    stakedUsdatCondition: { existingTicketId: '7', existingTicketOwnership: 'holder', existingTicketClaimStatus: 'evm_revert',
      existingTicketRequestedAtUnix: String(Math.floor(now / 1000) - 3600),
      existingTicketConversionBasis: 'recorded_owed_if_delivered', existingTicketConversionFeeStatus: 'unknown',
      existingTicketRecordedRequest: { sharesRaw18: '1000000000000000000', usdatOwedRaw6: '2000000', requestedAtUnix: String(Math.floor(now / 1000) - 3600), minSharePriceRaw: '0', rawStatus: 0 },
      existingTicketConversionQuote: { status: 'conditional_quote', execution: 'unassessed', usdatInputRaw: '2000000', usdcQuotedRaw: '1999999', ausdQuotedRaw: '1999990',
        curveCashUsdcRaw: '100000000', curveCashUsdatRaw: '100000000', uniswapActiveLiquidityRaw: '100000000', initializedTicksCrossed: 0 } },
  } as unknown as HolderExitAssessment
  return { assessment, request }
}
