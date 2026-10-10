// Outcome-blind account-context treated baseline; never rewrites the v1 checkpoint.
// Dry: node scripts/research/morpho-v2-signer-baseline.mjs
// Live (after review): node scripts/research/morpho-v2-signer-baseline.mjs --run true --max-rows 8
// Offline: node scripts/research/morpho-v2-signer-baseline.mjs --verify true
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, toHex } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import {
  FACTORY_SHA,
  MANIFEST_SHA,
  selectAnchors,
  verifyCheckpoint as verifyV1,
  validateRaw,
  replayTransfers,
  baselineSize,
  MAX_RAW_BYTES,
} from './morpho-v2-full-cohort-baseline.mjs'

export const STUDY = 'morpho-v2-full-cohort-signer-baseline-v2'
export const V1_SHA = '76f5c5654240c383c3553c098002cd7eb4a1166322da8be728bbf7952c54928c'
export const FIRST_ROWS = 64
export const RESERVE_BYTES = 2_500_000_000
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
export const MAX_RPC_PER_ROW = 4_096
const GAS = toHex(30_000_000)
const ABI = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function withdraw(uint256,address,address) returns (uint256)',
])
const ZERO = `0x${'0'.repeat(40)}`
const DEAD = `0x${'0'.repeat(36)}dead`
const HASH = /^0x[\da-f]{64}$/
const ADDRESS = /^0x[\da-f]{40}$/
const SHA = /^[\da-f]{64}$/
const UNSIGNED_DECIMAL = /^(0|[1-9]\d*)$/
const HEX = /^0x(?:[\da-fA-F]{2})*$/
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const unsigned = ({ checkpointSha256, ...rest }) => rest
const seal = (value) => ({
  ...unsigned(value),
  checkpointSha256: sha(JSON.stringify(unsigned(value))),
})
class RpcBudgetError extends Error {}

export function sentinelReason(address) {
  const normalized = address?.toLowerCase()
  if (!ADDRESS.test(normalized || '')) throw new Error('Invalid holder address')
  if (normalized === ZERO) return 'zero-address'
  if (normalized === DEAD) return 'dead-address'
  if (BigInt(normalized) <= 0xffn) return 'low-reserved-address'
  return null
}

export function holderPlan(logs) {
  const ordered = replayTransfers(logs)
  const excluded = [],
    candidates = []
  for (const [address, shares] of ordered) {
    const reason = sentinelReason(address)
    if (reason) excluded.push({ holder: address, shares: shares.toString(), reason })
    else candidates.push({ holder: address, shares: shares.toString() })
  }
  return {
    excluded,
    candidates,
    replayedSupply: ordered.reduce((sum, [, shares]) => sum + shares, 0n).toString(),
  }
}

export function signerStratum(nonce) {
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('Invalid pinned account nonce')
  return nonce > 0 ? 'code-empty-positive-account-nonce' : 'code-empty-zero-account-nonce'
}

function pinned(path, expected) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== expected) throw new Error('Pinned source physical SHA mismatch')
  return JSON.parse(bytes)
}

export function loadInputs({ manifestPath, factoryPath, v1Path }) {
  const manifest = pinned(manifestPath, MANIFEST_SHA)
  const factory = pinned(factoryPath, FACTORY_SHA)
  const v1 = pinned(v1Path, V1_SHA)
  const anchors = selectAnchors(manifest, factory)
  verifyV1(v1, anchors)
  if (v1.results.length !== FIRST_ROWS || v1.status !== 'partial')
    throw new Error('Frozen first-64 v1 baseline mismatch')
  const prefixes = []
  for (let i = 0; i < FIRST_ROWS; i++) {
    const anchor = anchors[i],
      old = v1.results[i]
    if (
      !old.rawPath ||
      !SHA.test(old.rawSha256 || '') ||
      old.preBlockHash?.toLowerCase() !== old.preBlockHash
    )
      throw new Error('Missing frozen v1 raw prefix')
    const bytes = readFileSync(old.rawPath)
    if (bytes.length > MAX_RAW_BYTES || sha(bytes) !== old.rawSha256)
      throw new Error('Frozen v1 raw prefix physical SHA mismatch')
    const raw = validateRaw(JSON.parse(bytes), anchor, old.preBlockHash)
    prefixes.push({ anchor, old, raw, rawSha256: old.rawSha256 })
  }
  return prefixes
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
    throw new Error('Signer baseline output cap reached')
  guardDisk(path, Buffer.byteLength(bytes), stat)
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, bytes, { mode: 0o600 })
  renameSync(temp, path)
  return JSON.parse(bytes)
}

async function rpc(client, out, budget, method, params, stat) {
  guardDisk(out, 0, stat)
  if (budget.used >= MAX_RPC_PER_ROW) throw new RpcBudgetError('Per-row RPC cap reached')
  budget.used++
  return client.request({ method, params })
}
async function header(client, out, budget, block, stat) {
  const value = await rpc(client, out, budget, 'eth_getBlockByNumber', [toHex(block), false], stat)
  if (
    !value ||
    Number(BigInt(value.number)) !== block ||
    !HASH.test(value.hash?.toLowerCase() || '')
  )
    throw new Error('Historical header mismatch')
  return value.hash.toLowerCase()
}
async function getCode(client, out, budget, address, hash, stat) {
  const value = await rpc(
    client,
    out,
    budget,
    'eth_getCode',
    [address, { blockHash: hash, requireCanonical: true }],
    stat,
  )
  if (!HEX.test(value || '')) throw new Error('Malformed pinned code')
  return value.toLowerCase()
}
async function call(client, out, budget, vault, functionName, args, hash, stat, from = vault) {
  const data = encodeFunctionData({ abi: ABI, functionName, args })
  const value = await rpc(
    client,
    out,
    budget,
    'eth_call',
    [
      { from, to: vault, data, gas: GAS },
      { blockHash: hash, requireCanonical: true },
    ],
    stat,
  )
  return decodeFunctionResult({ abi: ABI, functionName, data: value })
}
const isRevert = (error) =>
  [3, -32015].includes(error?.code ?? error?.cause?.code) ||
  /execution reverted|vm execution error/i.test(error?.message || '')

export async function probe({ client, prefix, out, stat = statfsSync }) {
  const { anchor, old, raw, rawSha256 } = prefix
  const budget = { used: 0 },
    hash = old.preBlockHash
  const plan = holderPlan(raw.logs)
  const result = {
    index: anchor.index,
    proposalIndex: anchor.proposalIndex,
    vault: anchor.vault,
    anchorBlock: anchor.anchorBlock,
    preBlock: anchor.preBlock,
    preBlockHash: hash,
    v1Status: old.status,
    v1RawSha256: rawSha256,
    excludedSentinels: plan.excluded,
    replayedSupply: plan.replayedSupply,
    examinedHolders: [],
    accountNonceContext: null,
    status: 'unresolved',
  }
  try {
    if (
      (await header(client, out, budget, anchor.preBlock, stat)) !== hash ||
      (await header(client, out, budget, anchor.anchorBlock, stat)) !== anchor.anchorBlockHash
    )
      throw new Error('Frozen B-1 or B header hash mismatch')
    const vaultCode = await getCode(client, out, budget, anchor.vault, hash, stat)
    if (vaultCode === '0x')
      return { ...result, status: 'missing-vault-code', rpcCalls: budget.used }
    result.runtimeCodeHash = keccak256(vaultCode)
    if (old.runtimeCodeHash && result.runtimeCodeHash !== old.runtimeCodeHash)
      throw new Error('Historical vault code differs from v1 pinned baseline')
    const supply = await call(client, out, budget, anchor.vault, 'totalSupply', [], hash, stat)
    result.totalSupply = supply.toString()
    if (supply.toString() !== plan.replayedSupply)
      return { ...result, status: 'holder-ledger-supply-mismatch', rpcCalls: budget.used }
    for (const candidate of plan.candidates) {
      const attempt = { holder: candidate.holder, shares: candidate.shares }
      let holderCode
      try {
        holderCode = await getCode(client, out, budget, candidate.holder, hash, stat)
      } catch (error) {
        if (error instanceof RpcBudgetError || /Disk reserve/.test(error.message)) throw error
        attempt.status = 'holder-code-rpc-ambiguous'
        result.examinedHolders.push(attempt)
        return { ...result, status: 'holder-code-rpc-ambiguous', rpcCalls: budget.used }
      }
      attempt.codeHash = holderCode === '0x' ? null : keccak256(holderCode)
      if (holderCode !== '0x') {
        attempt.status = 'contract-code-holder'
        result.examinedHolders.push(attempt)
        continue
      }
      result.holder = candidate.holder
      result.holderShares = candidate.shares
      attempt.status = 'selected-code-empty'
      result.examinedHolders.push(attempt)
      break // Largest remaining code-empty holder, regardless of later q or call result.
    }
    if (!result.holder)
      return { ...result, status: 'no-non-sentinel-code-empty-holder', rpcCalls: budget.used }
    const nonceRaw = await rpc(
      client,
      out,
      budget,
      'eth_getTransactionCount',
      [result.holder, { blockHash: hash, requireCanonical: true }],
      stat,
    )
    const nonce = Number(BigInt(nonceRaw))
    result.accountNonceContext = { nonce, stratum: signerStratum(nonce) }
    const shares = BigInt(result.holderShares)
    const balance = await call(
      client,
      out,
      budget,
      anchor.vault,
      'balanceOf',
      [result.holder],
      hash,
      stat,
    )
    result.balanceOf = balance.toString()
    if (balance !== shares)
      return { ...result, status: 'holder-ledger-balance-mismatch', rpcCalls: budget.used }
    const [assets, redeemable] = [
      await call(client, out, budget, anchor.vault, 'totalAssets', [], hash, stat),
      await call(client, out, budget, anchor.vault, 'previewRedeem', [shares], hash, stat),
    ]
    result.totalAssets = assets.toString()
    result.previewRedeemable = redeemable.toString()
    if (old.totalAssets && result.totalAssets !== old.totalAssets)
      throw new Error('Historical totalAssets differs from v1 pinned baseline')
    const q = baselineSize(assets, redeemable)
    result.qAssets = q.toString()
    if (q === 0n) return { ...result, status: 'zero-baseline-size', rpcCalls: budget.used }
    try {
      result.withdrawShares = (
        await call(
          client,
          out,
          budget,
          anchor.vault,
          'withdraw',
          [q, result.holder, result.holder],
          hash,
          stat,
          result.holder,
        )
      ).toString()
    } catch (error) {
      if (error instanceof RpcBudgetError || /Disk reserve/.test(error.message)) throw error
      return {
        ...result,
        status: isRevert(error) ? 'baseline-revert' : 'withdraw-rpc-ambiguous',
        rpcCalls: budget.used,
      }
    }
    if ((await header(client, out, budget, anchor.preBlock, stat)) !== hash)
      throw new Error('Pinned B-1 hash changed after baseline')
    return { ...result, status: 'baseline-success', rpcCalls: budget.used }
  } catch (error) {
    if (error instanceof RpcBudgetError)
      return { ...result, status: 'rpc-budget-censored', rpcCalls: budget.used }
    if (/Disk reserve|differs from v1|header hash mismatch|hash changed/.test(error.message))
      throw error
    return { ...result, status: 'historical-state-rpc-ambiguous', rpcCalls: budget.used }
  }
}

export function verifyCheckpoint(saved, prefixes) {
  if (
    !saved ||
    !SHA.test(saved.checkpointSha256 || '') ||
    sha(JSON.stringify(unsigned(saved))) !== saved.checkpointSha256 ||
    saved.study !== STUDY ||
    saved.manifestSha256 !== MANIFEST_SHA ||
    saved.factorySha256 !== FACTORY_SHA ||
    saved.v1PhysicalSha256 !== V1_SHA ||
    saved.status !==
      (saved.rows?.length === FIRST_ROWS ? 'complete-first64-preoutcome' : 'partial') ||
    !Array.isArray(saved.rows) ||
    saved.rows.length > FIRST_ROWS
  )
    throw new Error('Signer baseline checkpoint integrity mismatch')
  for (let i = 0; i < saved.rows.length; i++) {
    const row = saved.rows[i],
      prefix = prefixes[i]
    if (
      row.index !== i ||
      row.proposalIndex !== prefix.anchor.proposalIndex ||
      row.vault !== prefix.anchor.vault ||
      row.anchorBlock !== prefix.anchor.anchorBlock ||
      row.preBlock !== prefix.anchor.preBlock ||
      row.preBlockHash !== prefix.old.preBlockHash ||
      row.v1RawSha256 !== prefix.rawSha256 ||
      !Array.isArray(row.excludedSentinels) ||
      !Array.isArray(row.examinedHolders) ||
      !/^[a-z0-9-]+$/.test(row.status) ||
      (row.holder && sentinelReason(row.holder) !== null) ||
      !Number.isSafeInteger(row.rpcCalls) ||
      row.rpcCalls < 0 ||
      row.rpcCalls > MAX_RPC_PER_ROW
    )
      throw new Error('Signer baseline result frontier mismatch')
    const plan = holderPlan(prefix.raw.logs)
    if (row.replayedSupply !== plan.replayedSupply)
      throw new Error('Signer replayed supply differs from pinned ledger')
    if (
      row.totalAssets !== undefined &&
      prefix.old.totalAssets !== undefined &&
      row.totalAssets !== prefix.old.totalAssets
    )
      throw new Error('Signer assets differ from pinned v1 state')
    if (JSON.stringify(row.excludedSentinels) !== JSON.stringify(plan.excluded))
      throw new Error('Signer sentinel exclusions changed')
    if (row.signerEvidence !== undefined) throw new Error('Legacy signer claim in checkpoint')
    if (row.accountNonceContext !== null && row.accountNonceContext !== undefined) {
      if (
        !Number.isSafeInteger(row.accountNonceContext.nonce) ||
        row.accountNonceContext.nonce < 0 ||
        row.accountNonceContext.stratum !== signerStratum(row.accountNonceContext.nonce)
      )
        throw new Error('Account nonce context mismatch')
    }
    if (row.examinedHolders.length > plan.candidates.length)
      throw new Error('Examined holder frontier exceeds ledger')
    for (let j = 0; j < row.examinedHolders.length; j++) {
      const attempt = row.examinedHolders[j]
      if (
        attempt.holder !== plan.candidates[j].holder ||
        attempt.shares !== plan.candidates[j].shares ||
        (j < row.examinedHolders.length - 1 && attempt.status !== 'contract-code-holder')
      )
        throw new Error('Examined holder order differs from ledger')
    }
    if (row.holder) {
      const selected = row.examinedHolders.at(-1)
      if (
        selected?.status !== 'selected-code-empty' ||
        selected.holder !== row.holder ||
        selected.shares !== row.holderShares ||
        row.holderShares !== plan.candidates.find((x) => x.holder === row.holder)?.shares
      )
        throw new Error('Selected holder differs from ledger frontier')
    } else if (row.examinedHolders.some((x) => x.status === 'selected-code-empty')) {
      throw new Error('Selected holder missing from checkpoint')
    }
    if (row.qAssets !== undefined) {
      if (
        !UNSIGNED_DECIMAL.test(row.totalAssets || '') ||
        !UNSIGNED_DECIMAL.test(row.previewRedeemable || '') ||
        !UNSIGNED_DECIMAL.test(row.qAssets)
      )
        throw new Error('Baseline size inputs missing')
      if (
        row.qAssets !==
        baselineSize(BigInt(row.totalAssets), BigInt(row.previewRedeemable)).toString()
      )
        throw new Error('Baseline size differs from pinned inputs')
    }
    if (['baseline-success', 'baseline-revert', 'withdraw-rpc-ambiguous'].includes(row.status)) {
      if (!row.holder || !row.accountNonceContext || !row.qAssets || BigInt(row.qAssets) <= 0n)
        throw new Error('Withdraw status lacks positive baseline context')
      if (
        row.status === 'baseline-success'
          ? !UNSIGNED_DECIMAL.test(row.withdrawShares || '')
          : row.withdrawShares !== undefined
      )
        throw new Error('Withdraw status/result mismatch')
    }
    if (row.status === 'zero-baseline-size' && row.qAssets !== '0')
      throw new Error('Zero baseline status/result mismatch')
  }
  return saved
}

export async function run({
  client,
  manifestPath,
  factoryPath,
  v1Path,
  out,
  maxRows = 8,
  stat = statfsSync,
}) {
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > FIRST_ROWS)
    throw new Error('max-rows must be 1..64')
  const prefixes = loadInputs({ manifestPath, factoryPath, v1Path })
  let saved = existsSync(out)
    ? verifyCheckpoint(JSON.parse(readFileSync(out, 'utf8')), prefixes)
    : seal({
        study: STUDY,
        status: 'partial',
        manifestSha256: MANIFEST_SHA,
        factorySha256: FACTORY_SHA,
        v1PhysicalSha256: V1_SHA,
        rows: [],
      })
  if (saved.rows.length >= maxRows) return saved
  const chainBudget = { used: 0 }
  if (Number(BigInt(await rpc(client, out, chainBudget, 'eth_chainId', [], stat))) !== 1)
    throw new Error('Wrong chain ID')
  for (let i = saved.rows.length; i < maxRows; i++) {
    const row = await probe({ client, prefix: prefixes[i], out, stat })
    if (
      (await header(client, out, { used: 0 }, prefixes[i].anchor.preBlock, stat)) !==
        row.preBlockHash ||
      (await header(client, out, { used: 0 }, prefixes[i].anchor.anchorBlock, stat)) !==
        prefixes[i].anchor.anchorBlockHash
    )
      throw new Error('Frozen header changed before checkpoint')
    saved = save(
      out,
      {
        ...saved,
        rows: [...saved.rows, row],
        status: i + 1 === FIRST_ROWS ? 'complete-first64-preoutcome' : 'partial',
      },
      stat,
    )
  }
  return saved
}

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
      (x) => !['manifest', 'factory', 'v1', 'out', 'max-rows', 'run', 'verify'].includes(x),
    ) ||
    (opts.run && opts.run !== 'true') ||
    (opts.verify && opts.verify !== 'true') ||
    (opts.run && opts.verify)
  )
    throw new Error('Invalid signer baseline options')
  return opts
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = options(process.argv.slice(2)),
      base = 'data/research/venue-signals/'
    const manifestPath = resolve(opts.manifest || `${base}morpho-v2-full-cohort-manifest.json`)
    const factoryPath = resolve(opts.factory || `${base}${FACTORY_SHA}.json`)
    const v1Path = resolve(opts.v1 || `${base}morpho-v2-full-cohort-baseline.json`)
    const out = resolve(opts.out || `${base}morpho-v2-signer-baseline-v2.json`)
    const maxRows = opts['max-rows'] === undefined ? 8 : Number(opts['max-rows'])
    if (!opts.run && !opts.verify) {
      const prefixes = loadInputs({ manifestPath, factoryPath, v1Path })
      process.stdout.write(
        JSON.stringify({
          mode: 'dry',
          sourceRows: prefixes.length,
          defaultNextRows: 8,
          runRequired: true,
        }) + '\n',
      )
    } else if (opts.verify) {
      const saved = verifyCheckpoint(
        JSON.parse(readFileSync(out, 'utf8')),
        loadInputs({ manifestPath, factoryPath, v1Path }),
      )
      process.stdout.write(
        JSON.stringify({
          mode: 'verify',
          rows: saved.rows.length,
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
        factoryPath,
        v1Path,
        out,
        maxRows,
      })
      process.stdout.write(
        JSON.stringify({
          mode: 'run',
          rows: saved.rows.length,
          status: saved.status,
          sha256: sha(readFileSync(out)),
        }) + '\n',
      )
    }
  } catch {
    // Provider errors may contain credential-bearing URLs.
    process.stderr.write('Signer baseline stopped; source, RPC, or resource validation failed.\n')
    process.exitCode = 1
  }
}
