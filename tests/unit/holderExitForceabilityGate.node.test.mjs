import assert from 'node:assert/strict'
import test from 'node:test'

import React from 'react'
import { ChakraProvider } from '@chakra-ui/react'
import { renderToStaticMarkup } from 'react-dom/server'

import componentModule from '../../components/Carry/HolderExitForceabilityGate.tsx'

const { HolderExitForceabilityGate } = componentModule
const base = {
  status: 'available',
  routeKey: 'sample route',
  destination: '0x1111111111111111111111111111111111111111',
  forecastValidated: false,
  holderExecutableExit: false,
  subject: {
    mechanism: 'atomic',
    directIssueCellObservations: 3,
    measuredDirectBaselineCellObservations: 2,
    historicalDirectFinalAssetPayoutTransactions: 0,
    stageIssueObservations: 0,
    terminalSameEpisodeFinalAssetPaidProofs: 0,
    historicalReceiptCohort: null,
    historicalIntermediateQueue: null,
    observedRequestToPayoutSeconds: [],
    calibratedImpairmentDuration: false,
    forecastValidated: false,
  },
}

function render(evidence, apyUsdOpenReceiptStatus) {
  return renderToStaticMarkup(
    React.createElement(
      ChakraProvider,
      null,
      React.createElement(HolderExitForceabilityGate, { evidence, apyUsdOpenReceiptStatus }),
    ),
  )
}

const apyUsdHistorical = {
  ...base,
  subject: {
    ...base.subject,
    mechanism: 'staged',
    historicalReceiptCohort: {
      mintedReceipts: 96,
      firstEligibleHolderClaimSuccesses: 96,
      sameReceiptHolderPaidClaims: 89,
      openCensoredReceipts: 7,
    },
    latestOpenReceiptObservation: {
      block: 26110045,
      blockTime: 1791000000,
      cohort: 7,
      sameHolder: 7,
      claimCallable: 7,
      fullEscrowClaimable: 7,
      noCurrentOwner: 0,
      evidenceSha256: 'a'.repeat(64),
    },
  },
}

test('ApyUSD current check replaces the sealed row with dated receipt counts', () => {
  const blockTime = 1791000000
  const html = render(apyUsdHistorical, {
    status: 'fresh',
    scope: 'historical_open_receipts',
    prospectiveQForecast: false,
    block: { number: 26114032, hash: `0x${'b'.repeat(64)}`, timestamp: blockTime },
    observedAtUtc: new Date((blockTime + 120) * 1000).toISOString(),
    openReceiptCount: 7,
    noCurrentOwnerCount: 0,
    holderChangedCount: 0,
    claimSimulationPassCount: 7,
    fullEscrowSimulationCount: 7,
    noCodeHolderCount: 6,
    delegatedEoaHolderCount: 1,
    contractHolderCount: 0,
    sourceHosts: ['rpc.example'],
  })
  assert.match(html, /CLAIM CHECK/)
  assert.match(
    html,
    /7\/7 claim simulations passed · 7\/7 full escrow · 6 no-code · 1 delegated EOA · B26114032/,
  )
  assert.match(html, /sampled 2026-10-03 04:00 UTC/)
  assert.doesNotMatch(html, /B26110045|LAST CLAIM CHECK|FORECAST|VALIDATED/)
})

test('ApyUSD current check separates absent and transferred receipts from callable originals', () => {
  const blockTime = 1791000000
  const html = render(apyUsdHistorical, {
    status: 'fresh',
    scope: 'historical_open_receipts',
    prospectiveQForecast: false,
    block: { number: 26114032, hash: `0x${'b'.repeat(64)}`, timestamp: blockTime },
    observedAtUtc: new Date((blockTime + 120) * 1000).toISOString(),
    openReceiptCount: 5,
    noCurrentOwnerCount: 1,
    holderChangedCount: 1,
    claimSimulationPassCount: 5,
    fullEscrowSimulationCount: 5,
    noCodeHolderCount: 5,
    delegatedEoaHolderCount: 0,
    contractHolderCount: 0,
    sourceHosts: ['rpc.example'],
  })
  assert.match(html, /5\/5 claim simulations passed · 5\/5 full escrow/)
  assert.match(html, /1 absent, payout unverified · 1 transferred/)
  assert.doesNotMatch(html, /FORECAST|VALIDATED/)
})

test('unavailable ApyUSD check keeps the sealed block explicitly dated', () => {
  const html = render(apyUsdHistorical, null)
  assert.match(html, /LAST CLAIM CHECK/)
  assert.match(html, /B26110045 · sampled 2026-10-03 04:00 UTC/)
  assert.doesNotMatch(html, /B26114032|FORECAST|VALIDATED/)
  assert.match(render(apyUsdHistorical), /LAST CLAIM CHECK/)
})

test('atomic route renders Q cases and holder assays without a forecast claim', () => {
  const html = render(base)
  assert.match(html, /Q CASES/)
  assert.match(html, /HOLDER ASSAY/)
  assert.doesNotMatch(html, /LIKELY DURATION/)
  assert.doesNotMatch(html, /FORECAST/)
  assert.doesNotMatch(html, /VALIDATED/)
  assert.doesNotMatch(html, /UNAVAILABLE/)
})

test('atomic payout receipt is historical and does not become a holder forecast', () => {
  const html = render({
    ...base,
    subject: { ...base.subject, historicalDirectFinalAssetPayoutTransactions: 5 },
  })
  assert.match(html, /SAMPLED PAID TX/)
  assert.match(html, /Route exit evidence/)
  assert.doesNotMatch(html, /LIKELY DURATION/)
  assert.doesNotMatch(html, /UNAVAILABLE/)
  assert.doesNotMatch(html, /VALIDATED/)
})

test('sampled historical stable revert appears only for the affected exact subject', () => {
  const episode = {
    anchorBlock: 25400000,
    anchorAtUtc: '2026-06-26T06:25:47.000Z',
    qLabel: 'fixed_10k',
    sampledHours: [0, 1, 4, 24, 48, 168],
    provenance: 'saved_cell_disk_integrity_only',
  }
  const html = render({
    ...base,
    subject: { ...base.subject, historicalStableSimulatedReverts: [episode] },
  })
  assert.match(html, /HIST. SIMULATED REVERT/)
  assert.match(html, /Q \$10k · B25400000 · 2026-06-26 06:25 UTC · sampled 0\/1\/4\/24\/48\/168h/)
  assert.match(html, /SHA-checked · no RPC replay/)
  assert.doesNotMatch(render(base), /HIST. SIMULATED REVERT/)
  assert.doesNotMatch(html, /LIKELY DURATION|UNAVAILABLE|VALIDATED/)
})

test('four same-subject historical anchors collapse to one latest-anchor row', () => {
  const episode = {
    qLabel: 'fixed_10k',
    provenance: 'saved_cell_disk_integrity_only',
  }
  const html = render({
    ...base,
    subject: {
      ...base.subject,
      historicalStableSimulatedReverts: [
        {
          ...episode,
          anchorBlock: 25800000,
          anchorAtUtc: '2026-08-21T00:44:11.000Z',
          sampledHours: [0, 1, 4],
        },
        {
          ...episode,
          anchorBlock: 25400000,
          anchorAtUtc: '2026-06-26T06:25:47.000Z',
          sampledHours: [0, 1, 4, 24, 48, 168],
        },
        {
          ...episode,
          anchorBlock: 26000000,
          anchorAtUtc: '2026-09-17T21:49:23.000Z',
          sampledHours: [0, 1],
        },
        {
          ...episode,
          anchorBlock: 25600000,
          anchorAtUtc: '2026-07-24T03:46:47.000Z',
          sampledHours: [0, 1, 4, 24],
        },
      ],
    },
  })
  assert.equal(html.match(/HIST. SIMULATED REVERT/g)?.length, 1)
  assert.match(html, /Q \$10k · B26000000 · 2026-09-17 21:49 UTC · sampled 0\/1h · 4 anchors/)
  assert.doesNotMatch(html, /B25400000|B25600000|B25800000|LIKELY DURATION/)
})

test('missing or malformed saved-cell provenance cannot render as checked evidence', () => {
  for (const provenance of [undefined, 'rpc_replayed', '']) {
    const html = render({
      ...base,
      subject: {
        ...base.subject,
        historicalStableSimulatedReverts: [
          {
            anchorBlock: 25400000,
            anchorAtUtc: '2026-06-26T06:25:47.000Z',
            qLabel: 'fixed_10k',
            sampledHours: [0, 1, 4],
            provenance,
          },
        ],
      },
    })
    assert.doesNotMatch(html, /HIST. SIMULATED REVERT|SHA-checked/)
  }
  const missingDate = render({
    ...base,
    subject: {
      ...base.subject,
      historicalStableSimulatedReverts: [
        {
          anchorBlock: 25400000,
          qLabel: 'fixed_10k',
          sampledHours: [0, 1, 4],
          provenance: 'saved_cell_disk_integrity_only',
        },
      ],
    },
  })
  assert.doesNotMatch(missingDate, /HIST. SIMULATED REVERT|disk checked/)
})

test('staged route renders issues and final payout separately', () => {
  const html = render({
    ...base,
    subject: {
      ...base.subject,
      mechanism: 'staged',
      stageIssueObservations: 8,
      terminalSameEpisodeFinalAssetPaidProofs: 1,
      observedRequestToPayoutSeconds: [86_436],
    },
  })
  assert.match(html, /STAGE ISSUES/)
  assert.match(html, /PAID FROM ISSUES/)
  assert.match(html, /Route exit evidence/)
  assert.doesNotMatch(html, /Q CASES/)
  assert.doesNotMatch(html, /HOLDER ASSAY/)
  assert.match(html, /REQUEST→PAYOUT/)
  assert.match(html, /24h 00m 36s/)
  assert.match(html, /n=1/)
  assert.doesNotMatch(html, /UNAVAILABLE/)
})

test('two observed payouts render their historical range without claiming a forecast', () => {
  const html = render({
    ...base,
    subject: {
      ...base.subject,
      mechanism: 'staged',
      stageIssueObservations: 14,
      terminalSameEpisodeFinalAssetPaidProofs: 2,
      observedRequestToPayoutSeconds: [86_436, 92_628],
    },
  })
  assert.match(html, /24h 00m 36s–25h 43m 48s/)
  assert.match(html, /n=2/)
  assert.doesNotMatch(html, /UNAVAILABLE/)
  assert.doesNotMatch(html, /VALIDATED/)
})

test('historical receipt cohort shows eligibility and paid claims without claiming calibration', () => {
  const html = render({
    ...base,
    subject: {
      ...base.subject,
      mechanism: 'staged',
      historicalReceiptCohort: {
        mintedReceipts: 96,
        firstEligibleHolderClaimSuccesses: 96,
        sameReceiptHolderPaidClaims: 89,
        openCensoredReceipts: 7,
      },
    },
  })
  assert.match(html, /HIST\. RECEIPTS/)
  assert.match(html, /96 · 89 paid · 7 open/)
  assert.match(html, /FIRST ELIGIBLE/)
  assert.match(html, /96\/96/)
  assert.doesNotMatch(html, /UNAVAILABLE/)
  assert.doesNotMatch(html, /VALIDATED/)
})

test('historical receipt timing uses the full cohort and stays distinct from a forecast', () => {
  const html = render({
    ...base,
    subject: {
      ...base.subject,
      mechanism: 'staged',
      historicalReceiptCohort: {
        mintedReceipts: 96,
        firstEligibleHolderClaimSuccesses: 96,
        mechanicalClaimGateSeconds: 259_200,
        sameReceiptHolderPaidClaims: 89,
        openCensoredReceipts: 7,
        historicalRequestToMinedPaymentTiming: {
          scope: 'historical_holder_action_influenced_request_to_mined_payment',
          denominator: 96,
          paidWithin7Days: 16,
          paidWithin21Days: 74,
          paidWithin28Days: 87,
          medianRequestToMinedPayoutSeconds: 1_731_228,
          openRightCensored: 7,
          censorTimestamp: 1_790_855_795,
        },
      },
    },
  })
  assert.match(html, /HIST\. CLAIM GATE[\s\S]*PAST REQUEST→PAID/)
  assert.match(html, /7d 16\/96 · 21d 74\/96 · 28d 87\/96/)
  assert.match(html, /PAST REQUEST→PAID/)
  assert.match(html, /median 20\.037d · 7 open at cutoff/)
})

test('intermediate queue shows paid USDat and the price gate without implying AUSD delivery', () => {
  const html = render({
    ...base,
    subject: {
      ...base.subject,
      mechanism: 'staged',
      historicalIntermediateQueue: {
        intermediateAsset: '0x23238f20b894f29041f48d88ee91131c395aaa71',
        cutoffBlock: 26107302,
        requests: 146,
        processed: 106,
        paidIntermediate: 77,
        processedUnclaimed: 29,
        pendingCensored: 40,
        pendingAboveCurrentLimit: 40,
        pendingBeforeUpgrade: 34,
        pendingAfterUpgrade: 6,
        processingWithin24h: {
          horizonSeconds: 86400,
          confirmedProcessed: 87,
          possibleProcessed: 89,
          censoredBeforeHorizon: 2,
        },
        processingRegimeDiagnostic: {
          scope: 'request_to_operator_processing_only',
          horizonSeconds: 86400,
          split: { atUtc: '2026-09-23T07:25:23.000Z' },
          train: { evaluable: 69, processedWithinHorizon: 67 },
          later: { evaluable: 71, processedWithinHorizon: 18 },
          prospectiveValidated: false,
          fullRouteExitAssessed: false,
        },
      },
    },
  })
  assert.match(html, /USDat QUEUE/)
  assert.match(html, /146 requests · 106 processed · 77 USDat paid/)
  assert.match(html, /PAST 24H PROCESS/)
  assert.match(html, /87–89 \/ 146 · 2 unknown/)
  assert.match(html, /24H QUEUE SHIFT/)
  assert.match(html, /67\/69 → 18\/71 · split 09-23 · retrospective/)
  assert.match(html, /PRICE GATE/)
  assert.match(html, /40\/40 pending · B26107302/)
  assert.doesNotMatch(html, /77 AUSD paid/)
  assert.doesNotMatch(html, /LIKELY DURATION/)
  assert.doesNotMatch(html, /VALIDATED/)
  const currentHtml = render({
    ...base,
    subject: {
      ...base.subject,
      mechanism: 'staged',
      historicalIntermediateQueue: {
        intermediateAsset: '0x23238f20b894f29041f48d88ee91131c395aaa71',
        cutoffBlock: 26107302,
        requests: 146,
        processed: 106,
        paidIntermediate: 77,
        processedUnclaimed: 29,
        pendingCensored: 40,
        pendingAboveCurrentLimit: 40,
        pendingBeforeUpgrade: 34,
        pendingAfterUpgrade: 6,
      },
      latestPendingTicketObservation: {
        sourceCutoffBlock: 26107302,
        block: 26109183,
        blockTime: 1790998871,
        cohort: 40,
        stillRequested: 40,
        noLongerRequested: 0,
        priceGated: 40,
        quoteEligible: 0,
        medianElapsedSeconds: 402000,
        atLeastSevenDays: 15,
        gateChange: {
          previousBlock: 26109182,
          previousEvidenceSha256: 'b'.repeat(64),
          newlyGated: 1,
          newlyQuoteEligible: 0,
          stillGatedDeeper: 3,
        },
        evidenceSha256: 'a'.repeat(64),
      },
    },
  })
  assert.match(currentHtml, /40\/40 · median 111h 40m waited · 15 ≥7d · B26109183/)
  assert.match(currentHtml, /COHORT GATE PRESSURE/)
  assert.match(currentHtml, /role="status"/)
  assert.match(
    currentHtml,
    /\+1 gated · 3 further below min · \+0 quote eligible · B26109182→B26109183 · 2026-10-03 03:41 UTC/,
  )
  assert.doesNotMatch(currentHtml, /B26107302/)
})
