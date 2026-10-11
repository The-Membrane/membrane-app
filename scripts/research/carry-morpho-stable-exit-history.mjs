// Outcome-blind retrospective design and resumable, one-vault/anchor execution.
// Historical eth_call evidence is research; it is not a prospective exit forecast.
import { createHash } from 'node:crypto'
import { linkSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { parseAbi } from 'viem'

import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { findFirstBlockAtOrAfter, loadUniverse } from './carry-morpho-exit-history-panel.mjs'
import {
  DESIGN as GRID_DESIGN,
  classifyProbe,
  holderState,
  identity,
  lossIntervals,
  measureVault,
  qLadder,
  simulate,
} from './carry-morpho-exit-history-grid.mjs'

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function totalAssets() view returns (uint256)',
])
const sha = (x) => createHash('sha256').update(x).digest('hex')
const unsigned = ({ planSha256, ...rest }) => rest
const unsignedCell = ({ cellSha256, ...rest }) => rest
const sealCell = (value) => ({ ...value, cellSha256: sha(JSON.stringify(value)) })
const checkedNumber = (x) => {
  const n = Number(x)
  if (!Number.isSafeInteger(n) || n < 0) throw Error('unsafe_number')
  return n
}
const lower = (x) => String(x).toLowerCase()

export const DESIGN = Object.freeze({
  schemaVersion: 1,
  study: 'carry-morpho-v2-stable-holder-exit-history',
  chainId: 1,
  manifestSha256: GRID_DESIGN.manifestSha256,
  assets: [USDC, USDT],
  // Set from a round-number rule after all 40 stable vaults' manifest creation blocks,
  // before any exit outcome inspection. The earlier six-vault panel begins after these.
  anchors: [25_400_000, 25_600_000, 25_800_000, 26_000_000],
  horizonsHours: [1, 4, 24, 48, 168],
  qLabels: GRID_DESIGN.qLabels,
  candidateLookbackBlocks: GRID_DESIGN.candidateLookbackBlocks,
  candidateLimit: GRID_DESIGN.candidateLimit,
  reservedHoldoutAnchor: 26_000_000,
  cohortSelection:
    'current pinned tracked-set survivors assessed retrospectively; vaults absent from the current tracked list are not sampled',
  episodeIndependence:
    'anchor clocks must be >168h apart; repeated holder-vault pairs remain dependent clusters',
  receiptAndExitMethod:
    'reuse corrected grid receipt-verified pre-anchor EOA selection, same-holder withdraw(Q,holder,holder), attrition-censored interval labels',
  forecast: false,
  prospectiveValidated: false,
})

export function stableSubjects(universe = loadUniverse()) {
  const subjects = universe
    .filter((x) => DESIGN.assets.includes(x.asset))
    .map((x) => ({
      ...x,
      routeKey: x.asset === USDC ? 'USDC → VaultV2 [USDC]' : 'USDT → VaultV2 [USDT]',
    }))
  if (
    subjects.length !== 40 ||
    new Set(subjects.map((x) => x.vault)).size !== 40 ||
    subjects.some(
      (x) =>
        !ADDRESS.test(x.vault) ||
        !DESIGN.assets.includes(x.asset) ||
        !Number.isSafeInteger(x.creationBlock) ||
        x.creationBlock >= DESIGN.anchors[0],
    )
  )
    throw Error('stable_manifest_cohort_invalid')
  return subjects.sort((a, b) => a.vault.localeCompare(b.vault))
}

async function header(client, number) {
  const b = await client.getBlock({ blockNumber: BigInt(number) })
  if (b.number !== BigInt(number) || !HASH.test(lower(b.hash)) || typeof b.timestamp !== 'bigint')
    throw Error('anchor_header_invalid')
  return { number, hash: lower(b.hash), timestamp: checkedNumber(b.timestamp) }
}

export async function freezeSchedule(client, design = DESIGN) {
  if (!isDeepStrictEqual(design, DESIGN) || (await client.getChainId()) !== 1)
    throw Error('study_or_chain_invalid')
  const finalized = await client.getBlock({ blockTag: 'finalized' })
  if (!HASH.test(lower(finalized.hash)) || typeof finalized.timestamp !== 'bigint')
    throw Error('finalized_header_invalid')
  const head = {
    number: checkedNumber(finalized.number),
    hash: lower(finalized.hash),
    timestamp: checkedNumber(finalized.timestamp),
  }
  const anchors = []
  for (const number of design.anchors) {
    const anchor = await header(client, number)
    if (head.number <= number) throw Error('anchor_not_finalized')
    const horizons = []
    for (const hours of design.horizonsHours) {
      const target = anchor.timestamp + hours * 3600
      if (head.timestamp < target) {
        horizons.push({ hours, requestedTimestamp: target, status: 'head_censored' })
        continue
      }
      const result = await findFirstBlockAtOrAfter(client, anchor, target, head)
      if (result.realizedLagSeconds < 0 || result.realizedLagSeconds > 30)
        throw Error('horizon_header_gap')
      horizons.push({ hours, status: 'fixed', ...result })
    }
    anchors.push({ anchor, horizons })
  }
  for (let i = 1; i < anchors.length; i++)
    if (anchors[i].anchor.timestamp - anchors[i - 1].anchor.timestamp <= 168 * 3600)
      throw Error('episodes_overlap')
  return { head, anchors }
}

/** Read only pre-anchor aggregate state. Freeze every Q before any holder/event search. */
export async function freezeCell(client, subject, anchor) {
  const base = {
    vault: subject.vault,
    asset: subject.asset,
    routeKey: subject.routeKey,
    anchorBlock: anchor.number,
  }
  if (subject.creationBlock >= anchor.number) return { ...base, status: 'not_created_at_anchor' }
  const pinned = { blockHash: anchor.hash, requireCanonical: true }
  try {
    const [asset, totalAssets] = await Promise.all([
      client.readContract({ address: subject.vault, abi: ABI, functionName: 'asset', ...pinned }),
      client.readContract({
        address: subject.vault,
        abi: ABI,
        functionName: 'totalAssets',
        ...pinned,
      }),
    ])
    if (lower(asset) !== subject.asset) return { ...base, status: 'asset_identity_mismatch' }
    if (typeof totalAssets !== 'bigint' || totalAssets <= 0n)
      return { ...base, status: 'unfunded_at_anchor' }
    return {
      ...base,
      status: 'frozen',
      totalAssetsRaw: totalAssets.toString(),
      sizes: qLadder(totalAssets, 0n, 6, DESIGN).map(({ label, assetsRaw }) => ({
        label,
        assetsRaw,
      })),
    }
  } catch {
    return { ...base, status: 'preflight_rpc_unavailable' }
  }
}

/** Complete this whole plan and save it before executing any cell. No partial plan measures holders. */
export async function freezeFullPlan(client, subjects = stableSubjects()) {
  if (!isDeepStrictEqual(subjects, stableSubjects())) throw Error('stable_subjects_invalid')
  const schedule = await freezeSchedule(client)
  const cells = []
  for (const plan of schedule.anchors)
    for (const subject of subjects) cells.push(await freezeCell(client, subject, plan.anchor))
  const body = {
    schemaVersion: DESIGN.schemaVersion,
    study: DESIGN.study,
    chainId: 1,
    mode: 'historical_read_only',
    prospectiveValidated: false,
    futureExitForecast: false,
    design: DESIGN,
    subjects,
    schedule,
    cells,
  }
  const result = { ...body, planSha256: sha(JSON.stringify(body)) }
  validatePlan(result)
  return result
}

export function validatePlan(plan) {
  if (
    plan?.schemaVersion !== 1 ||
    plan.study !== DESIGN.study ||
    plan.chainId !== 1 ||
    plan.mode !== 'historical_read_only' ||
    plan.prospectiveValidated !== false ||
    plan.futureExitForecast !== false ||
    !isDeepStrictEqual(plan.design, DESIGN) ||
    !isDeepStrictEqual(plan.subjects, stableSubjects()) ||
    plan.planSha256 !== sha(JSON.stringify(unsigned(plan))) ||
    plan.schedule?.anchors?.length !== DESIGN.anchors.length ||
    !HASH.test(plan.schedule?.head?.hash || '') ||
    !Number.isSafeInteger(plan.schedule?.head?.number) ||
    !Number.isSafeInteger(plan.schedule?.head?.timestamp) ||
    plan.cells?.length !== DESIGN.anchors.length * plan.subjects.length
  )
    throw Error('stable_plan_invalid')
  for (let ai = 0; ai < DESIGN.anchors.length; ai++) {
    const entry = plan.schedule.anchors[ai]
    if (
      entry.anchor.number !== DESIGN.anchors[ai] ||
      !HASH.test(entry.anchor.hash) ||
      !isDeepStrictEqual(
        entry.horizons.map((x) => x.hours),
        DESIGN.horizonsHours,
      )
    )
      throw Error('stable_schedule_invalid')
    if (
      ai > 0 &&
      entry.anchor.timestamp - plan.schedule.anchors[ai - 1].anchor.timestamp <= 168 * 3600
    )
      throw Error('episodes_overlap')
    for (const h of entry.horizons) {
      if (h.requestedTimestamp !== entry.anchor.timestamp + h.hours * 3600)
        throw Error('horizon_target_invalid')
      if (h.status === 'fixed') {
        if (
          !HASH.test(h.hash) ||
          h.number <= entry.anchor.number ||
          h.timestamp - h.requestedTimestamp !== h.realizedLagSeconds ||
          h.realizedLagSeconds < 0 ||
          h.realizedLagSeconds > 30 ||
          h.priorTimestamp >= h.requestedTimestamp
        )
          throw Error('horizon_block_invalid')
      } else if (
        h.status !== 'head_censored' ||
        plan.schedule.head.timestamp >= h.requestedTimestamp
      )
        throw Error('horizon_censor_invalid')
    }
    for (let vi = 0; vi < plan.subjects.length; vi++) {
      const cell = plan.cells[ai * plan.subjects.length + vi]
      const subject = plan.subjects[vi]
      if (
        cell.vault !== subject.vault ||
        cell.asset !== subject.asset ||
        cell.routeKey !== subject.routeKey ||
        cell.anchorBlock !== entry.anchor.number
      )
        throw Error('cell_route_invalid')
      if (cell.status === 'frozen') {
        if (
          !/^[1-9]\d*$/.test(cell.totalAssetsRaw) ||
          !isDeepStrictEqual(
            cell.sizes,
            qLadder(BigInt(cell.totalAssetsRaw), 0n, 6, DESIGN).map(({ label, assetsRaw }) => ({
              label,
              assetsRaw,
            })),
          )
        )
          throw Error('cell_sizes_invalid')
      } else if (
        ![
          'not_created_at_anchor',
          'asset_identity_mismatch',
          'unfunded_at_anchor',
          'preflight_rpc_unavailable',
        ].includes(cell.status)
      )
        throw Error('cell_status_invalid')
    }
  }
  return true
}

/** One bounded unit: one vault, one anchor, six frozen sizes, five frozen horizons. */
export async function runCell(client, plan, anchorBlock, vault) {
  validatePlan(plan)
  const ai = DESIGN.anchors.indexOf(anchorBlock)
  const vi = plan.subjects.findIndex((x) => x.vault === lower(vault))
  if (ai < 0 || vi < 0) throw Error('cell_not_in_plan')
  const frozen = plan.cells[ai * plan.subjects.length + vi]
  const schedule = plan.schedule.anchors[ai]
  if (frozen.status !== 'frozen') {
    const skipped = {
      planSha256: plan.planSha256,
      anchorBlock,
      vault: frozen.vault,
      routeKey: frozen.routeKey,
      status: frozen.status,
      row: null,
    }
    const sealed = sealCell(skipped)
    validateCellResult(plan, sealed)
    return sealed
  }
  const measured = await measureVault(
    client,
    plan.subjects[vi],
    { anchor: schedule.anchor, horizons: schedule.horizons.filter((x) => x.status === 'fixed') },
    DESIGN,
  )
  if (
    measured.vault !== frozen.vault ||
    measured.asset !== frozen.asset ||
    (measured.totalAssetsRaw !== undefined && measured.totalAssetsRaw !== frozen.totalAssetsRaw) ||
    (measured.sizes &&
      !isDeepStrictEqual(
        measured.sizes.map(({ label, assetsRaw }) => ({ label, assetsRaw })),
        frozen.sizes,
      ))
  )
    throw Error('measured_cell_differs_from_frozen_plan')
  for (const size of measured.sizes || []) {
    if (!size.eligible) continue
    for (const h of schedule.horizons.filter((x) => x.status === 'head_censored'))
      size.horizons.push({ hours: h.hours, class: 'head_censored' })
    size.horizons.sort((a, b) => a.hours - b.hours)
    size.exitInterval = lossIntervals(size)
  }
  const result = {
    planSha256: plan.planSha256,
    anchorBlock,
    vault: frozen.vault,
    routeKey: frozen.routeKey,
    status: measured.status,
    row: measured,
  }
  const sealed = sealCell(result)
  validateCellResult(plan, sealed)
  return sealed
}

export function validateCellResult(plan, result) {
  validatePlan(plan)
  if (
    result?.planSha256 !== plan.planSha256 ||
    !ADDRESS.test(result.vault || '') ||
    result.cellSha256 !== sha(JSON.stringify(unsignedCell(result)))
  )
    throw Error('cell_plan_mismatch')
  const ai = DESIGN.anchors.indexOf(result.anchorBlock)
  const vi = plan.subjects.findIndex((x) => x.vault === result.vault)
  if (ai < 0 || vi < 0) throw Error('cell_not_in_plan')
  const frozen = plan.cells[ai * plan.subjects.length + vi]
  if (result.routeKey !== frozen.routeKey) throw Error('cell_route_invalid')
  if (frozen.status !== 'frozen') {
    if (
      result.status !== frozen.status ||
      result.row !== null ||
      !isDeepStrictEqual(
        Object.keys(unsignedCell(result)).sort(),
        ['planSha256', 'anchorBlock', 'vault', 'routeKey', 'status', 'row'].sort(),
      )
    )
      throw Error('skipped_cell_invalid')
    return true
  }
  const row = result.row
  if (
    !row ||
    result.status !== row.status ||
    row.vault !== frozen.vault ||
    row.asset !== frozen.asset ||
    row.anchorBlock !== frozen.anchorBlock ||
    (row.totalAssetsRaw !== undefined && row.totalAssetsRaw !== frozen.totalAssetsRaw)
  )
    throw Error('measured_cell_identity_invalid')
  const baseKeys = ['vault', 'asset', 'anchorBlock', 'status']
  const earlyExitStatuses = new Set([
    'identity_changed',
    'rpc_unavailable',
    'discovery_unavailable',
  ])
  if (earlyExitStatuses.has(row.status)) {
    if (!isDeepStrictEqual(Object.keys(row).sort(), baseKeys.sort()))
      throw Error('early_exit_cell_shape_invalid')
    return true
  }
  if (row.status !== 'measured' && row.status !== 'no_eligible_holder')
    throw Error('cell_status_invalid')
  if (
    !isDeepStrictEqual(row.baselineIdentity, {
      status: 'confirmed',
      shareDecimals: 18,
      assetDecimals: 6,
    }) ||
    row.totalAssetsRaw !== frozen.totalAssetsRaw ||
    row.candidateWindow?.fromBlock !==
      Math.max(1, row.anchorBlock - DESIGN.candidateLookbackBlocks) ||
    row.candidateWindow?.throughBlock !== row.anchorBlock - 1 ||
    !Number.isSafeInteger(row.candidateWindow?.transferLogs) ||
    row.candidateWindow.transferLogs < 0 ||
    !Number.isSafeInteger(row.candidateWindow?.screened) ||
    row.candidateWindow.screened < 0 ||
    row.candidateWindow.screened > DESIGN.candidateLimit ||
    !Array.isArray(row.screenedCandidates) ||
    row.screenedCandidates.length !== row.candidateWindow.screened
  )
    throw Error('cell_discovery_evidence_invalid')
  if (row.status === 'no_eligible_holder') {
    if (
      !isDeepStrictEqual(
        Object.keys(row).sort(),
        [
          ...baseKeys,
          'baselineIdentity',
          'totalAssetsRaw',
          'candidateWindow',
          'screenedCandidates',
        ].sort(),
      ) ||
      row.sizes !== undefined ||
      row.holder !== undefined ||
      row.screenedCandidates.some((x) => x.status === 'eligible_holder')
    )
      throw Error('no_holder_cell_shape_invalid')
    return true
  }
  if (
    !isDeepStrictEqual(
      Object.keys(row).sort(),
      [
        ...baseKeys,
        'baselineIdentity',
        'totalAssetsRaw',
        'candidateWindow',
        'screenedCandidates',
        'holder',
        'holderDiscovery',
        'anchorSharesRaw',
        'anchorClaimRaw',
        'sizes',
      ].sort(),
    ) ||
    !ADDRESS.test(row.holder || '') ||
    row.holderDiscovery?.owner !== row.holder ||
    row.holderDiscovery?.receiptVerified !== true ||
    row.holderDiscovery?.status !== 'eligible_holder' ||
    row.holderDiscovery?.discoveryBlock >= row.anchorBlock ||
    !row.screenedCandidates.some((x) => isDeepStrictEqual(x, row.holderDiscovery)) ||
    row.sizes?.length !== DESIGN.qLabels.length ||
    !isDeepStrictEqual(
      row.sizes.map(({ label, assetsRaw }) => ({ label, assetsRaw })),
      frozen.sizes,
    )
  )
    throw Error('measured_cell_holder_or_q_invalid')
  // Reconstruct selectHolder's choice from the screened receipt rows: the first
  // claim >=10k wins and ends screening; otherwise the first eligible row wins.
  // This is local evidence consistency, not proof that the RPC supplied all logs.
  const eligibleRows = row.screenedCandidates.filter((x) => x.status === 'eligible_holder')
  if (
    eligibleRows.some(
      (x) =>
        !ADDRESS.test(x.owner || '') ||
        x.receiptVerified !== true ||
        !/^[1-9]\d*$/.test(x.sharesRaw || '') ||
        !/^[1-9]\d*$/.test(x.claimRaw || ''),
    )
  )
    throw Error('holder_selection_evidence_invalid')
  const large = eligibleRows.find((x) => BigInt(x.claimRaw) >= 10_000n * 1_000_000n)
  const selected = large || eligibleRows[0]
  if (
    !selected ||
    (large && row.screenedCandidates.at(-1) !== large) ||
    !isDeepStrictEqual(row.holderDiscovery, selected) ||
    row.holder !== selected.owner ||
    row.anchorSharesRaw !== selected.sharesRaw ||
    row.anchorClaimRaw !== selected.claimRaw
  )
    throw Error('holder_selection_invalid')
  const horizons = plan.schedule.anchors[ai].horizons
  for (const size of row.sizes) {
    const eligibility = qLadder(
      BigInt(frozen.totalAssetsRaw),
      BigInt(row.anchorClaimRaw),
      6,
      DESIGN,
    ).find((x) => x.label === size.label)
    if (
      !eligibility ||
      size.eligible !== eligibility.eligible ||
      size.reason !== eligibility.reason
    )
      throw Error('size_eligibility_invalid')
    if (!size.eligible) {
      if (size.baseline !== null || size.horizons.length !== 0) throw Error('ineligible_measured')
      continue
    }
    if (
      size.baseline?.class !==
        classifyProbe({ status: 'confirmed' }, size.baseline.state, size.baseline.call) ||
      size.horizons?.length !== horizons.length ||
      !isDeepStrictEqual(size.exitInterval, lossIntervals(size))
    )
      throw Error('size_probe_invalid')
    for (let i = 0; i < horizons.length; i++) {
      const expected = horizons[i],
        actual = size.horizons[i]
      if (actual?.hours !== expected.hours) throw Error('horizon_order_invalid')
      if (expected.status === 'head_censored') {
        if (actual.class !== 'head_censored') throw Error('head_censor_invalid')
      } else if (actual.class !== classifyProbe(actual.identity, actual.state, actual.call))
        throw Error('horizon_probe_invalid')
    }
  }
  return true
}

export function summarize(plan, completed) {
  validatePlan(plan)
  const byKey = new Map()
  for (const result of completed) {
    validateCellResult(plan, result)
    const key = `${result.anchorBlock}:${result.vault}`
    if (!plan.cells.some((x) => `${x.anchorBlock}:${x.vault}` === key))
      throw Error('cell_not_in_plan')
    if (byKey.has(key)) throw Error('cell_duplicate')
    byKey.set(key, result)
  }
  const status = {},
    baseline = {},
    horizons = {},
    episodeKeys = new Set(),
    clusterKeys = new Set(),
    firstLossEpisodes = new Set(),
    recoveredEpisodes = new Set()
  let unmeasuredSizeCells = 0
  let baselineSuccessSizeRows = 0,
    firstCoveredLossSizeRows = 0,
    observedRecoverySizeRows = 0,
    attritionCensoredRiskSizeRows = 0,
    rightCensoredRiskSizeRows = 0
  const count = (target, key) => {
    target[key] = (target[key] || 0) + 1
  }
  for (const frozen of plan.cells) {
    const key = `${frozen.anchorBlock}:${frozen.vault}`
    const result = byKey.get(key)
    count(status, result?.status || (frozen.status === 'frozen' ? 'pending' : frozen.status))
    if (!result?.row?.sizes) {
      unmeasuredSizeCells += DESIGN.qLabels.length
      continue
    }
    for (const size of result.row.sizes) {
      count(baseline, size.eligible ? size.baseline?.class || 'missing' : 'ineligible')
      if (!size.eligible) {
        for (const h of DESIGN.horizonsHours) count(horizons, `${h}h:ineligible`)
        continue
      }
      for (const h of DESIGN.horizonsHours)
        count(horizons, `${h}h:${size.horizons.find((x) => x.hours === h)?.class || 'missing'}`)
      if (size.baseline?.class === 'success') {
        const episode = `${key}:${result.row.holder}`
        const interval = lossIntervals(size)
        baselineSuccessSizeRows++
        episodeKeys.add(episode)
        clusterKeys.add(`${frozen.vault}:${result.row.holder}`)
        if (interval.firstLoss?.class === 'evm_revert') {
          firstCoveredLossSizeRows++
          firstLossEpisodes.add(episode)
        }
        if (interval.recovery?.throughHours !== undefined) {
          observedRecoverySizeRows++
          recoveredEpisodes.add(episode)
        }
        if (interval.censoring?.class === 'holder_attrition') attritionCensoredRiskSizeRows++
        if (interval.firstLoss?.rightCensoredAtHours !== undefined) rightCensoredRiskSizeRows++
      }
    }
  }
  return {
    plannedVaultAnchorCells: plan.cells.length,
    completedCells: byKey.size,
    plannedSizeCells: plan.cells.length * DESIGN.qLabels.length,
    unmeasuredSizeCells,
    plannedHorizonSizeCells:
      plan.cells.length * DESIGN.qLabels.length * DESIGN.horizonsHours.length,
    unmeasuredHorizonSizeCells: unmeasuredSizeCells * DESIGN.horizonsHours.length,
    cellStatus: status,
    baselineSizeStatus: baseline,
    horizonSizeStatus: horizons,
    baselineSuccessEpisodes: episodeKeys.size,
    uniqueHolderVaultClusters: clusterKeys.size,
    riskSet: {
      baselineSuccessSizeRows,
      firstCoveredLossSizeRows,
      distinctFirstCoveredLossEpisodes: firstLossEpisodes.size,
      observedRecoverySizeRows,
      distinctObservedRecoveryEpisodes: recoveredEpisodes.size,
      attritionCensoredRiskSizeRows,
      rightCensoredRiskSizeRows,
      independentObservations: false,
    },
    independentObservations: false,
    reservedHoldoutAnchor: DESIGN.reservedHoldoutAnchor,
    cohortSelection: DESIGN.cohortSelection,
    forecast: false,
  }
}

function saveImmutable(path, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  try {
    if (readFileSync(path).equals(bytes)) return { path, replay: true, sha256: sha(bytes) }
    throw Error('artifact_conflict')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, bytes, { flag: 'wx' })
  try {
    linkSync(temp, path)
  } finally {
    unlinkSync(temp)
  }
  return { path, replay: false, sha256: sha(bytes) }
}

export function savePlanOnce(plan, directory) {
  validatePlan(plan)
  mkdirSync(directory, { recursive: true })
  return saveImmutable(join(directory, `plan-${plan.planSha256}.json`), plan)
}

const cellPrefix = (plan, anchorBlock, vault) => `cell-${plan.planSha256}-${anchorBlock}-${vault}-`

/** Disk integrity replay only; this does not independently re-execute historical RPC. */
export function readSavedCell(plan, anchorBlock, vault, directory) {
  validatePlan(plan)
  const prefix = cellPrefix(plan, anchorBlock, vault)
  let matches
  try {
    matches = readdirSync(directory).filter(
      (name) => name.startsWith(prefix) && name.endsWith('.json'),
    )
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  if (matches.length > 1) throw Error('cell_artifact_ambiguous')
  if (!matches.length) return null
  const path = join(directory, matches[0])
  const bytes = readFileSync(path)
  const cell = JSON.parse(bytes.toString('utf8'))
  validateCellResult(plan, cell)
  if (
    matches[0] !== `${prefix}${cell.cellSha256}.json` ||
    bytes.toString('utf8') !== `${JSON.stringify(cell, null, 2)}\n`
  )
    throw Error('cell_artifact_content_invalid')
  return { path, cell, sha256: sha(bytes), sourceRevalidated: false }
}

/** Optional independent read-only RPC replay at the same frozen canonical hashes. */
export async function verifySavedCellWithRpc(client, plan, anchorBlock, vault, directory) {
  const saved = readSavedCell(plan, anchorBlock, vault, directory)
  if (!saved) throw Error('cell_artifact_missing')
  const replayed = await runCell(client, plan, anchorBlock, vault)
  if (!isDeepStrictEqual(saved.cell, replayed)) throw Error('cell_rpc_replay_mismatch')
  return { ...saved, sourceRevalidated: true }
}

/** Recheck a saved exact holder/Q at every frozen block without replaying log discovery. */
export async function verifySavedCellExactHolderProbesWithRpc(
  client,
  plan,
  anchorBlock,
  vault,
  directory,
  sizeLabel = 'fixed_10k',
) {
  const saved = readSavedCell(plan, anchorBlock, vault, directory)
  if (!saved || saved.cell.status !== 'measured') throw Error('cell_probe_artifact_missing')
  const row = saved.cell.row
  const size = row.sizes.find((item) => item.label === sizeLabel)
  if (!size?.eligible || !size.baseline) throw Error('cell_probe_size_ineligible')
  const subject = plan.subjects.find((item) => item.vault === saved.cell.vault)
  const schedule = plan.schedule.anchors.find((item) => item.anchor.number === anchorBlock)
  if (!subject || !schedule) throw Error('cell_probe_plan_mismatch')
  const probes = [
    {
      hours: 0,
      hash: schedule.anchor.hash,
      expectedIdentity: row.baselineIdentity,
      expected: size.baseline,
    },
    ...schedule.horizons
      .filter((item) => item.status === 'fixed')
      .map((item) => ({
        hours: item.hours,
        hash: item.hash,
        expectedIdentity: size.horizons.find((sample) => sample.hours === item.hours)?.identity,
        expected: size.horizons.find((sample) => sample.hours === item.hours),
      })),
  ]
  for (const probe of probes) {
    if (!probe.expected || !probe.expectedIdentity) throw Error('cell_probe_saved_missing')
    const checkedIdentity = await identity(client, subject, probe.hash)
    const state =
      checkedIdentity.status === 'confirmed'
        ? await holderState(client, subject, row.holder, BigInt(size.assetsRaw), probe.hash)
        : { status: 'not_read_identity' }
    const call =
      checkedIdentity.status === 'confirmed'
        ? await simulate(client, subject.vault, row.holder, BigInt(size.assetsRaw), probe.hash)
        : { status: 'not_read_identity' }
    const observedClass = classifyProbe(checkedIdentity, state, call)
    if (
      !isDeepStrictEqual(checkedIdentity, probe.expectedIdentity) ||
      !isDeepStrictEqual(state, probe.expected.state) ||
      !isDeepStrictEqual(call, probe.expected.call) ||
      observedClass !== probe.expected.class
    )
      throw Error(`cell_probe_rpc_mismatch_${probe.hours}`)
  }
  return {
    cellSha256: saved.cell.cellSha256,
    anchorBlock,
    vault: saved.cell.vault,
    holder: row.holder,
    sizeLabel,
    assetsRaw: size.assetsRaw,
    verifiedHours: probes.map((probe) => probe.hours),
    probesSourceRevalidated: true,
    holderDiscoveryRevalidated: false,
  }
}

export function saveCellOnce(plan, cell, directory) {
  validateCellResult(plan, cell)
  mkdirSync(directory, { recursive: true })
  const existing = readSavedCell(plan, cell.anchorBlock, cell.vault, directory)
  if (existing) {
    if (!isDeepStrictEqual(existing.cell, cell)) throw Error('artifact_conflict')
    return { path: existing.path, replay: true, sha256: existing.sha256 }
  }
  return saveImmutable(
    join(directory, `${cellPrefix(plan, cell.anchorBlock, cell.vault)}${cell.cellSha256}.json`),
    cell,
  )
}

// plan <directory>                 freezes all 160 cells, then saves one immutable plan.
// cell <plan.json> <B> <vault> <directory>  measures or integrity-replays one cell.
// verify <plan.json> <B> <vault> <directory>  independently replays stored RPC evidence.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [mode, ...args] = process.argv.slice(2)
  if (mode === 'help' || mode === '--help') {
    process.stdout.write(
      'plan <directory> | cell|verify <plan.json> <anchor-block> <vault> <directory>\n',
    )
  } else if (
    (mode === 'plan' && args.length === 1) ||
    (['cell', 'verify'].includes(mode) && args.length === 4)
  ) {
    const work = async () => {
      if (mode === 'cell' || mode === 'verify') {
        const [planPath, anchorArg, vaultArg, directory] = args
        const plan = JSON.parse(readFileSync(planPath, 'utf8'))
        validatePlan(plan)
        const anchorBlock = checkedNumber(anchorArg)
        const vault = lower(vaultArg)
        if (!DESIGN.anchors.includes(anchorBlock) || !plan.subjects.some((x) => x.vault === vault))
          throw Error('cell_not_in_plan')
        if (mode === 'verify') {
          const { get } = readEnv()
          const rpc = process.env.RECORDER_RPC_URL || get('RECORDER_RPC_URL')
          if (!rpc) throw Error('rpc_required')
          const checked = await verifySavedCellWithRpc(
            makeClient(rpc),
            plan,
            anchorBlock,
            vault,
            directory,
          )
          process.stdout.write(
            JSON.stringify({
              path: checked.path,
              status: checked.cell.status,
              sourceRevalidated: true,
            }) + '\n',
          )
          return
        }
        const existing = readSavedCell(plan, anchorBlock, vault, directory)
        if (existing) {
          process.stdout.write(
            JSON.stringify({
              path: existing.path,
              status: existing.cell.status,
              replay: true,
              sourceRevalidated: false,
            }) + '\n',
          )
          return
        }
        const { get } = readEnv()
        const rpc = process.env.RECORDER_RPC_URL || get('RECORDER_RPC_URL')
        if (!rpc) throw Error('rpc_required')
        const cell = await runCell(makeClient(rpc), plan, anchorBlock, vault)
        const saved = saveCellOnce(plan, cell, directory)
        process.stdout.write(
          JSON.stringify({ path: saved.path, status: cell.status, replay: saved.replay }) + '\n',
        )
        return
      }
      const { get } = readEnv()
      const rpc = process.env.RECORDER_RPC_URL || get('RECORDER_RPC_URL')
      if (!rpc) throw Error('rpc_required')
      const plan = await freezeFullPlan(makeClient(rpc))
      const saved = savePlanOnce(plan, args[0])
      process.stdout.write(
        JSON.stringify({
          path: saved.path,
          planSha256: plan.planSha256,
          cells: plan.cells.length,
          replay: saved.replay,
        }) + '\n',
      )
    }
    work().catch((error) => {
      process.stderr.write(`${error?.message || 'stable_exit_history_failed'}\n`)
      process.exitCode = 1
    })
  } else {
    process.stderr.write(
      'usage: plan <directory> | cell|verify <plan.json> <anchor-block> <vault> <directory>\n',
    )
    process.exitCode = 1
  }
}
