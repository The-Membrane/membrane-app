// Offline by default; explicit capture is parent-authorized only. Daily endpoint cash and holder getter summaries are not
// shared protocol capacity proofs. Plan and replay never start RPC.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync, statfsSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeFunctionData, parseAbi } from 'viem'
import { buildSubjectManifest } from '../record-carry-cash-issues.mjs'
import { verifyLocalCarryCash } from '../lib/localCarryCashStore.mjs'
import {
  buildSupplementalAaveUsdeCashManifest,
  verifyLocalSupplementalAaveUsdeCash,
} from '../lib/localSupplementalAaveUsdeCashStore.mjs'
import { ROUTES } from './carry-fluid-ftoken-payout.mjs'
import { verify as verifyFluidFlow, OUT as FLUID_FLOW } from './fluid-ftoken-gross-flow.mjs'

export const SCHEMA = 'protocol_capacity_history_plan_v1'
const LIQUIDITY = '0x52aa899454998be5b000ad077a46bbe360f4e497'
const RESOLVER = '0xca13a15de31235a37134b4717021c35a3cf25c60'
const HOSTS = Object.freeze(['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'])
const ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function getUserSupplyData(address user,address token) view',
])
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const SHA = /^[0-9a-f]{64}$/
const check = (ok, reason) => {
  if (!ok) throw new Error(`protocol_capacity_history_${reason}`)
}
const seal = (body) => ({
  ...body,
  sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
})
const utc = (value) =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value

// A locator preserves both historical source time and when its evidence became
// locally known. Missing observations stay on the grid; never join across holes.
export function selectAnchorGrid(ledger, limit = 120) {
  check(Number.isInteger(limit) && limit > 0 && limit <= 120, 'grid_limit')
  const rows = ledger.records.filter((row) => row.collectionMode === 'retrospective')
  rows.sort((a, b) => Date.parse(a.anchorAt) - Date.parse(b.anchorAt))
  const grid = rows.slice(-limit).map((row) => {
    check(
      row.chainId === 1 &&
        /^(0|[1-9][0-9]*)$/.test(row.block) &&
        HASH.test(row.blockHash) &&
        SHA.test(row.sha256) &&
        utc(row.anchorAt) &&
        utc(row.blockAt) &&
        utc(row.firstLocalReceiptAt) &&
        Date.parse(row.blockAt) <= Date.parse(row.anchorAt),
      'anchor',
    )
    return {
      anchorAt: row.anchorAt,
      source: {
        chainId: 1,
        blockNumber: row.block,
        blockHash: row.blockHash,
        blockTime: row.blockAt,
      },
      receiptSha256: row.sha256,
      firstLocalReceiptAt: row.firstLocalReceiptAt,
      rows: row.rows,
    }
  })
  check(
    grid.every(
      (row, i) =>
        !i ||
        (Date.parse(row.anchorAt) > Date.parse(grid[i - 1].anchorAt) &&
          BigInt(row.source.blockNumber) > BigInt(grid[i - 1].source.blockNumber)),
    ),
    'anchor_order',
  )
  return grid
}

export function protocolAdapter(subject) {
  const fluid = ROUTES.find(
    (route) =>
      route.key === subject.route_key &&
      route.vault === subject.destination &&
      route.asset === subject.asset,
  )
  return fluid
    ? {
        id: 'fluid_shared_liquidity_resolver_v1',
        status: 'requires_historical_state_revalidation',
        liquidity: LIQUIDITY,
        resolver: RESOLVER,
        implementationSourceAttested: false,
        requiredFacts: [
          'shared_bank_cash_C',
          'native_user_supply_S',
          'expanded_minimum_remaining_supply_W',
          'historical_implementation_identity',
          'pause_and_authority',
        ],
      }
    : {
        id: null,
        status: 'protocol_adapter_not_implemented',
        requiredFacts: [
          'protocol_accessible_capacity',
          'withdrawal_limits',
          'native_final_asset_legs',
          'historical_implementation_identity',
        ],
      }
}

export function planProtocolHistory(subjects, grid, witness, cutoffAt) {
  check(
    utc(cutoffAt) && SHA.test(witness.manifestSha256) && SHA.test(witness.headSha256),
    'witness',
  )
  check(
    grid.every((anchor) => Date.parse(anchor.firstLocalReceiptAt) <= Date.parse(cutoffAt)),
    'knowledge_cutoff',
  )
  const slots = subjects.map((subject) => {
    check(
      typeof subject.route_key === 'string' &&
        ADDRESS.test(subject.destination) &&
        ADDRESS.test(subject.asset),
      'subject',
    )
    const units = new Set(
      grid.flatMap((anchor) =>
        anchor.rows
          .filter(
            (row) =>
              row.routeKey === subject.route_key &&
              row.destination === subject.destination &&
              row.state === 'observed' &&
              row.asset === subject.asset &&
              Number.isInteger(row.assetDecimals),
          )
          .map((row) => row.assetDecimals),
      ),
    )
    check(units.size <= 1, 'mixed_native_units')
    const assetDecimals = units.size ? [...units][0] : null
    check(assetDecimals === null || (assetDecimals >= 0 && assetDecimals <= 36), 'native_units')
    const observations = grid.map((anchor) => {
      const rows = anchor.rows.filter(
        (row) => row.routeKey === subject.route_key && row.destination === subject.destination,
      )
      check(rows.length === 1, 'subject_grid')
      const row = rows[0]
      check(
        row.state !== 'observed' ||
          (row.asset === subject.asset && row.assetDecimals === assetDecimals),
        'native_identity',
      )
      return {
        state: row.state,
        reason: row.reason,
        capacityStatus: 'unattested',
        C: null,
        S: null,
        W: null,
      }
    })
    return {
      routeKey: subject.route_key,
      destination: subject.destination,
      asset: subject.asset,
      assetDecimals,
      adapter: protocolAdapter(subject),
      observations,
    }
  })
  return seal({
    schema: SCHEMA,
    knowledgeCutoffAt: cutoffAt,
    witness,
    anchors: grid.map(({ rows, ...anchor }) => anchor),
    subjects: slots,
    semantics: {
      cashMetric: 'underlying_balance_of_shared_liquidity_bank',
      supplyMetric: 'resolver_native_fToken_user_supply',
      limitMetric: 'resolver_expanded_minimum_remaining_supply',
      getDataLiquidityBalanceIsCash: false,
      ownerGetterFractionIsProtocolCapacity: false,
      holderExecutableExit: false,
      forwardProbability: false,
      prospectiveValidated: false,
    },
    flowArchives: [],
  })
}

// State-request subset only. Capture must also attest finalized ceiling, stable
// before/after headers, identity/decimals and proxy/implementation at each header.
export function firstFluidRequests(plan, routeIndex = 0) {
  check(
    plan.schema === SCHEMA &&
      Number.isInteger(routeIndex) &&
      routeIndex >= 0 &&
      routeIndex < ROUTES.length,
    'route_index',
  )
  const route = ROUTES[routeIndex],
    slot = plan.subjects.find(
      (s) => s.routeKey === route.key && s.destination === route.vault && s.asset === route.asset,
    )
  check(slot?.adapter.id === 'fluid_shared_liquidity_resolver_v1', 'fluid_subject')
  const indices = slot.observations
    .map((row, i) => (row.state === 'observed' ? i : null))
    .filter((i) => i !== null)
  const start = indices.find(
    (i) =>
      slot.observations[i + 1]?.state === 'observed' &&
      Date.parse(plan.anchors[i + 1].anchorAt) - Date.parse(plan.anchors[i].anchorAt) === 86400000,
  )
  check(start !== undefined, 'contiguous_pair_missing')
  const endpoints = [plan.anchors[start], plan.anchors[start + 1]]
  const requests = []
  for (const endpoint of endpoints)
    for (const host of HOSTS)
      for (const [fact, to, functionName, args] of [
        ['C', LIQUIDITY, 'balanceOf', [LIQUIDITY]],
        ['S_W', RESOLVER, 'getUserSupplyData', [route.vault, route.asset]],
      ]) {
        // C is the underlying asset's bank balance, not balanceOf on the bank itself.
        requests.push({
          host,
          source: endpoint.source,
          fact,
          method: 'eth_call',
          params: [
            {
              to: fact === 'C' ? route.asset : to,
              data: encodeFunctionData({ abi: ABI, functionName, args }),
            },
            { blockHash: endpoint.source.blockHash, requireCanonical: true },
          ],
        })
      }
  return {
    schema: 'protocol_capacity_history_capture_plan_v1',
    routeKey: route.key,
    destination: route.vault,
    asset: route.asset,
    assetDecimals: slot.assetDecimals,
    planSha256: plan.sha256,
    sourceElapsedSeconds:
      (Date.parse(endpoints[1].source.blockTime) - Date.parse(endpoints[0].source.blockTime)) /
      1000,
    stateRequests: requests,
    budget: {
      maxPhysicalRequests: 64,
      deadlineMs: 60000,
      rpcTimeoutMs: 8000,
      cleanupGraceMs: 250,
      maxInFlightPerOrigin: 2,
      minStartSpacingMs: 50,
      maxResponseBytes: 131072,
      diskReserveBytes: 1342177280,
    },
    requiredSetup: [
      'chain1_and_finalized_ceiling',
      'before_after_historical_headers',
      'asset_native_decimals',
      'runtime_codehashes_with_proxyinspection_not_read',
      'official_resolver_ABI_decode',
      'two_origin_agreement',
      'preserve_reverts_misses_and_contradictions',
    ],
    captureImplemented: true,
  }
}

export function selectProtocolSource(plan, selector) {
  const anchor =
    selector === 'flow-start'
      ? plan.flowArchives[0]?.endpointSources?.[0]
      : selector === 'flow-end'
        ? plan.flowArchives[0]?.endpointSources?.[1]
        : plan.anchors.find((anchor) => anchor.anchorAt === selector)?.source
  check(
    anchor &&
      anchor.chainId === 1 &&
      HASH.test(anchor.blockHash) &&
      utc(anchor.blockTime) &&
      /^(0|[1-9][0-9]*)$/.test(String(anchor.blockNumber)),
    'source_selector',
  )
  const blockNumber = Number(anchor.blockNumber)
  check(Number.isSafeInteger(blockNumber) && blockNumber > 0, 'source_block')
  return { ...anchor, blockNumber, finalized: true }
}

function exact(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}
export async function exportProtocolCapacityPair(plan, routeIndex, baseline, target, replay) {
  const route = ROUTES[routeIndex],
    slot = plan.subjects.find((s) => s.routeKey === route?.key && s.destination === route.vault)
  check(slot && slot.adapter.id === 'fluid_shared_liquidity_resolver_v1', 'pair_subject')
  const subject = {
    routeKey: slot.routeKey,
    destination: slot.destination,
    asset: slot.asset,
    assetDecimals: slot.assetDecimals,
  }
  const allowedSources = [
    ...plan.anchors.map((a) => a.source),
    ...(plan.flowArchives[0]?.endpointSources ?? []),
  ]
  const bind = (receipt) => {
    const source = allowedSources.find(
      (s) =>
        String(s.blockNumber) === String(receipt.source?.blockNumber) &&
        s.blockHash === receipt.source?.blockHash &&
        s.blockTime === receipt.source?.blockTime,
    )
    check(source, 'pair_source_not_independently_pinned')
    return replay(receipt, subject, {
      ...source,
      blockNumber: Number(source.blockNumber),
      finalized: true,
    })
  }
  const a = await bind(baseline),
    b = await bind(target)
  check(a && b, 'pair_prongs_unavailable')
  const elapsedSeconds = (Date.parse(b.source.blockTime) - Date.parse(a.source.blockTime)) / 1000
  check(elapsedSeconds > 0 && b.source.blockNumber > a.source.blockNumber, 'pair_chronology')
  check(
    exact(
      [a.routeKey, a.destination, a.asset, a.assetDecimals],
      [subject.routeKey, subject.destination, subject.asset, subject.assetDecimals],
    ) &&
      exact(
        [b.routeKey, b.destination, b.asset, b.assetDecimals],
        [subject.routeKey, subject.destination, subject.asset, subject.assetDecimals],
      ),
    'pair_native_identity',
  )
  const identitiesMatch = exact(a.origins[0].identities, b.origins[0].identities)
  const parameterKeys = [
    'lastUpdateTimestamp',
    'expandPercent',
    'expandDuration',
    'baseWithdrawalLimitRaw',
    'decayEndTimestamp',
    'reportedDecayAmountRaw',
  ]
  const parametersPresent = parameterKeys.every(
    (k) =>
      Object.hasOwn(a.origins[0].limitParameters ?? {}, k) &&
      Object.hasOwn(b.origins[0].limitParameters ?? {}, k),
  )
  const stableParameters =
    parametersPresent &&
    parameterKeys
      .filter(
        (k) => !['lastUpdateTimestamp', 'decayEndTimestamp', 'reportedDecayAmountRaw'].includes(k),
      )
      .every((k) => a.origins[0].limitParameters[k] === b.origins[0].limitParameters[k])
  const delta = {}
  for (const [name, key] of [
    ['C', 'sharedLiquidityCashRaw'],
    ['S', 'resolverSupplyRaw'],
    ['W', 'expandedWithdrawalLimitRaw'],
  ]) {
    check(
      /^(0|[1-9][0-9]*)$/.test(a.prongs[key]) && /^(0|[1-9][0-9]*)$/.test(b.prongs[key]),
      'pair_prong_raw',
    )
    delta[name] = (BigInt(b.prongs[key]) - BigInt(a.prongs[key])).toString()
  }
  const first = Date.parse(a.source.blockTime) / 1000,
    last = Date.parse(b.source.blockTime) / 1000,
    flow = plan.flowArchives[0]
  const fullFlowOverlap =
    flow?.status === 'verified_ftoken_event_archive' &&
    flow.firstBlockTime <= first &&
    flow.lastBlockTime >= last
  return seal({
    schema: 'protocol_capacity_joint_prong_path_v1',
    status: 'verified_conditional_protocol_prong_history',
    subject,
    knowledgeCutoffAt: [baseline.capturedAt, target.capturedAt].sort().at(-1),
    historicalSourceTimesUnchanged: true,
    manifestSha256: plan.witness.manifestSha256,
    sourceEvidence: [a.source, b.source],
    proofSha256: [baseline.sha256, target.sha256],
    elapsedSeconds,
    baselineProngs: a.prongs,
    targetProngs: b.prongs,
    baselineLimitParameters: a.origins[0].limitParameters ?? null,
    targetLimitParameters: b.origins[0].limitParameters ?? null,
    runtimeIdentities: [a.origins[0].identities, b.origins[0].identities],
    signedNativeDeltas: delta,
    regime: {
      identitiesMatch,
      proxyImplementationContinuity: 'unknown_not_read',
      parametersPresent,
      stableParameters,
      sourceEquivalence: 'unverified_at_captured_runtime',
      pause: 'unknown',
      authority: 'unknown',
    },
    flowOverlap: {
      completeFTokenEventOverlap: fullFlowOverlap,
      sharedBankCompetitionComplete: false,
      depositIsCashReplenishment: false,
      netDeltaIsGrossFlow: false,
      archiveTipSha256: flow?.tipSha256 ?? null,
    },
    holderExecutableExit: false,
    executableMaximumRaw: null,
    forwardProbability: false,
    prospectiveValidated: false,
  })
}

export async function captureProtocolCapacityPair(
  plan,
  routeIndex,
  sources,
  origins,
  {
    capture,
    now = Date.now,
    wait = async (ms) => {
      const started = performance.now()
      while (performance.now() - started < ms)
        await new Promise((resolve) =>
          setTimeout(resolve, Math.ceil(ms - (performance.now() - started))),
        )
    },
  } = {},
) {
  check(typeof capture === 'function' && sources.length === 2, 'collector_required')
  const route = ROUTES[routeIndex],
    slot = plan.subjects.find((s) => s.routeKey === route?.key && s.destination === route.vault)
  check(slot?.adapter.id === 'fluid_shared_liquidity_resolver_v1', 'capture_subject')
  check(
    sources[1].blockNumber > sources[0].blockNumber &&
      Date.parse(sources[1].blockTime) > Date.parse(sources[0].blockTime),
    'capture_chronology',
  )
  check(origins.length === 2 && origins.every((o, i) => o.host === HOSTS[i]), 'capture_origins')
  const allowed = [
    ...plan.anchors.map((a) => a.source),
    ...(plan.flowArchives[0]?.endpointSources ?? []),
  ]
  check(
    sources.every((source) =>
      allowed.some(
        (a) =>
          String(a.blockNumber) === String(source.blockNumber) &&
          a.blockHash === source.blockHash &&
          a.blockTime === source.blockTime,
      ),
    ),
    'capture_source_not_pinned',
  )
  const subject = {
      routeKey: slot.routeKey,
      destination: slot.destination,
      asset: slot.asset,
      assetDecimals: slot.assetDecimals,
    },
    started = now(),
    outcomes = []
  let starts = 0
  for (const source of sources) {
    if (outcomes.length) await wait(50)
    const remaining = 60000 - (now() - started)
    if (remaining < 1000 || 64 - starts < 28) {
      outcomes.push({
        source,
        status: 'censored',
        reason: 'shared_budget_exhausted',
        receipt: null,
      })
      continue
    }
    try {
      const receipt = await capture(subject, origins, {
        source,
        maxRequests: 64 - starts,
        deadlineMs: remaining,
        now,
      })
      check(
        receipt?.budget && Number.isSafeInteger(receipt.budget.physicalRequestStarts),
        'capture_count',
      )
      starts += receipt.budget.physicalRequestStarts
      check(starts <= 64, 'shared_request_cap')
      outcomes.push({ source, status: 'captured', receipt })
    } catch (error) {
      const receipt = error.failedReceipt ?? null
      if (receipt?.budget && Number.isSafeInteger(receipt.budget.physicalRequestStarts))
        starts += receipt.budget.physicalRequestStarts
      outcomes.push({ source, status: 'censored', reason: 'endpoint_capture_failed', receipt })
      // With no raw counted failure receipt, another endpoint cannot be started.
      if (!receipt) break
    }
  }
  check(starts <= 64 && now() - started <= 60250, 'shared_capture_budget')
  return seal({
    schema: 'protocol_capacity_history_pair_receipt_v1',
    subject,
    manifestSha256: plan.witness.manifestSha256,
    startedAt: new Date(started).toISOString(),
    capturedAt: new Date(now()).toISOString(),
    physicalRequestStarts: starts,
    outcomes,
  })
}

export async function replayProtocolCapacityPair(receipt, plan, replay) {
  const { sha256, ...body } = receipt
  check(
    seal(body).sha256 === sha256 &&
      receipt.schema === 'protocol_capacity_history_pair_receipt_v1' &&
      receipt.manifestSha256 === plan.witness.manifestSha256,
    'pair_receipt_integrity',
  )
  const routeIndex = ROUTES.findIndex(
    (r) =>
      r.key === receipt.subject.routeKey &&
      r.vault === receipt.subject.destination &&
      r.asset === receipt.subject.asset,
  )
  check(
    routeIndex >= 0 && Array.isArray(receipt.outcomes) && receipt.outcomes.length <= 2,
    'pair_receipt_subject',
  )
  const slot = plan.subjects.find(
    (s) => s.routeKey === receipt.subject.routeKey && s.destination === receipt.subject.destination,
  )
  check(
    slot &&
      receipt.subject.asset === slot.asset &&
      receipt.subject.assetDecimals === slot.assetDecimals,
    'pair_receipt_native_units',
  )
  check(
    Number.isSafeInteger(receipt.physicalRequestStarts) &&
      receipt.physicalRequestStarts <= 64 &&
      utc(receipt.startedAt) &&
      utc(receipt.capturedAt) &&
      Date.parse(receipt.capturedAt) >= Date.parse(receipt.startedAt) &&
      Date.parse(receipt.capturedAt) - Date.parse(receipt.startedAt) <= 60250,
    'pair_receipt_budget',
  )
  if (receipt.outcomes.length !== 2 || receipt.outcomes.some((o) => o.status !== 'captured'))
    return {
      status: 'censored_protocol_capacity_history_pair',
      reason: 'endpoint_capture_failed',
      outcomes: receipt.outcomes,
      holderExecutableExit: false,
    }
  const starts = receipt.outcomes.reduce(
    (sum, o) => sum + o.receipt.budget.physicalRequestStarts,
    0,
  )
  check(
    starts === receipt.physicalRequestStarts &&
      receipt.outcomes.every(
        (o) =>
          exact(o.source, o.receipt.source) &&
          Date.parse(o.receipt.startedAt) >= Date.parse(receipt.startedAt) &&
          Date.parse(o.receipt.capturedAt) <= Date.parse(receipt.capturedAt),
      ),
    'pair_receipt_accounting',
  )
  return exportProtocolCapacityPair(
    plan,
    routeIndex,
    receipt.outcomes[0].receipt,
    receipt.outcomes[1].receipt,
    replay,
  )
}

async function collector() {
  return import('./carry-fluid-capacity-prongs.mjs')
}
function writeBounded(path, value) {
  const bytes = Buffer.from(JSON.stringify(value) + '\n')
  check(bytes.length <= 9 * 1024 * 1024, 'output_size')
  const disk = statfsSync(resolve('.'), { bigint: true })
  check(disk.bavail * disk.bsize - BigInt(bytes.length) >= 1342177280n, 'disk_reserve')
  writeFileSync(path, bytes, { flag: 'wx' })
}

function fluidFlowLocator() {
  if (!existsSync(join(FLUID_FLOW, 'plan.json')))
    return { status: 'archive_missing', sharedBankCompetition: false }
  const verified = verifyFluidFlow()
  const names = readdirSync(FLUID_FLOW)
    .filter((name) => /^range-\d+-\d+\.json$/.test(name))
    .sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]))
  const endpoints = names.length
    ? [names[0], names.at(-1)].map((name) =>
        JSON.parse(readFileSync(join(FLUID_FLOW, name), 'utf8')),
      )
    : []
  return {
    status: 'verified_ftoken_event_archive',
    ...verified,
    firstBlockTime: endpoints[0]?.witnesses[0]?.headers[0]?.timestamp ?? null,
    lastBlockTime: endpoints.at(-1)?.witnesses[0]?.headers.at(-1)?.timestamp ?? null,
    sharedBankCompetition: false,
    depositIsCashReplenishment: false,
    withdrawEventIsFinalPayout: false,
    capacityFactsPresent: false,
    endpointSources: endpoints.map((row, i) => {
      const h = i === 0 ? row.witnesses[0].headers[0] : row.witnesses[0].headers.at(-1)
      return {
        chainId: 1,
        blockNumber: String(h.number),
        blockHash: h.hash,
        blockTime: new Date(h.timestamp * 1000).toISOString(),
      }
    }),
    coverage: 'fToken_deposit_withdraw_events_only_other_shared_bank_users_not_covered',
  }
}

export async function loadProtocolHistoryPlan(asOfMs = Date.now()) {
  const manifest = await buildSubjectManifest(),
    ledger = verifyLocalCarryCash(manifest)
  check(
    ledger.last && Date.parse(ledger.last.firstLocalReceiptAt) <= asOfMs,
    'ledger_knowledge_cutoff',
  )
  const core = planProtocolHistory(
    manifest.subjects,
    selectAnchorGrid(ledger),
    { scope: 'registered_core', manifestSha256: manifest.sha256, headSha256: ledger.last.sha256 },
    new Date(asOfMs).toISOString(),
  )
  const supplementalManifest = await buildSupplementalAaveUsdeCashManifest({
      issueManifest: manifest,
    }),
    supplementalLedger = verifyLocalSupplementalAaveUsdeCash(supplementalManifest)
  check(
    supplementalLedger.last && Date.parse(supplementalLedger.last.firstLocalReceiptAt) <= asOfMs,
    'supplemental_knowledge_cutoff',
  )
  const supplemental = planProtocolHistory(
    supplementalManifest.subjects,
    selectAnchorGrid(supplementalLedger),
    {
      scope: 'supplemental_separate',
      manifestSha256: supplementalManifest.sha256,
      headSha256: supplementalLedger.last.sha256,
    },
    new Date(asOfMs).toISOString(),
  )
  delete core.sha256
  core.flowArchives = [fluidFlowLocator()]
  return { core: seal(core), supplemental }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2] ?? 'plan',
      option = (name) =>
        process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
    check(['plan', 'requests', 'capture', 'replay'].includes(command), 'command')
    const result = await loadProtocolHistoryPlan(),
      output = option('output')
    let value = result
    if (command === 'requests')
      value = firstFluidRequests(result.core, Number(option('route') ?? 0))
    if (command === 'capture') {
      check(output && !existsSync(output), 'unique_output_required')
      const disk = statfsSync(resolve('.'), { bigint: true })
      check(disk.bavail * disk.bsize >= 1342177280n + 9n * 1024n * 1024n, 'disk_reserve')
      const { captureFluidCapacityProngs } = await collector(),
        { configuredProviders, readProviderPolicy } =
          await import('./carry-depth-quote-archive.mjs'),
        { readEnv } = await import('../lib/venue-reads.mjs')
      const policy = readProviderPolicy()
      check(
        policy.status === 'active' && policy.policyId === 'configured-c1-c3-v1',
        'provider_policy',
      )
      const origins = configuredProviders(readEnv(), policy)
      value = await captureProtocolCapacityPair(
        result.core,
        Number(option('route') ?? 0),
        [
          selectProtocolSource(result.core, option('baseline') ?? 'flow-start'),
          selectProtocolSource(result.core, option('target') ?? 'flow-end'),
        ],
        origins,
        { capture: captureFluidCapacityProngs },
      )
    }
    if (command === 'replay') {
      const input = option('input')
      check(input && output && !existsSync(output), 'replay_paths')
      check(statSync(input).size <= 9 * 1024 * 1024, 'input_size')
      const bytes = readFileSync(input)
      const { replayFluidCapacityProngs } = await collector()
      value = await replayProtocolCapacityPair(
        JSON.parse(bytes.toString()),
        result.core,
        replayFluidCapacityProngs,
      )
    }
    if (output) writeBounded(output, value)
    else
      console.log(
        JSON.stringify({
          schema: SCHEMA,
          coreSubjects: result.core.subjects.length,
          coreGroups: new Set(result.core.subjects.map((s) => s.routeKey)).size,
          anchors: result.core.anchors.length,
          supplementalSubjects: result.supplemental.subjects.length,
          fluidSubjects: result.core.subjects.filter((s) => s.adapter.id).length,
          flowArchives: result.core.flowArchives,
          stateRequests: value.stateRequests?.length ?? null,
        }),
      )
  } catch {
    console.error('protocol_capacity_history_failed')
    process.exitCode = 1
  }
}
