// Prospective same-holder sUSDat queue-request observations. An eth_call never mints a
// ticket, settles a claim, or proves AUSD delivery. Private exact holder records stay local.
import { pathToFileURL } from 'node:url'

import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  parseAbiItem,
} from 'viem'
import { mainnet } from 'viem/chains'

import * as stakedModule from '../../lib/carry/stakedUsdatExit.ts'
import { readEnv } from '../lib/venue-reads.mjs'
import {
  ATTEMPT_DIR,
  ISSUE_DIR,
  SCORE_DIR,
  appendChain,
  readChain,
} from './carry-local-staked-usdat-holder-store.mjs'

const {
  STAKED_USDAT_ROUTE: ROUTE,
  STAKED_USDAT_VAULT: VAULT,
  STAKED_USDAT_QUEUE: QUEUE,
  USDAT_ASSET: USDAT,
  STAKED_USDAT_IMPLEMENTATION: VAULT_IMPL,
  STAKED_USDAT_IMPLEMENTATION_CODE_HASH: VAULT_HASH,
  STAKED_USDAT_QUEUE_IMPLEMENTATION: QUEUE_IMPL,
  STAKED_USDAT_QUEUE_IMPLEMENTATION_CODE_HASH: QUEUE_HASH,
} = stakedModule.default ?? stakedModule

export const STUDY = 'carry_local_staked_usdat_holder_v2'
export const SHARES_RAW = '10000000000000000000'
export const HORIZONS_HOURS = Object.freeze([1, 4, 24, 48, 168])
const CAPTURE_DEADLINE_HOURS = 2
const SLOT_MS = 15 * 60_000
const MAX_CANDIDATES = 60
const SCAN_BLOCKS = 20_000n
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const HASH = /^0x[0-9a-f]{64}$/i
const SHA = /^[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/i
const vaultAbi = parseAbi([
  'function asset() view returns (address)',
  'function decimals() view returns (uint8)',
  'function getWithdrawalQueue() view returns (address)',
  'function paused() view returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function maxRedeem(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function requestRedeem(uint256,uint256) returns (uint256)',
])
const queueAbi = parseAbi([
  'function paused() view returns (bool)',
  'function USDAT() view returns (address)',
  'function STAKED_USDAT() view returns (address)',
])
const assetAbi = parseAbi(['function decimals() view returns (uint8)'])
const transfer = parseAbiItem(
  'event Transfer(address indexed from,address indexed to,uint256 value)',
)
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
const iso = (ms) => new Date(ms).toISOString()
const addressFromSlot = (raw) =>
  raw && HASH.test(raw) && !/^0x0{64}$/i.test(raw) ? `0x${raw.slice(26)}`.toLowerCase() : null

function isRevert(error) {
  const text = `${error?.shortMessage ?? ''} ${error?.message ?? ''}`.toLowerCase()
  if (/http request|timeout|network|rate limit|gas limit|out of gas/.test(text)) return false
  if (/execution reverted|reverted with|contract function reverted/.test(text)) return true
  return error?.cause && error.cause !== error ? isRevert(error.cause) : false
}

function origin(url) {
  const parsed = new URL(url)
  if (
    !['https:', 'http:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  )
    throw Error('saturn_rpc_origin_invalid')
  return parsed.hostname
    .replace(/\.$/, '')
    .replace(/^www\./, '')
    .toLowerCase()
}

export function configuredClients(env = readEnv(), overrides = process.env) {
  const urls = String(
    overrides.RECORDER_RPC_URLS ??
      overrides.RECORDER_RPC_URL ??
      env.get('RECORDER_RPC_URLS') ??
      env.get('RECORDER_RPC_URL') ??
      '',
  )
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean)
  if (urls.length < 2 || urls.length > 8 || new Set(urls.map(origin)).size < 2)
    throw Error('saturn_independent_rpc_required')
  return urls.map((url) => ({
    source: origin(url),
    client: createPublicClient({
      chain: mainnet,
      transport: http(url, { timeout: 10_000, retryCount: 0 }),
    }),
  }))
}

const header = (block) => ({
  number: Number(block.number),
  hash: block.hash?.toLowerCase(),
  parentHash: block.parentHash?.toLowerCase(),
  timestamp: Number(block.timestamp),
})
const validHeader = (item) =>
  Number.isSafeInteger(item?.number) &&
  item.number >= 0 &&
  HASH.test(item.hash ?? '') &&
  HASH.test(item.parentHash ?? '') &&
  Number.isSafeInteger(item.timestamp) &&
  item.timestamp > 0

export async function finalizedPair(sources) {
  const heads = await Promise.allSettled(
    sources.map(async (entry) => {
      if ((await entry.client.getChainId()) !== 1) throw Error('saturn_rpc_chain_mismatch')
      return { ...entry, head: await entry.client.getBlock({ blockTag: 'finalized' }) }
    }),
  )
  const good = heads.filter((item) => item.status === 'fulfilled').map((item) => item.value)
  for (let i = 0; i < good.length; i++) {
    for (let j = i + 1; j < good.length; j++) {
      if (good[i].source === good[j].source) continue
      const number =
        good[i].head.number < good[j].head.number ? good[i].head.number : good[j].head.number
      try {
        const [a, b] = await Promise.all([
          good[i].client.getBlock({ blockNumber: number }),
          good[j].client.getBlock({ blockNumber: number }),
        ])
        const h = header(a)
        if (
          !validHeader(h) ||
          !same(a.hash, b.hash) ||
          !same(a.parentHash, b.parentHash) ||
          a.timestamp !== b.timestamp
        )
          continue
        return { pair: [good[i], good[j]], block: h }
      } catch {
        // Try another independent pair without changing a sealed observation.
      }
    }
  }
  throw Error('saturn_finalized_pair_unavailable')
}

async function deployment(entry, block) {
  const pinned = { blockHash: block.hash, requireCanonical: true }
  const [vaultSlot, queueSlot] = await Promise.all([
    entry.client.getStorageAt({ address: VAULT, slot: SLOT, ...pinned }),
    entry.client.getStorageAt({ address: QUEUE, slot: SLOT, ...pinned }),
  ])
  const vaultImpl = addressFromSlot(vaultSlot)
  const queueImpl = addressFromSlot(queueSlot)
  if (!vaultImpl || !queueImpl) throw Error('saturn_implementation_unavailable')
  const [vaultCode, queueCode] = await Promise.all([
    entry.client.getCode({ address: vaultImpl, ...pinned }),
    entry.client.getCode({ address: queueImpl, ...pinned }),
  ])
  if (!vaultCode || !queueCode) throw Error('saturn_implementation_code_missing')
  return {
    vaultImpl,
    vaultCodeHash: keccak256(vaultCode).toLowerCase(),
    queueImpl,
    queueCodeHash: keccak256(queueCode).toLowerCase(),
  }
}

export function deployedRegime(current) {
  return same(current.vaultImpl, VAULT_IMPL) &&
    same(current.vaultCodeHash, VAULT_HASH) &&
    same(current.queueImpl, QUEUE_IMPL) &&
    same(current.queueCodeHash, QUEUE_HASH)
    ? 'current_pinned'
    : 'changed'
}

async function measured(entry, block, holder, { allowChanged = false } = {}) {
  const pinned = { blockHash: block.hash, requireCanonical: true }
  const regime = await deployment(entry, block)
  if (deployedRegime(regime) !== 'current_pinned' && !allowChanged)
    return { regime, outcome: 'regime_changed' }
  if (deployedRegime(regime) !== 'current_pinned') throw Error('saturn_changed_regime_not_callable')
  const [
    asset,
    decimals,
    queue,
    queueAsset,
    queueVault,
    assetDecimals,
    vaultPaused,
    queuePaused,
    balance,
    maxRedeem,
    code,
  ] = await Promise.all([
    entry.client.readContract({ address: VAULT, abi: vaultAbi, functionName: 'asset', ...pinned }),
    entry.client.readContract({
      address: VAULT,
      abi: vaultAbi,
      functionName: 'decimals',
      ...pinned,
    }),
    entry.client.readContract({
      address: VAULT,
      abi: vaultAbi,
      functionName: 'getWithdrawalQueue',
      ...pinned,
    }),
    entry.client.readContract({ address: QUEUE, abi: queueAbi, functionName: 'USDAT', ...pinned }),
    entry.client.readContract({
      address: QUEUE,
      abi: queueAbi,
      functionName: 'STAKED_USDAT',
      ...pinned,
    }),
    entry.client.readContract({
      address: USDAT,
      abi: assetAbi,
      functionName: 'decimals',
      ...pinned,
    }),
    entry.client.readContract({ address: VAULT, abi: vaultAbi, functionName: 'paused', ...pinned }),
    entry.client.readContract({ address: QUEUE, abi: queueAbi, functionName: 'paused', ...pinned }),
    entry.client.readContract({
      address: VAULT,
      abi: vaultAbi,
      functionName: 'balanceOf',
      args: [holder],
      ...pinned,
    }),
    entry.client.readContract({
      address: VAULT,
      abi: vaultAbi,
      functionName: 'maxRedeem',
      args: [holder],
      ...pinned,
    }),
    entry.client.getCode({ address: holder, ...pinned }),
  ])
  if (
    !same(asset, USDAT) ||
    decimals !== 18 ||
    assetDecimals !== 6 ||
    !same(queue, QUEUE) ||
    !same(queueAsset, USDAT) ||
    !same(queueVault, VAULT)
  )
    throw Error('saturn_route_identity_changed')
  const eoa = !code || code === '0x'
  let previewRaw = null
  try {
    previewRaw = String(
      await entry.client.readContract({
        address: VAULT,
        abi: vaultAbi,
        functionName: 'previewRedeem',
        args: [BigInt(SHARES_RAW)],
        ...pinned,
      }),
    )
  } catch (error) {
    if (!isRevert(error)) throw error
  }
  let callOutcome = 'not_attempted'
  let ticketId = null
  if (eoa && balance >= BigInt(SHARES_RAW) && maxRedeem >= BigInt(SHARES_RAW)) {
    try {
      const call = await entry.client.call({
        to: VAULT,
        account: holder,
        data: encodeFunctionData({
          abi: vaultAbi,
          functionName: 'requestRedeem',
          args: [BigInt(SHARES_RAW), 0n],
        }),
        gas: 15_000_000n,
        ...pinned,
      })
      if (!call.data) throw Error('saturn_call_empty')
      ticketId = String(
        decodeFunctionResult({ abi: vaultAbi, functionName: 'requestRedeem', data: call.data }),
      )
      callOutcome = 'success'
    } catch (error) {
      if (!isRevert(error)) throw error
      callOutcome = 'evm_revert'
    }
  }
  const confirmed = await entry.client.getBlock({ blockNumber: BigInt(block.number) })
  if (!same(confirmed.hash, block.hash)) throw Error('saturn_block_changed')
  return {
    regime,
    outcome: callOutcome,
    ticketId,
    holderSharesRaw: String(balance),
    maxRedeemSharesRaw: String(maxRedeem),
    previewUsdatRaw: previewRaw,
    vaultPaused,
    queuePaused,
    holderEoa: eoa,
    minSharePriceRaw: '0',
  }
}

export async function twoOriginMeasurement(pair, block, holder) {
  const [a, b] = await Promise.all(pair.map((entry) => measured(entry, block, holder)))
  if (JSON.stringify(a) !== JSON.stringify(b)) throw Error('saturn_two_origin_disagreement')
  return { ...a, sources: pair.map((entry) => entry.source) }
}

export async function findCandidate(sources, pair, block) {
  let logs
  let discoverySource
  for (const entry of sources) {
    try {
      const anchor = await entry.client.getBlock({ blockNumber: BigInt(block.number) })
      if (!same(anchor.hash, block.hash)) continue
      logs = await entry.client.getLogs({
        address: VAULT,
        event: transfer,
        fromBlock: BigInt(Math.max(0, block.number - Number(SCAN_BLOCKS))),
        toBlock: BigInt(block.number),
      })
      discoverySource = entry.source
      break
    } catch {
      // A provider can serve pinned calls but reject a 20k-block log shape.
    }
  }
  if (!logs || !discoverySource) throw Error('saturn_transfer_discovery_unavailable')
  const candidates = [...new Set(logs.map((log) => log.args.to?.toLowerCase()).filter(Boolean))]
    .reverse()
    .filter(
      (address) => ADDRESS.test(address) && !same(address, QUEUE) && !/^0x0{40}$/.test(address),
    )
    .slice(0, MAX_CANDIDATES)
  const pinned = { blockHash: block.hash, requireCanonical: true }
  let fallback = null
  let eligibleTested = 0
  let checked = 0
  for (const [index, address] of candidates.entries()) {
    checked = index + 1
    const source = sources.find((entry) => entry.source === discoverySource)
    const [code, balance] = await Promise.all([
      source.client.getCode({ address, ...pinned }),
      source.client.readContract({
        address: VAULT,
        abi: vaultAbi,
        functionName: 'balanceOf',
        args: [address],
        ...pinned,
      }),
    ])
    if ((!code || code === '0x') && balance >= BigInt(SHARES_RAW)) {
      const measurement = await twoOriginMeasurement(pair, block, address)
      eligibleTested += 1
      const candidate = {
        holder: address,
        measurement,
        selection: {
          fromBlock: Math.max(0, block.number - Number(SCAN_BLOCKS)),
          toBlock: block.number,
          transferLogs: logs.length,
          candidatesChecked: index + 1,
          eligibleTested,
          discoverySource,
          samplingRule: 'first_reverting_eoa_else_first_callable',
        },
      }
      if (measurement.outcome === 'evm_revert') return candidate
      if (measurement.outcome === 'success' && !fallback) fallback = candidate
      if (eligibleTested >= 8) break
    }
  }
  if (fallback)
    return {
      ...fallback,
      selection: { ...fallback.selection, candidatesChecked: checked, eligibleTested },
    }
  throw Error('saturn_no_callable_or_reverting_eoa')
}

const validClock = (value) =>
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value

export function validateIssue(row) {
  if (
    row.study !== STUDY ||
    row.kind !== 'issue' ||
    row.routeKey !== ROUTE ||
    row.destination !== VAULT ||
    row.sharesRaw !== SHARES_RAW ||
    !ADDRESS.test(row.holder ?? '') ||
    !validHeader(row.baseline) ||
    !validClock(row.issuedAtUtc) ||
    Date.parse(row.issuedAtUtc) < row.baseline.timestamp * 1000 ||
    row.targets?.some((item) => Date.parse(row.issuedAtUtc) >= Date.parse(item.targetAtUtc)) ||
    !row.selection ||
    row.selection.samplingRule !== 'first_reverting_eoa_else_first_callable' ||
    !Number.isSafeInteger(row.selection.candidatesChecked) ||
    row.selection.candidatesChecked < 1 ||
    !Number.isSafeInteger(row.selection.eligibleTested) ||
    row.selection.eligibleTested < 1 ||
    typeof row.selection.discoverySource !== 'string' ||
    row.measurement?.sources?.length !== 2 ||
    row.measurement.sources[0] === row.measurement.sources[1] ||
    deployedRegime(row.measurement.regime) !== 'current_pinned' ||
    !['success', 'evm_revert'].includes(row.measurement.outcome) ||
    !Array.isArray(row.targets) ||
    row.targets.length !== HORIZONS_HOURS.length ||
    row.targets.some(
      (item, index) =>
        item.horizonHours !== HORIZONS_HOURS[index] ||
        !validClock(item.targetAtUtc) ||
        !validClock(item.deadlineUtc) ||
        Date.parse(item.targetAtUtc) !==
          row.baseline.timestamp * 1000 + item.horizonHours * 3_600_000 ||
        Date.parse(item.deadlineUtc) !==
          Date.parse(item.targetAtUtc) + CAPTURE_DEADLINE_HOURS * 3_600_000,
    )
  )
    throw Error('saturn_issue_invalid')
}

export function classifyTransition(issue, measurement) {
  if (measurement.outcome === 'regime_changed') return 'regime_change_censored'
  if (!measurement.holderEoa || BigInt(measurement.holderSharesRaw) < BigInt(SHARES_RAW))
    return 'holder_attrition'
  if (
    BigInt(measurement.maxRedeemSharesRaw) < BigInt(SHARES_RAW) ||
    measurement.outcome === 'not_attempted'
  )
    return 'request_unavailable'
  if (issue.measurement.outcome === 'evm_revert' && measurement.outcome === 'success')
    return 'simulated_call_recovery'
  if (issue.measurement.outcome === 'evm_revert' && measurement.outcome === 'evm_revert')
    return 'still_reverting'
  if (issue.measurement.outcome === 'success' && measurement.outcome === 'success')
    return 'still_callable'
  if (issue.measurement.outcome === 'success' && measurement.outcome === 'evm_revert')
    return 'became_reverting'
  return 'unclassified'
}

export function validateScore(row, issues) {
  const issue = issues.find((item) => item.sequence === row.issueSequence)
  const plan = issue?.targets.find((item) => item.horizonHours === row.horizonHours)
  if (
    row.study !== STUDY ||
    row.kind !== 'score' ||
    !issue ||
    !plan ||
    row.issueSha256 !== issue.sha256 ||
    !validClock(row.scoredAtUtc) ||
    !['measured', 'missed_deadline'].includes(row.status) ||
    (row.status === 'measured' &&
      (Date.parse(row.scoredAtUtc) > Date.parse(plan.deadlineUtc) ||
        Date.parse(row.scoredAtUtc) < Date.parse(plan.targetAtUtc) ||
        !validHeader(row.targetBlock) ||
        Date.parse(row.scoredAtUtc) < row.targetBlock.timestamp * 1000 ||
        row.targetBlock.timestamp * 1000 < Date.parse(plan.targetAtUtc) ||
        !validHeader(row.parentBlock) ||
        row.parentBlock.number !== row.targetBlock.number - 1 ||
        row.parentBlock.timestamp * 1000 >= Date.parse(plan.targetAtUtc) ||
        !same(row.parentBlock.hash, row.targetBlock.parentHash) ||
        row.measurement?.sources?.length !== 2 ||
        row.measurement.sources[0] === row.measurement.sources[1] ||
        row.transition !== classifyTransition(issue, row.measurement))) ||
    (row.status === 'missed_deadline' &&
      (Date.parse(row.scoredAtUtc) <= Date.parse(plan.deadlineUtc) ||
        row.targetBlock !== null ||
        row.measurement !== null ||
        row.transition !== 'missing'))
  )
    throw Error('saturn_score_invalid')
}

export function validateAttempt(row) {
  if (
    row.study !== STUDY ||
    row.kind !== 'attempt' ||
    !validClock(row.startedAtUtc) ||
    !validClock(row.finishedAtUtc) ||
    Date.parse(row.finishedAtUtc) < Date.parse(row.startedAtUtc) ||
    !['issue', 'score'].includes(row.mode) ||
    (['issued', 'reconciled_issue'].includes(row.status) && row.mode !== 'issue') ||
    (['scored', 'reconciled_score'].includes(row.status) && row.mode !== 'score') ||
    ![
      'issued',
      'scored',
      'reconciled_issue',
      'reconciled_score',
      'nothing_due',
      'duplicate_slot',
      'failed',
    ].includes(row.status) ||
    !Number.isSafeInteger(row.slot) ||
    row.slot !== Math.floor(Date.parse(row.startedAtUtc) / SLOT_MS) ||
    (['issued', 'scored', 'reconciled_issue', 'reconciled_score'].includes(row.status) &&
      (!Number.isSafeInteger(row.recordSequence) || !SHA.test(row.recordSha256 ?? ''))) ||
    (!['issued', 'scored', 'reconciled_issue', 'reconciled_score'].includes(row.status) &&
      (row.recordSequence !== null || row.recordSha256 !== null))
  )
    throw Error('saturn_attempt_invalid')
}

export function reconcileLinks(issues, scores, attempts, allowOrphans = false) {
  const seen = new Set()
  for (const score of scores) {
    const key = `${score.issueSequence}:${score.horizonHours}`
    if (seen.has(key)) throw Error('saturn_score_duplicate')
    seen.add(key)
  }
  const linked = new Set()
  for (const attempt of attempts) {
    if (!['issued', 'scored', 'reconciled_issue', 'reconciled_score'].includes(attempt.status))
      continue
    const issueMode = ['issued', 'reconciled_issue'].includes(attempt.status)
    const chain = issueMode ? issues : scores
    const row = chain.find((item) => item.sequence === attempt.recordSequence)
    const key = `${issueMode ? 'issued' : 'scored'}:${attempt.recordSequence}`
    const recordTime = Date.parse(row?.[issueMode ? 'issuedAtUtc' : 'scoredAtUtc'])
    const reconciled = attempt.status.startsWith('reconciled_')
    if (
      !row ||
      row.sha256 !== attempt.recordSha256 ||
      linked.has(key) ||
      (reconciled
        ? recordTime > Date.parse(attempt.startedAtUtc)
        : recordTime < Date.parse(attempt.startedAtUtc) ||
          recordTime > Date.parse(attempt.finishedAtUtc))
    )
      throw Error('saturn_attempt_link_invalid')
    linked.add(key)
  }
  const orphanIssues = issues.filter((row) => !linked.has(`issued:${row.sequence}`))
  const orphanScores = scores.filter((row) => !linked.has(`scored:${row.sequence}`))
  if (!allowOrphans && (orphanIssues.length || orphanScores.length))
    throw Error('saturn_orphan_record_unreconciled')
  return { orphanIssues, orphanScores }
}

export async function verifyAll(allowOrphans = false) {
  const issues = await readChain(ISSUE_DIR, validateIssue)
  const scores = await readChain(SCORE_DIR, (row) => validateScore(row, issues))
  const attempts = await readChain(ATTEMPT_DIR, validateAttempt)
  const orphans = reconcileLinks(issues, scores, attempts, allowOrphans)
  return {
    issues,
    scores,
    attempts,
    orphanIssues: orphans.orphanIssues.length,
    orphanScores: orphans.orphanScores.length,
  }
}

export async function recoverInterruptedAppends(now = () => Date.now()) {
  const { issues, scores, attempts } = await verifyAll(true)
  const { orphanIssues, orphanScores } = reconcileLinks(issues, scores, attempts, true)
  for (const [mode, rows] of [
    ['issue', orphanIssues],
    ['score', orphanScores],
  ]) {
    for (const row of rows) {
      const startedAtUtc = iso(now())
      await appendChain(
        ATTEMPT_DIR,
        {
          study: STUDY,
          kind: 'attempt',
          mode,
          slot: Math.floor(Date.parse(startedAtUtc) / SLOT_MS),
          startedAtUtc,
          finishedAtUtc: iso(now()),
          status: mode === 'issue' ? 'reconciled_issue' : 'reconciled_score',
          recordSequence: row.sequence,
          recordSha256: row.sha256,
          failure: null,
        },
        validateAttempt,
      )
    }
  }
  return verifyAll()
}

export async function issueOne(sources = configuredClients(), now = () => Date.now()) {
  await verifyAll()
  const { pair, block } = await finalizedPair(sources)
  if (now() - block.timestamp * 1000 < -120_000 || now() - block.timestamp * 1000 > 7_200_000)
    throw Error('saturn_finalized_block_stale')
  const { holder, selection, measurement } = await findCandidate(sources, pair, block)
  if (deployedRegime(measurement.regime) !== 'current_pinned')
    throw Error('saturn_issue_regime_changed')
  const issuedAtUtc = iso(now())
  if (Date.parse(issuedAtUtc) >= block.timestamp * 1000 + HORIZONS_HOURS[0] * 3_600_000)
    throw Error('saturn_h1_target_already_passed')
  const row = await appendChain(
    ISSUE_DIR,
    {
      study: STUDY,
      kind: 'issue',
      routeKey: ROUTE,
      destination: VAULT,
      holder,
      sharesRaw: SHARES_RAW,
      issuedAtUtc,
      baseline: block,
      selection,
      measurement,
      targets: HORIZONS_HOURS.map((horizonHours) => {
        const targetMs = block.timestamp * 1000 + horizonHours * 3_600_000
        return {
          horizonHours,
          targetAtUtc: iso(targetMs),
          deadlineUtc: iso(targetMs + CAPTURE_DEADLINE_HOURS * 3_600_000),
        }
      }),
    },
    validateIssue,
  )
  return row
}

export async function firstFinalizedAt(pair, targetMs, baseline) {
  const headNumber =
    pair[0].head.number < pair[1].head.number ? pair[0].head.number : pair[1].head.number
  const head = await pair[0].client.getBlock({ blockNumber: headNumber })
  if (Number(head.timestamp) * 1000 < targetMs) return null
  const start = BigInt(baseline.number)
  const [startA, startB] = await Promise.all(
    pair.map((entry) => entry.client.getBlock({ blockNumber: start })),
  )
  if (
    !same(startA.hash, baseline.hash) ||
    !same(startB.hash, baseline.hash) ||
    Number(startA.timestamp) * 1000 >= targetMs ||
    startA.timestamp !== startB.timestamp
  )
    throw Error('saturn_target_baseline_changed')
  let lo = start
  let hi = head.number
  while (lo < hi) {
    const mid = (lo + hi) / 2n
    const block = await pair[0].client.getBlock({ blockNumber: mid })
    if (Number(block.timestamp) * 1000 >= targetMs) hi = mid
    else lo = mid + 1n
  }
  if (lo === 0n) throw Error('saturn_target_parent_missing')
  const [a, b, pa, pb] = await Promise.all([
    pair[0].client.getBlock({ blockNumber: lo }),
    pair[1].client.getBlock({ blockNumber: lo }),
    pair[0].client.getBlock({ blockNumber: lo - 1n }),
    pair[1].client.getBlock({ blockNumber: lo - 1n }),
  ])
  if (
    !same(a.hash, b.hash) ||
    !same(pa.hash, pb.hash) ||
    !same(a.parentHash, pa.hash) ||
    Number(a.timestamp) * 1000 < targetMs ||
    Number(pa.timestamp) * 1000 >= targetMs ||
    a.timestamp !== b.timestamp ||
    pa.timestamp !== pb.timestamp
  )
    throw Error('saturn_target_two_origin_invalid')
  return { target: header(a), parent: header(pa) }
}

export function selectDueScore(issues, scores, nowMs) {
  const scored = new Set(scores.map((row) => `${row.issueSequence}:${row.horizonHours}`))
  const due = issues
    .flatMap((issue) =>
      issue.targets
        .filter(
          (plan) =>
            Date.parse(plan.targetAtUtc) <= nowMs &&
            !scored.has(`${issue.sequence}:${plan.horizonHours}`),
        )
        .map((plan) => ({ issue, plan })),
    )
    .sort((a, b) => Date.parse(a.plan.targetAtUtc) - Date.parse(b.plan.targetAtUtc))
  // Preserve a still-measurable target before sealing older missed deadlines.
  return due.find(({ plan }) => nowMs <= Date.parse(plan.deadlineUtc)) ?? due[0] ?? null
}

export async function scoreDue(sources = configuredClients(), now = () => Date.now()) {
  const { issues, scores } = await verifyAll()
  const dueSelection = selectDueScore(issues, scores, now())
  if (!dueSelection) return null
  const { issue, plan } = dueSelection
  const sealMissed = () =>
    appendChain(
      SCORE_DIR,
      {
        study: STUDY,
        kind: 'score',
        issueSequence: issue.sequence,
        issueSha256: issue.sha256,
        horizonHours: plan.horizonHours,
        scoredAtUtc: iso(now()),
        status: 'missed_deadline',
        targetBlock: null,
        parentBlock: null,
        measurement: null,
        transition: 'missing',
      },
      (row) => validateScore(row, issues),
    )
  if (now() > Date.parse(plan.deadlineUtc)) return sealMissed()
  const { pair } = await finalizedPair(sources)
  const selected = await firstFinalizedAt(pair, Date.parse(plan.targetAtUtc), issue.baseline)
  if (!selected) return null
  const measurement = await twoOriginMeasurement(pair, selected.target, issue.holder)
  if (now() > Date.parse(plan.deadlineUtc)) return sealMissed()
  return appendChain(
    SCORE_DIR,
    {
      study: STUDY,
      kind: 'score',
      issueSequence: issue.sequence,
      issueSha256: issue.sha256,
      horizonHours: plan.horizonHours,
      scoredAtUtc: iso(now()),
      status: 'measured',
      targetBlock: selected.target,
      parentBlock: selected.parent,
      measurement,
      transition: classifyTransition(issue, measurement),
    },
    (row) => validateScore(row, issues),
  )
}

export async function retryTransient(
  operation,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await operation(attempt)
    } catch (error) {
      const transportFailure = isTransportFailure(error)
      if (!transportFailure || attempt === 2) throw error
      await pause(1_000 * (attempt + 1))
    }
  }
}

function isTransportFailure(error) {
  for (let current = error, depth = 0; current && depth < 8; current = current.cause, depth++) {
    if (
      /^(HttpRequestError|TimeoutError|SocketError|WebSocketRequestError)$/.test(
        String(current.name ?? ''),
      ) ||
      ['saturn_finalized_pair_unavailable', 'saturn_transfer_discovery_unavailable'].includes(
        String(current.message ?? ''),
      )
    )
      return true
  }
  return false
}

export async function tick(mode, now = () => Date.now(), sources = configuredClients()) {
  if (!['issue', 'score'].includes(mode)) throw Error('saturn_tick_mode_invalid')
  const startedAtUtc = iso(now())
  const slot = Math.floor(Date.parse(startedAtUtc) / SLOT_MS)
  const { attempts } = await recoverInterruptedAppends(now)
  let status = 'nothing_due'
  let row = null
  let failure = null
  if (attempts.some((item) => item.mode === mode && item.slot === slot && item.status !== 'failed'))
    status = 'duplicate_slot'
  else {
    try {
      row = await retryTransient((attempt) =>
        mode === 'issue'
          ? issueOne([...sources.slice(attempt), ...sources.slice(0, attempt)], now)
          : scoreDue([...sources.slice(attempt), ...sources.slice(0, attempt)], now),
      )
      status = row ? (mode === 'issue' ? 'issued' : 'scored') : 'nothing_due'
    } catch (error) {
      status = 'failed'
      const code = String(error?.message ?? '')
      failure = /^saturn_[a-z0-9_]+$/.test(code)
        ? code
        : isTransportFailure(error)
          ? 'rpc_http_error'
          : 'unexpected_failure'
    }
  }
  const attempt = await appendChain(
    ATTEMPT_DIR,
    {
      study: STUDY,
      kind: 'attempt',
      mode,
      slot,
      startedAtUtc,
      finishedAtUtc: iso(now()),
      status,
      recordSequence: row?.sequence ?? null,
      recordSha256: row?.sha256 ?? null,
      failure,
    },
    validateAttempt,
  )
  if (status === 'failed') throw Error(`saturn_tick_failed:${failure}`)
  return { status, recordSequence: row?.sequence ?? null, attemptSequence: attempt.sequence }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2]
  if (!['issue', 'score', 'verify'].includes(mode)) throw Error('usage: issue|score|verify')
  const result = mode === 'verify' ? await verifyAll() : await tick(mode)
  console.log(
    mode === 'verify'
      ? JSON.stringify({
          issues: result.issues.length,
          scores: result.scores.length,
          attempts: result.attempts.length,
          orphanIssues: result.orphanIssues,
          orphanScores: result.orphanScores,
        })
      : JSON.stringify(result),
  )
}
