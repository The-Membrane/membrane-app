// Outcome-blind, first-page matched-control baselines. No post-anchor reads.
// Dry: node scripts/research/morpho-v2-full-cohort-controls.mjs
// Bounded: node scripts/research/morpho-v2-full-cohort-controls.mjs --run true --max-candidates 1
// Offline: node scripts/research/morpho-v2-full-cohort-controls.mjs --verify true
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, toHex } from 'viem'
import {
  collectTransfers,
  replayTransfers,
  TransferRpcError,
  TransferLedgerError,
  validateRaw,
  MAX_RAW_BYTES,
} from './morpho-v2-full-cohort-baseline.mjs'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const STUDY = 'morpho-v2-full-cohort-control-baseline-firstpage-v1'
export const MANIFEST_SHA = '6c37829c74cf1897c6a86a409fddc1bdaf1e94b64169695df589f49214f1dbf5'
export const FACTORY_SHA = '745062b27def710352f1b6c5ca220ebc3a953513a384077e190f7eef92ea6aaa'
export const RESERVE_BYTES = 2_500_000_000
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
export const FIRST_PAGE = 32
export const FIRST_TREATED = 32
export const MAX_CANDIDATE_RPC = 4_000
const DAY = 86_400
const GAS = toHex(30_000_000)
const ABI = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function asset() view returns (address)',
  'function liquidityAdapter() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function withdraw(uint256,address,address) returns (uint256)',
])
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)'])
const ZERO = `0x${'0'.repeat(40)}`
const ADDRESS = /^0x[\da-f]{40}$/
const HASH = /^0x[\da-f]{64}$/
const SHA = /^[\da-f]{64}$/
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const unsigned = ({ checkpointSha256, ...rest }) => rest
const seal = (value) => ({
  ...unsigned(value),
  checkpointSha256: sha(JSON.stringify(unsigned(value))),
})
const isRevert = (error) =>
  [3, -32015].includes(error?.code ?? error?.cause?.code) ||
  /execution reverted|vm execution error/i.test(error?.message || '')
class CandidateBudgetError extends Error {}
export function budgetClient(client, limit = MAX_CANDIDATE_RPC - 1) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit >= MAX_CANDIDATE_RPC)
    throw new Error('Invalid per-candidate RPC budget')
  const budget = { used: 0, limit, exhausted: false }
  const wrapped = {
    request: async (args) => {
      if (budget.used >= limit) {
        budget.exhausted = true
        throw new CandidateBudgetError('Candidate RPC budget reached')
      }
      budget.used++
      return client.request(args)
    },
  }
  return { client: wrapped, budget }
}
export const treatedPrefixCommitment = (results) => {
  if (!Array.isArray(results) || results.length < FIRST_TREATED)
    throw new Error('Incomplete treated prefix')
  return sha(JSON.stringify(results.slice(0, FIRST_TREATED)))
}

export function guardDisk(path, proposedBytes = 0, stat = statfsSync) {
  const root = existsSync(dirname(path)) ? dirname(path) : resolve('data/research/venue-signals')
  const disk = stat(root)
  if (Number(disk.bavail) * Number(disk.bsize) - proposedBytes < RESERVE_BYTES)
    throw new Error('Disk reserve reached')
}

function save(path, value, stat = statfsSync) {
  const bytes = JSON.stringify(seal(value))
  if (Buffer.byteLength(bytes) > MAX_OUTPUT_BYTES)
    throw new Error('Control checkpoint output cap reached')
  guardDisk(path, Buffer.byteLength(bytes), stat)
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, bytes, { mode: 0o600 })
  renameSync(temp, path)
  return JSON.parse(bytes)
}

function pinned(path, expectedSha) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== expectedSha) throw new Error('Pinned source SHA mismatch')
  return JSON.parse(bytes)
}

export function loadSources(manifestPath, treatedPath, factoryPath, treatedSha) {
  if (!SHA.test(treatedSha || '')) throw new Error('Require explicit treated physical SHA')
  const manifest = pinned(manifestPath, MANIFEST_SHA)
  const treated = pinned(treatedPath, treatedSha)
  const factory = pinned(factoryPath, FACTORY_SHA)
  if (
    manifest.study !== 'morpho-v2-full-cohort-manifest-v1' ||
    manifest.status !== 'complete' ||
    manifest.summary?.anchors !== 304 ||
    manifest.controlPageSize !== FIRST_PAGE ||
    manifest.rows?.length !== 304 ||
    treated.study !== 'morpho-v2-full-cohort-treated-baseline-v1' ||
    treated.manifestSha256 !== MANIFEST_SHA ||
    treated.results?.length < FIRST_TREATED ||
    !['partial', 'complete'].includes(treated.status) ||
    !SHA.test(treated.checkpointSha256 || '') ||
    sha(JSON.stringify(unsigned(treated))) !== treated.checkpointSha256 ||
    factory.study !== 'morpho-v2-factory-create-v1' ||
    factory.status !== 'complete' ||
    factory.events?.length !== 757
  )
    throw new Error('Pinned control source metadata mismatch')
  const creations = new Map(factory.events.map((event) => [event.vault.toLowerCase(), event]))
  const anchors = []
  for (let i = 0; i < FIRST_TREATED; i++) {
    const row = manifest.rows[i],
      baseline = treated.results[i]
    const candidates = row?.controls?.firstCleanCandidates
    const treatedCreation = creations.get(row?.vault)
    if (
      !ADDRESS.test(row?.vault) ||
      !ADDRESS.test(row?.asset) ||
      !HASH.test(row?.anchorBlockHash) ||
      !HASH.test(baseline?.preBlockHash) ||
      baseline.index !== i ||
      baseline.proposalIndex !== row.proposalIndex ||
      baseline.vault !== row.vault ||
      baseline.anchorBlock !== row.anchorBlock ||
      baseline.preBlock !== row.anchorBlock - 1 ||
      !Array.isArray(candidates) ||
      candidates.length > FIRST_PAGE ||
      candidates.length !== Math.min(FIRST_PAGE, row.controls.counts.clean) ||
      (row.controls.nextCleanOffset !== null && row.controls.nextCleanOffset !== FIRST_PAGE) ||
      !treatedCreation ||
      treatedCreation.block >= row.anchorBlock ||
      !Number.isSafeInteger(treatedCreation.timestamp) ||
      treatedCreation.timestamp >= row.anchorTimestamp
    )
      throw new Error('Manifest/treated anchor mismatch')
    const seen = new Set()
    for (const candidate of candidates) {
      if (
        !ADDRESS.test(candidate.vault) ||
        candidate.vault === row.vault ||
        seen.has(candidate.vault) ||
        !Number.isSafeInteger(candidate.creationBlock) ||
        candidate.creationBlock >= row.anchorBlock ||
        !Number.isSafeInteger(candidate.creationTimestamp) ||
        candidate.creationTimestamp >= row.anchorTimestamp ||
        candidate.ageSeconds !== row.anchorTimestamp - candidate.creationTimestamp
      )
        throw new Error('Manifest control candidate mismatch')
      seen.add(candidate.vault)
    }
    // The manifest's SHA pins the actual age order. This first-page reader never recomputes
    // the risk set or replaces candidates after observing a baseline failure.
    anchors.push({
      index: i,
      row,
      baseline,
      candidates,
      treatedAgeSeconds: row.anchorTimestamp - treatedCreation.timestamp,
    })
  }
  return {
    anchors,
    treatedPrefixSha256: treatedPrefixCommitment(treated.results),
    treatedPhysicalSha256: treatedSha,
  }
}

const validDecimal = (value) => /^\d+$/.test(value || '')
export function distance(candidate, treatedState, treatedAgeSeconds) {
  if (
    !validDecimal(candidate.totalAssets) ||
    !validDecimal(treatedState.totalAssets) ||
    !Number.isSafeInteger(candidate.ageSeconds) ||
    !Number.isSafeInteger(treatedAgeSeconds) ||
    candidate.ageSeconds < 0 ||
    treatedAgeSeconds < 0 ||
    !Number.isFinite(candidate.idleFraction) ||
    !Number.isFinite(treatedState.idleFraction)
  )
    throw new Error('Incomplete pre-B matching state')
  const cAssets = Number(BigInt(candidate.totalAssets)),
    tAssets = Number(BigInt(treatedState.totalAssets))
  if (!Number.isFinite(cAssets) || !Number.isFinite(tAssets))
    throw new Error('Matching assets overflow')
  return (
    Math.abs(Math.log((cAssets + 1) / (tAssets + 1))) +
    Math.abs(Math.log((candidate.ageSeconds + DAY) / (treatedAgeSeconds + DAY))) +
    2 * Math.abs(candidate.idleFraction - treatedState.idleFraction) +
    Number(candidate.adapterPresent !== treatedState.adapterPresent)
  )
}

function fraction(idle, assets) {
  if (assets <= 0n || idle < 0n) throw new Error('Invalid idle fraction state')
  return Math.min(1, Number((idle * 1_000_000n) / assets) / 1_000_000)
}

async function rpc(client, out, method, params, stat) {
  guardDisk(out, 0, stat)
  return client.request({ method, params })
}
async function header(client, out, block, stat) {
  const value = await rpc(client, out, 'eth_getBlockByNumber', [toHex(block), false], stat)
  if (
    !value ||
    Number(BigInt(value.number)) !== block ||
    !HASH.test(value.hash?.toLowerCase() || '')
  )
    throw new Error('Historical block header mismatch')
  return value.hash.toLowerCase()
}
async function contract(
  client,
  out,
  address,
  abi,
  functionName,
  args,
  blockHash,
  stat,
  from = address,
) {
  const data = encodeFunctionData({ abi, functionName, args })
  const output = await rpc(
    client,
    out,
    'eth_call',
    [
      { from, to: address, data, gas: GAS },
      { blockHash, requireCanonical: true },
    ],
    stat,
  )
  return decodeFunctionResult({ abi, functionName, data: output })
}
async function code(client, out, address, blockHash, stat) {
  const value = await rpc(
    client,
    out,
    'eth_getCode',
    [address, { blockHash, requireCanonical: true }],
    stat,
  )
  if (!/^0x(?:[\da-fA-F]{2})*$/.test(value || '')) throw new Error('Malformed historical code')
  return value.toLowerCase()
}

export function chooseControls(screened, treatedState, treatedAgeSeconds) {
  return screened
    .filter((x) => x.status === 'baseline-success')
    .map((x) => ({
      ...x,
      distance: distance(x, treatedState, treatedAgeSeconds),
    }))
    .sort((a, b) => a.distance - b.distance || a.vault.localeCompare(b.vault))
    .slice(0, 2)
}

export function pageDisposition(anchor, screened) {
  if (screened.length < anchor.candidates.length) return 'first-page-in-progress'
  if (
    anchor.row.controls.nextCleanOffset !== null &&
    screened.filter((x) => x.status === 'baseline-success').length < 2
  )
    return 'continuation-required'
  if (screened.filter((x) => x.status === 'baseline-success').length < 2)
    return screened.some((x) => /ambiguous|censored|ledger-.*mismatch/.test(x.status))
      ? 'first-page-exhausted-unresolved'
      : 'first-page-exhausted-under-matched'
  return 'first-page-matched'
}

export async function screenCandidate({
  client,
  anchor,
  candidate,
  rawDir,
  out,
  stat = statfsSync,
  collectPrefix = collectTransfers,
  rpcLimit = MAX_CANDIDATE_RPC - 1,
}) {
  const budgeted = budgetClient(client, rpcLimit)
  client = budgeted.client
  const budget = budgeted.budget
  const { row, baseline } = anchor,
    preBlock = row.anchorBlock - 1,
    blockHash = baseline.preBlockHash
  const base = {
    vault: candidate.vault,
    creationBlock: candidate.creationBlock,
    creationTimestamp: candidate.creationTimestamp,
    ageSeconds: candidate.ageSeconds,
    preBlock,
    preBlockHash: blockHash,
    rpcBudget: rpcLimit,
    holderAttempts: [],
  }
  try {
    if ((await header(client, out, preBlock, stat)) !== blockHash)
      throw new Error('Pre-B header hash changed')
    const vaultCode = await code(client, out, candidate.vault, blockHash, stat)
    if (vaultCode === '0x') return { ...base, status: 'missing-vault-code' }
    base.runtimeCodeHash = keccak256(vaultCode)
    let supply, assets, asset, adapter, idle
    try {
      supply = await contract(client, out, candidate.vault, ABI, 'totalSupply', [], blockHash, stat)
      assets = await contract(client, out, candidate.vault, ABI, 'totalAssets', [], blockHash, stat)
      asset = await contract(client, out, candidate.vault, ABI, 'asset', [], blockHash, stat)
      adapter = await contract(
        client,
        out,
        candidate.vault,
        ABI,
        'liquidityAdapter',
        [],
        blockHash,
        stat,
      )
      idle = await contract(
        client,
        out,
        row.asset,
        ERC20,
        'balanceOf',
        [candidate.vault],
        blockHash,
        stat,
      )
    } catch (error) {
      if (error instanceof CandidateBudgetError) throw error
      if (/Disk reserve/.test(error.message)) throw error
      return { ...base, status: 'state-rpc-ambiguous' }
    }
    Object.assign(base, {
      totalSupply: supply.toString(),
      totalAssets: assets.toString(),
      asset: asset.toLowerCase(),
      adapter: adapter.toLowerCase(),
      adapterPresent: adapter.toLowerCase() !== ZERO,
      idleAssets: idle.toString(),
    })
    if (asset.toLowerCase() !== row.asset) return { ...base, status: 'asset-mismatch-at-pre-b' }
    if (supply <= 0n || assets <= 0n) return { ...base, status: 'unfunded' }
    base.idleFraction = fraction(idle, assets)
    const holderAnchor = {
      vault: candidate.vault,
      creationBlock: candidate.creationBlock,
      preBlock,
    }
    // The separate raw directory is never shared with treated holder prefixes.
    let collected
    try {
      collected = await collectPrefix({
        client,
        anchor: holderAnchor,
        rawDir,
        preBlockHash: blockHash,
      })
    } catch (error) {
      if (budget.exhausted) return { ...base, status: 'rpc-budget-censored' }
      if (error instanceof TransferRpcError) return { ...base, status: 'transfer-rpc-censored' }
      if (error instanceof TransferLedgerError)
        return { ...base, status: 'transfer-ledger-censored' }
      throw error // seal/SHA/metadata/reorg/disk failures are fatal, never ordinary missingness.
    }
    Object.assign(base, {
      rawPath: collected.rawPath,
      rawSha256: collected.physicalSha256,
      rawLogCount: collected.raw.logs.length,
    })
    const holders = replayTransfers(collected.raw.logs)
    const summed = holders.reduce((n, [, shares]) => n + shares, 0n)
    base.replayedSupply = summed.toString()
    if (summed !== supply) return { ...base, status: 'holder-ledger-supply-mismatch' }
    const q = BigInt(baseline.qAssets)
    let unresolved = false
    for (const [holder, shares] of holders) {
      const attempt = { holder, shares: shares.toString() }
      let holderCode
      try {
        holderCode = await code(client, out, holder, blockHash, stat)
      } catch (error) {
        if (error instanceof CandidateBudgetError) {
          attempt.status = 'rpc-budget-censored'
          base.holderAttempts.push(attempt)
          return { ...base, status: 'rpc-budget-censored' }
        }
        if (/Disk reserve/.test(error.message)) throw error
        attempt.status = 'holder-code-rpc-ambiguous'
        base.holderAttempts.push(attempt)
        unresolved = true
        continue
      }
      attempt.codeHash = holderCode === '0x' ? null : keccak256(holderCode)
      if (holderCode !== '0x') {
        attempt.status = 'contract-holder'
        base.holderAttempts.push(attempt)
        continue
      }
      let balance, claim
      try {
        balance = await contract(
          client,
          out,
          candidate.vault,
          ABI,
          'balanceOf',
          [holder],
          blockHash,
          stat,
        )
        claim = await contract(
          client,
          out,
          candidate.vault,
          ABI,
          'previewRedeem',
          [shares],
          blockHash,
          stat,
        )
      } catch (error) {
        if (error instanceof CandidateBudgetError) {
          attempt.status = 'rpc-budget-censored'
          base.holderAttempts.push(attempt)
          return { ...base, status: 'rpc-budget-censored' }
        }
        if (/Disk reserve/.test(error.message)) throw error
        attempt.status = 'holder-state-rpc-ambiguous'
        base.holderAttempts.push(attempt)
        unresolved = true
        continue
      }
      attempt.balanceOf = balance.toString()
      attempt.previewRedeemable = claim.toString()
      if (balance !== shares) {
        attempt.status = 'holder-ledger-balance-mismatch'
        base.holderAttempts.push(attempt)
        return { ...base, status: 'holder-ledger-balance-mismatch' }
      }
      if (claim < q) {
        attempt.status = 'insufficient-claim'
        base.holderAttempts.push(attempt)
        continue
      }
      try {
        const output = await contract(
          client,
          out,
          candidate.vault,
          ABI,
          'withdraw',
          [q, holder, holder],
          blockHash,
          stat,
          holder,
        )
        attempt.status = 'success'
        attempt.withdrawShares = output.toString()
        base.holderAttempts.push(attempt)
        if ((await header(client, out, preBlock, stat)) !== blockHash)
          throw new Error('Pre-B header changed after call')
        return {
          ...base,
          status: 'baseline-success',
          holder,
          holderShares: shares.toString(),
          holderClaimAssets: claim.toString(),
          withdrawShares: output.toString(),
        }
      } catch (error) {
        if (error instanceof CandidateBudgetError) {
          attempt.status = 'rpc-budget-censored'
          base.holderAttempts.push(attempt)
          return { ...base, status: 'rpc-budget-censored' }
        }
        if (/Disk reserve|Pre-B header changed/.test(error.message)) throw error
        attempt.status = isRevert(error) ? 'withdraw-revert' : 'withdraw-transport-ambiguous'
        base.holderAttempts.push(attempt)
        if (attempt.status === 'withdraw-transport-ambiguous') unresolved = true
      }
    }
    if ((await header(client, out, preBlock, stat)) !== blockHash)
      throw new Error('Pre-B header changed after screen')
    return {
      ...base,
      status: unresolved ? 'holder-or-withdraw-rpc-ambiguous' : 'no-successful-eoa-holder',
    }
  } catch (error) {
    if (error instanceof CandidateBudgetError) return { ...base, status: 'rpc-budget-censored' }
    throw error
  }
}

async function treatedState({ client, anchor, out, stat }) {
  const { row, baseline } = anchor,
    blockHash = baseline.preBlockHash
  if ((await header(client, out, row.anchorBlock - 1, stat)) !== blockHash)
    throw new Error('Treated pre-B hash mismatch')
  const [assets, adapter, idle] = await Promise.all([
    contract(client, out, row.vault, ABI, 'totalAssets', [], blockHash, stat),
    contract(client, out, row.vault, ABI, 'liquidityAdapter', [], blockHash, stat),
    contract(client, out, row.asset, ERC20, 'balanceOf', [row.vault], blockHash, stat),
  ])
  if (assets.toString() !== baseline.totalAssets)
    throw new Error('Treated totalAssets changed at pinned B-1')
  const state = {
    totalAssets: assets.toString(),
    adapterPresent: adapter.toLowerCase() !== ZERO,
    idleAssets: idle.toString(),
    idleFraction: fraction(idle, assets),
  }
  if ((await header(client, out, row.anchorBlock - 1, stat)) !== blockHash)
    throw new Error('Treated pre-B hash changed')
  return state
}

export function verifyCheckpoint(saved, anchors, treatedPrefixSha256) {
  if (
    !saved ||
    !SHA.test(saved.checkpointSha256 || '') ||
    sha(JSON.stringify(unsigned(saved))) !== saved.checkpointSha256 ||
    saved.study !== STUDY ||
    saved.status !== 'partial' ||
    saved.manifestSha256 !== MANIFEST_SHA ||
    saved.factorySha256 !== FACTORY_SHA ||
    saved.treatedPrefixSha256 !== treatedPrefixSha256 ||
    !Array.isArray(saved.treatedSourceShaHistory) ||
    !saved.treatedSourceShaHistory.length ||
    saved.treatedSourceShaHistory.some((x) => !SHA.test(x)) ||
    saved.denominator !== 304 ||
    saved.firstPageAnchors !== FIRST_TREATED ||
    !Array.isArray(saved.rows) ||
    saved.rows.length > FIRST_TREATED
  )
    throw new Error('Control checkpoint seal/metadata mismatch')
  for (let i = 0; i < saved.rows.length; i++) {
    const row = saved.rows[i],
      anchor = anchors[i]
    if (
      row.index !== i ||
      row.proposalIndex !== anchor.row.proposalIndex ||
      row.vault !== anchor.row.vault ||
      row.anchorBlock !== anchor.row.anchorBlock ||
      row.preBlockHash !== anchor.baseline.preBlockHash ||
      !Array.isArray(row.screened) ||
      row.screened.length > anchor.candidates.length ||
      row.screened.some(
        (x, j) =>
          x.vault !== anchor.candidates[j].vault ||
          x.preBlockHash !== anchor.baseline.preBlockHash ||
          !Array.isArray(x.holderAttempts),
      ) ||
      row.disposition !==
        (row.treatedStatus !== 'baseline-success'
          ? 'treated-baseline-unavailable'
          : anchor.candidates.length === 0
            ? 'no-clean-control-candidates'
            : pageDisposition(anchor, row.screened))
    )
      throw new Error('Control checkpoint frontier mismatch')
    if (
      row.treatedAgeSeconds !==
        (row.treatedStatus === 'baseline-success' && anchor.candidates.length
          ? anchor.treatedAgeSeconds
          : null) ||
      row.treatedStatus !== anchor.baseline.status ||
      row.qAssets !== (anchor.baseline.qAssets ?? null) ||
      Boolean(row.treatedState) !==
        Boolean(row.treatedStatus === 'baseline-success' && anchor.candidates.length) ||
      (row.treatedState &&
        (!validDecimal(row.treatedState.totalAssets) ||
          !Number.isFinite(row.treatedState.idleFraction)))
    )
      throw new Error('Control treated-state mismatch')
    if (
      JSON.stringify(row.selected) !==
      JSON.stringify(
        row.treatedState && row.screened.length
          ? chooseControls(row.screened, row.treatedState, row.treatedAgeSeconds)
          : null,
      )
    )
      throw new Error('Control selected ranking mismatch')
    for (const item of row.screened)
      if (item.rawPath) {
        const bytes = readFileSync(item.rawPath)
        if (sha(bytes) !== item.rawSha256 || bytes.length > MAX_RAW_BYTES)
          throw new Error('Control raw prefix physical SHA mismatch')
        validateRaw(
          JSON.parse(bytes),
          {
            vault: item.vault,
            creationBlock: item.creationBlock,
            preBlock: item.preBlock,
          },
          item.preBlockHash,
        )
      }
  }
  return saved
}

export async function run({
  client,
  manifestPath,
  treatedPath,
  out,
  rawDir,
  factoryPath,
  treatedSha,
  maxCandidates = 1,
  maxAnchors = FIRST_TREATED,
  stat = statfsSync,
}) {
  if (
    !Number.isSafeInteger(maxCandidates) ||
    maxCandidates < 1 ||
    !Number.isSafeInteger(maxAnchors) ||
    maxAnchors < 1 ||
    maxAnchors > FIRST_TREATED
  )
    throw new Error('Invalid bounded control batch')
  const { anchors, treatedPrefixSha256 } = loadSources(
    manifestPath,
    treatedPath,
    factoryPath,
    treatedSha,
  )
  let saved = existsSync(out)
    ? verifyCheckpoint(JSON.parse(readFileSync(out, 'utf8')), anchors, treatedPrefixSha256)
    : seal({
        study: STUDY,
        status: 'partial',
        manifestSha256: MANIFEST_SHA,
        factorySha256: FACTORY_SHA,
        treatedPrefixSha256,
        treatedSourceShaHistory: [treatedSha],
        denominator: 304,
        firstPageAnchors: FIRST_TREATED,
        rows: [],
      })
  if (!saved.treatedSourceShaHistory.includes(treatedSha)) {
    pinned(treatedPath, treatedSha)
    saved = save(
      out,
      { ...saved, treatedSourceShaHistory: [...saved.treatedSourceShaHistory, treatedSha] },
      stat,
    )
  }
  guardDisk(out, 0, stat)
  if (Number(BigInt(await rpc(client, out, 'eth_chainId', [], stat))) !== 1)
    throw new Error('Wrong chain ID')
  let remaining = maxCandidates
  for (let i = 0; i < maxAnchors && remaining > 0; i++) {
    const anchor = anchors[i]
    let row = saved.rows[i]
    if (!row) {
      const { row: source, baseline } = anchor
      row = {
        index: i,
        proposalIndex: source.proposalIndex,
        vault: source.vault,
        anchorBlock: source.anchorBlock,
        preBlockHash: baseline.preBlockHash,
        treatedStatus: baseline.status,
        qAssets: baseline.qAssets ?? null,
        treatedAgeSeconds: null,
        treatedState: null,
        screened: [],
        selected: null,
        disposition: 'first-page-in-progress',
      }
      if (
        baseline.status !== 'baseline-success' ||
        !validDecimal(baseline.qAssets) ||
        BigInt(baseline.qAssets) <= 0n
      )
        row.disposition = 'treated-baseline-unavailable'
      else if (!anchor.candidates.length) row.disposition = 'no-clean-control-candidates'
      else {
        row.treatedAgeSeconds = anchor.treatedAgeSeconds
        row.treatedState = await treatedState({ client, anchor, out, stat })
      }
      pinned(treatedPath, treatedSha)
      saved = save(out, { ...saved, rows: [...saved.rows, row] }, stat)
    }
    if (
      row.disposition === 'treated-baseline-unavailable' ||
      row.disposition === 'no-clean-control-candidates' ||
      row.screened.length === anchor.candidates.length
    )
      continue
    for (let j = row.screened.length; j < anchor.candidates.length && remaining > 0; j++) {
      const screened = await screenCandidate({
        client,
        anchor,
        candidate: anchor.candidates[j],
        rawDir,
        out,
        stat,
      })
      // Range queries in collectTransfers lack EIP-1898; never commit a row if B-1 changed.
      if (
        (await header(client, out, sourcePreBlock(anchor), stat)) !== anchor.baseline.preBlockHash
      )
        throw new Error('Control B-1 hash changed before checkpoint')
      row = { ...row, screened: [...row.screened, screened] }
      row.disposition = pageDisposition(anchor, row.screened)
      row.selected = chooseControls(row.screened, row.treatedState, row.treatedAgeSeconds)
      pinned(treatedPath, treatedSha)
      saved = save(out, { ...saved, rows: [...saved.rows.slice(0, i), row] }, stat)
      remaining--
    }
  }
  return saved
}

const sourcePreBlock = (anchor) => anchor.row.anchorBlock - 1

function options(args) {
  const opts = {}
  for (let i = 0; i < args.length; i += 2) {
    if (
      !args[i]?.startsWith('--') ||
      args[i + 1] === undefined ||
      opts[args[i].slice(2)] !== undefined
    )
      throw new Error('Expected unique --key value options')
    opts[args[i].slice(2)] = args[i + 1]
  }
  if (
    Object.keys(opts).some(
      (x) =>
        ![
          'manifest',
          'treated',
          'treated-sha',
          'factory',
          'out',
          'raw-dir',
          'max-candidates',
          'max-anchors',
          'run',
          'verify',
        ].includes(x),
    ) ||
    (opts.run && opts.run !== 'true') ||
    (opts.verify && opts.verify !== 'true') ||
    (opts.run && opts.verify)
  )
    throw new Error('Invalid control CLI options')
  return opts
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = options(process.argv.slice(2))
    const base = 'data/research/venue-signals/'
    const manifestPath = resolve(opts.manifest || `${base}morpho-v2-full-cohort-manifest.json`)
    const treatedPath = resolve(opts.treated || `${base}morpho-v2-full-cohort-baseline.json`)
    const factoryPath = resolve(opts.factory || `${base}${FACTORY_SHA}.json`)
    const treatedSha = opts['treated-sha']
    const out = resolve(opts.out || `${base}morpho-v2-full-cohort-controls.json`)
    const rawDir = resolve(opts['raw-dir'] || `${base}morpho-v2-full-cohort-controls-raw`)
    const maxCandidates = opts['max-candidates'] === undefined ? 1 : Number(opts['max-candidates'])
    const maxAnchors =
      opts['max-anchors'] === undefined ? FIRST_TREATED : Number(opts['max-anchors'])
    if (!opts.run && !opts.verify) {
      const { anchors, treatedPrefixSha256 } = loadSources(
        manifestPath,
        treatedPath,
        factoryPath,
        treatedSha,
      )
      process.stdout.write(
        JSON.stringify({
          mode: 'dry',
          denominator: 304,
          firstPageAnchors: anchors.length,
          eligibleTreated: anchors.filter((x) => x.baseline.status === 'baseline-success').length,
          treatedPrefixSha256,
          runRequired: true,
        }) + '\n',
      )
    } else if (opts.verify) {
      const { anchors, treatedPrefixSha256 } = loadSources(
        manifestPath,
        treatedPath,
        factoryPath,
        treatedSha,
      )
      const saved = verifyCheckpoint(
        JSON.parse(readFileSync(out, 'utf8')),
        anchors,
        treatedPrefixSha256,
      )
      process.stdout.write(
        JSON.stringify({
          mode: 'verify',
          rows: saved.rows.length,
          screened: saved.rows.reduce((n, x) => n + x.screened.length, 0),
          status: saved.status,
          sha256: sha(readFileSync(out)),
        }) + '\n',
      )
    } else {
      const url = process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
      if (!url) throw new Error('Missing RPC')
      const saved = await run({
        client: makeClient(url),
        manifestPath,
        treatedPath,
        factoryPath,
        treatedSha,
        out,
        rawDir,
        maxCandidates,
        maxAnchors,
      })
      process.stdout.write(
        JSON.stringify({
          mode: 'run',
          rows: saved.rows.length,
          screened: saved.rows.reduce((n, x) => n + x.screened.length, 0),
          status: saved.status,
          sha256: sha(readFileSync(out)),
        }) + '\n',
      )
    }
  } catch {
    // RPC errors can contain credential-bearing URLs; never print provider messages.
    process.stderr.write('Control baseline stopped; source, RPC, or resource check failed.\n')
    process.exitCode = 1
  }
}
