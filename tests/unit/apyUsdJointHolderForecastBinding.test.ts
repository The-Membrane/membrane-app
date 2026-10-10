import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { encodeFunctionResult, sha256, stringToHex } from 'viem'
import {
  APY_USD_JOINT_NATIVE_ABI,
  APY_USD_JOINT_NATIVE_ANCHORS,
  APY_USD_JOINT_NATIVE_SUBJECT,
  apyUsdJointNativeCurrentReadPlan,
  apyUsdJointNativeHistoryReadPlan,
  replayApyUsdJointNativeCurrent,
  type ApyUsdJointNativeCurrentBinding,
  type ApyUsdJointNativeCurrentWire,
  type ApyUsdJointNativeHistoryBinding,
  type ApyUsdJointNativeHistoryWire,
  type ApyUsdJointNativeRead,
  type ApyUsdJointNativeTrace,
} from '@/lib/carry/apyUsdJointNativeEvidence'

import {
  APY_USD_JOINT_BINDING_LIMITS,
  issuedApyUsdJointHolderForecast,
  selectedApyUsdJointHolderForecast,
  apyUsdJointHolderForecastIssue,
  selectedApyUsdJointHolderForecastFromIssue,
  selectedApyUsdJointHolderForecastIssue,
  apyUsdJointHolderForecastRenderWindow,
  apyUsdJointHolderForecastFromResponse,
  apyUsdJointHolderForecastIssueFromResponse,
  type ApyUsdJointHolderForecastQuestion,
  type ApyUsdJointCurrentEvidence,
  type ApyUsdJointHistoricalEvidence,
} from '@/lib/carry/apyUsdJointHolderForecastBinding'

const ROOT = resolve(process.cwd(), 'data/research/venue-signals')
const CAPTURE = resolve(
  ROOT,
  'apyusd-current-liquid-cash-native-evidence-2026-10-08/originals-c2c0dfb5-be12-4368-a52f-f6a1c491c0c9/capture',
)
const OLD_CAPTURE = resolve(
  ROOT,
  'apyusd-full-owner-two-leg-native-evidence-2026-10-08/originals-801c0a42-a3c0-4292-a288-18b65e4d40ff/capture',
)
const OWNER = '0x9830d6b37fe7488707cc4ad7f8b481d75eb2a8c2'
const VESTING = '0x0d62b4cc02b4b51ed19ddf41d7a7979cf394c99f'
const NOW = Date.now()
const SOURCE = {
  chainId: 1 as const,
  finalized: true as const,
  blockNumber: 26150788,
  blockHash: '0xbcf4f563592ecf5ff161a44eab753025ca4adfa682fe300a4eba5a75a2d5762e',
  blockTime: new Date(Math.floor((NOW - 120000) / 1000) * 1000).toISOString(),
}
const ACQUIRED = new Date(NOW - 1000).toISOString()
const VAULT = APY_USD_JOINT_NATIVE_SUBJECT.destination,
  RECEIPT = APY_USD_JOINT_NATIVE_SUBJECT.receipt
const FULL_S = '391143432',
  FULL_G = '562976263',
  FULL_EA = '562413849',
  CASH = '164310986216896497035561351'
const ESCROW = '169162231456603977484'
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const hex = (n: number) => '0x' + n.toString(16)
const headerValue = (s: typeof SOURCE | ApyUsdJointNativeHistoryBinding['source']) => ({
  number: hex(s.blockNumber),
  hash: s.blockHash,
  timestamp: hex(Date.parse(s.blockTime) / 1000),
})
const result = (name: string, value: unknown) =>
  encodeFunctionResult({ abi: APY_USD_JOINT_NATIVE_ABI, functionName: name, result: value })
/** Actual archived runtime bytes, never replacement implementations or mock hash functions. */
const codeFixtures = Object.fromEntries(
  [
    ['vault_code', VAULT, '01-discovery-physical-9'],
    ['receipt_code', RECEIPT, '01-discovery-physical-10'],
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
    ['asset_code', APY_USD_JOINT_NATIVE_SUBJECT.asset, '01-discovery-physical-28'],
    ['vesting_code', VESTING, '02-current-physical-73'],
  ].map(([key, address, basename]) => {
    const request = JSON.parse(readFileSync(resolve(CAPTURE, basename + '-request.bin'), 'utf8'))
    const response = JSON.parse(readFileSync(resolve(CAPTURE, basename + '-response.bin'), 'utf8'))
    if (
      request.method !== 'eth_getCode' ||
      request.params[0] !== address ||
      response.id !== request.id ||
      typeof response.result !== 'string'
    )
      throw Error('invalid_archived_runtime_fixture')
    return [key, response.result]
  }),
)
const stockFrames = JSON.parse(
  readFileSync(resolve(OLD_CAPTURE, '04-native-receipt-history-frames.json'), 'utf8'),
).frames
type Change = { [key: string]: unknown }
function fixtureValue(key: string, changes: Change, s = SOURCE): unknown {
  if (Object.hasOwn(changes, key)) return changes[key]
  if (key in codeFixtures) return codeFixtures[key]
  if (key.startsWith('header_') || key.startsWith('phase_header_') || key === 'finalized')
    return headerValue(s)
  if (key === 'chain') return '0x1'
  if (key === 'vault_implementation_slot')
    return '0x' + '0'.repeat(24) + 'fd616567ecc1607f61073951a1e822f7315bb112'
  if (key === 'receipt_implementation_slot')
    return '0x' + '0'.repeat(24) + '54f1c7ffe10bc392f08ae9432a7e21a6e86bb982'
  const values: Record<string, [string, unknown]> = {
    vault_asset: ['asset', APY_USD_JOINT_NATIVE_SUBJECT.asset],
    receipt_asset: ['asset', APY_USD_JOINT_NATIVE_SUBJECT.asset],
    vault_receipt: ['receipt', RECEIPT],
    share_decimals: ['decimals', 18],
    asset_decimals: ['decimals', 18],
    vault_paused: ['paused', false],
    receipt_paused: ['paused', false],
    unlocking_fee: ['unlockingFee', 1000000000000000n],
    fee_curve: ['feeCurve', [0n, 34000000000000000n, 259200, 1728000, 1000000000000000000n]],
    vault_cash: ['balanceOf', BigInt(CASH)],
    receipt_cash: ['balanceOf', 12185144975262803935614883n],
    total_assets: ['totalAssets', 164310986216896497035561351n],
    total_supply: ['totalSupply', 100000000000000000000000000n],
    vesting_address: ['vesting', VESTING],
    vested_amount: ['vestedAmount', 0n],
    full_shares: ['balanceOf', BigInt(FULL_S)],
    owned_count: ['balanceOf', 1n],
    full_escrow_ea: ['previewRedeem', BigInt(FULL_EA)],
    full_gross_assets: ['convertToAssets', BigInt(FULL_G)],
    full_withdraw_shares: ['previewWithdraw', BigInt(FULL_S)],
    full_share_sim: ['withdrawForReceipt', [BigInt(FULL_S), 1141n]],
  }
  if (key === 'owner_code') return '0x'
  if (key.startsWith('candidate_owner_')) return result('ownerOf', OWNER)
  if (key.startsWith('receipt_tuple_'))
    return result('getReceipt', [BigInt(ESCROW), 0n, 1787499395, 1787758595])
  if (key.startsWith('receipt_preview_')) return result('previewClaim', BigInt(ESCROW))
  if (key.startsWith('receipt_claimable_')) return result('isClaimable', true)
  if (key.startsWith('receipt_claim_')) return result('claim', BigInt(ESCROW))
  if (!values[key]) throw Error('fixture_key_' + key)
  return result(...values[key])
}
function makeTrace(
  read: ApyUsdJointNativeRead,
  value: unknown,
  started: number,
): ApyUsdJointNativeTrace {
  const data =
    value && typeof value === 'object' && Object.hasOwn(value, 'error')
      ? (value as { error: { code: number; message: 'native_error'; data?: string } })
      : { result: value }
  return {
    ...clone(read),
    ...data,
    startedAtUtc: new Date(started).toISOString(),
    completedAtUtc: new Date(started + 1).toISOString(),
    requestBodySha256: sha256(stringToHex(JSON.stringify(read))).slice(2),
    responseBodySha256: sha256(stringToHex(JSON.stringify(data))).slice(2),
  }
}
function currentFixture(changes: Change = {}, candidates = ['881'], fullSharesRaw = FULL_S) {
  const binding: ApyUsdJointNativeCurrentBinding = {
    routeKey: APY_USD_JOINT_NATIVE_SUBJECT.routeKey,
    destination: VAULT,
    asset: APY_USD_JOINT_NATIVE_SUBJECT.asset,
    owner: OWNER,
    candidateReceiptIds: candidates,
    source: SOURCE,
    acquiredAtUtc: ACQUIRED,
  }
  const owned = candidates.filter(
    (id) => fixtureValue('candidate_owner_' + id, changes) === result('ownerOf', OWNER),
  )
  const reads = [
    'base',
    'candidate_owners',
    'owned_receipts',
    'share_quote',
    'initiation_simulation',
    'vesting',
    'end',
  ].flatMap((stage) =>
    apyUsdJointNativeCurrentReadPlan(binding, {
      stage: stage as 'base',
      fullSharesRaw,
      fullEscrowEaRaw: changes.full_escrow_ea === result('previewRedeem', 0n) ? '0' : FULL_EA,
      ownedReceiptIds: owned,
      vestingAddress: VESTING,
    }),
  )
  const base = Date.parse(ACQUIRED) - 901
  const wire: ApyUsdJointNativeCurrentWire = {
    origins: ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'].map((host) => ({
      host,
      acquiredAtUtc: ACQUIRED,
      phases: [
        {
          chainIdTrace: makeTrace(
            { key: 'chain', request: { method: 'eth_chainId', params: [] } },
            '0x1',
            base,
          ),
          finalizedTrace: makeTrace(
            {
              key: 'finalized',
              request: { method: 'eth_getBlockByNumber', params: ['finalized', false] },
            },
            headerValue(SOURCE),
            base + 2,
          ),
          headerBeforeTrace: makeTrace(
            {
              key: 'phase_header_before',
              request: { method: 'eth_getBlockByNumber', params: [hex(SOURCE.blockNumber), false] },
            },
            headerValue(SOURCE),
            base + 4,
          ),
          headerAfterTrace: makeTrace(
            {
              key: 'phase_header_after',
              request: { method: 'eth_getBlockByNumber', params: [hex(SOURCE.blockNumber), false] },
            },
            headerValue(SOURCE),
            base + 900,
          ),
          acquiredAtUtc: ACQUIRED,
        },
      ],
      traces: reads.map((r, i) => makeTrace(r, fixtureValue(r.key, changes), base + 10 + i * 2)),
    })),
  }
  return { binding, wire }
}
const nativeError = (data?: string) => ({
  error: { code: 3, message: 'native_error' as const, ...(data ? { data } : {}) },
})
function replay(changes: Change = {}) {
  const f = currentFixture(changes)
  return replayApyUsdJointNativeCurrent(f.wire, f.binding)
}
function historyFixture(index = 112) {
  const cur = replay(),
    anchor = APY_USD_JOINT_NATIVE_ANCHORS.find((a) => a.cashIndex === index)!,
    actual = stockFrames.find(
      (f: { factsByOrigin: { cashIndex: number }[] }) => f.factsByOrigin[0].cashIndex === index,
    ).factsByOrigin[0]
  const binding: ApyUsdJointNativeHistoryBinding = {
    cashIndex: index,
    source: anchor.source,
    currentSource: SOURCE,
    fullSharesRaw: FULL_S,
    currentRuntimeRegime: cur.current.runtimeRegime,
    vestingAddress: VESTING,
    vaultUnlockingFeeWad: '1000000000000000',
    owner: null,
    acquiredAtUtc: ACQUIRED,
  }
  const changes = {
    vault_cash: result('balanceOf', BigInt(anchor.cashRaw)),
    full_escrow_ea: result('previewRedeem', BigInt(actual.fullSharePreviewRedeem.value)),
    full_gross_assets: result('convertToAssets', BigInt(actual.fullShareConvertToAssets.value)),
  }
  const reads = apyUsdJointNativeHistoryReadPlan(binding),
    base = Date.parse(ACQUIRED) - (10 + (reads.length - 1) * 2 + 1)
  const wire: ApyUsdJointNativeHistoryWire = {
    origins: ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'].map((host) => ({
      host,
      acquiredAtUtc: ACQUIRED,
      chainIdTrace: makeTrace(
        { key: 'chain', request: { method: 'eth_chainId', params: [] } },
        '0x1',
        base,
      ),
      traces: reads.map((r, i) =>
        makeTrace(r, fixtureValue(r.key, changes, anchor.source), base + 10 + i * 2),
      ),
    })),
  }
  return { binding, wire }
}

/** Native-derived unsigned fixtures; fresh clocks are synthetic headers, not RPC or authentication. */
function fixture() {
  const c = currentFixture(),
    availableAtUtc = new Date(NOW - 500).toISOString()
  const current: ApyUsdJointCurrentEvidence = { ...c, availableAtUtc }
  const history: ApyUsdJointHistoricalEvidence = {
    schema: 'apyusd_joint_native_history_evidence_v1',
    points: APY_USD_JOINT_NATIVE_ANCHORS.map((a) => historyFixture(a.cashIndex)),
    acquiredAtUtc: ACQUIRED,
    availableAtUtc,
    fullSharesRaw: FULL_S,
    owner: null,
    historicalOwnership: false,
    originalAuthority: false,
    authenticated: false,
    executionQualified: false,
  }
  const question: ApyUsdJointHolderForecastQuestion = {
    routeKey: APY_USD_JOINT_NATIVE_SUBJECT.routeKey,
    destination: VAULT,
    requestedHolderAddress: OWNER,
    requestedRaw: '1000000000000000000',
    requestedAssetAddress: APY_USD_JOINT_NATIVE_SUBJECT.asset,
    requestedAssetDecimals: 18,
    horizonHours: 168,
    asOfMs: NOW,
    plannedInitiationOffsetSeconds: 0,
    fundingBasis: 'native_liquid_cash',
    independentSource: clone(SOURCE),
  }
  return { current, history, question }
}
const issue = (f: ReturnType<typeof fixture>) =>
  issuedApyUsdJointHolderForecast(f.current, f.history, f.question)
function response(f: ReturnType<typeof fixture>) {
  return {
    apyUsdJointNativeCurrentEvidence: f.current,
    apyUsdJointHistoricalEvidence: f.history,
    apyUsdJointIssuedAtUtc: new Date(f.question.asOfMs).toISOString(),
  }
}
function shiftCaptureClocks(f: ReturnType<typeof fixture>, delta: number) {
  const shift = (v: string) => new Date(Date.parse(v) + delta).toISOString()
  const traceShift = (t: ApyUsdJointNativeTrace) => {
    t.startedAtUtc = shift(t.startedAtUtc)
    t.completedAtUtc = shift(t.completedAtUtc)
  }
  f.current.binding.acquiredAtUtc = shift(f.current.binding.acquiredAtUtc)
  f.current.availableAtUtc = shift(f.current.availableAtUtc)
  f.current.wire.origins.forEach((o) => {
    o.acquiredAtUtc = shift(o.acquiredAtUtc)
    o.traces.forEach(traceShift)
    o.phases.forEach((p) => {
      p.acquiredAtUtc = shift(p.acquiredAtUtc)
      ;[p.chainIdTrace, p.finalizedTrace, p.headerBeforeTrace, p.headerAfterTrace].forEach(
        traceShift,
      )
    })
  })
  f.history.acquiredAtUtc = shift(f.history.acquiredAtUtc)
  f.history.availableAtUtc = shift(f.history.availableAtUtc)
  f.history.points.forEach((p) => {
    p.binding.acquiredAtUtc = shift(p.binding.acquiredAtUtc)
    p.wire.origins.forEach((o) => {
      o.acquiredAtUtc = shift(o.acquiredAtUtc)
      ;[o.chainIdTrace, ...o.traces].forEach(traceShift)
    })
  })
  f.question.asOfMs += delta
}

describe('APY original private conditional holder binding', () => {
  it('replays native full S, complete receipts and eight history points with source age counted once', () => {
    const f = fixture(),
      m = issue(f)!
    expect(m).not.toBeNull()
    expect(m.process.sourceAgeMs).toBe(NOW - Date.parse(SOURCE.blockTime))
    expect(m.input.current.fullSharesRaw).toBe(FULL_S)
    expect(m.input.question.requestedRaw).toBe(f.question.requestedRaw)
    expect(m.input.current.receiptInventory?.receipts[0].escrowRaw).toBe(ESCROW)
    expect(m.input.history.length).toBe(8)
    expect(m.targetAtUtc).toBe(new Date(NOW + 168 * 3600000).toISOString())
    expect(m.authenticated).toBe(false)
    expect(m.executionQualified).toBe(false)
    expect(m.calibrated).toBe(false)
    expect(m.sourceImplementationEquivalence).toBe(false)
    expect(m.MRaw).toBe(null)
    expect(Object.isFrozen(m.input.current.receiptInventory)).toBe(true)
    const receipt = apyUsdJointHolderForecastIssue(m)!
    expect(receipt.candidateReceiptIds).toEqual(['881'])
    expect(receipt.ownedReceiptIds).toEqual(['881'])
    expect(selectedApyUsdJointHolderForecastFromIssue(receipt, f.question)).toBe(m)
  })
  it('binds exact holder/route/destination/asset/Q/H and planned initiation/funding basis', () => {
    const f = fixture(),
      m = issue(f)!,
      r = apyUsdJointHolderForecastIssue(m)!
    for (const change of [
      { requestedHolderAddress: '0x' + '1'.repeat(40) },
      { routeKey: 'wrong' },
      { destination: RECEIPT },
      { requestedAssetAddress: RECEIPT },
      { requestedRaw: '1' },
      { horizonHours: 24 },
      { plannedInitiationOffsetSeconds: 1 },
      { fundingBasis: 'cash_plus_vested_assumption' as const },
    ]) {
      const q = { ...f.question, ...change }
      expect(selectedApyUsdJointHolderForecast(m, q)).toBeNull()
      expect(selectedApyUsdJointHolderForecastIssue(r, q)).toBeNull()
    }
    expect(selectedApyUsdJointHolderForecast(m, clone(f.question))).toBe(m)
  })
  it('allows future horizons through 30 days and an explicit delayed planned action', () => {
    const f = fixture()
    f.question.horizonHours = 720
    f.question.plannedInitiationOffsetSeconds = 2592000
    const m = issue(f)!
    expect(m).not.toBeNull()
    expect(m.input.question.plannedInitiationOffsetSeconds).toBe(2592000)
    f.question.horizonHours = 721
    expect(issue(f)).toBeNull()
    f.question.horizonHours = 720
    f.question.plannedInitiationOffsetSeconds++
    expect(issue(f)).toBeNull()
  })
  it('rejects malformed or future issue questions without allowing accessor execution', () => {
    const f = fixture()
    for (const change of [
      { requestedRaw: '0' },
      { requestedRaw: '01' },
      { requestedAssetDecimals: 6 },
      { horizonHours: 1.5 },
      { asOfMs: Date.now() + 60000 },
      { plannedInitiationOffsetSeconds: -1 },
    ])
      expect(
        issuedApyUsdJointHolderForecast(f.current, f.history, {
          ...f.question,
          ...change,
        } as ApyUsdJointHolderForecastQuestion),
      ).toBeNull()
    let calls = 0
    Object.defineProperty(f.question, 'requestedRaw', {
      enumerable: true,
      get: () => {
        calls++
        return '1'
      },
    })
    expect(issue(f)).toBeNull()
    expect(calls).toBe(0)
  })
  it('requires the complete native NFT inventory including zero receipts; no decoded count override', () => {
    const f = fixture()
    f.current.wire.origins.forEach((o) => {
      o.traces.find((t) => t.key === 'owned_count')!.result = result('balanceOf', 2n)
    })
    expect(issue(f)).toBeNull()
    const g = fixture()
    g.current.binding.candidateReceiptIds = []
    expect(issue(g)).toBeNull()
  })
  it('retains native paused facts and a conditional zero exit band under the unchanged pause policy', () => {
    const f = fixture(),
      c = currentFixture({
        receipt_paused: result('paused', true),
        receipt_claimable_881: result('isClaimable', false),
        receipt_claim_881: nativeError('0xd93c0665'),
        full_share_sim: nativeError('0xd93c0665'),
      })
    f.current = { ...c, availableAtUtc: f.current.availableAtUtc }
    const m = issue(f)!
    expect(m).not.toBeNull()
    expect(m.input.current.receiptPaused).toBe(true)
    expect(m.process.scenarios.every((s) => s.target.availableRaw === '0')).toBe(true)
  })
  it('cannot join a different current source, share amount, policy or historical owner assertion', () => {
    const f = fixture()
    f.question.independentSource!.blockHash = '0x' + '1'.repeat(64)
    expect(issue(f)).toBeNull()
    const g = fixture()
    g.history.points[0].binding.fullSharesRaw = String(BigInt(FULL_S) + 1n)
    expect(issue(g)).toBeNull()
    const h = fixture()
    h.history.points[0].binding.vaultUnlockingFeeWad = '0'
    expect(issue(h)).toBeNull()
    const j = fixture()
    ;(j.history as unknown as { owner: string }).owner = OWNER
    expect(issue(j)).toBeNull()
    const k = fixture()
    k.history.points[0].binding.currentSource = { ...SOURCE, blockHash: '0x' + '1'.repeat(64) }
    expect(issue(k)).toBeNull()
  })
  it('requires all eight ordered anchors and immutable historical acquisition metadata', () => {
    const f = fixture()
    f.history.points = [...f.history.points].reverse()
    expect(issue(f)).toBeNull()
    const g = fixture()
    g.history.points = g.history.points.slice(1)
    expect(issue(g)).toBeNull()
    const h = fixture()
    h.history.acquiredAtUtc = new Date(Date.parse(ACQUIRED) - 1).toISOString()
    expect(issue(h)).toBeNull()
  })
  it('preserves an older original finalized reference and acquisition clocks when a matching-S history cache is reused', () => {
    const f = fixture(),
      reference = {
        ...SOURCE,
        blockNumber: SOURCE.blockNumber - 1000,
        blockHash: '0x' + '2'.repeat(64),
        blockTime: new Date(Date.parse(SOURCE.blockTime) - 86400000).toISOString(),
      }
    f.history.points.forEach((p) => {
      p.binding.currentSource = clone(reference)
    })
    const acquired = f.history.acquiredAtUtc,
      retained = f.history.availableAtUtc
    expect(issue(f)).not.toBeNull()
    expect(f.history.points[0].binding.currentSource).toEqual(reference)
    expect(f.history.acquiredAtUtc).toBe(acquired)
    expect(f.history.availableAtUtc).toBe(retained)
    f.history.points[0].binding.currentSource = { ...SOURCE, blockNumber: SOURCE.blockNumber + 1 }
    expect(issue(f)).toBeNull()
  })
  it('will not issue before current or historical original retention actually finished', () => {
    const f = fixture()
    f.current.availableAtUtc = new Date(NOW + 1).toISOString()
    expect(issue(f)).toBeNull()
    const g = fixture()
    g.history.availableAtUtc = new Date(NOW + 1).toISOString()
    expect(issue(g)).toBeNull()
    const h = fixture()
    h.history.availableAtUtc = new Date(Date.parse(ACQUIRED) - 1).toISOString()
    expect(issue(h)).toBeNull()
    const j = fixture()
    j.current.availableAtUtc = new Date(Date.parse(ACQUIRED) - 1).toISOString()
    expect(issue(j)).toBeNull()
  })
  it('keeps the original model and receipt identity despite later caller payload changes', () => {
    const f = fixture(),
      m = issue(f)!,
      r = apyUsdJointHolderForecastIssue(m)!
    f.current.binding.owner = '0x' + '1'.repeat(40)
    f.history.points[0].binding.fullSharesRaw = '1'
    expect(selectedApyUsdJointHolderForecast(m, f.question)).toBe(m)
    expect(selectedApyUsdJointHolderForecastFromIssue(r, f.question)).toBe(m)
    expect(selectedApyUsdJointHolderForecast(clone(m), f.question)).toBeNull()
    expect(selectedApyUsdJointHolderForecastFromIssue(clone(r), f.question)).toBeNull()
    expect(selectedApyUsdJointHolderForecast(f.current, f.question)).toBeNull()
    expect(apyUsdJointHolderForecastIssue(clone(m))).toBeNull()
  })
  it('uses the actual render clock; forged past or future clocks cannot revive an expired source', () => {
    const f = fixture()
    shiftCaptureClocks(f, -10000)
    const oldSource = {
      ...SOURCE,
      blockTime: new Date(Math.floor((Date.now() - 1801000) / 1000) * 1000).toISOString(),
    }
    f.current.binding.source = oldSource
    f.question.independentSource = clone(oldSource)
    f.current.wire.origins.forEach((o) => {
      o.traces
        .filter((t) => t.key.startsWith('header_'))
        .forEach((t) => {
          t.result = headerValue(oldSource)
        })
      o.phases.forEach((p) => {
        ;[p.finalizedTrace, p.headerBeforeTrace, p.headerAfterTrace].forEach((t) => {
          t.result = headerValue(oldSource)
        })
      })
    })
    f.history.points.forEach((p) => {
      p.binding.currentSource = clone(oldSource)
    })
    const m = issue(f)!
    expect(m).not.toBeNull()
    expect(apyUsdJointHolderForecastRenderWindow(m, f.question.asOfMs)).toBe(false)
    expect(selectedApyUsdJointHolderForecast(m, f.question, f.question.asOfMs)).toBeNull()
    const fresh = fixture(),
      valid = issue(fresh)!
    expect(apyUsdJointHolderForecastRenderWindow(valid, Date.now() + 60000)).toBe(false)
  })
  it('replays real JSON response transport into a new local private model with all authority flags false', () => {
    const f = fixture(),
      body = JSON.stringify(response(f)),
      m = apyUsdJointHolderForecastFromResponse(body, 200, f.question, Date.now())!
    expect(m).not.toBeNull()
    expect(selectedApyUsdJointHolderForecast(m, f.question)).toBe(m)
    expect(m.authenticated).toBe(false)
    const r = apyUsdJointHolderForecastIssueFromResponse(body, 200, f.question, Date.now())!
    expect(selectedApyUsdJointHolderForecastFromIssue(r, f.question)).not.toBeNull()
  })
  it('accepts only the matching partial response status and exact server issue timestamp', () => {
    const f = fixture(),
      body = response(f)
    expect(
      apyUsdJointHolderForecastFromResponse(
        { ...body, error: 'holder_exit_assessment_unavailable' },
        503,
        f.question,
        Date.now(),
      ),
    ).not.toBeNull()
    expect(
      apyUsdJointHolderForecastFromResponse(
        { ...body, error: 'different' },
        503,
        f.question,
        Date.now(),
      ),
    ).toBeNull()
    expect(apyUsdJointHolderForecastFromResponse(body, 500, f.question, Date.now())).toBeNull()
    expect(
      apyUsdJointHolderForecastFromResponse(
        { ...body, apyUsdJointIssuedAtUtc: new Date(NOW - 1).toISOString() },
        200,
        f.question,
        Date.now(),
      ),
    ).toBeNull()
    expect(apyUsdJointHolderForecastFromResponse(body, 200, f.question, NOW - 1)).toBeNull()
    expect(
      apyUsdJointHolderForecastFromResponse(body, 200, f.question, Date.now() + 60000),
    ).toBeNull()
  })
  it('rejects JSON/native mutations, duplicate keys, authority claims and oversized responses', () => {
    const f = fixture(),
      body = response(f)
    body.apyUsdJointNativeCurrentEvidence.wire.origins[0].traces.find(
      (t) => t.key === 'full_escrow_ea',
    )!.result = result('previewRedeem', 1n)
    expect(
      apyUsdJointHolderForecastFromResponse(JSON.stringify(body), 200, f.question, Date.now()),
    ).toBeNull()
    const g = fixture()
    ;(g.history as unknown as { authenticated: boolean }).authenticated = true
    expect(issue(g)).toBeNull()
    expect(
      apyUsdJointHolderForecastFromResponse(
        '{"apyUsdJointIssuedAtUtc":"x","apyUsdJointIssuedAtUtc":"y"}',
        200,
        f.question,
        Date.now(),
      ),
    ).toBeNull()
    expect(
      apyUsdJointHolderForecastFromResponse(
        {
          ...response(fixture()),
          excess: 'x'.repeat(APY_USD_JOINT_BINDING_LIMITS.transportBytes + 1),
        },
        200,
        f.question,
        Date.now(),
      ),
    ).toBeNull()
  })
})
