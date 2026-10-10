// Exploratory second q, declared after the $1m treated holder failed the claim gate.
// Dry by default; never discovers a new holder or reads a post-B state.
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, toHex } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import {
  B,
  B_HASH,
  CONTROLS,
  TREATED,
  USDC,
  loadPlan,
  verifyArtifacts as verifyMillion,
} from './morpho-v2-cap-prospective-baseline.mjs'

export const STUDY = 'morpho-v2-cap-prospective-fixed-exit-100k-exploratory-v1'
export const Q = 100_000_000_000n
export const RESERVE_BYTES = 1_000_000_000
const MAX_RPC = 24
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_ARTIFACT_BYTES = 64 * 1024
const HASH = /^0x[\da-f]{64}$/
const ADDRESS = /^0x[\da-f]{40}$/
const DECIMAL = /^(0|[1-9]\d*)$/
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function liquidityAdapter() view returns (address)',
  'function withdraw(uint256,address,address) returns (uint256)',
])
const defaultRoot = resolve('data/research/venue-signals')
const defaultMillion = join(defaultRoot, 'morpho-v2-cap-prospective-baseline')
const defaultOut = join(defaultRoot, 'morpho-v2-cap-100k-pilot')
const sha = (value) => createHash('sha256').update(value).digest('hex')
const unsigned = ({ payloadSha256, ...rest }) => rest
const seal = (artifact) => ({ ...artifact, payloadSha256: sha(JSON.stringify(artifact)) })
const fileName = (index) => `${String(index).padStart(2, '0')}-baseline.json`
const isRevert = (error) =>
  [3, -32015].includes(error?.code ?? error?.cause?.code) ||
  /execution reverted|vm execution error/i.test(error?.message || '')

function diskGuard(out, stat = statfsSync, extra = 0) {
  const fs = stat(existsSync(dirname(out)) ? dirname(out) : defaultRoot)
  if (Number(fs.bavail) * Number(fs.bsize) - extra < RESERVE_BYTES)
    throw new Error('100k pilot disk reserve reached')
}

export function classifySourceResult(result) {
  if (!result) return 'transfer-prefix-incomplete'
  if (result.holder) return 'fixed-holder-ready'
  return result.status === 'no-positive-code-empty-eoa'
    ? 'source-no-fixed-holder'
    : 'source-baseline-unusable'
}

export function readiness({ plan = loadPlan(), million = defaultMillion } = {}) {
  if (
    plan.baselineBlock !== B ||
    plan.baselineHash !== B_HASH ||
    plan.vaults?.length !== 5 ||
    plan.vaults[0]?.vault !== TREATED ||
    plan.vaults.slice(1).some((row, i) => row.vault !== CONTROLS[i])
  )
    throw new Error('100k pilot frozen cohort mismatch')
  const source = verifyMillion({ out: million, plan })
  const rows = source.rows.map((row) => {
    const result = row.result
    if (!result)
      return {
        index: row.vault.index,
        role: row.vault.role,
        vault: row.vault.vault,
        status: 'transfer-prefix-incomplete',
        throughBlock: row.throughBlock,
      }
    const holder = result.holder
    const sourceSha256 = row.previousSha256 // Physical SHA of the verified $1m result segment.
    if (!/^[\da-f]{64}$/.test(sourceSha256 || ''))
      throw new Error('100k pilot missing sealed source result')
    const sourcePath = join(
      million,
      `${String(row.vault.index).padStart(2, '0')}-${String(row.sequence - 1).padStart(6, '0')}-baseline.json`,
    )
    const sourceBytes = readFileSync(sourcePath)
    if (sha(sourceBytes) !== sourceSha256)
      throw new Error('100k pilot source physical SHA mismatch')
    const sourceSegmentSha256 = JSON.parse(sourceBytes).segmentSha256
    return {
      index: row.vault.index,
      role: row.vault.role,
      vault: row.vault.vault,
      status: classifySourceResult(result),
      sourceStatus: result.status,
      sourceSha256,
      sourceSegmentSha256,
      sourceResult: result,
    }
  })
  return {
    plan,
    rows,
    transferPrefixesComplete: rows.every((row) => row.status !== 'transfer-prefix-incomplete'),
    eligibleControlCount: rows.filter(
      (row) => row.role === 'control' && row.status === 'fixed-holder-ready',
    ).length,
  }
}

function validateSource(row) {
  const source = row.sourceResult
  if (
    row.status !== 'fixed-holder-ready' ||
    !source ||
    source.vault !== row.vault ||
    source.baselineBlock !== B ||
    source.baselineHash !== B_HASH ||
    source.qRaw !== '1000000000000' ||
    !ADDRESS.test(source.holder || '') ||
    !DECIMAL.test(source.holderShares || '') ||
    !DECIMAL.test(source.previewRedeemable || '') ||
    source.balanceOf !== source.holderShares ||
    source.totalSupply !== source.replayedSupply ||
    source.asset !== USDC ||
    source.examinedHolders?.at(-1)?.holder !== source.holder ||
    source.examinedHolders?.at(-1)?.codeHash !== null
  )
    throw new Error('100k pilot source holder is not verified B EOA')
}

export async function probe({ row, request }) {
  validateSource(row)
  const holder = row.sourceResult.holder
  const param = { blockHash: B_HASH, requireCanonical: true }
  const result = {
    status: 'unresolved',
    holder,
    holderShares: row.sourceResult.holderShares,
    sourceStatus: row.sourceStatus,
    sourceClaimRaw: row.sourceResult.previewRedeemable,
  }
  const call = async (name, args = [], from = row.vault) =>
    decodeFunctionResult({
      abi: ABI,
      functionName: name,
      data: await request('eth_call', [
        {
          from,
          to: row.vault,
          data: encodeFunctionData({ abi: ABI, functionName: name, args }),
          gas: toHex(30_000_000),
        },
        param,
      ]),
    })
  try {
    const code = await request('eth_getCode', [row.vault, param])
    if (!/^0x(?:[\da-f]{2})+$/i.test(code || ''))
      return { ...result, status: 'vault-code-unresolved' }
    result.runtimeCodeHash = keccak256(code)
    if (result.runtimeCodeHash !== row.sourceResult.runtimeCodeHash)
      return { ...result, status: 'vault-code-changed-at-B' }
    const holderCode = await request('eth_getCode', [holder, param])
    if (holderCode !== '0x') return { ...result, status: 'holder-code-changed-at-B' }
    result.asset = (await call('asset')).toLowerCase()
    result.liquidityAdapter = (await call('liquidityAdapter')).toLowerCase()
    result.totalSupply = (await call('totalSupply')).toString()
    result.totalAssets = (await call('totalAssets')).toString()
    result.holderBalance = (await call('balanceOf', [holder])).toString()
    if (
      result.asset !== USDC ||
      result.liquidityAdapter !== row.sourceResult.liquidityAdapter ||
      result.totalSupply !== row.sourceResult.totalSupply ||
      result.totalAssets !== row.sourceResult.totalAssets ||
      result.holderBalance !== row.sourceResult.holderShares
    )
      return { ...result, status: 'B-prestate-disagrees-with-source' }
    result.claimRaw = (await call('previewRedeem', [BigInt(result.holderBalance)])).toString()
    if (result.claimRaw !== row.sourceResult.previewRedeemable)
      return { ...result, status: 'B-claim-disagrees-with-source' }
    if (BigInt(result.claimRaw) < Q) return { ...result, status: 'holder-claim-below-fixed-q' }
    try {
      result.withdrawShares = (await call('withdraw', [Q, holder, holder], holder)).toString()
      result.status = 'baseline-success'
    } catch (error) {
      if (/disk reserve|RPC cap|response size cap/i.test(error.message)) throw error
      result.status = isRevert(error) ? 'baseline-revert' : 'withdraw-rpc-ambiguous'
    }
    return result
  } catch (error) {
    if (/disk reserve|RPC cap|response size cap/i.test(error.message)) throw error
    return { ...result, status: 'historical-state-rpc-ambiguous' }
  }
}

const STATUSES = new Set([
  'source-no-fixed-holder',
  'source-baseline-unusable',
  'vault-code-unresolved',
  'vault-code-changed-at-B',
  'holder-code-changed-at-B',
  'B-prestate-disagrees-with-source',
  'B-claim-disagrees-with-source',
  'holder-claim-below-fixed-q',
  'baseline-success',
  'baseline-revert',
  'withdraw-rpc-ambiguous',
  'historical-state-rpc-ambiguous',
])
const EXIT_STATUSES = new Set([
  'baseline-success',
  'baseline-revert',
  'withdraw-rpc-ambiguous',
  'holder-claim-below-fixed-q',
])

function checkArtifact(saved, row, plan) {
  if (
    saved.study !== STUDY ||
    saved.schemaVersion !== 1 ||
    saved.chainId !== 1 ||
    saved.index !== row.index ||
    saved.role !== row.role ||
    saved.vault !== row.vault ||
    saved.baselineBlock !== B ||
    saved.baselineHash !== B_HASH ||
    saved.qRaw !== Q.toString() ||
    saved.proposalTx !== plan.proposalTx ||
    saved.watcherFrontierSha256 !== plan.watcherFrontierSha256 ||
    saved.factorySha256 !== plan.factorySha256 ||
    saved.submitSha256 !== plan.submitSha256 ||
    saved.sourceMillionResultSha256 !== row.sourceSha256 ||
    saved.sourceMillionResultSegmentSha256 !== row.sourceSegmentSha256 ||
    saved.holder !== (row.sourceResult?.holder || null) ||
    saved.sourceMillionStatus !== row.sourceStatus ||
    !STATUSES.has(saved.result?.status) ||
    saved.result.holder !== (row.sourceResult?.holder || null) ||
    saved.payloadSha256 !== sha(JSON.stringify(unsigned(saved)))
  )
    throw new Error('100k pilot artifact source or seal mismatch')
  if (
    (row.status === 'source-no-fixed-holder' &&
      (row.sourceStatus !== 'no-positive-code-empty-eoa' ||
        saved.result.status !== 'source-no-fixed-holder' ||
        saved.result.sourceStatus !== row.sourceStatus)) ||
    (row.status === 'source-baseline-unusable' &&
      (row.sourceStatus === 'no-positive-code-empty-eoa' ||
        saved.result.status !== 'source-baseline-unusable' ||
        saved.result.sourceStatus !== row.sourceStatus)) ||
    (row.status === 'fixed-holder-ready' &&
      ['source-no-fixed-holder', 'source-baseline-unusable'].includes(saved.result.status))
  )
    throw new Error('100k pilot false source-holder censor label')
  if (
    EXIT_STATUSES.has(saved.result.status) &&
    (row.status !== 'fixed-holder-ready' ||
      saved.result.holderShares !== row.sourceResult.holderShares ||
      saved.result.sourceStatus !== row.sourceStatus ||
      saved.result.sourceClaimRaw !== row.sourceResult.previewRedeemable ||
      saved.result.claimRaw !== row.sourceResult.previewRedeemable ||
      saved.result.asset !== USDC ||
      saved.result.holderBalance !== row.sourceResult.holderShares ||
      saved.result.totalSupply !== row.sourceResult.totalSupply ||
      saved.result.totalAssets !== row.sourceResult.totalAssets ||
      saved.result.liquidityAdapter !== row.sourceResult.liquidityAdapter ||
      saved.result.runtimeCodeHash !== row.sourceResult.runtimeCodeHash ||
      !DECIMAL.test(saved.result.claimRaw || '') ||
      (saved.result.status === 'holder-claim-below-fixed-q'
        ? BigInt(saved.result.claimRaw) >= Q
        : BigInt(saved.result.claimRaw) < Q))
  )
    throw new Error('100k pilot false fixed-exit status label')
  if (
    saved.result.status === 'baseline-success' &&
    !DECIMAL.test(saved.result.withdrawShares || '')
  )
    throw new Error('100k pilot false clean-success label')
}

export function verify({ ready = readiness(), out = defaultOut } = {}) {
  const results = []
  for (const row of ready.rows) {
    const path = join(out, fileName(row.index))
    if (!existsSync(path)) continue
    if (!row.sourceResult || row.status === 'transfer-prefix-incomplete')
      throw new Error('100k pilot result has incomplete source ledger')
    const bytes = readFileSync(path)
    if (bytes.length > MAX_ARTIFACT_BYTES) throw new Error('100k pilot artifact size cap exceeded')
    const saved = JSON.parse(bytes)
    checkArtifact(saved, row, ready.plan)
    results.push({ index: row.index, status: saved.result.status, physicalSha256: sha(bytes) })
  }
  return {
    results,
    completed: results.length,
    success: results.filter((x) => x.status === 'baseline-success').length,
  }
}

function append(out, saved, stat) {
  const bytes = JSON.stringify(seal(saved))
  if (Buffer.byteLength(bytes) > MAX_ARTIFACT_BYTES)
    throw new Error('100k pilot artifact size cap exceeded')
  mkdirSync(out, { recursive: true })
  diskGuard(out, stat, Buffer.byteLength(bytes))
  const target = join(out, fileName(saved.index))
  const temp = `${target}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temp, target)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
}

export async function collect({
  client,
  ready = readiness(),
  out = defaultOut,
  stat = statfsSync,
  maxRows = 1,
} = {}) {
  if (!client || !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 5)
    throw new Error('Invalid bounded 100k pilot request')
  const prior = verify({ ready, out })
  const done = new Set(prior.results.map((row) => row.index))
  let collected = 0
  for (const row of ready.rows) {
    if (collected >= maxRows) break
    if (done.has(row.index) || row.status === 'transfer-prefix-incomplete') continue
    let calls = 0
    const request = async (method, params) => {
      diskGuard(out, stat)
      if (++calls > MAX_RPC) throw new Error('100k pilot RPC cap reached')
      const value = await client.request({ method, params })
      if (Buffer.byteLength(JSON.stringify(value)) > MAX_RESPONSE_BYTES)
        throw new Error('100k pilot response size cap reached')
      return value
    }
    if (Number(BigInt(await request('eth_chainId', []))) !== 1) throw new Error('Wrong chain ID')
    const finalized = await request('eth_getBlockByNumber', ['finalized', false])
    if (Number(BigInt(finalized?.number || 0)) < B) throw new Error('100k pilot B is not finalized')
    const atB = await request('eth_getBlockByNumber', [toHex(B), false])
    if (atB?.hash?.toLowerCase() !== B_HASH || Number(BigInt(atB.number)) !== B)
      throw new Error('100k pilot canonical B mismatch')
    const result =
      row.status === 'fixed-holder-ready'
        ? await probe({ row, request })
        : { status: row.status, holder: null, sourceStatus: row.sourceStatus }
    const after = await request('eth_getBlockByNumber', [toHex(B), false])
    if (after?.hash?.toLowerCase() !== B_HASH) throw new Error('100k pilot B changed during probe')
    const saved = {
      study: STUDY,
      schemaVersion: 1,
      chainId: 1,
      index: row.index,
      role: row.role,
      vault: row.vault,
      baselineBlock: B,
      baselineHash: B_HASH,
      qRaw: Q.toString(),
      proposalTx: ready.plan.proposalTx,
      watcherFrontierSha256: ready.plan.watcherFrontierSha256,
      factorySha256: ready.plan.factorySha256,
      submitSha256: ready.plan.submitSha256,
      sourceMillionResultSha256: row.sourceSha256,
      sourceMillionResultSegmentSha256: row.sourceSegmentSha256,
      sourceMillionStatus: row.sourceStatus,
      holder: row.sourceResult?.holder || null,
      result,
    }
    checkArtifact(seal(saved), row, ready.plan)
    append(out, saved, stat)
    collected++
  }
  return {
    collected,
    ...verify({ ready, out }),
    eligibleControlCount: ready.eligibleControlCount,
    comparisonStatus: ready.eligibleControlCount
      ? 'exploratory-controls-present'
      : 'uncontrolled-single-treated-probe',
    pendingPrefixes: ready.rows
      .filter((row) => row.status === 'transfer-prefix-incomplete')
      .map((row) => row.vault),
  }
}

async function main() {
  const args = process.argv.slice(2)
  const option = (name) => {
    const i = args.indexOf(name)
    return i < 0 ? undefined : args[i + 1]
  }
  const root = resolve(option('--source-root') || defaultRoot)
  const watch = resolve(option('--watch') || join(root, 'morpho-v2-cap-prospective-watch'))
  const million = resolve(option('--million') || join(root, 'morpho-v2-cap-prospective-baseline'))
  const out = resolve(option('--out') || join(root, 'morpho-v2-cap-100k-pilot'))
  const ready = readiness({ plan: loadPlan({ root, watch }), million })
  if (args.includes('--run')) {
    const maxRows = Number(option('--max-rows') || 1)
    const url = option('--rpc') || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
    console.log(JSON.stringify(await collect({ client: makeClient(url), ready, out, maxRows })))
  } else {
    const checked = verify({ ready, out })
    console.log(
      JSON.stringify({
        dry: true,
        study: STUDY,
        qRaw: Q.toString(),
        baselineBlock: B,
        baselineHash: B_HASH,
        transferPrefixesComplete: ready.transferPrefixesComplete,
        eligibleControlCount: ready.eligibleControlCount,
        comparisonStatus: ready.eligibleControlCount
          ? 'exploratory-controls-present'
          : 'uncontrolled-single-treated-probe',
        readiness: ready.rows.map(
          ({ index, role, vault, status, sourceStatus, sourceSha256, throughBlock }) => ({
            index,
            role,
            vault,
            status,
            sourceStatus,
            sourceSha256,
            throughBlock,
          }),
        ),
        ...checked,
      }),
    )
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  main().catch((error) => {
    // Provider errors can contain keys or URLs; only display our fixed diagnostic categories.
    const known = /^(100k pilot|Wrong chain|Invalid bounded|Frozen|Pinned|Transfer|Baseline)/
    console.error(known.test(error.message) ? error.message : '100k pilot RPC or source failure')
    process.exitCode = 1
  })
