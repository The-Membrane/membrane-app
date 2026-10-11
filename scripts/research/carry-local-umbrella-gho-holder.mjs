// Prospective, private same-holder stkGHO redeem observations. A successful eth_call is
// only an executable simulation at one block; it is not a mined GHO receipt.
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

import * as umbrellaModule from '../../lib/carry/umbrellaGhoExit.ts'
import { readEnv } from '../lib/venue-reads.mjs'
import {
  ATTEMPT_DIR,
  ISSUE_DIR,
  SCORE_DIR,
  appendChain,
  readChain,
} from './carry-local-umbrella-gho-holder-store.mjs'

const {
  UMBRELLA_GHO_ROUTE: ROUTE,
  UMBRELLA_STKGHO: VAULT,
  ORIGINAL_GHO: GHO,
  VERIFIED_STKGHO_IMPLEMENTATION: IMPLEMENTATION,
} = umbrellaModule.default ?? umbrellaModule

export const STUDY = 'carry_local_umbrella_gho_holder_v1'
export const SHARES_RAW = '1000000000000000000'
// Later probes bracket this route's observed ~15-day cooldown and 48h window.
// The first sealed issue used the four short horizons and stays immutable.
const LEGACY_HORIZONS_HOURS = Object.freeze([1, 24, 48, 168])
export const HORIZONS_HOURS = Object.freeze([1, 24, 48, 168, 348, 360, 384, 432])
const DEADLINE_HOURS = 2
const SLOT_MS = 30 * 60_000
const SCAN_BLOCKS = 100_000n
// These existing sealed records predate raw holder-code attestation. Their
// original bytes remain readable, but later rows must carry the new proof.
const LEGACY_ISSUES_WITHOUT_HOLDER_PROOF = 3
const LEGACY_SCORES_WITHOUT_HOLDER_PROOF = 5
const LOG_CHUNK_BLOCKS = 2_000n
const SEED_PATH = fileURLToPath(
  new URL('../route-cohort/aug-2026-ab-vault-seed.json', import.meta.url),
)
const SEED_RELATIVE_PATH = 'scripts/route-cohort/aug-2026-ab-vault-seed.json'
const SEED_SHA256 = 'c3e85a98ff3b634c8e6c4bdd4cc64e94f3bdcc417c071125cd40cdff09a21243'
const SEED_SAMPLING_RULE = 'first_window_open_else_first_eligible_frozen_seed_eoa'
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const HASH = /^0x[0-9a-f]{64}$/i
const SHA = /^[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/i
const RUNTIME_CODE = /^0x(?:[0-9a-f]{2})*$/i
const DELEGATION_CODE = /^0xef0100[0-9a-f]{40}$/i
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function paused() view returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function getStakerCooldown(address) view returns (uint192 amount,uint32 endOfCooldown,uint32 withdrawalWindow)',
  'function maxRedeem(address) view returns (uint256)',
  'function getCooldown() view returns (uint256)',
  'function getUnstakeWindow() view returns (uint256)',
  'function getMaxSlashableAssets() view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function redeem(uint256,address,address) returns (uint256)',
])
const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from,address indexed to,uint256 value)',
)
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
const iso = (ms) => new Date(ms).toISOString()
const clock = (value) =>
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const fromSlot = (raw) =>
  raw && HASH.test(raw) && !/^0x0{64}$/i.test(raw) ? `0x${raw.slice(26)}`.toLowerCase() : null
const header = (block) => ({
  number: Number(block.number),
  hash: block.hash?.toLowerCase(),
  parentHash: block.parentHash?.toLowerCase(),
  timestamp: Number(block.timestamp),
})
const validHeader = (value) =>
  Number.isSafeInteger(value?.number) &&
  value.number > 0 &&
  HASH.test(value.hash ?? '') &&
  HASH.test(value.parentHash ?? '') &&
  Number.isSafeInteger(value.timestamp) &&
  value.timestamp > 0

export function holderOriginCodeProof(code) {
  if (typeof code !== 'string' || !RUNTIME_CODE.test(code))
    throw Error('umbrella_holder_code_invalid')
  const normalized = code.toLowerCase()
  const status =
    normalized === '0x'
      ? 'no_code'
      : DELEGATION_CODE.test(normalized)
        ? 'eip7702_delegated'
        : 'contract_code'
  return {
    holderEoa: status !== 'contract_code',
    holderCodeStatus: status,
    holderCodeHex: status === 'contract_code' ? null : normalized,
    holderCodeHash: normalized === '0x' ? null : keccak256(normalized).toLowerCase(),
  }
}

export async function pinnedHolderOriginCodeProof(client, holder, blockHash) {
  const code = await client.request({
    method: 'eth_getCode',
    params: [holder, { blockHash, requireCanonical: true }],
  })
  return holderOriginCodeProof(code)
}

function validHolderOriginCodeProof(measurement, allowLegacy = false) {
  // Earlier sealed rows only contain holderEoa. Keep their bytes and their
  // historical evidence limits intact; new rows carry a raw-code proof.
  if (
    !('holderCodeStatus' in measurement) &&
    !('holderCodeHex' in measurement) &&
    !('holderCodeHash' in measurement)
  )
    return allowLegacy || measurement.outcome === 'regime_changed'
  const status = measurement.holderCodeStatus
  return (
    ['no_code', 'eip7702_delegated', 'contract_code'].includes(status) &&
    measurement.holderEoa === (status !== 'contract_code') &&
    (status === 'no_code'
      ? measurement.holderCodeHex === '0x' && measurement.holderCodeHash === null
      : status === 'eip7702_delegated'
        ? DELEGATION_CODE.test(measurement.holderCodeHex ?? '') &&
          measurement.holderCodeHash === keccak256(measurement.holderCodeHex).toLowerCase()
        : measurement.holderCodeHex === null && HASH.test(measurement.holderCodeHash ?? ''))
  )
}

function isRevert(error) {
  const detail = `${error?.shortMessage ?? ''} ${error?.message ?? ''}`.toLowerCase()
  if (/http request|timeout|network|rate limit|gas limit|out of gas/.test(detail)) return false
  if (error?.cause && error.cause !== error && !isRevert(error.cause)) return false
  if (
    error?.name === 'ContractFunctionRevertedError' ||
    /execution reverted|reverted with|contract function reverted/.test(detail)
  )
    return true
  return false
}

function origin(url) {
  const parsed = new URL(url)
  if (
    !['https:', 'http:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  )
    throw Error('umbrella_rpc_origin_invalid')
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
    throw Error('umbrella_independent_rpc_required')
  return urls.map((url) => ({
    source: origin(url),
    client: createPublicClient({
      chain: mainnet,
      transport: http(url, { timeout: 10_000, retryCount: 0 }),
    }),
  }))
}

export async function finalizedPair(sources) {
  const heads = await Promise.allSettled(
    sources.map(async (entry) => {
      if ((await entry.client.getChainId()) !== 1) throw Error('umbrella_chain_mismatch')
      return { ...entry, head: await entry.client.getBlock({ blockTag: 'finalized' }) }
    }),
  )
  const good = heads.filter((item) => item.status === 'fulfilled').map((item) => item.value)
  for (let i = 0; i < good.length; i++)
    for (let j = i + 1; j < good.length; j++) {
      if (good[i].source === good[j].source) continue
      const n =
        good[i].head.number < good[j].head.number ? good[i].head.number : good[j].head.number
      try {
        const [a, b] = await Promise.all([
          good[i].client.getBlock({ blockNumber: n }),
          good[j].client.getBlock({ blockNumber: n }),
        ])
        const h = header(a)
        if (
          validHeader(h) &&
          same(a.hash, b.hash) &&
          same(a.parentHash, b.parentHash) &&
          a.timestamp === b.timestamp
        ) {
          const pinned = { blockHash: h.hash, requireCanonical: true }
          const [assetA, assetB] = await Promise.all([
            good[i].client.readContract({
              address: VAULT,
              abi: ABI,
              functionName: 'asset',
              ...pinned,
            }),
            good[j].client.readContract({
              address: VAULT,
              abi: ABI,
              functionName: 'asset',
              ...pinned,
            }),
          ])
          if (same(assetA, GHO) && same(assetB, GHO)) return { pair: [good[i], good[j]], block: h }
        }
      } catch {
        /* Try another independent pair. */
      }
    }
  throw Error('umbrella_finalized_pair_unavailable')
}

async function measured(entry, block, holder, expectedCodeHash = null) {
  const pinned = { blockHash: block.hash, requireCanonical: true }
  const slot = await entry.client.getStorageAt({ address: VAULT, slot: SLOT, ...pinned })
  const implementation = fromSlot(slot)
  if (!implementation || !same(implementation, IMPLEMENTATION))
    return { outcome: 'regime_changed', implementation, codeHash: null }
  const code = await entry.client.getCode({ address: implementation, ...pinned })
  if (!code || code === '0x') throw Error('umbrella_implementation_code_missing')
  const codeHash = keccak256(code).toLowerCase()
  if (expectedCodeHash && codeHash !== expectedCodeHash)
    return { outcome: 'regime_changed', implementation, codeHash }
  const read = (functionName, args) =>
    entry.client.readContract({
      address: VAULT,
      abi: ABI,
      functionName,
      args,
      ...pinned,
    })
  const [asset, paused, balance, snapshot, maxRedeem, cooldown, window, slashable, holderProof] =
    await Promise.all([
      read('asset'),
      read('paused'),
      read('balanceOf', [holder]),
      read('getStakerCooldown', [holder]),
      read('maxRedeem', [holder]),
      read('getCooldown'),
      read('getUnstakeWindow'),
      read('getMaxSlashableAssets'),
      pinnedHolderOriginCodeProof(entry.client, holder, block.hash),
    ])
  if (!same(asset, GHO)) throw Error('umbrella_route_asset_changed')
  if (
    typeof paused !== 'boolean' ||
    typeof balance !== 'bigint' ||
    typeof maxRedeem !== 'bigint' ||
    typeof cooldown !== 'bigint' ||
    typeof window !== 'bigint' ||
    typeof slashable !== 'bigint' ||
    !Array.isArray(snapshot) ||
    snapshot.length !== 3 ||
    snapshot.some((v) => typeof v !== 'number' && typeof v !== 'bigint')
  )
    throw Error('umbrella_state_invalid')
  const [cooldownShares, end, withdrawalWindow] = snapshot.map(BigInt)
  const at = BigInt(block.timestamp)
  const windowOpen = cooldownShares > 0n && at >= end && at <= end + withdrawalWindow
  const gate = paused
    ? 'paused'
    : balance < BigInt(SHARES_RAW)
      ? 'holder_attrition'
      : cooldownShares === 0n || end === 0n
        ? 'cooldown_not_started'
        : at < end
          ? 'waiting'
          : at > end + withdrawalWindow
            ? 'window_expired'
            : maxRedeem < BigInt(SHARES_RAW)
              ? 'amount_exceeds_window'
              : 'window_open'
  const eoa = holderProof.holderEoa
  let outcome = 'not_attempted'
  let ghoRaw = null
  if (eoa && balance >= BigInt(SHARES_RAW)) {
    try {
      const response = await entry.client.call({
        to: VAULT,
        account: holder,
        data: encodeFunctionData({
          abi: ABI,
          functionName: 'redeem',
          args: [BigInt(SHARES_RAW), holder, holder],
        }),
        gas: 20_000_000n,
        ...pinned,
      })
      if (!response.data) throw Error('umbrella_call_empty')
      const amount = decodeFunctionResult({ abi: ABI, functionName: 'redeem', data: response.data })
      if (typeof amount !== 'bigint' || amount <= 0n) throw Error('umbrella_call_invalid')
      outcome = 'success'
      ghoRaw = String(amount)
    } catch (error) {
      if (!isRevert(error)) throw error
      outcome = 'evm_revert'
    }
  }
  const confirmed = await entry.client.getBlock({ blockNumber: BigInt(block.number) })
  if (!same(confirmed.hash, block.hash)) throw Error('umbrella_block_changed')
  return {
    outcome,
    implementation,
    codeHash,
    asset: GHO.toLowerCase(),
    holderEoa: eoa,
    holderCodeStatus: holderProof.holderCodeStatus,
    holderCodeHex: holderProof.holderCodeHex,
    holderCodeHash: holderProof.holderCodeHash,
    holderSharesRaw: String(balance),
    cooldownSharesRaw: String(cooldownShares),
    endOfCooldown: Number(end),
    withdrawalWindow: Number(withdrawalWindow),
    windowOpen,
    maxRedeemSharesRaw: String(maxRedeem),
    gate,
    paused,
    currentCooldownSeconds: String(cooldown),
    currentWindowSeconds: String(window),
    maxSlashableGhoRaw: String(slashable),
    ghoRaw,
  }
}

export async function twoOriginMeasurement(pair, block, holder, expectedCodeHash = null) {
  const [a, b] = await Promise.all(
    pair.map((entry) => measured(entry, block, holder, expectedCodeHash)),
  )
  if (JSON.stringify(a) !== JSON.stringify(b)) throw Error('umbrella_two_origin_disagreement')
  return { ...a, sources: pair.map((entry) => entry.source) }
}

export function previouslySampledHolder(holder, issues) {
  return issues.some((issue) => same(issue.holder, holder))
}

export function readFrozenSeedCandidates(path = SEED_PATH) {
  const bytes = readFileSync(path)
  if (createHash('sha256').update(bytes).digest('hex') !== SEED_SHA256)
    throw Error('umbrella_seed_sha_mismatch')
  const seed = JSON.parse(bytes.toString('utf8'))
  const owners = seed.positions
    .filter((position) => same(position.vault, VAULT) && position.routeIds.includes(ROUTE))
    .map((position) => position.owner.toLowerCase())
  if (
    owners.length !== 21 ||
    new Set(owners).size !== 21 ||
    owners.some((owner) => !ADDRESS.test(owner))
  )
    throw Error('umbrella_seed_route_invalid')
  return owners
}

export async function findFrozenSeedCandidate(
  pair,
  block,
  previousIssues = [],
  measure = twoOriginMeasurement,
) {
  const owners = readFrozenSeedCandidates()
  const discovery = pair[0]
  const pinned = { blockHash: block.hash, requireCanonical: true }
  let fallback = null,
    checked = 0,
    eligible = 0
  for (const [index, holder] of owners.entries()) {
    if (previouslySampledHolder(holder, previousIssues)) continue
    checked++
    const [holderProof, balance] = await Promise.all([
      pinnedHolderOriginCodeProof(discovery.client, holder, block.hash),
      discovery.client.readContract({
        address: VAULT,
        abi: ABI,
        functionName: 'balanceOf',
        args: [holder],
        ...pinned,
      }),
    ])
    if (!holderProof.holderEoa || typeof balance !== 'bigint' || balance < BigInt(SHARES_RAW))
      continue
    const observation = await measure(pair, block, holder)
    if (observation.outcome === 'regime_changed') throw Error('umbrella_issue_regime_changed')
    if (!observation.holderEoa || BigInt(observation.holderSharesRaw) < BigInt(SHARES_RAW)) continue
    eligible++
    const candidate = {
      holder,
      measurement: observation,
      selection: {
        candidateSource: 'frozen_august_route_seed',
        samplingRule: SEED_SAMPLING_RULE,
        seedPath: SEED_RELATIVE_PATH,
        seedSha256: SEED_SHA256,
        seedCandidates: owners.length,
        seedIndex: index,
        candidatesChecked: checked,
        eligibleTested: eligible,
        discoverySource: discovery.source,
      },
    }
    if (observation.gate === 'window_open') return candidate
    if (!fallback) fallback = candidate
    if (eligible >= 8) break
  }
  if (fallback)
    return {
      ...fallback,
      selection: { ...fallback.selection, candidatesChecked: checked, eligibleTested: eligible },
    }
  throw Error('umbrella_no_eligible_eoa')
}

export function shouldSealMissedDeadline(finalizedMs, localMs, deadlineMs) {
  return finalizedMs > deadlineMs && localMs > deadlineMs
}

export async function findCandidate(
  sources,
  pair,
  block,
  previousIssues = [],
  measure = twoOriginMeasurement,
) {
  // The 100k-block discovery window screens at most 60 distinct recipients.
  // A cap hit means no eligible EOA was found in that bounded screen, not
  // that every Transfer recipient in the window lacks current shares.
  let fallback = null,
    eligible = 0,
    checked = 0,
    totalLogs = 0
  const seen = new Set()
  const pinned = { blockHash: block.hash, requireCanonical: true }
  for (
    let end = BigInt(block.number);
    end >= 0n && end > BigInt(block.number) - SCAN_BLOCKS;
    end -= LOG_CHUNK_BLOCKS
  ) {
    const start = end - LOG_CHUNK_BLOCKS + 1n
    let logs = null,
      discoverySource = null,
      discoveryClient = null
    for (const entry of sources) {
      try {
        const anchor = await entry.client.getBlock({ blockNumber: BigInt(block.number) })
        if (!same(anchor.hash, block.hash)) continue
        logs = await entry.client.getLogs({
          address: VAULT,
          event: TRANSFER,
          fromBlock: start > 0n ? start : 0n,
          toBlock: end,
        })
        discoverySource = entry.source
        discoveryClient = entry.client
        break
      } catch {
        /* Try another source for this exact chunk. */
      }
    }
    if (!logs || !discoveryClient) throw Error('umbrella_transfer_discovery_unavailable')
    totalLogs += logs.length
    for (const log of logs.reverse()) {
      const holder = log.args.to?.toLowerCase()
      if (
        !ADDRESS.test(holder ?? '') ||
        /^0x0{40}$/.test(holder) ||
        seen.has(holder) ||
        previouslySampledHolder(holder, previousIssues)
      )
        continue
      seen.add(holder)
      checked++
      const [holderProof, balance] = await Promise.all([
        pinnedHolderOriginCodeProof(discoveryClient, holder, block.hash),
        discoveryClient.readContract({
          address: VAULT,
          abi: ABI,
          functionName: 'balanceOf',
          args: [holder],
          ...pinned,
        }),
      ])
      if (!holderProof.holderEoa || typeof balance !== 'bigint' || balance < BigInt(SHARES_RAW))
        continue
      const observation = await measure(pair, block, holder)
      if (observation.outcome === 'regime_changed') throw Error('umbrella_issue_regime_changed')
      if (!observation.holderEoa || BigInt(observation.holderSharesRaw) < BigInt(SHARES_RAW))
        continue
      eligible++
      const candidate = {
        holder,
        measurement: observation,
        selection: {
          fromBlock: Number(start > 0n ? start : 0n),
          toBlock: block.number,
          transferLogs: totalLogs,
          candidatesChecked: checked,
          eligibleTested: eligible,
          discoverySource,
          samplingRule: 'first_window_open_else_first_eligible_eoa',
        },
      }
      if (observation.gate === 'window_open') return candidate
      if (!fallback) fallback = candidate
      if (eligible >= 8 || checked >= 60) break
    }
    if (eligible >= 8 || checked >= 60) break
  }
  if (fallback)
    return {
      ...fallback,
      selection: { ...fallback.selection, candidatesChecked: checked, eligibleTested: eligible },
    }
  return findFrozenSeedCandidate(pair, block, previousIssues, measure)
}

export function classifyTransition(issue, measurement) {
  if (measurement.outcome === 'regime_changed') return 'regime_change_censored'
  if (!measurement.holderEoa || BigInt(measurement.holderSharesRaw) < BigInt(SHARES_RAW))
    return 'holder_attrition'
  if (measurement.outcome === 'success')
    return issue.measurement.outcome === 'success' ? 'still_callable' : 'simulated_call_recovery'
  if (measurement.outcome === 'evm_revert')
    return issue.measurement.outcome === 'success' ? 'became_reverting' : 'still_reverting'
  return 'unassessed'
}

export function validateIssue(row) {
  const seedSelection = row.selection?.candidateSource === 'frozen_august_route_seed'
  const seedOwners = seedSelection ? readFrozenSeedCandidates() : null
  const validSelection = seedSelection
    ? row.selection.samplingRule === SEED_SAMPLING_RULE &&
      row.selection.seedPath === SEED_RELATIVE_PATH &&
      row.selection.seedSha256 === SEED_SHA256 &&
      row.selection.seedCandidates === 21 &&
      Number.isSafeInteger(row.selection.seedIndex) &&
      row.selection.seedIndex >= 0 &&
      row.selection.seedIndex < 21 &&
      same(seedOwners[row.selection.seedIndex], row.holder) &&
      row.selection.discoverySource === row.measurement?.sources?.[0]
    : row.selection?.candidateSource === undefined &&
      row.selection?.samplingRule === 'first_window_open_else_first_eligible_eoa' &&
      Number.isSafeInteger(row.selection.fromBlock) &&
      Number.isSafeInteger(row.selection.toBlock) &&
      row.selection.fromBlock >= Math.max(0, row.baseline?.number - Number(SCAN_BLOCKS) + 1) &&
      row.selection.toBlock === row.baseline?.number &&
      row.selection.fromBlock <= row.selection.toBlock &&
      Number.isSafeInteger(row.selection.transferLogs) &&
      row.selection.transferLogs >= row.selection.candidatesChecked &&
      typeof row.selection.discoverySource === 'string' &&
      row.selection.discoverySource.length > 0 &&
      row.selection.discoverySource.length <= 253 &&
      !['seedPath', 'seedSha256', 'seedCandidates', 'seedIndex'].some((key) => key in row.selection)
  const plan = row.targets?.map((target) => target.horizonHours)
  const validPlan =
    Array.isArray(plan) &&
    [LEGACY_HORIZONS_HOURS, HORIZONS_HOURS].some(
      (expected) =>
        (expected !== LEGACY_HORIZONS_HOURS || row.sequence === 1) &&
        plan.length === expected.length &&
        plan.every((value, index) => value === expected[index]),
    )
  if (
    row.study !== STUDY ||
    row.kind !== 'issue' ||
    row.routeKey !== ROUTE ||
    row.destination !== VAULT ||
    row.sharesRaw !== SHARES_RAW ||
    !ADDRESS.test(row.holder ?? '') ||
    !validHeader(row.baseline) ||
    !clock(row.issuedAtUtc) ||
    Date.parse(row.issuedAtUtc) < row.baseline.timestamp * 1000 ||
    !validSelection ||
    !Number.isSafeInteger(row.selection.candidatesChecked) ||
    row.selection.candidatesChecked < 1 ||
    !Number.isSafeInteger(row.selection.eligibleTested) ||
    row.selection.eligibleTested < 1 ||
    row.measurement?.sources?.length !== 2 ||
    row.measurement.sources[0] === row.measurement.sources[1] ||
    row.measurement.implementation?.toLowerCase() !== IMPLEMENTATION.toLowerCase() ||
    !HASH.test(row.measurement.codeHash ?? '') ||
    !['success', 'evm_revert'].includes(row.measurement.outcome) ||
    !row.measurement.holderEoa ||
    !validHolderOriginCodeProof(
      row.measurement,
      Number.isSafeInteger(row.sequence) && row.sequence <= LEGACY_ISSUES_WITHOUT_HOLDER_PROOF,
    ) ||
    BigInt(row.measurement.holderSharesRaw ?? '0') < BigInt(SHARES_RAW) ||
    !validPlan ||
    row.targets.some(
      (target, index) =>
        target.horizonHours !== plan[index] ||
        !clock(target.targetAtUtc) ||
        !clock(target.deadlineUtc) ||
        Date.parse(target.targetAtUtc) !==
          row.baseline.timestamp * 1000 + target.horizonHours * 3_600_000 ||
        Date.parse(target.deadlineUtc) !==
          Date.parse(target.targetAtUtc) + DEADLINE_HOURS * 3_600_000 ||
        Date.parse(row.issuedAtUtc) >= Date.parse(target.targetAtUtc),
    )
  )
    throw Error('umbrella_issue_invalid')
}

export function validateScore(row, issues) {
  const issue = issues.find((item) => item.sequence === row.issueSequence)
  const target = issue?.targets.find((item) => item.horizonHours === row.horizonHours)
  if (
    row.study !== STUDY ||
    row.kind !== 'score' ||
    !issue ||
    !target ||
    row.issueSha256 !== issue.sha256 ||
    !clock(row.scoredAtUtc) ||
    !['measured', 'missed_deadline'].includes(row.status) ||
    (row.status === 'measured' &&
      (Date.parse(row.scoredAtUtc) < Date.parse(target.targetAtUtc) ||
        Date.parse(row.scoredAtUtc) > Date.parse(target.deadlineUtc) ||
        !validHeader(row.targetBlock) ||
        !validHeader(row.parentBlock) ||
        row.targetBlock.number !== row.parentBlock.number + 1 ||
        !same(row.targetBlock.parentHash, row.parentBlock.hash) ||
        row.parentBlock.timestamp * 1000 >= Date.parse(target.targetAtUtc) ||
        row.targetBlock.timestamp * 1000 < Date.parse(target.targetAtUtc) ||
        Date.parse(row.scoredAtUtc) < row.targetBlock.timestamp * 1000 ||
        row.measurement?.sources?.length !== 2 ||
        row.measurement.sources[0] === row.measurement.sources[1] ||
        !validHolderOriginCodeProof(
          row.measurement,
          Number.isSafeInteger(row.sequence) && row.sequence <= LEGACY_SCORES_WITHOUT_HOLDER_PROOF,
        ) ||
        row.transition !== classifyTransition(issue, row.measurement))) ||
    (row.status === 'missed_deadline' &&
      (Date.parse(row.scoredAtUtc) <= Date.parse(target.deadlineUtc) ||
        !validHeader(row.deadlineFinalizedBlock) ||
        row.deadlineFinalizedBlock.timestamp * 1000 <= Date.parse(target.deadlineUtc) ||
        row.deadlineFinalizedBlock.timestamp * 1000 > Date.parse(row.scoredAtUtc) ||
        row.targetBlock !== null ||
        row.parentBlock !== null ||
        row.measurement !== null ||
        row.transition !== 'missing'))
  )
    throw Error('umbrella_score_invalid')
}

export function validateAttempt(row) {
  if (
    row.study !== STUDY ||
    row.kind !== 'attempt' ||
    !['issue', 'score'].includes(row.mode) ||
    !clock(row.startedAtUtc) ||
    !clock(row.finishedAtUtc) ||
    Date.parse(row.finishedAtUtc) < Date.parse(row.startedAtUtc) ||
    row.slot !== Math.floor(Date.parse(row.startedAtUtc) / SLOT_MS) ||
    ![
      'issued',
      'scored',
      'reconciled_issue',
      'reconciled_score',
      'nothing_due',
      'duplicate_slot',
      'failed',
    ].includes(row.status) ||
    (['issued', 'scored', 'reconciled_issue', 'reconciled_score'].includes(row.status) &&
      (!Number.isSafeInteger(row.recordSequence) || !SHA.test(row.recordSha256 ?? ''))) ||
    (!['issued', 'scored', 'reconciled_issue', 'reconciled_score'].includes(row.status) &&
      (row.recordSequence !== null || row.recordSha256 !== null))
  )
    throw Error('umbrella_attempt_invalid')
}

export async function verifyAll(allowOrphans = false) {
  const issues = await readChain(ISSUE_DIR, validateIssue)
  const issuedHolders = new Set()
  for (const issue of issues) {
    const holder = issue.holder.toLowerCase()
    if (issuedHolders.has(holder)) throw Error('umbrella_duplicate_holder_issue')
    issuedHolders.add(holder)
  }
  const scores = await readChain(SCORE_DIR, (row) => validateScore(row, issues))
  const attempts = await readChain(ATTEMPT_DIR, validateAttempt)
  const unique = new Set()
  for (const score of scores) {
    const key = `${score.issueSequence}:${score.horizonHours}`
    if (unique.has(key)) throw Error('umbrella_duplicate_score')
    unique.add(key)
  }
  const linked = new Set()
  for (const attempt of attempts) {
    if (!['issued', 'scored', 'reconciled_issue', 'reconciled_score'].includes(attempt.status))
      continue
    const mode = ['issued', 'reconciled_issue'].includes(attempt.status) ? 'issue' : 'score'
    const record = (mode === 'issue' ? issues : scores)[attempt.recordSequence - 1]
    const key = `${mode}:${attempt.recordSequence}`
    const recordedAt = Date.parse(record?.[mode === 'issue' ? 'issuedAtUtc' : 'scoredAtUtc'])
    if (
      !record ||
      record.sha256 !== attempt.recordSha256 ||
      linked.has(key) ||
      (attempt.status.startsWith('reconciled_')
        ? recordedAt > Date.parse(attempt.startedAtUtc)
        : recordedAt < Date.parse(attempt.startedAtUtc) ||
          recordedAt > Date.parse(attempt.finishedAtUtc))
    )
      throw Error('umbrella_attempt_link_invalid')
    linked.add(key)
  }
  const orphanIssues = issues.filter((row) => !linked.has(`issue:${row.sequence}`))
  const orphanScores = scores.filter((row) => !linked.has(`score:${row.sequence}`))
  if (!allowOrphans && (orphanIssues.length || orphanScores.length))
    throw Error('umbrella_orphan_record')
  return { issues, scores, attempts, orphanIssues, orphanScores }
}

export async function recoverInterruptedAppends(now = () => Date.now()) {
  const pending = await verifyAll(true)
  for (const [mode, records] of [
    ['issue', pending.orphanIssues],
    ['score', pending.orphanScores],
  ])
    for (const row of records) {
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
  return verifyAll()
}

export function selectIssueCandidate(
  candidateSource,
  sources,
  pair,
  block,
  issues,
  selectors = { transfer: findCandidate, seed: findFrozenSeedCandidate },
) {
  if (candidateSource === 'transfer') return selectors.transfer(sources, pair, block, issues)
  if (candidateSource === 'frozen_seed') return selectors.seed(pair, block, issues)
  throw Error('umbrella_candidate_source_invalid')
}

export async function issueOne(
  sources = configuredClients(),
  now = () => Date.now(),
  candidateSource = 'transfer',
) {
  const { issues } = await verifyAll()
  const { pair, block } = await finalizedPair(sources)
  if (now() - block.timestamp * 1000 < -120_000 || now() - block.timestamp * 1000 > 2 * 3_600_000)
    throw Error('umbrella_finalized_block_stale')
  const { holder, selection, measurement } = await selectIssueCandidate(
    candidateSource,
    sources,
    pair,
    block,
    issues,
  )
  const issuedAtUtc = iso(now())
  if (Date.parse(issuedAtUtc) >= block.timestamp * 1000 + HORIZONS_HOURS[0] * 3_600_000)
    throw Error('umbrella_h1_target_passed')
  return appendChain(
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
      targets: HORIZONS_HOURS.map((horizonHours) => ({
        horizonHours,
        targetAtUtc: iso(block.timestamp * 1000 + horizonHours * 3_600_000),
        deadlineUtc: iso(block.timestamp * 1000 + (horizonHours + DEADLINE_HOURS) * 3_600_000),
      })),
    },
    validateIssue,
  )
}

async function firstFinalizedAt(pair, targetMs) {
  const headNumber =
    pair[0].head.number < pair[1].head.number ? pair[0].head.number : pair[1].head.number
  const head = await pair[0].client.getBlock({ blockNumber: headNumber })
  if (Number(head.timestamp) * 1000 < targetMs) return null
  let lo = 0n,
    hi = head.number
  while (lo < hi) {
    const mid = (lo + hi) / 2n
    const block = await pair[0].client.getBlock({ blockNumber: mid })
    if (Number(block.timestamp) * 1000 >= targetMs) hi = mid
    else lo = mid + 1n
  }
  if (lo === 0n) throw Error('umbrella_target_parent_missing')
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
    throw Error('umbrella_target_two_origin_invalid')
  return { target: header(a), parent: header(pa) }
}

export async function scoreDue(sources = configuredClients(), now = () => Date.now()) {
  const { issues, scores } = await verifyAll()
  const scored = new Set(scores.map((row) => `${row.issueSequence}:${row.horizonHours}`))
  if (
    issues.every((issue) =>
      issue.targets.every((target) => scored.has(`${issue.sequence}:${target.horizonHours}`)),
    )
  )
    return null
  const { pair, block } = await finalizedPair(sources)
  const finalizedTime = block.timestamp * 1000
  const selectedDue = selectDueScoreTarget(issues, scores, finalizedTime, now())
  if (!selectedDue) return null
  const { issue, target } = selectedDue
  const missed = () =>
    appendChain(
      SCORE_DIR,
      {
        study: STUDY,
        kind: 'score',
        issueSequence: issue.sequence,
        issueSha256: issue.sha256,
        horizonHours: target.horizonHours,
        scoredAtUtc: iso(now()),
        status: 'missed_deadline',
        deadlineFinalizedBlock: block,
        targetBlock: null,
        parentBlock: null,
        measurement: null,
        transition: 'missing',
      },
      (row) => validateScore(row, issues),
    )
  // A changed Mac clock cannot permanently censor an outcome before two
  // independent finalized chain views have crossed its capture deadline.
  if (finalizedTime > Date.parse(target.deadlineUtc)) {
    if (!shouldSealMissedDeadline(finalizedTime, now(), Date.parse(target.deadlineUtc))) return null
    return missed()
  }
  if (now() < Date.parse(target.targetAtUtc) || now() > Date.parse(target.deadlineUtc)) return null
  const selected = await firstFinalizedAt(pair, Date.parse(target.targetAtUtc))
  if (!selected) return null
  const measurement = await twoOriginMeasurement(
    pair,
    selected.target,
    issue.holder,
    issue.measurement.codeHash,
  )
  if (now() > Date.parse(target.deadlineUtc)) return null
  return appendChain(
    SCORE_DIR,
    {
      study: STUDY,
      kind: 'score',
      issueSequence: issue.sequence,
      issueSha256: issue.sha256,
      horizonHours: target.horizonHours,
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

export function selectDueScoreTarget(issues, scores, finalizedTime, localTime) {
  const scored = new Set(scores.map((row) => `${row.issueSequence}:${row.horizonHours}`))
  const due = issues
    .flatMap((issue) =>
      issue.targets
        .filter(
          (target) =>
            Date.parse(target.targetAtUtc) <= finalizedTime &&
            Date.parse(target.targetAtUtc) <= localTime &&
            !scored.has(`${issue.sequence}:${target.horizonHours}`),
        )
        .map((target) => ({ issue, target })),
    )
    .filter(({ target }) =>
      finalizedTime <= Date.parse(target.deadlineUtc)
        ? localTime <= Date.parse(target.deadlineUtc)
        : localTime > Date.parse(target.deadlineUtc),
    )
    .sort((a, b) => {
      const aOpen = finalizedTime <= Date.parse(a.target.deadlineUtc)
      const bOpen = finalizedTime <= Date.parse(b.target.deadlineUtc)
      if (aOpen !== bOpen) return aOpen ? -1 : 1
      const aClock = Date.parse(aOpen ? a.target.deadlineUtc : a.target.targetAtUtc)
      const bClock = Date.parse(bOpen ? b.target.deadlineUtc : b.target.targetAtUtc)
      return (
        aClock - bClock ||
        a.issue.sequence - b.issue.sequence ||
        a.target.horizonHours - b.target.horizonHours
      )
    })
  return due[0] ?? null
}

function isTransportFailure(error) {
  for (let current = error, depth = 0; current && depth < 8; current = current.cause, depth++) {
    if (
      /^(HttpRequestError|TimeoutError|SocketError|WebSocketRequestError)$/.test(
        String(current.name ?? ''),
      ) ||
      ['umbrella_finalized_pair_unavailable', 'umbrella_transfer_discovery_unavailable'].includes(
        String(current.message ?? ''),
      )
    )
      return true
  }
  return false
}

export async function retryTransient(
  operation,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await operation(attempt)
    } catch (error) {
      if (!isTransportFailure(error) || attempt === 3) throw error
      await pause(500 * (attempt + 1))
    }
  }
}

export function tickMode(mode) {
  if (mode === 'issue') return { attemptMode: 'issue', candidateSource: 'transfer' }
  if (mode === 'issue-seed') return { attemptMode: 'issue', candidateSource: 'frozen_seed' }
  if (mode === 'score') return { attemptMode: 'score', candidateSource: null }
  throw Error('umbrella_mode_invalid')
}

export async function tick(mode, now = () => Date.now(), sources = configuredClients()) {
  const { attemptMode, candidateSource } = tickMode(mode)
  const startedAtUtc = iso(now())
  const slot = Math.floor(Date.parse(startedAtUtc) / SLOT_MS)
  const { attempts } = await recoverInterruptedAppends(now)
  let row = null,
    status = 'nothing_due',
    failure = null
  if (
    attemptMode === 'issue' &&
    attempts.some(
      (item) => item.mode === attemptMode && item.slot === slot && item.status !== 'failed',
    )
  )
    status = 'duplicate_slot'
  else {
    try {
      row = await retryTransient((attempt) => {
        const rotated = [...sources.slice(attempt), ...sources.slice(0, attempt)]
        return attemptMode === 'issue'
          ? issueOne(rotated, now, candidateSource)
          : scoreDue(rotated, now)
      })
      status = row ? (attemptMode === 'issue' ? 'issued' : 'scored') : 'nothing_due'
    } catch (error) {
      status = 'failed'
      const code = String(error?.message ?? '')
      failure = /^umbrella_[a-z0-9_]+$/.test(code)
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
      mode: attemptMode,
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
  if (status === 'failed') throw Error(`umbrella_tick_failed:${failure}`)
  return { status, recordSequence: row?.sequence ?? null, attemptSequence: attempt.sequence }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2]
  if (!['issue', 'issue-seed', 'score', 'verify'].includes(mode))
    throw Error('usage: issue|issue-seed|score|verify')
  const result = mode === 'verify' ? await verifyAll() : await tick(mode)
  console.log(
    mode === 'verify'
      ? JSON.stringify({
          issues: result.issues.length,
          scores: result.scores.length,
          attempts: result.attempts.length,
        })
      : JSON.stringify(result),
  )
}
