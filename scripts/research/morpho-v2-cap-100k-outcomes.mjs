// One exploratory, uncontrolled fixed-holder outcome sequence. Dry by default.
// No horizon may be queried until a finalized block reaches its frozen target.
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, toHex } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { B, B_HASH, TREATED, USDC, loadPlan } from './morpho-v2-cap-prospective-baseline.mjs'
import { Q, readiness, verify as verifyPilot } from './morpho-v2-cap-100k-pilot.mjs'

export const STUDY = 'morpho-v2-cap-prospective-fixed-exit-100k-outcomes-v1'
export const SOURCE_SHA = '7015611213c40b736aa819c14dfea9c876223c79d2ec16848367be1c8b7f9d6d'
export const HOLDER = '0xcf46bbab1f7bdd392be98ec08e653cb8bb6cc94a'
export const ELIGIBLE_AT = 1_790_585_111
export const HORIZONS = [
  { id: '6h', seconds: 6 * 3600 },
  { id: '24h', seconds: 24 * 3600 },
  { id: '7d', seconds: 7 * 86400 },
]
export const RESERVE_BYTES = 1_000_000_000
const MAX_RPC = 80
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_ARTIFACT_BYTES = 32 * 1024
const HASH = /^0x[\da-f]{64}$/
const DECIMAL = /^(0|[1-9]\d*)$/
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function liquidityAdapter() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function withdraw(uint256,address,address) returns (uint256)',
])
const root = resolve('data/research/venue-signals')
const sourceDir = join(root, 'morpho-v2-cap-100k-pilot')
const defaultOut = join(root, 'morpho-v2-cap-100k-outcomes')
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const unsigned = ({ payloadSha256, ...rest }) => rest
const seal = (value) => ({ ...value, payloadSha256: sha(JSON.stringify(value)) })
const filename = (id) => `${id}-outcome.json`
const quantity = (value) => {
  const n = Number(BigInt(value))
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid RPC quantity')
  return n
}
const isRevert = (error) =>
  [3, -32015].includes(error?.code ?? error?.cause?.code) ||
  /execution reverted|vm execution error/i.test(error?.message || '')

function block(value, expected) {
  const number = quantity(value?.number)
  const timestamp = quantity(value?.timestamp)
  const hash = value?.hash?.toLowerCase()
  const parentHash = value?.parentHash?.toLowerCase()
  if (
    !HASH.test(hash || '') ||
    !HASH.test(parentHash || '') ||
    (expected !== undefined && number !== expected)
  )
    throw new Error('Canonical target block identity mismatch')
  return { number, timestamp, hash, parentHash }
}

function diskGuard(out, stat = statfsSync, extra = 0) {
  const fs = stat(existsSync(dirname(out)) ? dirname(out) : root)
  if (Number(fs.bavail) * Number(fs.bsize) - extra < RESERVE_BYTES)
    throw new Error('Outcome disk reserve reached')
}

// The original source and all four censored controls remain part of readiness.
export function loadFrozen({
  plan = loadPlan(),
  million = join(root, 'morpho-v2-cap-prospective-baseline'),
  pilot = sourceDir,
} = {}) {
  const ready = readiness({ plan, million })
  const checked = verifyPilot({ ready, out: pilot })
  if (
    ready.rows.length !== 5 ||
    ready.eligibleControlCount !== 0 ||
    checked.completed !== 5 ||
    checked.success !== 1 ||
    ready.rows[0].vault !== TREATED ||
    ready.rows.slice(1).some((row) => row.status !== 'source-no-fixed-holder')
  )
    throw new Error('Frozen uncontrolled cohort mismatch')
  const bytes = readFileSync(join(pilot, '00-baseline.json'))
  const source = JSON.parse(bytes)
  if (
    sha(bytes) !== SOURCE_SHA ||
    source.baselineBlock !== B ||
    source.baselineHash !== B_HASH ||
    source.vault !== TREATED ||
    source.holder !== HOLDER ||
    source.qRaw !== Q.toString() ||
    source.result?.status !== 'baseline-success' ||
    source.result.holder !== HOLDER ||
    source.result.asset !== USDC ||
    !HASH.test(source.result.runtimeCodeHash || '') ||
    !/^0x[\da-f]{40}$/.test(source.result.liquidityAdapter || '') ||
    source.result.holderBalance !== source.result.holderShares ||
    !DECIMAL.test(source.result.claimRaw || '') ||
    BigInt(source.result.claimRaw) < Q
  )
    throw new Error('Frozen successful 100k baseline mismatch')
  return { source, sourceSha256: SOURCE_SHA, comparison: 'uncontrolled-single-treated' }
}

export function verify({ out = defaultOut, frozen = loadFrozen() } = {}) {
  const names = existsSync(out) ? readdirSync(out) : []
  if (names.some((name) => !/^(6h|24h|7d)-outcome\.json(?:\.[\da-f-]+\.tmp)?$/.test(name)))
    throw new Error('Unexpected outcome artifact file')
  const results = []
  for (const horizon of HORIZONS) {
    const path = join(out, filename(horizon.id))
    if (!existsSync(path)) continue
    const bytes = readFileSync(path)
    if (bytes.length > MAX_ARTIFACT_BYTES) throw new Error('Outcome artifact size cap exceeded')
    const saved = JSON.parse(bytes)
    const targetTime = ELIGIBLE_AT + horizon.seconds
    if (
      saved.study !== STUDY ||
      saved.schemaVersion !== 1 ||
      saved.chainId !== 1 ||
      saved.horizon !== horizon.id ||
      saved.targetTime !== targetTime ||
      saved.eligibilityTime !== ELIGIBLE_AT ||
      saved.sourceSha256 !== frozen.sourceSha256 ||
      saved.sourcePayloadSha256 !== frozen.source.payloadSha256 ||
      saved.vault !== TREATED ||
      saved.holder !== HOLDER ||
      saved.qRaw !== Q.toString() ||
      saved.baselineBlock !== B ||
      saved.baselineHash !== B_HASH ||
      saved.comparison !== 'uncontrolled-single-treated' ||
      !Number.isSafeInteger(saved.finalizedHead?.number) ||
      !Number.isSafeInteger(saved.finalizedHead?.timestamp) ||
      saved.finalizedHead.timestamp < 0 ||
      !HASH.test(saved.finalizedHead?.hash || '') ||
      saved.finalizedHead.timestamp < targetTime ||
      !Number.isSafeInteger(saved.targetBlock?.number) ||
      !Number.isSafeInteger(saved.targetBlock?.timestamp) ||
      saved.targetBlock.timestamp < 0 ||
      saved.targetBlock.number > saved.finalizedHead.number ||
      saved.targetBlock.timestamp < targetTime ||
      !HASH.test(saved.targetBlock.hash || '') ||
      !HASH.test(saved.targetBlock.parentHash || '') ||
      saved.targetBlock.number <= B ||
      (saved.previousBlock &&
        (saved.previousBlock.number !== saved.targetBlock.number - 1 ||
          !Number.isSafeInteger(saved.previousBlock.timestamp) ||
          saved.previousBlock.timestamp < 0 ||
          !HASH.test(saved.previousBlock.hash || '') ||
          !HASH.test(saved.previousBlock.parentHash || '') ||
          saved.previousBlock.timestamp >= targetTime ||
          saved.previousBlock.hash !== saved.targetBlock.parentHash)) ||
      (!saved.previousBlock && saved.targetBlock.number !== B + 1) ||
      !Number.isFinite(Date.parse(saved.firstAcquiredAt || '')) ||
      !STATUSES.has(saved.result?.status) ||
      saved.payloadSha256 !== sha(JSON.stringify(unsigned(saved)))
    )
      throw new Error('Outcome source, block selection, or seal mismatch')
    if (
      saved.result.holder !== HOLDER ||
      saved.result.qRaw !== Q.toString() ||
      saved.result.targetHash !== saved.targetBlock.hash
    )
      throw new Error('Outcome holder or target identity mismatch')
    const result = saved.result
    const source = frozen.source.result
    const matchingRuntime = result.runtimeCodeHash === source.runtimeCodeHash
    const matchingAsset = result.asset === USDC
    const matchingAdapter = result.adapter === source.liquidityAdapter
    const matchingHolderCode = result.holderCode === '0x'
    const validClaim = DECIMAL.test(result.claimRaw || '')
    const validShares = DECIMAL.test(result.holderShares || '')
    const completePrestate =
      matchingRuntime &&
      matchingAsset &&
      matchingAdapter &&
      matchingHolderCode &&
      validShares &&
      validClaim
    const statusEvidence = {
      'vault-code-missing': result.runtimeCodeHash === undefined,
      'vault-code-drift': HASH.test(result.runtimeCodeHash || '') && !matchingRuntime,
      'asset-identity-drift':
        matchingRuntime && /^0x[\da-f]{40}$/.test(result.asset || '') && !matchingAsset,
      'adapter-identity-drift':
        matchingRuntime &&
        matchingAsset &&
        /^0x[\da-f]{40}$/.test(result.adapter || '') &&
        !matchingAdapter,
      'holder-code-drift':
        matchingRuntime &&
        matchingAsset &&
        matchingAdapter &&
        /^0x(?:[\da-f]{2})+$/.test(result.holderCode || ''),
      'holder-claim-below-q':
        completePrestate &&
        BigInt(result.claimRaw || '0') < Q &&
        result.withdrawShares === undefined,
      'withdraw-revert':
        completePrestate &&
        BigInt(result.claimRaw || '0') >= Q &&
        result.withdrawShares === undefined,
      'withdraw-rpc-ambiguous':
        completePrestate &&
        BigInt(result.claimRaw || '0') >= Q &&
        result.withdrawShares === undefined,
      'historical-state-rpc-ambiguous': true,
      success:
        completePrestate &&
        BigInt(result.claimRaw || '0') >= Q &&
        DECIMAL.test(result.withdrawShares || ''),
    }
    if (!statusEvidence[result.status]) throw new Error('Outcome status evidence mismatch')
    results.push({ horizon: horizon.id, status: saved.result.status, physicalSha256: sha(bytes) })
  }
  return { completed: results.length, results }
}

const STATUSES = new Set([
  'vault-code-missing',
  'vault-code-drift',
  'asset-identity-drift',
  'adapter-identity-drift',
  'holder-code-drift',
  'holder-claim-below-q',
  'withdraw-revert',
  'withdraw-rpc-ambiguous',
  'historical-state-rpc-ambiguous',
  'success',
])

// Strict lower-bound selection in the finalized chain, not "latest" or nearest block.
export async function selectTarget({ targetTime, BNumber = B, finalized, getBlock }) {
  if (finalized.timestamp < targetTime || finalized.number <= BNumber)
    throw new Error('Outcome horizon not due at finalized head')
  let low = BNumber + 1,
    high = finalized.number
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = await getBlock(middle)
    if (candidate.timestamp >= targetTime) high = middle
    else low = middle + 1
  }
  const selected = await getBlock(low)
  const previous = await getBlock(low - 1)
  if (
    selected.timestamp < targetTime ||
    previous.timestamp >= targetTime ||
    selected.parentHash !== previous.hash ||
    (selected.number === finalized.number && selected.hash !== finalized.hash)
  )
    throw new Error('Canonical earliest target selection mismatch')
  return { selected, previous }
}

export async function probe({ frozen, targetBlock, request }) {
  const source = frozen.source.result
  const param = { blockHash: targetBlock.hash, requireCanonical: true }
  const result = {
    holder: HOLDER,
    qRaw: Q.toString(),
    targetHash: targetBlock.hash,
    status: 'historical-state-rpc-ambiguous',
  }
  const call = async (name, args = [], from = TREATED) =>
    decodeFunctionResult({
      abi: ABI,
      functionName: name,
      data: await request('eth_call', [
        {
          from,
          to: TREATED,
          data: encodeFunctionData({ abi: ABI, functionName: name, args }),
          gas: toHex(30_000_000),
        },
        param,
      ]),
    })
  try {
    const code = await request('eth_getCode', [TREATED, param])
    if (!/^0x(?:[\da-f]{2})*$/i.test(code || ''))
      return { ...result, status: 'historical-state-rpc-ambiguous' }
    if (code === '0x') return { ...result, status: 'vault-code-missing' }
    result.runtimeCodeHash = keccak256(code)
    if (result.runtimeCodeHash !== source.runtimeCodeHash)
      return { ...result, status: 'vault-code-drift' }
    result.asset = (await call('asset')).toLowerCase()
    if (result.asset !== USDC) return { ...result, status: 'asset-identity-drift' }
    result.adapter = (await call('liquidityAdapter')).toLowerCase()
    if (result.adapter !== source.liquidityAdapter)
      return { ...result, status: 'adapter-identity-drift' }
    result.holderCode = await request('eth_getCode', [HOLDER, param])
    if (!/^0x(?:[\da-f]{2})*$/i.test(result.holderCode || ''))
      return { ...result, status: 'historical-state-rpc-ambiguous' }
    if (result.holderCode !== '0x') return { ...result, status: 'holder-code-drift' }
    result.holderShares = (await call('balanceOf', [HOLDER])).toString()
    result.claimRaw = (await call('previewRedeem', [BigInt(result.holderShares)])).toString()
    if (BigInt(result.claimRaw) < Q) return { ...result, status: 'holder-claim-below-q' }
    try {
      result.withdrawShares = (await call('withdraw', [Q, HOLDER, HOLDER], HOLDER)).toString()
      result.status = 'success'
    } catch (error) {
      if (/disk reserve|RPC cap|response size cap/i.test(error.message)) throw error
      result.status = isRevert(error) ? 'withdraw-revert' : 'withdraw-rpc-ambiguous'
    }
    return result
  } catch (error) {
    if (/disk reserve|RPC cap|response size cap/i.test(error.message)) throw error
    return { ...result, status: 'historical-state-rpc-ambiguous' }
  }
}

function append(out, artifact, stat) {
  const bytes = JSON.stringify(seal(artifact))
  if (Buffer.byteLength(bytes) > MAX_ARTIFACT_BYTES)
    throw new Error('Outcome artifact size cap reached')
  mkdirSync(out, { recursive: true })
  diskGuard(out, stat, Buffer.byteLength(bytes))
  const target = join(out, filename(artifact.horizon))
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
  frozen = loadFrozen(),
  out = defaultOut,
  stat = statfsSync,
  now = () => new Date().toISOString(),
  maxHorizons = 1,
} = {}) {
  if (!client || !Number.isSafeInteger(maxHorizons) || maxHorizons < 1 || maxHorizons > 3)
    throw new Error('Invalid bounded outcome request')
  const done = new Set(verify({ frozen, out }).results.map((item) => item.horizon))
  let collected = 0
  for (const horizon of HORIZONS) {
    if (collected >= maxHorizons || done.has(horizon.id)) continue
    let calls = 0
    const request = async (method, params) => {
      diskGuard(out, stat)
      if (++calls > MAX_RPC) throw new Error('Outcome RPC cap reached')
      const value = await client.request({ method, params })
      if (Buffer.byteLength(JSON.stringify(value)) > MAX_RESPONSE_BYTES)
        throw new Error('Outcome response size cap reached')
      return value
    }
    if (quantity(await request('eth_chainId', [])) !== 1) throw new Error('Wrong chain ID')
    const finalized = block(await request('eth_getBlockByNumber', ['finalized', false]))
    const targetTime = ELIGIBLE_AT + horizon.seconds
    if (finalized.timestamp < targetTime) break
    const getBlock = async (number) =>
      block(await request('eth_getBlockByNumber', [toHex(number), false]), number)
    if ((await getBlock(B)).hash !== B_HASH) throw new Error('Canonical B changed')
    const { selected, previous } = await selectTarget({ targetTime, finalized, getBlock })
    const firstAcquiredAt = now()
    if (!Number.isFinite(Date.parse(firstAcquiredAt)))
      throw new Error('Invalid local acquisition time')
    const result = await probe({ frozen, targetBlock: selected, request })
    const afterFinalized = block(await request('eth_getBlockByNumber', ['finalized', false]))
    if (
      afterFinalized.number < selected.number ||
      (await getBlock(finalized.number)).hash !== finalized.hash ||
      (await getBlock(selected.number)).hash !== selected.hash ||
      (await getBlock(previous.number)).hash !== previous.hash ||
      (await getBlock(B)).hash !== B_HASH ||
      (afterFinalized.number === selected.number && afterFinalized.hash !== selected.hash)
    )
      throw new Error('Canonical target changed during outcome probe')
    const artifact = {
      study: STUDY,
      schemaVersion: 1,
      chainId: 1,
      horizon: horizon.id,
      eligibilityTime: ELIGIBLE_AT,
      targetTime,
      firstAcquiredAt,
      sourceSha256: frozen.sourceSha256,
      sourcePayloadSha256: frozen.source.payloadSha256,
      baselineBlock: B,
      baselineHash: B_HASH,
      vault: TREATED,
      holder: HOLDER,
      qRaw: Q.toString(),
      comparison: frozen.comparison,
      finalizedHead: finalized,
      targetBlock: selected,
      previousBlock: previous,
      result,
    }
    append(out, artifact, stat)
    collected++
  }
  return { collected, ...verify({ frozen, out }) }
}

async function main() {
  const args = process.argv.slice(2)
  const option = (name) => {
    const i = args.indexOf(name)
    return i < 0 ? undefined : args[i + 1]
  }
  const sourceRoot = resolve(option('--source-root') || root)
  const plan = loadPlan({
    root: sourceRoot,
    watch: resolve(option('--watch') || join(sourceRoot, 'morpho-v2-cap-prospective-watch')),
  })
  const frozen = loadFrozen({
    plan,
    million: resolve(option('--million') || join(sourceRoot, 'morpho-v2-cap-prospective-baseline')),
    pilot: resolve(option('--pilot') || join(sourceRoot, 'morpho-v2-cap-100k-pilot')),
  })
  const out = resolve(option('--out') || join(sourceRoot, 'morpho-v2-cap-100k-outcomes'))
  if (args.includes('--run')) {
    const url = option('--rpc') || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
    console.log(
      JSON.stringify(
        await collect({
          client: makeClient(url),
          frozen,
          out,
          maxHorizons: Number(option('--max-horizons') || 1),
        }),
      ),
    )
  } else
    console.log(
      JSON.stringify({
        dry: !args.includes('--verify'),
        verified: true,
        study: STUDY,
        holder: HOLDER,
        qRaw: Q.toString(),
        eligibilityTime: ELIGIBLE_AT,
        horizons: HORIZONS.map((h) => ({
          id: h.id,
          targetTime: ELIGIBLE_AT + h.seconds,
        })),
        comparison: frozen.comparison,
        ...verify({ frozen, out }),
      }),
    )
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  main().catch((error) => {
    const known = /^(Frozen|Outcome|Canonical|Wrong chain|Invalid bounded|Unexpected)/
    console.error(known.test(error.message) ? error.message : 'Outcome RPC or source failure')
    process.exitCode = 1
  })
