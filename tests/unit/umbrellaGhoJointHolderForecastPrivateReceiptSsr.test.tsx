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
  umbrellaGhoJointHolderForecastIssue,
  selectedUmbrellaGhoJointHolderForecastFromIssue,
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

import React from 'react'
import { ChakraProvider } from '@chakra-ui/react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ExitPressureCard,
  formatExitPressureSignedRaw,
  type ExitPressureCardProps,
  type ExitPressureUmbrellaGhoJointIssue,
} from '@/components/Carry/ExitPressureCard'
import {
  holderUmbrellaGhoJointIssueFromResponse,
  holderForecastHorizonOptions,
} from '@/components/Carry/ForecastWorkbench'
const base: ExitPressureCardProps = {
  scenarioMode: 'exit',
  routeKey: UMBRELLA_GHO_ROUTE,
  destination: UMBRELLA_STKGHO,
  requestedAmount: '1',
  requestedRaw: '1000000000000000000',
  requestedAssetSymbol: 'GHO',
  requestedAssetAddress: ORIGINAL_GHO,
  requestedAssetDecimals: 18,
  requestedHolderAddress: currentOriginal.owner,
  horizonHours: 168,
  asOfMs: ISSUE + 10,
  currentCash: null,
  prospectiveCashModel: null,
  historicalScenario: null,
  grossWithdrawals: null,
  grossInflows: null,
  historicalGrossFlow: null,
  morphoPayout: null,
  holderAssessment: null,
  expectedEventEnrollment: null,
  eventContext: null,
  historicalOutlook: null,
}
function nativeIssue() {
  const f = fixture()
  // Normal staged Umbrella requests have no generic atomic forecast reference.
  delete f.question.independentSource
  const { asOfMs, ...question } = f.question
  const response = {
    umbrellaGhoNativeCapacity: f.current,
    umbrellaGhoJointHistoricalEvidence: f.evidence,
    umbrellaGhoJointIssuedAtUtc: new Date(asOfMs).toISOString(),
  }
  const retained = holderUmbrellaGhoJointIssueFromResponse(response, 200, question, ISSUE + 1)!
  return { f, response, question, retained }
}
function render(
  retained: ExitPressureUmbrellaGhoJointIssue | null,
  changed: Partial<ExitPressureCardProps> = {},
) {
  return renderToStaticMarkup(
    <ChakraProvider>
      <ExitPressureCard {...base} holderUmbrellaGhoJointIssue={retained} {...changed} />
    </ChakraProvider>,
  )
}
function expected(retained: ExitPressureUmbrellaGhoJointIssue) {
  const model = selectedUmbrellaGhoJointHolderForecastFromIssue(
    retained.issue,
    retained.question,
    ISSUE + 10,
  )!
  const band = model.process.targetSummary!.headroom.band
  return `${formatExitPressureSignedRaw(band.p10Raw, 18)}–${formatExitPressureSignedRaw(band.p90Raw, 18)} GHO`
}
// Retrospective SSR and original-local-private identity controls only. No RPC,
// fresh original acquisition, browser acceptance, execution or calibration.
describe('Umbrella actual native response and private original Card selection', () => {
  it('uses real client receive clock and renders original GHO18 band at actual issue+H', () => {
    const { retained, response, question } = nativeIssue()
    expect(retained).not.toBeNull()
    expect(holderUmbrellaGhoJointIssueFromResponse(response, 200, question, ISSUE - 1)).toBeNull()
    expect(Object.hasOwn(retained.question, 'independentSource')).toBe(false)
    expect(retained.issue.source).toEqual(currentOriginal.source)
    expect(Object.hasOwn(retained.issue, 'independentSource')).toBe(false)
    const html = render(retained)
    expect(html).toContain('Expected headroom')
    expect(html).toContain(expected(retained))
    const model = selectedUmbrellaGhoJointHolderForecastFromIssue(
      retained.issue,
      retained.question,
    )!
    expect(model.targetAtUtc).toBe(new Date(ISSUE + 168 * 3600000).toISOString())
    expect(html).not.toContain(' USDC')
  })
  it('retains a real different alternate trajectory but cannot substitute it into the original receipt', () => {
    const { f, retained } = nativeIssue(),
      original = expected(retained),
      changed = alternate(f)
    const other = issuedUmbrellaGhoJointHolderForecast(f.current, changed, f.question)!
    expect(other.process.targetSummary).not.toBeNull()
    expect(other.process.targetSummary!.headroom.band).not.toEqual(
      selectedUmbrellaGhoJointHolderForecastFromIssue(retained.issue, retained.question)!.process
        .targetSummary!.headroom.band,
    )
    ;(retained.nativeCapacity as any).ghoCashRaw = '0'
    retained.historicalEvidence = changed
    expect(render(retained)).toContain(original)
  })
  it('omits cloned receipts, changed complete question or current source witness and expired/before-issue render clocks', () => {
    const { retained } = nativeIssue(),
      band = expected(retained)
    expect(render({ ...retained, issue: structuredClone(retained.issue) })).not.toContain(band)
    for (const changed of [
      { requestedRaw: '2' },
      { horizonHours: 24 },
      { requestedHolderAddress: '0x' + '1'.repeat(40) },
      { requestedAssetAddress: UMBRELLA_STKGHO },
      { requestedAssetDecimals: 6 },
      { destination: ORIGINAL_GHO },
      { routeKey: 'wrong' },
      { asOfMs: ISSUE - 1 },
      { asOfMs: Date.parse(currentOriginal.source.blockTime) + 1800001 },
    ])
      expect(render(retained, changed)).not.toContain(band)
    const wrongWitness = {
      routeKey: UMBRELLA_GHO_ROUTE,
      destination: UMBRELLA_STKGHO,
      cashRaw: currentOriginal.ghoCashRaw,
      assetDecimals: 18,
      assetSymbol: 'GHO',
      assetAddress: ORIGINAL_GHO,
      observedAt: currentOriginal.source.blockTime,
      block: String(currentOriginal.source.blockNumber),
      blockHash: '0x' + '1'.repeat(64),
      freshness: 'fresh' as const,
      label: 'Vault cash' as const,
    }
    const f = fixture(),
      explicit = issuedUmbrellaGhoJointHolderForecast(f.current, f.evidence, f.question)!
    const bound: ExitPressureUmbrellaGhoJointIssue = {
      question: f.question,
      issue: umbrellaGhoJointHolderForecastIssue(explicit)!,
      nativeCapacity: f.current,
      historicalEvidence: f.evidence,
    }
    expect(render(bound, { currentCash: wrongWitness })).not.toContain(expected(bound))
    const q = {
      ...retained.question,
      independentSource: { ...currentOriginal.source, blockHash: '0x' + '1'.repeat(64) },
    }
    expect(render({ ...retained, question: q })).not.toContain(band)
  })
  it('uses the original native model with stale unrelated cash and observation-only cash in normal staged requests', () => {
    const { retained } = nativeIssue(),
      band = expected(retained)
    expect(Object.hasOwn(retained.question, 'independentSource')).toBe(false)
    const context = {
      routeKey: UMBRELLA_GHO_ROUTE,
      destination: UMBRELLA_STKGHO,
      cashRaw: '123000000000000000000',
      assetDecimals: 18,
      assetSymbol: 'GHO',
      assetAddress: ORIGINAL_GHO,
      label: 'Vault cash' as const,
    }
    const stale = {
      ...context,
      observedAt: '2026-10-01T12:00:00.000Z',
      block: '26000000',
      blockHash: '0x' + '1'.repeat(64),
      freshness: 'stale' as const,
    }
    expect(render(retained, { currentCash: stale })).toContain(band)
    const observation = {
      ...context,
      observedAt: '2026-10-08T20:12:00.000Z',
      freshness: 'fresh' as const,
    }
    expect(render(retained, { currentCash: observation })).toContain(band)
    expect(
      selectedUmbrellaGhoJointHolderForecastFromIssue(retained.issue, retained.question)?.source,
    ).toEqual(currentOriginal.source)
  })
  it('keeps a censored original model but renders no diagnostic band as expected headroom', () => {
    const { f } = nativeIssue()
    f.question.horizonHours = 720
    const changed = alternate(f)
    for (const [i, p] of changed.points.entries())
      for (const o of p.wire.origins)
        for (const t of o.traces)
          if (t.key === 'fullEaRaw' || t.key === 'coveredEaRaw')
            t.result = encodeFunctionResult({
              abi: UMBRELLA_GHO_NATIVE_ABI,
              functionName: 'previewRedeem',
              result: BigInt(f.current.fullEaRaw) * BigInt(8 - i),
            })
    const model = issuedUmbrellaGhoJointHolderForecast(f.current, changed, f.question)!
    expect(model).not.toBeNull()
    expect(model.process.targetSummary).toBeNull()
    const retained: ExitPressureUmbrellaGhoJointIssue = {
      question: f.question,
      issue: umbrellaGhoJointHolderForecastIssue(model)!,
      nativeCapacity: f.current,
      historicalEvidence: changed,
    }
    const html = render(retained, { horizonHours: 720 })
    expect(html).toContain('Expected headroom')
    expect(html).toContain('—')
    expect(selectedUmbrellaGhoJointHolderForecastFromIssue(retained.issue, retained.question)).toBe(
      model,
    )
  })
  it('offers fourteen/thirty-day horizons only for exact Umbrella exit subject', () => {
    expect(holderForecastHorizonOptions(UMBRELLA_GHO_ROUTE, UMBRELLA_STKGHO, 'exit')).toEqual([
      1, 24, 48, 168, 336, 720,
    ])
    expect(holderForecastHorizonOptions(UMBRELLA_GHO_ROUTE, ORIGINAL_GHO, 'exit')).toEqual([
      1, 24, 48, 168,
    ])
    expect(holderForecastHorizonOptions(UMBRELLA_GHO_ROUTE, UMBRELLA_STKGHO, 'deposit')).toEqual([
      1, 24, 48, 168,
    ])
    expect(holderForecastHorizonOptions('wrong', UMBRELLA_STKGHO, 'exit')).toEqual([1, 24, 48, 168])
  })
  it('forwards a legitimate partial503 native response without changing required assessment execution evidence', () => {
    const { response, question } = nativeIssue()
    const partial = {
      ...response,
      error: 'holder_exit_assessment_unavailable',
      executionAgreement: { unqualified: true },
    }
    const before = JSON.stringify(partial)
    const retained = holderUmbrellaGhoJointIssueFromResponse(partial, 503, question, ISSUE + 10)!
    expect(retained).not.toBeNull()
    expect(render(retained)).toContain(expected(retained))
    expect(JSON.stringify(partial)).toBe(before)
    expect(holderUmbrellaGhoJointIssueFromResponse(response, 503, question, ISSUE + 10)).toBeNull()
  })
})
