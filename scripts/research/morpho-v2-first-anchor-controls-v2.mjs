// Correct the frozen first anchor only. No post-anchor reads or v1 artifact mutation.
// Dry: node scripts/research/morpho-v2-first-anchor-controls-v2.mjs
// Live (after review): node scripts/research/morpho-v2-first-anchor-controls-v2.mjs --run true --max-candidates 1
// Offline: node scripts/research/morpho-v2-first-anchor-controls-v2.mjs --verify true
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, toHex } from 'viem'
import { replayTransfers, validateRaw, MAX_RAW_BYTES } from './morpho-v2-full-cohort-baseline.mjs'
import {
  loadSources,
  verifyCheckpoint as verifyV1,
  chooseControls,
  pageDisposition,
  guardDisk,
  MANIFEST_SHA,
  FACTORY_SHA,
  RESERVE_BYTES,
  MAX_CANDIDATE_RPC,
} from './morpho-v2-full-cohort-controls.mjs'
import { sentinelReason } from './morpho-v2-signer-baseline.mjs'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const STUDY = 'morpho-v2-first-anchor-controls-sentinel-v2'
export const ESTIMAND =
  'non-sentinel code-empty holder mechanical eth_call; signer control unproven'
export const TREATED_SHA = '76f5c5654240c383c3553c098002cd7eb4a1166322da8be728bbf7952c54928c'
export const CONTROL_SHA = 'fc7a5ee9dd02a565a86169621aa1050c47adb1123bc970d40da6ac1114d4e963'
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const ABI = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function withdraw(uint256,address,address) returns (uint256)',
])
const GAS = toHex(30_000_000)
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const unsigned = ({ checkpointSha256, ...rest }) => rest
const seal = (value) => ({
  ...unsigned(value),
  checkpointSha256: sha(JSON.stringify(unsigned(value))),
})
const isRevert = (error) =>
  [3, -32015].includes(error?.code ?? error?.cause?.code) ||
  /execution reverted|vm execution error/i.test(
    `${error?.message || ''} ${error?.cause?.message || ''}`,
  )
class BudgetError extends Error {}
class RpcError extends Error {
  constructor(cause) {
    super('Historical RPC unavailable', { cause })
  }
}

function pinned(path, expected) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== expected) throw new Error('Pinned source physical SHA mismatch')
  return JSON.parse(bytes)
}

export function loadFrozen({ manifestPath, factoryPath, treatedPath, controlPath }) {
  const { anchors, treatedPrefixSha256 } = loadSources(
    manifestPath,
    treatedPath,
    factoryPath,
    TREATED_SHA,
  )
  const old = pinned(controlPath, CONTROL_SHA)
  verifyV1(old, anchors, treatedPrefixSha256)
  const anchor = anchors[0]
  if (
    old.rows.length !== 1 ||
    old.rows[0].screened.length !== anchor.candidates.length ||
    anchor.candidates.length !== 4 ||
    old.rows[0].treatedStatus !== 'baseline-success' ||
    !old.rows[0].treatedState ||
    anchor.baseline.status !== 'baseline-success' ||
    sentinelReason(anchor.baseline.holder) !== null
  )
    throw new Error('Frozen first-anchor control frontier mismatch')
  const sources = old.rows[0].screened.map((row, i) => {
    if (row.vault !== anchor.candidates[i].vault || !row.rawPath || !row.rawSha256)
      throw new Error('Frozen candidate/raw linkage mismatch')
    const bytes = readFileSync(row.rawPath)
    if (bytes.length > MAX_RAW_BYTES || sha(bytes) !== row.rawSha256)
      throw new Error('Frozen raw prefix physical SHA mismatch')
    const raw = validateRaw(
      JSON.parse(bytes),
      { vault: row.vault, creationBlock: row.creationBlock, preBlock: row.preBlock },
      row.preBlockHash,
    )
    return { old: row, raw }
  })
  return { anchor, oldRow: old.rows[0], sources, treatedPrefixSha256 }
}

export function candidatePlan(logs) {
  return replayTransfers(logs).map(([holder, shares]) => ({
    holder,
    shares: shares.toString(),
    exclusionReason: sentinelReason(holder),
  }))
}

function save(out, value, stat) {
  const bytes = JSON.stringify(seal(value))
  if (Buffer.byteLength(bytes) > MAX_OUTPUT_BYTES) throw new Error('V2 output cap reached')
  guardDisk(out, Buffer.byteLength(bytes), stat)
  mkdirSync(dirname(out), { recursive: true })
  const temp = `${out}.${process.pid}.tmp`
  writeFileSync(temp, bytes, { mode: 0o600 })
  renameSync(temp, out)
  return JSON.parse(bytes)
}

export function verify(saved, frozen) {
  const { anchor, oldRow, sources } = frozen
  if (
    !saved ||
    saved.checkpointSha256 !== sha(JSON.stringify(unsigned(saved))) ||
    saved.study !== STUDY ||
    saved.estimand !== ESTIMAND ||
    saved.manifestSha256 !== MANIFEST_SHA ||
    saved.factorySha256 !== FACTORY_SHA ||
    saved.treatedPhysicalSha256 !== TREATED_SHA ||
    saved.controlPhysicalSha256 !== CONTROL_SHA ||
    saved.anchorIndex !== 0 ||
    saved.denominator !== 304 ||
    !Array.isArray(saved.screened) ||
    saved.screened.length > sources.length ||
    saved.status !==
      (saved.screened.length === sources.length ? 'first-anchor-complete' : 'partial')
  )
    throw new Error('V2 checkpoint seal/metadata mismatch')
  for (let i = 0; i < saved.screened.length; i++) {
    const row = saved.screened[i],
      source = sources[i]
    const plan = candidatePlan(source.raw.logs)
    if (
      row.vault !== source.old.vault ||
      row.v1RawSha256 !== source.old.rawSha256 ||
      row.v1Status !== source.old.status ||
      JSON.stringify(row.v1HolderAttempts) !== JSON.stringify(source.old.holderAttempts) ||
      row.rawPath !== source.old.rawPath ||
      row.rawSha256 !== source.old.rawSha256 ||
      row.totalSupply !== source.old.totalSupply ||
      row.totalAssets !== source.old.totalAssets ||
      row.runtimeCodeHash !== source.old.runtimeCodeHash ||
      row.asset !== source.old.asset ||
      row.adapter !== source.old.adapter ||
      row.idleAssets !== source.old.idleAssets ||
      row.preBlockHash !== oldRow.preBlockHash ||
      !Array.isArray(row.holderAttempts) ||
      row.holderAttempts.length > plan.length ||
      row.holderAttempts.some(
        (attempt, j) =>
          attempt.holder !== plan[j].holder ||
          attempt.shares !== plan[j].shares ||
          (plan[j].exclusionReason
            ? attempt.status !== 'excluded-sentinel' ||
              attempt.exclusionReason !== plan[j].exclusionReason
            : attempt.status === 'excluded-sentinel'),
      ) ||
      !Number.isSafeInteger(row.rpcCalls) ||
      row.rpcCalls < 0 ||
      row.rpcCalls > MAX_CANDIDATE_RPC ||
      JSON.stringify(row.sentinelExclusions) !==
        JSON.stringify(plan.filter((x) => x.exclusionReason)) ||
      row.holderAttempts.some(
        (x) => sentinelReason(x.holder) !== null && x.status !== 'excluded-sentinel',
      ) ||
      (row.status === 'baseline-success' &&
        (sentinelReason(row.holder) !== null ||
          row.holderAttempts.at(-1)?.status !== 'success' ||
          row.holderAttempts.at(-1)?.holder !== row.holder ||
          row.holderShares !== row.holderAttempts.at(-1)?.shares ||
          row.holderClaimAssets !== row.holderAttempts.at(-1)?.previewRedeemable ||
          row.withdrawShares !== row.holderAttempts.at(-1)?.withdrawShares))
    )
      throw new Error('V2 candidate frontier mismatch')
  }
  const selected = chooseControls(saved.screened, oldRow.treatedState, anchor.treatedAgeSeconds)
  if (
    JSON.stringify(saved.selected) !== JSON.stringify(selected) ||
    saved.disposition !== pageDisposition(anchor, saved.screened)
  )
    throw new Error('V2 selection/disposition mismatch')
  return saved
}

export async function screen({
  client,
  frozen,
  index,
  out,
  stat = statfsSync,
  rpcLimit = MAX_CANDIDATE_RPC - 1,
}) {
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= frozen.sources.length ||
    !Number.isSafeInteger(rpcLimit) ||
    rpcLimit < 1 ||
    rpcLimit >= MAX_CANDIDATE_RPC
  )
    throw new Error('Invalid bounded candidate screen')
  const { anchor, sources } = frozen
  const { old, raw } = sources[index]
  const hash = anchor.baseline.preBlockHash
  const budget = { used: 0 }
  const rpc = async (method, params) => {
    if (budget.used >= rpcLimit) throw new BudgetError('Candidate RPC budget reached')
    guardDisk(out, 0, stat)
    budget.used++
    try {
      return await client.request({ method, params })
    } catch (error) {
      throw new RpcError(error)
    }
  }
  const header = async (block) => {
    const value = await rpc('eth_getBlockByNumber', [toHex(block), false])
    if (
      Number(BigInt(value?.number)) !== block ||
      value?.hash?.toLowerCase() !== (block === old.preBlock ? hash : anchor.row.anchorBlockHash)
    )
      throw new Error('Frozen header identity mismatch')
  }
  const call = async (name, args, from = old.vault) =>
    decodeFunctionResult({
      abi: ABI,
      functionName: name,
      data: await rpc('eth_call', [
        {
          from,
          to: old.vault,
          data: encodeFunctionData({ abi: ABI, functionName: name, args }),
          gas: GAS,
        },
        { blockHash: hash, requireCanonical: true },
      ]),
    })
  const base = {
    ...old,
    v1Status: old.status,
    v1RawSha256: old.rawSha256,
    v1HolderAttempts: old.holderAttempts,
    holderAttempts: [],
    sentinelExclusions: candidatePlan(raw.logs).filter((x) => x.exclusionReason),
  }
  delete base.status
  delete base.holder
  delete base.holderShares
  delete base.holderClaimAssets
  delete base.withdrawShares
  delete base.distance
  const finish = (status) => ({ ...base, status, rpcCalls: budget.used })
  try {
    await header(old.preBlock)
    await header(anchor.row.anchorBlock)
    const vaultCode = await rpc('eth_getCode', [
      old.vault,
      { blockHash: hash, requireCanonical: true },
    ])
    if (keccak256(vaultCode) !== old.runtimeCodeHash)
      throw new Error('Frozen vault runtime code mismatch')
    const [supply, assets] = [await call('totalSupply', []), await call('totalAssets', [])]
    if (supply.toString() !== old.totalSupply || assets.toString() !== old.totalAssets)
      throw new Error('Frozen B-1 vault state mismatch')
    const plan = candidatePlan(raw.logs)
    if (plan.reduce((sum, x) => sum + BigInt(x.shares), 0n) !== supply)
      throw new Error('Frozen holder ledger/supply mismatch')
    const q = BigInt(anchor.baseline.qAssets)
    let ambiguous = false
    for (const item of plan) {
      const attempt = { holder: item.holder, shares: item.shares }
      if (item.exclusionReason) {
        attempt.status = 'excluded-sentinel'
        attempt.exclusionReason = item.exclusionReason
        base.holderAttempts.push(attempt)
        continue
      }
      let code
      try {
        code = await rpc('eth_getCode', [item.holder, { blockHash: hash, requireCanonical: true }])
      } catch (error) {
        if (error instanceof BudgetError || /Disk reserve/.test(error.message)) throw error
        attempt.status = 'holder-code-rpc-ambiguous'
        base.holderAttempts.push(attempt)
        ambiguous = true
        continue
      }
      if (!/^0x(?:[\da-fA-F]{2})*$/.test(code)) throw new Error('Malformed holder code')
      attempt.codeHash = code === '0x' ? null : keccak256(code)
      if (code !== '0x') {
        attempt.status = 'contract-holder'
        base.holderAttempts.push(attempt)
        continue
      }
      let balance, claim
      try {
        balance = await call('balanceOf', [item.holder])
        claim = await call('previewRedeem', [BigInt(item.shares)])
      } catch (error) {
        if (error instanceof BudgetError || /Disk reserve/.test(error.message)) throw error
        attempt.status = 'holder-state-rpc-ambiguous'
        base.holderAttempts.push(attempt)
        ambiguous = true
        continue
      }
      attempt.balanceOf = balance.toString()
      attempt.previewRedeemable = claim.toString()
      if (balance !== BigInt(item.shares)) {
        attempt.status = 'holder-ledger-balance-mismatch'
        base.holderAttempts.push(attempt)
        return finish('holder-ledger-balance-mismatch')
      }
      if (claim < q) {
        attempt.status = 'insufficient-claim'
        base.holderAttempts.push(attempt)
        continue
      }
      try {
        const output = await call('withdraw', [q, item.holder, item.holder], item.holder)
        attempt.status = 'success'
        attempt.withdrawShares = output.toString()
        base.holderAttempts.push(attempt)
        await header(old.preBlock)
        return {
          ...finish('baseline-success'),
          holder: item.holder,
          holderShares: item.shares,
          holderClaimAssets: claim.toString(),
          withdrawShares: output.toString(),
        }
      } catch (error) {
        if (error instanceof BudgetError || /Disk reserve|Frozen header/.test(error.message))
          throw error
        attempt.status = isRevert(error) ? 'withdraw-revert' : 'withdraw-transport-ambiguous'
        base.holderAttempts.push(attempt)
        if (!isRevert(error)) ambiguous = true
      }
    }
    await header(old.preBlock)
    return finish(ambiguous ? 'holder-or-withdraw-rpc-ambiguous' : 'no-successful-eoa-holder')
  } catch (error) {
    if (error instanceof BudgetError) return finish('rpc-budget-censored')
    if (error instanceof RpcError) return finish('candidate-rpc-ambiguous')
    throw error
  }
}

export async function run({ client, frozen, out, maxCandidates = 1, stat = statfsSync }) {
  if (
    !Number.isSafeInteger(maxCandidates) ||
    maxCandidates < 1 ||
    maxCandidates > frozen.sources.length
  )
    throw new Error('Invalid candidate batch')
  guardDisk(out, 0, stat)
  let saved = existsSync(out)
    ? verify(JSON.parse(readFileSync(out, 'utf8')), frozen)
    : seal({
        study: STUDY,
        estimand: ESTIMAND,
        status: 'partial',
        manifestSha256: MANIFEST_SHA,
        factorySha256: FACTORY_SHA,
        treatedPhysicalSha256: TREATED_SHA,
        controlPhysicalSha256: CONTROL_SHA,
        anchorIndex: 0,
        denominator: 304,
        screened: [],
        selected: [],
        disposition: 'first-page-in-progress',
      })
  if (Number(BigInt(await client.request({ method: 'eth_chainId', params: [] }))) !== 1)
    throw new Error('Wrong chain ID')
  const stop = Math.min(frozen.sources.length, saved.screened.length + maxCandidates)
  for (let i = saved.screened.length; i < stop; i++) {
    const row = await screen({ client, frozen, index: i, out, stat })
    guardDisk(out, 0, stat)
    for (const [block, expected] of [
      [frozen.anchor.row.anchorBlock - 1, frozen.anchor.baseline.preBlockHash],
      [frozen.anchor.row.anchorBlock, frozen.anchor.row.anchorBlockHash],
    ]) {
      const header = await client.request({
        method: 'eth_getBlockByNumber',
        params: [toHex(block), false],
      })
      if (Number(BigInt(header?.number)) !== block || header?.hash?.toLowerCase() !== expected)
        throw new Error('Frozen header changed before checkpoint')
    }
    saved = save(
      out,
      {
        ...saved,
        screened: [...saved.screened, row],
        status: i + 1 === frozen.sources.length ? 'first-anchor-complete' : 'partial',
        selected: chooseControls(
          [...saved.screened, row],
          frozen.oldRow.treatedState,
          frozen.anchor.treatedAgeSeconds,
        ),
        disposition: pageDisposition(frozen.anchor, [...saved.screened, row]),
      },
      stat,
    )
  }
  return saved
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (
      args.some((value, i) =>
        i % 2 === 0 ? !['--run', '--verify', '--max-candidates'].includes(value) : !value,
      ) ||
      args.length % 2
    )
      throw new Error('Invalid options')
    const opts = Object.fromEntries(
      Array.from({ length: args.length / 2 }, (_, i) => args.slice(i * 2, i * 2 + 2)),
    )
    if (
      (opts['--run'] && opts['--run'] !== 'true') ||
      (opts['--verify'] && opts['--verify'] !== 'true') ||
      (opts['--run'] && opts['--verify'])
    )
      throw new Error('Invalid mode')
    const base = 'data/research/venue-signals/'
    const frozen = loadFrozen({
      manifestPath: `${base}morpho-v2-full-cohort-manifest.json`,
      factoryPath: `${base}${FACTORY_SHA}.json`,
      treatedPath: `${base}morpho-v2-full-cohort-baseline.json`,
      controlPath: `${base}morpho-v2-full-cohort-controls.json`,
    })
    const out = resolve(`${base}morpho-v2-first-anchor-controls-v2.json`)
    if (opts['--verify']) {
      const saved = verify(JSON.parse(readFileSync(out, 'utf8')), frozen)
      process.stdout.write(
        JSON.stringify({ mode: 'verify', screened: saved.screened.length }) + '\n',
      )
    } else if (opts['--run']) {
      const url = process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
      if (!url) throw new Error('Missing RPC')
      const saved = await run({
        client: makeClient(url),
        frozen,
        out,
        maxCandidates:
          opts['--max-candidates'] === undefined ? 1 : Number(opts['--max-candidates']),
      })
      process.stdout.write(
        JSON.stringify({
          mode: 'run',
          screened: saved.screened.length,
          disposition: saved.disposition,
        }) + '\n',
      )
    } else {
      process.stdout.write(
        JSON.stringify({
          mode: 'dry',
          candidates: frozen.sources.length,
          oldSelected: frozen.oldRow.selected.map((x) => x.vault),
          runRequired: true,
        }) + '\n',
      )
    }
  } catch {
    // Never print credential-bearing provider errors.
    process.stderr.write(
      'V2 first-anchor control correction stopped; check pinned sources, RPC, or resources.\n',
    )
    process.exitCode = 1
  }
}
