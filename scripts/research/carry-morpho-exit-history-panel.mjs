// Read-only historical exact-holder exit panel. It is not prospective validation or a forecast.
// node scripts/research/carry-morpho-exit-history-panel.mjs --max-vaults 4
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, linkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { decodeFunctionResult, encodeFunctionData, parseAbi, parseAbiItem, toEventSelector } from 'viem'
import { makeClient, readEnv, ROOT } from '../lib/venue-reads.mjs'

const MANIFEST_PATH = join(ROOT, 'lib/carry/morpho-v2-asset-identities.json')
const MANIFEST_SHA = '8dd54bbb3dea0842bb67e582f0725adcafb7594107933122c5fa381c083566da'
const DEFAULT_ANCHOR = 26_052_740n
const LOOKBACK = 4_096n
const LOG_CHUNK = 512n
const MAX_CANDIDATES = 4
const ADDRESS = /^0x[0-9a-f]{40}$/i
const HASH = /^0x[0-9a-f]{64}$/i
const ZERO = `0x${'0'.repeat(40)}`
const TRANSFER = toEventSelector('Transfer(address,address,uint256)')
const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)')
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function totalAssets() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function withdraw(uint256,address,address) returns (uint256)',
])
export const METHOD = Object.freeze({
  anchorSelection: 'fixed_block', holderDiscovery: 'positive Transfer recipients strictly before B',
  candidateOrder: 'most recent transfer first', candidateLookbackBlocks: Number(LOOKBACK),
  maxCandidatesPerVault: MAX_CANDIDATES,
  sizing: 'min(10% anchor holder claim, 0.1% anchor vault totalAssets)',
  call: 'withdraw(q,holder,holder) from holder at EIP-1898 canonical block hash, 20m gas',
  discoveryReceiptVerification: 'not_rechecked; canonical discovery block hash verified',
})

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const asNumber = (value) => {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('unsafe_block_number')
  return result
}
const lower = (value) => String(value).toLowerCase()
const pinned = (hash) => ({ blockHash: hash, requireCanonical: true })

export function loadUniverse(bytes = readFileSync(MANIFEST_PATH)) {
  if (sha(bytes) !== MANIFEST_SHA) throw new Error('morpho_manifest_hash_changed')
  const manifest = JSON.parse(bytes)
  if (manifest.schemaVersion !== 1 || manifest.chainId !== 1 || manifest.entries?.length !== 49)
    throw new Error('morpho_manifest_cohort_changed')
  const entries = manifest.entries.map((entry) => ({
    vault: lower(entry.vault), asset: lower(entry.asset),
    creationBlock: asNumber(entry.creation?.blockNumber),
  })).sort((a, b) => a.vault.localeCompare(b.vault))
  if (new Set(entries.map((e) => e.vault)).size !== 49 ||
      entries.some((e) => !ADDRESS.test(e.vault) || !ADDRESS.test(e.asset)))
    throw new Error('morpho_manifest_identity_invalid')
  return entries
}

export function chooseQ(claim, totalAssets) {
  if (claim <= 0n || totalAssets <= 0n) return 0n
  const qHolder = claim / 10n
  const qVault = totalAssets / 1_000n
  return qHolder < qVault ? qHolder : qVault
}

export function selectCandidates(logs, vault, fromBlock, anchorBlock) {
  const seen = new Set(), candidates = []
  const sorted = [...logs].sort((a, b) =>
    asNumber(b.blockNumber) - asNumber(a.blockNumber) ||
    asNumber(b.transactionIndex) - asNumber(a.transactionIndex) ||
    asNumber(b.logIndex) - asNumber(a.logIndex))
  for (const log of sorted) {
    const block = BigInt(log.blockNumber)
    if (lower(log.address) !== vault || block < fromBlock || block >= anchorBlock ||
        lower(log.topics?.[0]) !== lower(TRANSFER) || log.topics?.length !== 3 ||
        !HASH.test(log.blockHash) || !HASH.test(log.transactionHash) ||
        log.removed === true || !/^0x[0-9a-f]{64}$/i.test(log.data || '') ||
        !/^0x0{24}[0-9a-f]{40}$/i.test(log.topics[1] || '') ||
        !/^0x0{24}[0-9a-f]{40}$/i.test(log.topics[2] || ''))
      throw new Error('malformed_pre_anchor_transfer_log')
    if (BigInt(log.data) === 0n) continue
    const owner = `0x${log.topics[2].slice(26)}`.toLowerCase()
    if (owner === ZERO || owner === vault || seen.has(owner)) continue
    seen.add(owner)
    candidates.push({owner, discoveryBlock: asNumber(log.blockNumber),
      discoveryBlockHash: lower(log.blockHash), discoveryTransactionHash: lower(log.transactionHash),
      discoveryLogIndex: asNumber(log.logIndex)})
  }
  return candidates
}

export function classifyProbe({call, shares, claim, q, code}) {
  if (call.status === 'missing_rpc') return 'missing_rpc'
  if (call.status === 'gas_error') return 'gas_error'
  if (code !== '0x') return 'holder_type_changed'
  if (call.status === 'success') return 'success'
  if (shares === 0n || claim < q) return 'position_attrition'
  return 'evm_revert'
}

function errorKind(error) {
  const parts = []
  for (let e = error, i = 0; e && i < 5; e = e.cause, i++)
    parts.push(`${e.name || ''} ${e.shortMessage || ''} ${e.details || ''} ${e.message || ''}`)
  const message = parts.join(' ').toLowerCase()
  if (/out of gas|gas limit|exceeds block gas|intrinsic gas/.test(message)) return 'gas_error'
  if (/execution reverted|reverted with|contractfunctionrevertederror/.test(message)) return 'evm_revert'
  return 'missing_rpc'
}

async function header(client, number) {
  const block = await client.getBlock({blockNumber: number})
  if (block.number !== number || !HASH.test(block.hash || '') || typeof block.timestamp !== 'bigint')
    throw new Error('invalid_archive_header')
  return {number: asNumber(number), hash: lower(block.hash), timestamp: asNumber(block.timestamp)}
}

export async function findFirstBlockAtOrAfter(client, anchor, target, head) {
  let low = BigInt(anchor.number) + 1n, high = BigInt(head.number)
  if (head.timestamp < target) throw new Error('target_after_head')
  let result = head
  while (low <= high) {
    const mid = (low + high) / 2n
    const candidate = await header(client, mid)
    if (candidate.timestamp >= target) { result = candidate; high = mid - 1n }
    else low = mid + 1n
  }
  const prior = await header(client, BigInt(result.number) - 1n)
  if (prior.timestamp >= target || result.timestamp < target)
    throw new Error('hour_boundary_not_first_block')
  return { ...result, priorTimestamp: prior.timestamp,
    requestedTimestamp: target, realizedLagSeconds: result.timestamp - target }
}

async function read(client, vault, functionName, args, hash) {
  return client.readContract({address: vault, abi: ABI, functionName, args, ...pinned(hash)})
}

async function simulate(client, vault, owner, q, hash) {
  try {
    const data = encodeFunctionData({abi: ABI, functionName: 'withdraw', args: [q, owner, owner]})
    const result = await client.call({account: owner, to: vault, data, gas: 20_000_000n, ...pinned(hash)})
    if (!result.data) throw new Error('empty_eth_call_result')
    const shares = decodeFunctionResult({abi: ABI, functionName: 'withdraw', data: result.data})
    if (typeof shares !== 'bigint' || shares <= 0n) throw new Error('invalid_eth_call_result')
    return {status: 'success', sharesBurnedRaw: shares.toString()}
  } catch (error) {
    return {status: errorKind(error)}
  }
}

async function holderState(client, vault, owner, hash) {
  const code = await client.getCode({address: owner, ...pinned(hash)})
  const shares = await read(client, vault, 'balanceOf', [owner], hash)
  const claim = shares > 0n ? await read(client, vault, 'previewRedeem', [shares], hash) : 0n
  if (typeof shares !== 'bigint' || typeof claim !== 'bigint' || shares < 0n || claim < 0n)
    throw new Error('invalid_holder_state')
  return {code: code || '0x', shares, claim}
}

export async function logsBeforeAnchor(client, vault, anchorBlock) {
  const from = anchorBlock > LOOKBACK ? anchorBlock - LOOKBACK : 1n
  const logs = []
  for (let start = from; start < anchorBlock; start += LOG_CHUNK) {
    const end = start + LOG_CHUNK - 1n < anchorBlock ? start + LOG_CHUNK - 1n : anchorBlock - 1n
    const chunk = await client.getLogs({address: vault, event: TRANSFER_EVENT,
      fromBlock: start, toBlock: end, strict: false})
    logs.push(...chunk)
  }
  return {fromBlock: from, throughBlock: anchorBlock - 1n, logs}
}

async function measureVault(client, subject, anchor, horizon) {
  const row = {vault: subject.vault, expectedAsset: subject.asset, status: 'missing_rpc'}
  try {
    if (subject.creationBlock >= anchor.number) return {...row, status: 'not_created_at_anchor'}
    const [asset, totalAssets] = await Promise.all([
      read(client, subject.vault, 'asset', [], anchor.hash),
      read(client, subject.vault, 'totalAssets', [], anchor.hash),
    ])
    if (lower(asset) !== subject.asset || typeof totalAssets !== 'bigint')
      return {...row, status: 'identity_mismatch', observedAsset: lower(asset)}
    row.totalAssetsRaw = totalAssets.toString()
    if (totalAssets <= 0n) return {...row, status: 'unfunded_at_anchor'}
    const discovery = await logsBeforeAnchor(client, subject.vault, BigInt(anchor.number))
    row.candidateWindow = {fromBlock: Number(discovery.fromBlock),
      throughBlock: Number(discovery.throughBlock), transferLogCount: discovery.logs.length}
    const candidates = selectCandidates(discovery.logs, subject.vault, discovery.fromBlock, BigInt(anchor.number))
    row.discoveredCandidateCount = candidates.length
    row.screenedCandidates = []
    for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
      const screened = {...candidate}
      try {
        const state = await holderState(client, subject.vault, candidate.owner, anchor.hash)
        screened.eoa = state.code === '0x'
        screened.sharesRaw = state.shares.toString()
        screened.claimRaw = state.claim.toString()
        row.screenedCandidates.push(screened)
        if (!screened.eoa || state.shares <= 0n || state.claim <= 0n) continue
        const q = chooseQ(state.claim, totalAssets)
        if (q <= 0n) continue
        const discoveryHeader = await header(client, BigInt(candidate.discoveryBlock))
        if (discoveryHeader.hash !== candidate.discoveryBlockHash ||
            discoveryHeader.timestamp > anchor.timestamp)
          throw new Error('candidate_discovery_header_mismatch')
        row.holder = candidate.owner
        row.holderDiscovery = {...candidate, discoveryTimestamp: discoveryHeader.timestamp}
        row.qAssetsRaw = q.toString()
        row.anchorSharesRaw = state.shares.toString()
        row.anchorClaimRaw = state.claim.toString()
        row.anchorCall = await simulate(client, subject.vault, candidate.owner, q, anchor.hash)
        if (row.anchorCall.status === 'missing_rpc' || row.anchorCall.status === 'gas_error')
          return {...row, status: row.anchorCall.status}
        const future = await holderState(client, subject.vault, candidate.owner, horizon.hash)
        row.horizonSharesRaw = future.shares.toString()
        row.horizonClaimRaw = future.claim.toString()
        row.horizonHolderCodePresent = future.code !== '0x'
        row.horizonCall = await simulate(client, subject.vault, candidate.owner, q, horizon.hash)
        row.horizonClass = classifyProbe({call: row.horizonCall, shares: future.shares,
          claim: future.claim, q, code: future.code})
        row.status = 'measured'
        return row
      } catch (error) {
        if (error?.message === 'candidate_discovery_header_mismatch') throw error
        screened.state = 'missing_rpc'
        if (!row.screenedCandidates.includes(screened)) row.screenedCandidates.push(screened)
        return {...row, status: 'missing_rpc'}
      }
    }
    return {...row, status: candidates.length === 0 ? 'no_candidate_in_lookback' :
      candidates.length > MAX_CANDIDATES ? 'no_holder_in_bounded_candidates' : 'no_pre_anchor_eoa_holder'}
  } catch (error) {
    if (['malformed_pre_anchor_transfer_log', 'candidate_discovery_header_mismatch'].includes(error?.message)) throw error
    return {...row, status: 'missing_rpc'}
  }
}

export async function run(client, {anchorBlock = DEFAULT_ANCHOR, maxVaults = 4, universe = loadUniverse()} = {}) {
  if (!Number.isInteger(maxVaults) || maxVaults < 1 || maxVaults > 49)
    throw new Error('max_vaults_must_be_1_to_49')
  if ((await client.getChainId()) !== 1) throw new Error('wrong_chain')
  const anchor = await header(client, BigInt(anchorBlock))
  const headBlock = await client.getBlock({blockTag: 'finalized'})
  const head = {number: asNumber(headBlock.number), hash: lower(headBlock.hash), timestamp: asNumber(headBlock.timestamp)}
  const horizon = await findFirstBlockAtOrAfter(client, anchor, anchor.timestamp + 3_600, head)
  if (horizon.timestamp - anchor.timestamp > 3_620) throw new Error('horizon_time_gap_too_large')
  const rows = universe.map((entry) => ({vault: entry.vault, expectedAsset: entry.asset,
    status: 'not_attempted_budget'}))
  for (let i = 0; i < maxVaults; i++) rows[i] = await measureVault(client, universe[i], anchor, horizon)
  const aggregates = aggregateRows(rows)
  return {schemaVersion: 1, study: 'carry-morpho-exit-history-panel-v1', chainId: 1,
    mode: 'historical_read_only', prospectiveValidation: false, futureExitForecast: false,
    universe: {manifestSha256: MANIFEST_SHA, knownVaults: universe.length, attemptedVaults: maxVaults},
    method: METHOD, anchor, horizon, ...aggregates, rows}
}

export function aggregateRows(rows) {
  const countBy = (items, getKey) => Object.fromEntries([...new Set(items.map(getKey))]
    .sort().map((key) => [key, items.filter((row) => getKey(row) === key).length]))
  const measured = rows.filter((row) => row.status === 'measured')
  const baselineSuccess = rows.filter((row) => row.anchorCall?.status === 'success')
  return {
    statusCounts: countBy(rows, (row) => row.status),
    baselineCounts: {
      success: baselineSuccess.length,
      evmRevert: rows.filter((row) => row.anchorCall?.status === 'evm_revert').length,
      missingRpc: rows.filter((row) => row.anchorCall?.status === 'missing_rpc').length,
      gasError: rows.filter((row) => row.anchorCall?.status === 'gas_error').length,
    },
    baselineSuccessRiskSet: {count: baselineSuccess.length,
      uniqueHolders: new Set(baselineSuccess.map((row) => row.holder)).size,
      horizonCounts: countBy(baselineSuccess, (row) => row.horizonClass || 'missing_rpc')},
    holderDependence: {measuredPairs: measured.length,
      measuredUniqueHolders: new Set(measured.map((row) => row.holder)).size,
      sameAnchorForAllRows: true, independentObservations: false},
  }
}

export function validatePanel(panel) {
  const known = loadUniverse()
  if (panel.schemaVersion !== 1 || panel.study !== 'carry-morpho-exit-history-panel-v1' ||
      panel.chainId !== 1 || panel.mode !== 'historical_read_only' ||
      panel.prospectiveValidation !== false || panel.futureExitForecast !== false ||
      !isDeepStrictEqual(panel.method, METHOD) ||
      panel.universe?.manifestSha256 !== MANIFEST_SHA ||
      panel.universe.knownVaults !== 49 ||
      panel.rows?.length !== 49 ||
      panel.rows.some((row, i) => row.vault !== known[i].vault ||
        row.expectedAsset !== known[i].asset) ||
      !HASH.test(panel.anchor?.hash || '') || !HASH.test(panel.horizon?.hash || '') ||
      panel.horizon.requestedTimestamp !== panel.anchor.timestamp + 3_600 ||
      panel.horizon.realizedLagSeconds !== panel.horizon.timestamp - panel.horizon.requestedTimestamp ||
      panel.horizon.realizedLagSeconds > 20 ||
      panel.horizon.priorTimestamp >= panel.horizon.requestedTimestamp ||
      panel.horizon.timestamp < panel.horizon.requestedTimestamp ||
      panel.rows.filter((row) => row.status !== 'not_attempted_budget').length !==
        panel.universe.attemptedVaults)
    throw new Error('historical_panel_validation_failed')
  for (const row of panel.rows) {
    if (row.status !== 'measured') continue
    if (!ADDRESS.test(row.holder || '') || !/^\d+$/.test(row.qAssetsRaw || '') ||
        BigInt(row.qAssetsRaw) <= 0n ||
        row.holderDiscovery?.owner !== row.holder ||
        row.holderDiscovery.discoveryBlock >= panel.anchor.number ||
        !HASH.test(row.holderDiscovery.discoveryBlockHash || '') ||
        !Number.isSafeInteger(row.holderDiscovery.discoveryTimestamp) ||
        row.holderDiscovery.discoveryTimestamp > panel.anchor.timestamp ||
        typeof row.horizonHolderCodePresent !== 'boolean' ||
        BigInt(row.qAssetsRaw) !== chooseQ(BigInt(row.anchorClaimRaw), BigInt(row.totalAssetsRaw)) ||
        !['success','evm_revert'].includes(row.anchorCall?.status) ||
        !['success','evm_revert','missing_rpc','gas_error'].includes(row.horizonCall?.status) ||
        (row.anchorCall.status === 'success' &&
          (!/^\d+$/.test(row.anchorCall.sharesBurnedRaw || '') ||
            BigInt(row.anchorCall.sharesBurnedRaw) <= 0n)) ||
        (row.horizonCall.status === 'success' &&
          (!/^\d+$/.test(row.horizonCall.sharesBurnedRaw || '') ||
            BigInt(row.horizonCall.sharesBurnedRaw) <= 0n)) ||
        row.horizonClass !== classifyProbe({call: row.horizonCall,
          shares: BigInt(row.horizonSharesRaw), claim: BigInt(row.horizonClaimRaw),
          q: BigInt(row.qAssetsRaw), code: row.horizonHolderCodePresent ? '0x01' : '0x'}))
      throw new Error('historical_panel_measured_row_invalid')
  }
  const expected = aggregateRows(panel.rows)
  if (!['statusCounts','baselineCounts','baselineSuccessRiskSet','holderDependence']
    .every((key) => isDeepStrictEqual(panel[key], expected[key])))
    throw new Error('historical_panel_counts_invalid')
  return true
}

export function savePanelOnce(panel, path) {
  validatePanel(panel)
  const bytes = `${JSON.stringify(panel, null, 2)}\n`
  try {
    const existing = readFileSync(path)
    if (existing.toString() !== bytes) throw new Error('historical_panel_artifact_conflict')
    return {path, replay: true}
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, bytes, {flag: 'wx'})
  try {
    try {
      linkSync(temp, path)
      return {path, replay: false}
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (readFileSync(path).toString() !== bytes)
        throw new Error('historical_panel_artifact_conflict')
      return {path, replay: true}
    }
  } finally {
    unlinkSync(temp)
  }
}

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rpc = process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
  if (!rpc) throw new Error('RECORDER_RPC_URL_required')
  const maxVaults = Number(arg('--max-vaults', '4'))
  const anchorBlock = BigInt(arg('--anchor-block', String(DEFAULT_ANCHOR)))
  run(makeClient(rpc), {anchorBlock, maxVaults}).then((result) => {
    const bytes = `${JSON.stringify(result, null, 2)}\n`
    const digest = sha(Buffer.from(bytes)).slice(0, 16)
    const path = join(ROOT, `lib/carry/carry-morpho-exit-history-${result.anchor.number}-${digest}.json`)
    const saved = savePanelOnce(result, path)
    process.stdout.write(`${JSON.stringify({path, replay: saved.replay,
      anchor: result.anchor, horizon: result.horizon,
      statusCounts: result.statusCounts, baselineCounts: result.baselineCounts,
      baselineSuccessRiskSet: result.baselineSuccessRiskSet,
      holderDependence: result.holderDependence, coverage: result.universe})}\n`)
  }).catch(() => { process.stderr.write('carry_morpho_history_panel_failed\n'); process.exitCode = 1 })
}
