import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { encodeFunctionData, encodeFunctionResult } from 'viem'
import {
  umbrellaGhoJointNativeHistoryReadPlan,
  type UmbrellaGhoJointNativeHistoryBinding,
  type UmbrellaGhoJointNativeHistoryWire,
} from '@/lib/carry/umbrellaGhoJointNativeHistory'
import {
  UMBRELLA_GHO_NATIVE_ABI,
  projectUmbrellaGhoNativeHeader,
} from '@/lib/carry/umbrellaGhoNativeCapacity'
import { UMBRELLA_STKGHO } from '@/lib/carry/umbrellaGhoExit'

const archive = join(
  process.cwd(),
  'data/research/venue-signals/umbrella-gho-joint-native-evidence-2026-10-08',
)
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const indexBytes = readFileSync(join(archive, 'evidence-index.json'))
if (sha(indexBytes) !== '98b80e938432a08511ef163040cf24285dacdb61031465b2a8c3dd54cad86e6b')
  throw Error('expected independently retained archive index')
const index = JSON.parse(indexBytes.toString())
function original<T>(name: string): T {
  const row = index.files.find((r: { destination: string }) => r.destination === name)
  const b = readFileSync(join(archive, name))
  if (!row || row.bytes !== b.length || row.sha256 !== sha(b))
    throw Error('original fixture byte drift')
  return JSON.parse(b.toString()) as T
}
// Read sealed archived codes/raw facts once. Mutated copies are unsigned structural controls.
const plan = original<any>('history-292/plan.json')
const prior = original<any>('current-74/qualified-current.json')
// Reconstruct chain/finality from both archived native bootstrap witnesses.
// The compact qualified-current source intentionally contains only three identity fields.
const currentWitnesses = [1, 2, 3, 4].map((id) => ({
  start: original<any>('current-74/rpc-start-' + String(id).padStart(4, '0') + '.json'),
  response: original<any>('current-74/rpc-response-' + String(id).padStart(4, '0') + '.bin'),
}))
for (let origin = 0; origin < 2; origin++) {
  const chain = currentWitnesses[origin * 2],
    finalized = currentWitnesses[origin * 2 + 1]
  const host = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'][origin]
  if (
    chain.start.host !== host ||
    finalized.start.host !== host ||
    chain.start.request.method !== 'eth_chainId' ||
    JSON.stringify(chain.start.request.params) !== '[]' ||
    chain.response.jsonrpc !== '2.0' ||
    chain.response.id !== chain.start.request.id ||
    chain.response.result !== '0x1' ||
    finalized.start.request.method !== 'eth_getBlockByNumber' ||
    JSON.stringify(finalized.start.request.params) !== '["finalized",false]' ||
    finalized.response.jsonrpc !== '2.0' ||
    finalized.response.id !== finalized.start.request.id ||
    Number(BigInt(finalized.response.result.number)) !== prior.source.blockNumber ||
    finalized.response.result.hash !== prior.source.blockHash ||
    new Date(Number(BigInt(finalized.response.result.timestamp)) * 1000).toISOString() !==
      prior.source.blockTime
  )
    throw Error('archived current chain/finalized source witness mismatch')
}
const currentSource = { ...prior.source, chainId: 1 as const, finalized: true as const }
const legacy = original<any[]>('history-292/replayed-native-points.json')
const terminals = [
  original<any>('history-292/batch-0-terminal.json'),
  original<any>('history-292/batch-1-terminal.json'),
]
const BASELINES = Array.from({ length: 8 }, (_, anchor) => {
  const terminal = terminals[Math.floor(anchor / 4)],
    point = legacy[anchor]
  const wire: UmbrellaGhoJointNativeHistoryWire = {
    origins: ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'].map((host, origin) => {
      const traces = terminal.ledger
        .slice(2 + (anchor % 4) * 36 + origin * 18, 2 + (anchor % 4) * 36 + (origin + 1) * 18)
        .map((row: any, i: number) => ({
          key: [
            'headerBefore',
            'implementationSlot',
            'proxyCode',
            'implementationCode',
            'assetCode',
            'asset',
            'shareDecimals',
            'assetDecimals',
            'fullEaRaw',
            'coveredEaRaw',
            'cashRaw',
            'paused',
            'totalAssetsRaw',
            'totalSupplyRaw',
            'cooldownSeconds',
            'unstakeWindowSeconds',
            'maxSlashableAssetsRaw',
            'headerAfter',
          ][i],
          request: { method: row.request.method, params: row.request.params },
          result: JSON.parse(Buffer.from(row.rawBodyBase64, 'base64').toString()).result,
          completedAtUtc: row.completedAtUtc,
        }))
      return {
        host,
        chainIdTrace: {
          key: 'chain',
          request: { method: 'eth_chainId', params: [] },
          result: JSON.parse(
            Buffer.from(terminal.ledger[origin].rawBodyBase64, 'base64').toString(),
          ).result,
        },
        traces,
        acquiredAtUtc: point.originAcquiredAtUtc[origin].acquiredAtUtc,
      }
    }),
  }
  const binding: UmbrellaGhoJointNativeHistoryBinding = {
    cashIndex: point.cashIndex,
    source: point.source,
    currentSource,
    fullSharesRaw: plan.sharesRaw,
    cooldownSharesRaw: plan.cooldownCoveredSharesRaw,
    acquiredAtUtc: point.acquiredAtUtc,
  }
  return { wire, binding }
})

import {
  issuedUmbrellaGhoJointHolderForecast,
  selectedUmbrellaGhoJointHolderForecast,
  umbrellaGhoJointHolderForecastIssue,
  selectedUmbrellaGhoJointHolderForecastFromIssue,
  umbrellaGhoJointHolderForecastFromResponse,
  type UmbrellaGhoJointHolderForecastQuestion,
} from '@/lib/carry/umbrellaGhoJointHolderForecastBinding'
import { ORIGINAL_GHO, UMBRELLA_GHO_ROUTE } from '@/lib/carry/umbrellaGhoExit'
const currentBytes = readFileSync(
  join(process.cwd(), 'tests/unit/fixtures/umbrella-gho-native-current50-oct8.json'),
)
if (sha(currentBytes) !== '3294e23d58c3dbdbca1b129dd14593a7081d92316cb867522e32353d60df8d3e')
  throw Error('current50 fixture changed')
const currentOriginal = JSON.parse(currentBytes.toString())
const ISSUE = Date.parse('2026-10-08T20:13:27.674Z')
function fixture() {
  const current = structuredClone(currentOriginal)
  const points = structuredClone(BASELINES).map((p) => ({
    ...p,
    binding: { ...p.binding, currentSource: structuredClone(current.source) },
  }))
  // Match the actual producer transport: raw headers remain in the sealed originals.
  for (const p of points)
    for (const o of p.wire.origins)
      for (const t of o.traces)
        if (t.key === 'headerBefore' || t.key === 'headerAfter')
          t.result = projectUmbrellaGhoNativeHeader(t.result)
  const evidence = {
    schema: 'umbrella_gho_joint_native_history_evidence_v1',
    subject: {
      fullSharesRaw: current.fullSharesRaw,
      cooldownSharesRaw: current.cooldownSharesRaw,
      owner: null,
      historicalOwnership: false,
    },
    points,
    acquiredAtUtc: new Date(
      Math.max(...points.map((p) => Date.parse(p.binding.acquiredAtUtc))),
    ).toISOString(),
    originalAuthority: false,
    authenticated: false,
    historicalOwnership: false,
    executionQualified: false,
    forecastIssued: false,
  }
  const question: UmbrellaGhoJointHolderForecastQuestion = {
    routeKey: UMBRELLA_GHO_ROUTE,
    destination: UMBRELLA_STKGHO,
    requestedHolderAddress: current.owner,
    requestedRaw: '1000000000000000000',
    requestedAssetAddress: ORIGINAL_GHO,
    requestedAssetDecimals: 18,
    horizonHours: 168,
    asOfMs: ISSUE,
    independentSource: structuredClone(current.source),
  }
  return { current, evidence, question }
}
function alternate(f: ReturnType<typeof fixture>) {
  const changed = structuredClone(f.evidence)
  for (const [i, p] of changed.points.entries())
    for (const o of p.wire.origins)
      for (const t of o.traces)
        if (t.key === 'fullEaRaw' || t.key === 'coveredEaRaw')
          t.result = encodeFunctionResult({
            abi: UMBRELLA_GHO_NATIVE_ABI,
            functionName: 'previewRedeem',
            result: BigInt(f.current.fullEaRaw) + BigInt(i) * 1000000000000000000n,
          })
  return changed
}
// Retrospective unsigned native originals and structural mutations only: no RPC,
// fresh acquisition, historical ownership, calibration or execution authority.
describe('Umbrella original private conditional holder forecast', () => {
  it('replays full native S/Ea separately from cooldown S/Ea and issues actual issue plus H through thirty days', () => {
    const f = fixture(),
      m = issuedUmbrellaGhoJointHolderForecast(f.current, f.evidence, f.question)!
    expect(m).not.toBeNull()
    expect(m.issueAtUtc).toBe(new Date(ISSUE).toISOString())
    expect(m.targetAtUtc).toBe(new Date(ISSUE + 168 * 3600000).toISOString())
    expect(m.process.sourceAgeMs).toBe(ISSUE - Date.parse(f.current.source.blockTime))
    expect(m.process.projectionElapsedMs).toBe(
      ISSUE - Date.parse(f.current.source.blockTime) + 168 * 3600000,
    )
    expect(m.process.input.current.fullSharesRaw).toBe(f.current.fullSharesRaw)
    expect(m.process.input.current.fullEaRaw).toBe(f.current.fullEaRaw)
    expect(m.process.MRaw).toBeNull()
    expect(m.originalAuthority).toBe(false)
    const long = issuedUmbrellaGhoJointHolderForecast(f.current, f.evidence, {
      ...f.question,
      horizonHours: 720,
    })!
    expect(long).not.toBeNull()
    expect(long.targetAtUtc).toBe(new Date(ISSUE + 720 * 3600000).toISOString())
    expect(
      issuedUmbrellaGhoJointHolderForecast(f.current, f.evidence, {
        ...f.question,
        horizonHours: 721,
      }),
    ).toBeNull()
  })
  it('keeps native partial cooldown shares and covered preview distinct from full S and Ea', () => {
    const f = fixture(),
      cs = BigInt(f.current.fullSharesRaw) / 2n
    f.current.cooldownSharesRaw = String(cs)
    f.current.cooldownSnapshotEaRaw = String(cs)
    const snapshot = f.current.traces.find((t: any) => t.key === 'snapshot')
    snapshot.result = encodeFunctionResult({
      abi: UMBRELLA_GHO_NATIVE_ABI,
      functionName: 'getStakerCooldown',
      result: [cs, f.current.cooldownEnd, f.current.withdrawalWindowSeconds],
    })
    const preview = f.current.traces.find((t: any) => t.key === 'snapshot_ea')
    preview.request.params[0].data = encodeFunctionData({
      abi: UMBRELLA_GHO_NATIVE_ABI,
      functionName: 'previewRedeem',
      args: [cs],
    })
    preview.result = encodeFunctionResult({
      abi: UMBRELLA_GHO_NATIVE_ABI,
      functionName: 'previewRedeem',
      result: cs,
    })
    f.evidence.subject.cooldownSharesRaw = String(cs)
    for (const p of f.evidence.points) {
      p.binding.cooldownSharesRaw = String(cs)
      const plan = umbrellaGhoJointNativeHistoryReadPlan(p.binding)!
      for (const o of p.wire.origins)
        for (const t of o.traces) {
          if (t.key === 'coveredEaRaw') {
            t.request = structuredClone(plan.find((s) => s.key === t.key)!.request)
            t.result = encodeFunctionResult({
              abi: UMBRELLA_GHO_NATIVE_ABI,
              functionName: 'previewRedeem',
              result: cs,
            })
          }
        }
    }
    const m = issuedUmbrellaGhoJointHolderForecast(f.current, f.evidence, f.question)!,
      receipt = umbrellaGhoJointHolderForecastIssue(m)!
    expect(m).not.toBeNull()
    expect(receipt.sharesRaw).toBe(currentOriginal.fullSharesRaw)
    expect(receipt.fullEaRaw).toBe(currentOriginal.fullEaRaw)
    expect(receipt.cooldownSharesRaw).toBe(String(cs))
    expect(receipt.cooldownSnapshotEaRaw).toBe(String(cs))
    expect(receipt.fullEaRaw).not.toBe(receipt.cooldownSnapshotEaRaw)
  })
  it('applies Q once without changing full S, full Ea or covered Ea', () => {
    const f = fixture(),
      a = issuedUmbrellaGhoJointHolderForecast(f.current, f.evidence, f.question)!,
      b = issuedUmbrellaGhoJointHolderForecast(f.current, f.evidence, {
        ...f.question,
        requestedRaw: '2000000000000000000',
      })!
    expect(a.process.targetSummary).not.toBeNull()
    expect(b.process.targetSummary).not.toBeNull()
    expect(
      BigInt(a.process.targetSummary!.headroom.band.p10Raw) -
        BigInt(b.process.targetSummary!.headroom.band.p10Raw),
    ).toBe(1000000000000000000n)
    expect(a.process.targetSummary!.available).toEqual(b.process.targetSummary!.available)
    expect(umbrellaGhoJointHolderForecastIssue(a)?.sharesRaw).toBe(
      umbrellaGhoJointHolderForecastIssue(b)?.sharesRaw,
    )
    expect(umbrellaGhoJointHolderForecastIssue(a)?.fullEaRaw).toBe(
      umbrellaGhoJointHolderForecastIssue(b)?.fullEaRaw,
    )
  })
  it('selects the exact original model even after accepted alternate trajectories yield a different band', () => {
    const f = fixture(),
      m = issuedUmbrellaGhoJointHolderForecast(f.current, f.evidence, f.question)!,
      issue = umbrellaGhoJointHolderForecastIssue(m)!,
      changed = alternate(f),
      other = issuedUmbrellaGhoJointHolderForecast(f.current, changed, f.question)!
    expect(other).not.toBeNull()
    expect(other.process.targetSummary).not.toBeNull()
    expect(other.process.targetSummary!.headroom.band).not.toEqual(
      m.process.targetSummary!.headroom.band,
    )
    f.evidence = changed
    f.current.ghoCashRaw = '0'
    expect(selectedUmbrellaGhoJointHolderForecastFromIssue(issue, f.question, ISSUE + 1)).toBe(m)
    expect(
      selectedUmbrellaGhoJointHolderForecastFromIssue(structuredClone(issue), f.question),
    ).toBeNull()
    expect(selectedUmbrellaGhoJointHolderForecast(structuredClone(m), f.question)).toBeNull()
    expect(Object.isFrozen(m.process.input.current)).toBe(true)
  })
  it('retains censored models, private receipts and null headline diagnostics', () => {
    const f = fixture()
    f.question.horizonHours = 720
    const declining = alternate(f)
    for (const [i, p] of declining.points.entries())
      for (const o of p.wire.origins)
        for (const t of o.traces)
          if (t.key === 'fullEaRaw' || t.key === 'coveredEaRaw')
            t.result = encodeFunctionResult({
              abi: UMBRELLA_GHO_NATIVE_ABI,
              functionName: 'previewRedeem',
              result: BigInt(f.current.fullEaRaw) * BigInt(8 - i),
            })
    const m = issuedUmbrellaGhoJointHolderForecast(f.current, declining, f.question)!
    expect(m).not.toBeNull()
    expect(m.process.targetSummary).toBeNull()
    expect(m.process.scenarios.some((s) => s.status === 'censored')).toBe(true)
    expect(
      selectedUmbrellaGhoJointHolderForecastFromIssue(
        umbrellaGhoJointHolderForecastIssue(m),
        f.question,
      ),
    ).toBe(m)
  })
  it('binds the actual three-field required source without synthesizing finality and rejects altered five-field flags', () => {
    const f = fixture(),
      source = f.current.source
    f.question.independentSource = {
      blockNumber: source.blockNumber,
      blockHash: source.blockHash,
      blockTime: source.blockTime,
    }
    const m = issuedUmbrellaGhoJointHolderForecast(f.current, f.evidence, f.question)!,
      issue = umbrellaGhoJointHolderForecastIssue(m)!
    expect(m).not.toBeNull()
    expect(issue.independentSource).toEqual(f.question.independentSource)
    expect(selectedUmbrellaGhoJointHolderForecastFromIssue(issue, f.question)).toBe(m)
    expect(
      selectedUmbrellaGhoJointHolderForecastFromIssue(issue, {
        ...f.question,
        independentSource: source,
      }),
    ).toBeNull()
    for (const drift of [
      { ...source, chainId: 2 },
      { ...source, finalized: false },
      { ...source, extra: true },
    ])
      expect(
        issuedUmbrellaGhoJointHolderForecast(f.current, f.evidence, {
          ...f.question,
          independentSource: drift as any,
        }),
      ).toBeNull()
  })
  it('rejects question drift, before-issue clocks and source TTL expiry', () => {
    const f = fixture(),
      m = issuedUmbrellaGhoJointHolderForecast(f.current, f.evidence, f.question)!,
      issue = umbrellaGhoJointHolderForecastIssue(m)!
    const changes = [
      { routeKey: 'wrong' },
      { destination: ORIGINAL_GHO },
      { requestedHolderAddress: '0x' + '1'.repeat(40) },
      { requestedRaw: '2' },
      { requestedAssetAddress: UMBRELLA_STKGHO },
      { requestedAssetDecimals: 6 },
      { horizonHours: 24 },
      { asOfMs: ISSUE + 1 },
      { independentSource: { ...f.current.source, blockHash: '0x' + '1'.repeat(64) } },
    ]
    for (const c of changes)
      expect(
        selectedUmbrellaGhoJointHolderForecastFromIssue(issue, { ...f.question, ...c }),
      ).toBeNull()
    expect(selectedUmbrellaGhoJointHolderForecastFromIssue(issue, f.question, ISSUE - 1)).toBeNull()
    expect(
      selectedUmbrellaGhoJointHolderForecastFromIssue(
        issue,
        f.question,
        Date.parse(f.current.source.blockTime) + 1800001,
      ),
    ).toBeNull()
  })
  it('replays canonical current and history trace guards before issuing, without invoking accessors', () => {
    const f = fixture()
    let calls = 0
    Object.defineProperty(f.current, 'fullEaRaw', {
      enumerable: true,
      get: () => {
        calls++
        return '1'
      },
    })
    expect(issuedUmbrellaGhoJointHolderForecast(f.current, f.evidence, f.question)).toBeNull()
    expect(calls).toBe(0)
    const clean = fixture()
    clean.evidence.points[0].wire.origins[0].traces.find((t) => t.key === 'fullEaRaw')!.result =
      '0x01'
    expect(
      issuedUmbrellaGhoJointHolderForecast(clean.current, clean.evidence, clean.question),
    ).toBeNull()
    const drift = fixture()
    drift.evidence.subject.fullSharesRaw = '1'
    expect(
      issuedUmbrellaGhoJointHolderForecast(drift.current, drift.evidence, drift.question),
    ).toBeNull()
    const code = fixture()
    code.current.runtimeCodeHashes[ORIGINAL_GHO] = '0x' + '1'.repeat(64)
    expect(
      issuedUmbrellaGhoJointHolderForecast(code.current, code.evidence, code.question),
    ).toBeNull()
    const header = fixture()
    header.current.traces.find((t: any) => t.key === 'header_after').result.hash =
      '0x' + '1'.repeat(64)
    expect(
      issuedUmbrellaGhoJointHolderForecast(header.current, header.evidence, header.question),
    ).toBeNull()
    const future = fixture()
    future.evidence.acquiredAtUtc = new Date(ISSUE + 1).toISOString()
    expect(
      issuedUmbrellaGhoJointHolderForecast(future.current, future.evidence, future.question),
    ).toBeNull()
  })
  it('accepts exact 200/partial503 clocks and rejects future receipt or unbounded/malformed envelopes', () => {
    const f = fixture(),
      response = {
        umbrellaGhoNativeCapacity: f.current,
        umbrellaGhoJointHistoricalEvidence: f.evidence,
        umbrellaGhoJointIssuedAtUtc: new Date(ISSUE).toISOString(),
      }
    expect(
      umbrellaGhoJointHolderForecastFromResponse(response, 200, f.question, ISSUE + 10),
    ).not.toBeNull()
    expect(
      umbrellaGhoJointHolderForecastFromResponse(
        { ...response, error: 'holder_exit_assessment_unavailable' },
        503,
        f.question,
        ISSUE + 10,
      ),
    ).not.toBeNull()
    expect(
      umbrellaGhoJointHolderForecastFromResponse(response, 503, f.question, ISSUE + 10),
    ).toBeNull()
    expect(
      umbrellaGhoJointHolderForecastFromResponse(response, 200, f.question, ISSUE - 1),
    ).toBeNull()
    expect(
      umbrellaGhoJointHolderForecastFromResponse(
        { ...response, umbrellaGhoJointIssuedAtUtc: new Date(ISSUE + 1).toISOString() },
        200,
        f.question,
        ISSUE + 10,
      ),
    ).toBeNull()
    expect(
      issuedUmbrellaGhoJointHolderForecast(
        f.current,
        { ...f.evidence, points: [...f.evidence.points, ...f.evidence.points] },
        f.question,
      ),
    ).toBeNull()
    expect(
      issuedUmbrellaGhoJointHolderForecast(
        f.current,
        { ...f.evidence, oversized: 'x'.repeat(1500000) },
        f.question,
      ),
    ).toBeNull()
  })
})
