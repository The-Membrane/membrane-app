// Exploratory post-hoc $1m USDC/USDT material-exit sensitivity. B-1 only; dry by default.
// The original fixed-q study and its sealed checkpoints are never modified.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeFunctionResult, parseAbi } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { FACTORY_SHA, MANIFEST_SHA } from './morpho-v2-full-cohort-baseline.mjs'
import { STAGE1_SHA } from './morpho-v2-exit-baseline-pilot.mjs'
import { loadPlan, observe } from './morpho-v2-first64-treated-outcomes.mjs'

export const STUDY = 'morpho-v2-material-baseline-v1'
export const Q = '1000000000000'
export const N = 304
export const FIRST = 64
export const MIN_FREE = 2_500_000_000n
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const HASH = /^0x[\da-f]{64}$/
const ADDRESS = /^0x[\da-f]{40}$/
const UINT = /^(0|[1-9]\d*)$/
const ZERO = `0x${'0'.repeat(40)}`
const WITHDRAW_ABI = parseAbi(['function withdraw(uint256,address,address) returns (uint256)'])
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const stable = (value) => JSON.stringify(value)
const seal = (value) => {
  const { checkpointSha256: _old, ...body } = value
  return { ...body, checkpointSha256: sha(stable(body)) }
}
function assert(ok, message) {
  if (!ok) throw new Error(message)
}
export function guardDisk(out, bytes = 0, stat = statfsSync) {
  let dir = dirname(out)
  while (!existsSync(dir)) dir = dirname(dir)
  const fs = stat(dir, { bigint: true })
  assert(fs.bavail * fs.bsize - BigInt(bytes) >= MIN_FREE, 'Morpho disk reserve reached')
}
function pinned(path, expected) {
  const bytes = readFileSync(path)
  assert(sha(bytes) === expected, 'Pinned material sensitivity source changed')
  return JSON.parse(bytes)
}
export function loadMaterialPlan(paths) {
  const first = loadPlan(paths) // Checks treated, manifest, factory, Stage1 ancestry and first64.
  const manifest = pinned(paths.manifestPath, MANIFEST_SHA)
  assert(manifest.rows.length === N && first.length === FIRST, '304/64 denominator changed')
  return manifest.rows.map((anchor, index) => {
    const source = first[index]
    const asset = anchor.asset.toLowerCase()
    const row = {
      index,
      vault: anchor.vault,
      asset,
      proposalIndex: anchor.proposalIndex,
      anchorBlock: anchor.anchorBlock,
      anchorBlockHash: anchor.anchorBlockHash,
      qAssets: Q,
      holder: source?.holder ?? null,
      holderClaimAssets: source?.baselineClaimAssets ?? null,
      sourceBaselineStatus: source?.baselineStatus ?? null,
      preBlock: source?.preBlock ?? null,
      preBlockHash: source?.preBlockHash ?? null,
      baselineRuntimeCodeHash: source?.baselineRuntimeCodeHash ?? null,
    }
    if (asset !== USDC && asset !== USDT) return { ...row, status: 'other-asset' }
    if (!source) return { ...row, status: 'corrected-baseline-unavailable' }
    assert(
      source.vault === anchor.vault && source.proposalIndex === anchor.proposalIndex,
      'Anchor join changed',
    )
    if (!source.holder) return { ...row, status: 'no-frozen-holder' }
    if (!source.baselineClaimAssets || !source.baselineRuntimeCodeHash)
      return { ...row, status: 'prestate-missing' }
    if (BigInt(source.baselineClaimAssets) < BigInt(Q))
      return { ...row, status: 'low-prestate-claim' }
    assert(HASH.test(source.preBlockHash), 'Invalid frozen B-1 hash')
    return { ...row, status: 'ready' }
  })
}
export function verifySnapshot(saved, plan) {
  assert(saved?.study === STUDY && saved?.denominator === N && saved?.qAssets === Q, 'Wrong study')
  assert(saved.prospective === false, 'Material sensitivity is retrospective')
  assert(
    saved.manifestSha256 === MANIFEST_SHA && saved.factorySha256 === FACTORY_SHA,
    'Wrong ancestry',
  )
  assert(saved.stage1Sha256 === STAGE1_SHA && saved.rows?.length === N, 'Wrong denominator')
  assert(seal(saved).checkpointSha256 === saved.checkpointSha256, 'Checkpoint seal mismatch')
  for (let i = 0; i < N; i++) {
    const row = saved.rows[i],
      source = plan[i]
    for (const [key, value] of Object.entries(source)) {
      if (key !== 'status') assert(row[key] === value, `Frozen row field changed: ${key}`)
    }
    assert(
      row.index === i && row.vault === source.vault && row.asset === source.asset,
      'Row join changed',
    )
    assert(row.holder === source.holder && row.qAssets === Q, 'Holder or q changed')
    assert(row.preBlockHash === source.preBlockHash, 'B-1 hash changed')
    if (source.status !== 'ready') assert(row.status === source.status, 'Ineligible row changed')
    else
      assert(
        ['ready', 'baseline-success', 'baseline-revert', 'censored'].includes(row.status),
        'Bad measured status',
      )
    if (row.status === 'baseline-success')
      assert(
        row.observation?.status === 'success' &&
          row.observation?.censoring?.length === 0 &&
          row.observation?.asset === row.asset &&
          row.observation?.hash === row.preBlockHash &&
          row.observation?.call === 'success' &&
          row.observation?.gasStatus === 'observed' &&
          /^0x(?:[\da-f]{2})+$/i.test(row.observation?.output || '') &&
          UINT.test(row.observation?.shares || '') &&
          decodeFunctionResult({
            abi: WITHDRAW_ABI,
            functionName: 'withdraw',
            data: row.observation.output,
          }).toString() === row.observation.shares &&
          UINT.test(row.observation?.gasEstimate || '') &&
          BigInt(row.observation.gasEstimate) <= 30_000_000n &&
          BigInt(row.observation.gasEstimate) <= BigInt(row.observation.gasLimit),
        'Success not clean',
      )
    if (row.status === 'baseline-revert')
      assert(
        row.observation?.status === 'evm-revert' &&
          row.observation?.censoring?.length === 0 &&
          row.observation?.asset === row.asset &&
          row.observation?.hash === row.preBlockHash &&
          row.observation?.call === 'evm-revert',
        'Revert not clean',
      )
    if (['baseline-success', 'baseline-revert'].includes(row.status)) {
      const observed = row.observation
      assert(
        Number.isSafeInteger(row.rpcCalls) &&
          row.rpcCalls > 0 &&
          row.rpcCalls <= 100 &&
          row.identity?.status === 'baseline-observed' &&
          row.identity?.censoring?.length === 0 &&
          row.identity.asset === row.asset &&
          row.identity.runtimeCodeHash === row.baselineRuntimeCodeHash &&
          row.identity.holderCodeHash === null &&
          row.identity.holderClaimAssets === row.holderClaimAssets &&
          UINT.test(observed.holderClaimAssets || '') &&
          BigInt(observed.holderClaimAssets) >= BigInt(Q) &&
          observed.holderClaimAssets === row.identity.holderClaimAssets &&
          observed.runtimeCodeHash === row.identity.runtimeCodeHash &&
          observed.holderCodeHash === null &&
          observed.adapter === row.identity.adapter &&
          observed.proxyImplementation === row.identity.proxyImplementation &&
          observed.adapterImplementation === row.identity.adapterImplementation &&
          observed.adapterCodeHash === row.identity.adapterCodeHash &&
          observed.proxyImplementationCodeHash === row.identity.proxyImplementationCodeHash &&
          observed.adapterImplementationCodeHash === row.identity.adapterImplementationCodeHash &&
          UINT.test(observed.gasLimit || '') &&
          BigInt(observed.gasLimit) >= 30_000_000n &&
          ADDRESS.test(observed.adapter || '') &&
          (observed.adapter === ZERO || HASH.test(observed.adapterCodeHash || '')),
        'Clean observation identity or size mismatch',
      )
    }
    if (row.status === 'censored')
      assert(
        typeof row.censorReason === 'string' &&
          row.censorReason.length > 0 &&
          Number.isSafeInteger(row.rpcCalls) &&
          row.rpcCalls > 0 &&
          row.rpcCalls <= 100,
        'Unexplained censor',
      )
  }
  return saved
}
function save(out, value, guard = guardDisk) {
  const bytes = stable(seal(value))
  assert(Buffer.byteLength(bytes) < 8 * 1024 * 1024, 'Material checkpoint output cap')
  guard(out, Buffer.byteLength(bytes))
  mkdirSync(dirname(out), { recursive: true })
  const tmp = `${out}.${process.pid}.tmp`
  writeFileSync(tmp, bytes, { mode: 0o600 })
  renameSync(tmp, out)
  return JSON.parse(bytes)
}
async function pinnedHeader(request, number) {
  const raw = await request('eth_getBlockByNumber', [`0x${number.toString(16)}`, false])
  assert(
    Number(BigInt(raw?.number)) === number && HASH.test(raw.hash?.toLowerCase() || ''),
    'Header mismatch',
  )
  return {
    block: number,
    hash: raw.hash.toLowerCase(),
    parentHash: raw.parentHash.toLowerCase(),
    timestamp: Number(BigInt(raw.timestamp)),
    gasLimit: BigInt(raw.gasLimit).toString(),
  }
}
export async function measureRow(client, row, { out, guard = guardDisk, observeFn = observe }) {
  assert(row.status === 'ready', 'Only frozen ready rows may be probed')
  let used = 0
  let fatal = null
  const request = async (method, params) => {
    try {
      guard(out)
    } catch (error) {
      fatal = error
      throw error
    }
    if (++used > 100) {
      fatal = new Error('Material per-row RPC cap reached')
      throw fatal
    }
    return client.request({ method, params })
  }
  const before = await pinnedHeader(request, row.preBlock)
  assert(before.hash === row.preBlockHash, 'Frozen B-1 header changed')
  const anchor = await pinnedHeader(request, row.anchorBlock)
  assert(anchor.hash === row.anchorBlockHash, 'Frozen anchor header changed')
  assert(anchor.parentHash === before.hash, 'B is not the child of frozen B-1')
  const preflightRow = {
    ...row,
    baselineClaimAssets: row.holderClaimAssets,
  }
  let observation
  let identity
  try {
    identity = await observeFn(request, preflightRow, before, true)
    if (fatal) throw fatal
    assert(identity.asset === row.asset, 'Pinned vault asset differs from frozen manifest')
    observation = await observeFn(request, { ...preflightRow, baseline: identity }, before, false)
    if (fatal) throw fatal
  } catch (error) {
    if (fatal) throw fatal
    if (/disk reserve|RPC cap|frozen manifest/i.test(error.message)) throw error
    const after = await pinnedHeader(request, row.preBlock)
    assert(after.hash === before.hash, 'B-1 hash changed during censored probe')
    const censorReason = /baseline code mismatch/i.test(error.message)
      ? 'vault-code-drift-from-frozen-source'
      : /baseline claim mismatch/i.test(error.message)
        ? 'holder-claim-drift-from-frozen-source'
        : /identity preflight failed/i.test(error.message)
          ? 'identity-preflight-censored'
          : 'rpc-or-identity-ambiguous'
    return { ...row, status: 'censored', censorReason, rpcCalls: used }
  }
  const after = await pinnedHeader(request, row.preBlock)
  assert(after.hash === before.hash, 'B-1 hash changed during probe')
  const status =
    observation.status === 'success'
      ? 'baseline-success'
      : observation.status === 'evm-revert'
        ? 'baseline-revert'
        : 'censored'
  return {
    ...row,
    status,
    identity,
    observation,
    censorReason: status === 'censored' ? 'observed-call-or-identity-censored' : undefined,
    rpcCalls: used,
  }
}
export async function run({
  client,
  paths,
  out,
  maxRows = 4,
  guard = guardDisk,
  observeFn = observe,
}) {
  assert(Number.isSafeInteger(maxRows) && maxRows >= 1 && maxRows <= 8, 'maxRows must be 1..8')
  const plan = loadMaterialPlan(paths)
  let saved = existsSync(out)
    ? verifySnapshot(JSON.parse(readFileSync(out)), plan)
    : seal({
        study: STUDY,
        denominator: N,
        qAssets: Q,
        manifestSha256: MANIFEST_SHA,
        factorySha256: FACTORY_SHA,
        stage1Sha256: STAGE1_SHA,
        prospective: false,
        rows: plan,
      })
  const ready = saved.rows.filter((row) => row.status === 'ready').slice(0, maxRows)
  if (!ready.length) return saved
  guard(out)
  assert(
    Number(BigInt(await client.request({ method: 'eth_chainId', params: [] }))) === 1,
    'Wrong chain',
  )
  for (const row of ready) {
    const measured = await measureRow(client, row, { out, guard, observeFn })
    saved = save(
      out,
      { ...saved, rows: saved.rows.map((item, i) => (i === row.index ? measured : item)) },
      guard,
    )
  }
  return verifySnapshot(saved, plan)
}

function options(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    assert(argv[i].startsWith('--'), 'Expected --key')
    const name = argv[i].slice(2)
    assert(!Object.hasOwn(opts, name), 'Duplicate option')
    if (name === 'run' || name === 'verify') opts[name] = true
    else opts[name] = argv[++i]
  }
  assert(
    Object.keys(opts).every((key) => ['run', 'verify', 'max-rows', 'out', 'rpc'].includes(key)),
    'Unknown option',
  )
  return opts
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = options(process.argv.slice(2))
  const base = 'data/research/venue-signals/'
  const paths = {
    treatedPath: resolve(`${base}morpho-v2-signer-baseline-v2.json`),
    manifestPath: resolve(`${base}morpho-v2-full-cohort-manifest.json`),
    factoryPath: resolve(`${base}${FACTORY_SHA}.json`),
    stage1Path: resolve(`${base}${STAGE1_SHA}.json`),
  }
  const out = resolve(opts.out || `${base}morpho-v2-material-baseline-v1.json`)
  try {
    const plan = loadMaterialPlan(paths)
    if (opts.verify) {
      const saved = verifySnapshot(JSON.parse(readFileSync(out)), plan)
      const statuses = Object.fromEntries(
        [...new Set(saved.rows.map((row) => row.status))].map((status) => [
          status,
          saved.rows.filter((row) => row.status === status).length,
        ]),
      )
      process.stdout.write(
        stable({
          verified: true,
          statuses,
          sha256: sha(readFileSync(out)),
        }) + '\n',
      )
    } else if (!opts.run) {
      process.stdout.write(
        stable({
          dry: true,
          study: STUDY,
          denominator: N,
          qAssets: Q,
          ready: plan.filter((r) => r.status === 'ready').length,
          statuses: Object.fromEntries(
            [...new Set(plan.map((r) => r.status))].map((s) => [
              s,
              plan.filter((r) => r.status === s).length,
            ]),
          ),
        }) + '\n',
      )
    } else {
      const rpc = opts.rpc || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
      assert(rpc, 'RPC required')
      const saved = await run({
        client: makeClient(rpc),
        paths,
        out,
        maxRows: opts['max-rows'] ? Number(opts['max-rows']) : 4,
      })
      process.stdout.write(
        stable({
          study: STUDY,
          measured: saved.rows.filter((r) =>
            ['baseline-success', 'baseline-revert', 'censored'].includes(r.status),
          ).length,
          sha256: sha(readFileSync(out)),
        }) + '\n',
      )
    }
  } catch {
    // RPC errors may include credential-bearing URLs.
    process.stderr.write('Material B-1 baseline stopped; prior checkpoint retained.\n')
    process.exitCode = 1
  }
}
