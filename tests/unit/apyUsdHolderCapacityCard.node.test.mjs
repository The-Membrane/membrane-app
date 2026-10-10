import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import React from 'react'
import { ChakraProvider } from '@chakra-ui/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { encodeFunctionResult, sha256, stringToHex } from 'viem'
import card from '../../components/Carry/ExitPressureCard.tsx'
import workbench from '../../components/Carry/ForecastWorkbench.tsx'
import native from '../../lib/carry/apyUsdJointNativeEvidence.ts'
import binding from '../../lib/carry/apyUsdJointHolderForecastBinding.ts'

const {
  APY_USD_JOINT_NATIVE_ABI: ABI,
  APY_USD_JOINT_NATIVE_ANCHORS: anchors,
  APY_USD_JOINT_NATIVE_SUBJECT: subject,
  apyUsdJointNativeCurrentReadPlan: currentPlan,
  apyUsdJointNativeHistoryReadPlan: historyPlan,
  replayApyUsdJointNativeCurrent: replayCurrent,
} = native
const ROOT = resolve(process.cwd(), 'data/research/venue-signals')
const CAPTURE = resolve(
  ROOT,
  'apyusd-current-liquid-cash-native-evidence-2026-10-08/originals-c2c0dfb5-be12-4368-a52f-f6a1c491c0c9/capture',
)
const OLD_CAPTURE = resolve(
  ROOT,
  'apyusd-full-owner-two-leg-native-evidence-2026-10-08/originals-801c0a42-a3c0-4292-a288-18b65e4d40ff/capture',
)
const OWNER = '0x9830d6b37fe7488707cc4ad7f8b481d75eb2a8c2',
  VESTING = '0x0d62b4cc02b4b51ed19ddf41d7a7979cf394c99f'
const FULL_S = '391143432',
  FULL_G = '562976263',
  FULL_EA = '562413849',
  CASH = '164310986216896497035561351',
  ESCROW = '169162231456603977484'
const NOW = Date.now(),
  clone = (v) => JSON.parse(JSON.stringify(v)),
  hex = (n) => '0x' + n.toString(16)
const result = (name, value) =>
  encodeFunctionResult({ abi: ABI, functionName: name, result: value })
const header = (s) => ({
  number: hex(s.blockNumber),
  hash: s.blockHash,
  timestamp: hex(Date.parse(s.blockTime) / 1000),
})
const codes = Object.fromEntries(
  [
    ['vault_code', subject.destination, '01-discovery-physical-9'],
    ['receipt_code', subject.receipt, '01-discovery-physical-10'],
    [
      'vault_implementation_code',
      '0xfd616567ecc1607f61073951a1e822f7315bb112',
      '01-discovery-physical-22',
    ],
    [
      'receipt_implementation_code',
      '0x54f1c7ffe10bc392f08ae9432a7e21a6e86bb982',
      '02-current-physical-9',
    ],
    ['asset_code', subject.asset, '01-discovery-physical-28'],
    ['vesting_code', VESTING, '02-current-physical-73'],
  ].map(([key, address, basename]) => {
    const request = JSON.parse(readFileSync(resolve(CAPTURE, basename + '-request.bin'), 'utf8')),
      response = JSON.parse(readFileSync(resolve(CAPTURE, basename + '-response.bin'), 'utf8'))
    assert.equal(request.method, 'eth_getCode')
    assert.equal(request.params[0], address)
    assert.equal(response.id, request.id)
    return [key, response.result]
  }),
)
const frames = JSON.parse(
  readFileSync(resolve(OLD_CAPTURE, '04-native-receipt-history-frames.json'), 'utf8'),
).frames
const nativeError = (data = '0xd93c0665') => ({ error: { code: 3, message: 'native_error', data } })
function trace(read, value, started) {
  const response =
    value && typeof value === 'object' && Object.hasOwn(value, 'error') ? value : { result: value }
  return {
    ...clone(read),
    ...response,
    startedAtUtc: new Date(started).toISOString(),
    completedAtUtc: new Date(started + 1).toISOString(),
    requestBodySha256: sha256(stringToHex(JSON.stringify(read))).slice(2),
    responseBodySha256: sha256(stringToHex(JSON.stringify(response))).slice(2),
  }
}
/** Native-derived unsigned envelopes with actual retained runtime/quote bytes.
 * Fresh clocks are synthetic test headers; no RPC, acquisition authority or Date replacement.
 */
function fixture({ paused = false, censored = false, clockOffset = 0 } = {}) {
  const at = NOW + clockOffset,
    acquiredAtUtc = new Date(at - 1000).toISOString(),
    availableAtUtc = new Date(at - 500).toISOString()
  const source = {
    chainId: 1,
    finalized: true,
    blockNumber: 26150788,
    blockHash: '0xbcf4f563592ecf5ff161a44eab753025ca4adfa682fe300a4eba5a75a2d5762e',
    blockTime: new Date(Math.floor((at - 120000) / 1000) * 1000).toISOString(),
  }
  const values = {
    vault_asset: ['asset', subject.asset],
    receipt_asset: ['asset', subject.asset],
    vault_receipt: ['receipt', subject.receipt],
    share_decimals: ['decimals', 18],
    asset_decimals: ['decimals', 18],
    vault_paused: ['paused', false],
    receipt_paused: ['paused', paused],
    unlocking_fee: ['unlockingFee', 1000000000000000n],
    fee_curve: ['feeCurve', [0n, 34000000000000000n, 259200, 1728000, 1000000000000000000n]],
    vault_cash: ['balanceOf', BigInt(CASH)],
    receipt_cash: ['balanceOf', 12185144975262803935614883n],
    total_assets: ['totalAssets', BigInt(CASH)],
    total_supply: ['totalSupply', 100000000000000000000000000n],
    vesting_address: ['vesting', VESTING],
    vested_amount: ['vestedAmount', 0n],
    full_shares: ['balanceOf', BigInt(FULL_S)],
    owned_count: ['balanceOf', 1n],
    full_escrow_ea: ['previewRedeem', BigInt(FULL_EA)],
    full_gross_assets: ['convertToAssets', BigInt(FULL_G)],
    full_withdraw_shares: ['previewWithdraw', BigInt(FULL_S)],
    full_share_sim: ['withdrawForReceipt', [BigInt(FULL_S), 1141n]],
    candidate_owner_881: ['ownerOf', OWNER],
    receipt_tuple_881: ['getReceipt', [BigInt(ESCROW), 0n, 1787499395, 1787758595]],
    receipt_preview_881: ['previewClaim', BigInt(ESCROW)],
    receipt_claimable_881: ['isClaimable', !paused],
    receipt_claim_881: ['claim', BigInt(ESCROW)],
  }
  const value = (key, s = source, changes = {}) => {
    if (Object.hasOwn(changes, key)) return changes[key]
    if (Object.hasOwn(codes, key)) return codes[key]
    if (key.startsWith('header_')) return header(s)
    if (key === 'vault_implementation_slot')
      return '0x' + '0'.repeat(24) + 'fd616567ecc1607f61073951a1e822f7315bb112'
    if (key === 'receipt_implementation_slot')
      return '0x' + '0'.repeat(24) + '54f1c7ffe10bc392f08ae9432a7e21a6e86bb982'
    if (key === 'owner_code') return '0x'
    if (key === 'full_share_sim' && (paused || censored))
      return nativeError(paused ? '0xd93c0665' : '0xdeadbeef')
    if (key === 'receipt_claim_881' && paused) return nativeError()
    assert.ok(values[key], key)
    return result(...values[key])
  }
  const currentBinding = {
    routeKey: subject.routeKey,
    destination: subject.destination,
    asset: subject.asset,
    owner: OWNER,
    candidateReceiptIds: ['881'],
    source,
    acquiredAtUtc,
  }
  const reads = [
    'base',
    'candidate_owners',
    'owned_receipts',
    'share_quote',
    'initiation_simulation',
    'vesting',
    'end',
  ].flatMap((stage) =>
    currentPlan(currentBinding, {
      stage,
      fullSharesRaw: FULL_S,
      fullEscrowEaRaw: FULL_EA,
      ownedReceiptIds: ['881'],
      vestingAddress: VESTING,
    }),
  )
  const base = at - 1901,
    hosts = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com']
  const current = {
    binding: currentBinding,
    availableAtUtc,
    wire: {
      origins: hosts.map((host) => ({
        host,
        acquiredAtUtc,
        phases: [
          {
            chainIdTrace: trace(
              { key: 'chain', request: { method: 'eth_chainId', params: [] } },
              '0x1',
              base,
            ),
            finalizedTrace: trace(
              {
                key: 'finalized',
                request: { method: 'eth_getBlockByNumber', params: ['finalized', false] },
              },
              header(source),
              base + 2,
            ),
            headerBeforeTrace: trace(
              {
                key: 'phase_header_before',
                request: {
                  method: 'eth_getBlockByNumber',
                  params: [hex(source.blockNumber), false],
                },
              },
              header(source),
              base + 4,
            ),
            headerAfterTrace: trace(
              {
                key: 'phase_header_after',
                request: {
                  method: 'eth_getBlockByNumber',
                  params: [hex(source.blockNumber), false],
                },
              },
              header(source),
              base + 900,
            ),
            acquiredAtUtc,
          },
        ],
        traces: reads.map((r, i) => trace(r, value(r.key), base + 10 + i * 2)),
      })),
    },
  }
  const replay = replayCurrent(current.wire, current.binding)
  const history = {
    schema: 'apyusd_joint_native_history_evidence_v1',
    acquiredAtUtc,
    availableAtUtc,
    fullSharesRaw: FULL_S,
    owner: null,
    historicalOwnership: false,
    originalAuthority: false,
    authenticated: false,
    executionQualified: false,
    points: anchors.map((anchor) => {
      const old = frames.find((f) => f.factsByOrigin[0].cashIndex === anchor.cashIndex)
        .factsByOrigin[0]
      const b = {
        cashIndex: anchor.cashIndex,
        source: anchor.source,
        currentSource: source,
        fullSharesRaw: FULL_S,
        currentRuntimeRegime: replay.current.runtimeRegime,
        vestingAddress: VESTING,
        vaultUnlockingFeeWad: '1000000000000000',
        owner: null,
        acquiredAtUtc,
      }
      const plans = historyPlan(b),
        t = at - 1000 - (10 + (plans.length - 1) * 2 + 1)
      const changes = {
        vault_cash: result('balanceOf', BigInt(anchor.cashRaw)),
        full_escrow_ea: result('previewRedeem', BigInt(old.fullSharePreviewRedeem.value)),
        full_gross_assets: result('convertToAssets', BigInt(old.fullShareConvertToAssets.value)),
      }
      return {
        binding: b,
        wire: {
          origins: hosts.map((host) => ({
            host,
            acquiredAtUtc,
            chainIdTrace: trace(
              { key: 'chain', request: { method: 'eth_chainId', params: [] } },
              '0x1',
              t,
            ),
            traces: plans.map((r, i) =>
              trace(r, value(r.key, anchor.source, changes), t + 10 + i * 2),
            ),
          })),
        },
      }
    }),
  }
  const question = {
    routeKey: subject.routeKey,
    destination: subject.destination,
    requestedHolderAddress: OWNER,
    requestedRaw: '1000000000000000000',
    requestedAssetAddress: subject.asset,
    requestedAssetDecimals: 18,
    horizonHours: 168,
    independentSource: clone(source),
  }
  const response = {
    apyUsdJointNativeCurrentEvidence: current,
    apyUsdJointHistoricalEvidence: history,
    apyUsdJointIssuedAtUtc: new Date(at).toISOString(),
  }
  return { current, history, question, response, at }
}
const retainedIssue = (f, status = 200) =>
  workbench.holderApyUsdJointIssueFromResponse(
    JSON.parse(
      JSON.stringify({
        ...f.response,
        ...(status === 503 ? { error: 'holder_exit_assessment_unavailable' } : {}),
      }),
    ),
    status,
    f.question,
    Date.now(),
  )
const model = (retained) =>
  binding.selectedApyUsdJointHolderForecastFromIssue(retained.issue, retained.question, Date.now())
function props(retained, changes = {}) {
  return {
    scenarioMode: 'exit',
    routeKey: subject.routeKey,
    destination: subject.destination,
    requestedAmount: '1',
    requestedRaw: '1000000000000000000',
    requestedAssetSymbol: 'apxUSD',
    requestedAssetAddress: subject.asset,
    requestedAssetDecimals: 18,
    requestedHolderAddress: OWNER,
    horizonHours: 168,
    asOfMs: Date.now(),
    currentCash: null,
    prospectiveCashModel: null,
    historicalScenario: null,
    grossWithdrawals: null,
    grossInflows: null,
    historicalGrossFlow: null,
    morphoPayout: null,
    holderAssessment: null,
    expectedEventEnrollment: { status: 'unavailable' },
    eventContext: null,
    historicalOutlook: null,
    holderApyUsdJointIssue: retained,
    ...changes,
  }
}
const render = (p) =>
  renderToStaticMarkup(
    React.createElement(ChakraProvider, null, React.createElement(card.ExitPressureCard, p)),
  ).replaceAll(/<style[\s\S]*?<\/style>/g, '')
const band = (m) =>
  `${card.formatExitPressureSignedRaw(m.process.targetSummary.headroom.band.p10Raw, 18)}–${card.formatExitPressureSignedRaw(m.process.targetSummary.headroom.band.p90Raw, 18)} apxUSD`
const row = (html) =>
  html.match(/Selected-horizon joint APY USD holder headroom[\s\S]*?<\/div>/)?.[0] ?? ''

test('Workbench retains only the original APY issue from real JSON transport and Card shows its conditional band', () => {
  const f = fixture(),
    retained = retainedIssue(f)
  assert.ok(retained)
  assert.deepEqual(Object.keys(retained).sort(), ['issue', 'question'])
  assert.equal(retained.question.asOfMs, f.at)
  assert.equal(retained.question.plannedInitiationOffsetSeconds, 0)
  assert.equal(retained.question.fundingBasis, 'native_liquid_cash')
  assert.equal(retained.issue.fullSharesRaw, FULL_S)
  assert.equal(retained.issue.receiptInventory.complete, true)
  assert.deepEqual(retained.issue.ownedReceiptIds, ['881'])
  const m = model(retained)
  assert.ok(m?.process.targetSummary)
  assert.equal(m.authenticated, false)
  assert.equal(m.executionQualified, false)
  assert.equal(m.calibrated, false)
  const html = render(props(retained))
  assert.match(html, /CONDITIONAL HOLDER OUTLOOK/)
  assert.ok(row(html).includes(band(m)))
  assert.ok(
    row(html).includes(
      `MIN ${card.formatExitPressureSignedRaw(m.process.targetSummary.headroom.band.minRaw, 18)} apxUSD`,
    ),
  )
  assert.equal((html.match(/Expected headroom/g) ?? []).length, 1)
  assert.doesNotMatch(html, /AFTER DEPOSIT/)
  // Mutating later transport cannot replace the private model selected by the original issue.
  f.response.apyUsdJointNativeCurrentEvidence.binding.owner = '0x' + '1'.repeat(40)
  assert.ok(row(render(props(retained))).includes(band(m)))
})

test('Card rejects receipt clones and current question changes instead of reissuing decoded models', () => {
  const retained = retainedIssue(fixture())
  assert.ok(retained)
  for (const changed of [
    { holderApyUsdJointIssue: clone(retained) },
    { holderApyUsdJointIssue: { ...retained, question: null } },
    { requestedHolderAddress: '0x' + '1'.repeat(40) },
    { requestedRaw: '2000000000000000000' },
    { horizonHours: 24 },
    { requestedAssetAddress: '0x' + '2'.repeat(40) },
    { requestedAssetDecimals: 6 },
    {
      holderApyUsdJointIssue: {
        ...retained,
        question: { ...retained.question, plannedInitiationOffsetSeconds: 1 },
      },
    },
    {
      holderApyUsdJointIssue: {
        ...retained,
        question: { ...retained.question, fundingBasis: 'cash_plus_vested_assumption' },
      },
    },
    {
      holderApyUsdJointIssue: {
        ...retained,
        question: {
          ...retained.question,
          independentSource: {
            ...retained.question.independentSource,
            blockHash: '0x' + 'a'.repeat(64),
          },
        },
      },
    },
    { asOfMs: Date.now() + 1800001 },
  ])
    assert.match(row(render(props(retained, changed))), /—/)
  const source = retained.question.independentSource
  const cash = {
    routeKey: subject.routeKey,
    destination: subject.destination,
    assetAddress: subject.asset,
    assetDecimals: 18,
    assetSymbol: 'apxUSD',
    cashRaw: CASH,
    block: String(source.blockNumber),
    blockHash: source.blockHash,
    observedAt: source.blockTime,
    freshness: 'fresh',
    label: 'Vault cash',
  }
  assert.ok(row(render(props(retained, { currentCash: cash }))).includes(band(model(retained))))
  assert.match(
    row(render(props(retained, { currentCash: { ...cash, blockHash: '0x' + 'b'.repeat(64) } }))),
    /—/,
  )
  assert.equal(row(render(props(retained, { scenarioMode: 'deposit' }))), '')
  assert.equal(row(render(props(retained, { routeKey: 'different route' }))), '')
  assert.equal(row(render(props(retained, { destination: '0x' + '3'.repeat(40) }))), '')
})

test('APY canonical partial503 retains the original issue while invalid issue/receive clocks and expired sources fail', () => {
  const f = fixture(),
    retained = retainedIssue(f, 503)
  assert.ok(retained)
  assert.ok(row(render(props(retained))).includes(band(model(retained))))
  assert.equal(
    workbench.holderApyUsdJointIssueFromResponse(
      { ...f.response, error: 'other' },
      503,
      f.question,
      Date.now(),
    ),
    null,
  )
  assert.equal(
    workbench.holderApyUsdJointIssueFromResponse(f.response, 200, f.question, f.at - 1),
    null,
  )
  assert.equal(
    workbench.holderApyUsdJointIssueFromResponse(
      { ...f.response, apyUsdJointIssuedAtUtc: new Date(Date.now() + 60000).toISOString() },
      200,
      f.question,
      Date.now(),
    ),
    null,
  )
  assert.equal(retainedIssue(fixture({ clockOffset: -1801000 })), null)
})

test('unclassified initiation remains censored while native receipt pause has a known zero-capacity headroom band', () => {
  const censored = retainedIssue(fixture({ censored: true }))
  assert.ok(censored)
  assert.equal(model(censored).process.targetSummary, null)
  assert.match(row(render(props(censored))), /—/)
  const paused = retainedIssue(fixture({ paused: true }))
  assert.ok(paused)
  const m = model(paused)
  assert.ok(m.process.targetSummary)
  assert.equal(m.process.targetSummary.available.band.maxRaw, '0')
  assert.equal(m.process.targetSummary.headroom.band.minRaw, '-1000000000000000000')
  assert.ok(row(render(props(paused))).includes(band(m)))
})
