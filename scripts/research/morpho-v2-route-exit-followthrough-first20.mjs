// Post-block B fixed-q follow-through for the five successful rows of the frozen
// B-1 route pilot. Never reads a block after B or changes the 20-vault denominator.
// node scripts/research/morpho-v2-route-exit-followthrough-first20.mjs
// node scripts/research/morpho-v2-route-exit-followthrough-first20.mjs --verify true
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, toHex } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const STUDY = 'morpho-v2-route-exit-followthrough-first20-v1'
export const BASELINE_SHA = '2f6129caafe1a28753a94d9ad0faea24724284b44f383abee3701931ac05600c'
export const HEADERS_SHA = '66595ce99bb86c86ddf38c8063c8f178bfbc4497043d61dab68762ab14deb4f6'
export const RESERVE_BYTES = 2_500_000_000
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const HASH = /^0x[\da-f]{64}$/i
const ADDRESS = /^0x[\da-f]{40}$/i
const SELECTOR = /^0x[\da-f]{8}$/i
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function liquidityAdapter() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function withdraw(uint256,address,address) returns (uint256)',
])
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const unseal = ({ checkpointSha256, ...rest }) => rest
export const seal = (value) => ({ ...unseal(value), checkpointSha256: sha(JSON.stringify(unseal(value))) })

function pinned(path, expected, name) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== expected) throw new Error(`${name} SHA mismatch`)
  return JSON.parse(bytes)
}
function writeBounded(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const bytes = JSON.stringify(value)
  const size = Buffer.byteLength(bytes)
  if (size > MAX_OUTPUT_BYTES) throw new Error('Checkpoint size cap reached')
  const disk = statfsSync(dirname(path))
  if (Number(disk.bavail) * Number(disk.bsize) - size < RESERVE_BYTES)
    throw new Error('Checkpoint disk reserve reached')
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, bytes, { mode: 0o600 })
  renameSync(temp, path)
}
function int(value) {
  const n = Number(BigInt(value))
  if (!Number.isSafeInteger(n)) throw new Error('Unsafe RPC integer')
  return n
}
export function selectEligible(baseline, headers) {
  if (baseline?.study !== 'morpho-v2-route-exit-baseline-first20-v1' ||
      baseline.chainId !== 1 || baseline.status !== 'complete' ||
      baseline.headersSha256 !== HEADERS_SHA || baseline.frozenDenominator !== 20 ||
      !Array.isArray(baseline.anchors) || baseline.anchors.length !== 20 ||
      !Array.isArray(baseline.results) || baseline.results.length !== 20 ||
      headers?.study !== 'morpho-v2-route-address-headers-v1' ||
      headers.chainId !== 1 || headers.status !== 'complete' ||
      !Array.isArray(headers.headers) || !Array.isArray(headers.changes))
    throw new Error('Incomplete frozen input')
  const headerByBlock = new Map(headers.headers.map((h) => [h.block, h]))
  const eligible = []
  for (let i = 0; i < 20; i++) {
    const row = baseline.results[i], anchor = baseline.anchors[i]
    if (row.vault !== anchor.vault || row.block !== anchor.block ||
        row.txHash !== anchor.txHash || row.preBlock !== anchor.block - 1 ||
        !HASH.test(anchor.blockHash) || !ADDRESS.test(anchor.toAdapter) ||
        !ADDRESS.test(row.asset || '') || !HASH.test(row.runtimeCodeHash || ''))
      throw new Error('Frozen baseline/anchor mismatch')
    const header = headerByBlock.get(anchor.block)
    if (!header || header.hash?.toLowerCase() !== anchor.blockHash.toLowerCase() ||
        !headers.changes.some((x) => x.vault === anchor.vault && x.block === anchor.block &&
          x.txHash === anchor.txHash && x.logIndex === anchor.logIndex))
      throw new Error('Route header/event mismatch')
    if (row.status === 'baseline-success') {
      if (!ADDRESS.test(row.holder || '') || !/^\d+$/.test(row.qAssets || '') ||
          BigInt(row.qAssets) <= 0n || !/^\d+$/.test(row.holderShares || ''))
        throw new Error('Invalid baseline-success row')
      eligible.push({ index: i, vault: row.vault, block: anchor.block,
        blockHash: anchor.blockHash.toLowerCase(), txHash: anchor.txHash,
        expectedAdapter: anchor.toAdapter.toLowerCase(), holder: row.holder,
        qAssets: row.qAssets, asset: row.asset, runtimeCodeHash: row.runtimeCodeHash })
    }
  }
  if (eligible.length !== 5) throw new Error('Frozen eligible count changed')
  return eligible
}

export function safeSelector(error) {
  // Only inspect provider data fields, never stringify errors or URLs.
  for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth++) {
    const data = current.data
    if (typeof data === 'string' && /^0x[\da-f]{8,}$/i.test(data))
      return data.slice(0, 10).toLowerCase()
    if (typeof data?.data === 'string' && /^0x[\da-f]{8,}$/i.test(data.data))
      return data.data.slice(0, 10).toLowerCase()
  }
  return null
}
export function classifyCallError(error) {
  const names = []
  for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth++)
    names.push(String(current.name || ''))
  const selector = safeSelector(error)
  // A selector from returned revert data is deterministic. Otherwise only
  // an explicit EVM-revert type/message qualifies; transport errors stay RPC.
  const message = String(error?.shortMessage || error?.message || '')
  const reverted = selector !== null || names.some((x) => /revert/i.test(x)) ||
    /execution reverted|VM Exception while processing transaction: revert/i.test(message)
  return { status: reverted ? 'b-evm-revert' : 'b-rpc-error', errorSelector: selector }
}
export async function probeAtB(client, eligible) {
  const at = BigInt(eligible.block)
  const result = { index: eligible.index, vault: eligible.vault, block: eligible.block,
    blockHash: eligible.blockHash, holder: eligible.holder, qAssets: eligible.qAssets }
  try {
    const header = await client.getBlock({ blockNumber: at })
    result.observedBlockHash = header.hash?.toLowerCase() || null
    if (int(header.number) !== eligible.block || result.observedBlockHash !== eligible.blockHash)
      return { ...result, status: 'b-ambiguous-header' }
    const code = await client.getCode({ address: eligible.vault, blockNumber: at })
    result.runtimeCodeHash = code && code !== '0x' ? keccak256(code) : null
    if (result.runtimeCodeHash !== eligible.runtimeCodeHash)
      return { ...result, status: 'b-ambiguous-code' }
    const read = (functionName, args = []) => client.readContract({
      address: eligible.vault, abi: ABI, functionName, args, blockNumber: at,
    })
    result.asset = (await read('asset')).toLowerCase()
    result.adapter = (await read('liquidityAdapter')).toLowerCase()
    if (result.asset !== eligible.asset) return { ...result, status: 'b-ambiguous-asset' }
    if (result.adapter !== eligible.expectedAdapter)
      return { ...result, status: 'b-ambiguous-route' }
    const shares = await read('balanceOf', [eligible.holder])
    result.holderShares = shares.toString()
    if (shares === 0n) return { ...result, status: 'b-holder-attrition' }
    const claim = await read('previewRedeem', [shares])
    result.previewRedeemableAssets = claim.toString()
    if (claim < BigInt(eligible.qAssets))
      return { ...result, status: 'b-holder-attrition' }
    const data = encodeFunctionData({ abi: ABI, functionName: 'withdraw',
      args: [BigInt(eligible.qAssets), eligible.holder, eligible.holder] })
    try {
      const output = await client.request({ method: 'eth_call', params: [
        { from: eligible.holder, to: eligible.vault, data, gas: toHex(20_000_000) }, toHex(at),
      ] })
      result.withdrawShares = decodeFunctionResult({ abi: ABI,
        functionName: 'withdraw', data: output }).toString()
      return { ...result, status: 'b-success' }
    } catch (error) {
      return { ...result, ...classifyCallError(error) }
    }
  } catch {
    return { ...result, status: 'b-read-error' }
  }
}
function expectedOutput(eligible) {
  return { study: STUDY, chainId: 1, baselineSha256: BASELINE_SHA,
    headersSha256: HEADERS_SHA, frozenDenominator: 20,
    baselineSuccessDenominator: 5, eligible }
}
export function validateOutput(saved, eligible) {
  for (const [key, value] of Object.entries(expectedOutput(eligible)))
    if (JSON.stringify(saved?.[key]) !== JSON.stringify(value))
      throw new Error('Output metadata/selection mismatch')
  if (!Array.isArray(saved.results) || saved.results.length > eligible.length ||
      saved.status !== (saved.results.length === eligible.length ? 'complete' : 'partial') ||
      !/^[\da-f]{64}$/.test(saved.checkpointSha256 || '') ||
      sha(JSON.stringify(unseal(saved))) !== saved.checkpointSha256)
    throw new Error('Output checkpoint integrity mismatch')
  const statuses = new Set(['b-success', 'b-evm-revert', 'b-rpc-error', 'b-read-error',
    'b-holder-attrition', 'b-ambiguous-header', 'b-ambiguous-code',
    'b-ambiguous-asset', 'b-ambiguous-route'])
  for (let i = 0; i < saved.results.length; i++) {
    const row = saved.results[i], source = eligible[i]
    if (row.index !== source.index || row.vault !== source.vault ||
        row.block !== source.block || row.blockHash !== source.blockHash ||
        row.holder !== source.holder || row.qAssets !== source.qAssets ||
        !statuses.has(row.status) ||
        (row.errorSelector !== undefined && row.errorSelector !== null && !SELECTOR.test(row.errorSelector)))
      throw new Error('Completed result/selection mismatch')
  }
  return saved
}
export async function run({ client, baselinePath, headersPath, out, onProgress = () => {} }) {
  const baseline = pinned(baselinePath, BASELINE_SHA, 'Baseline')
  const headers = pinned(headersPath, HEADERS_SHA, 'Route headers')
  const eligible = selectEligible(baseline, headers)
  let saved = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) :
    seal({ ...expectedOutput(eligible), status: 'partial', results: [] })
  validateOutput(saved, eligible)
  if (!existsSync(out)) writeBounded(out, saved)
  if (saved.status === 'complete') return saved
  if ((await client.getChainId()) !== 1) throw new Error('Wrong chain ID')
  for (let i = saved.results.length; i < eligible.length; i++) {
    const result = await probeAtB(client, eligible[i])
    saved = seal({ ...unseal(saved), results: [...saved.results, result],
      status: i + 1 === eligible.length ? 'complete' : 'partial' })
    validateOutput(saved, eligible)
    writeBounded(out, saved)
    onProgress({ completed: saved.results.length, baselineSuccessDenominator: 5,
      frozenDenominator: 20, vault: result.vault, result: result.status })
  }
  return saved
}

function options(args) {
  const parsed = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || args[i + 1] === undefined)
      throw new Error('Expected --key value arguments')
    parsed[args[i].slice(2)] = args[i + 1]
  }
  return parsed
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = options(process.argv.slice(2))
  const baselinePath = resolve(opts.baseline ||
    'data/research/venue-signals/morpho-v2-route-exit-baseline-first20.json')
  const headersPath = resolve(opts.headers ||
    'data/research/venue-signals/morpho-v2-route-address-headers.json')
  const out = resolve(opts.out ||
    'data/research/venue-signals/morpho-v2-route-exit-followthrough-first20.json')
  try {
    const baseline = pinned(baselinePath, BASELINE_SHA, 'Baseline')
    const headers = pinned(headersPath, HEADERS_SHA, 'Route headers')
    const eligible = selectEligible(baseline, headers)
    const saved = opts.verify === 'true'
      ? validateOutput(JSON.parse(readFileSync(out, 'utf8')), eligible)
      : await run({ client: makeClient(opts.rpc || process.env.RECORDER_RPC_URL ||
          readEnv().get('RECORDER_RPC_URL')), baselinePath, headersPath, out,
        onProgress: (x) => process.stdout.write(JSON.stringify(x) + '\n') })
    process.stdout.write(JSON.stringify({ path: out, status: saved.status,
      completed: saved.results.length, frozenDenominator: 20,
      baselineSuccessDenominator: 5, sha256: sha(readFileSync(out)) }) + '\n')
  } catch (error) {
    // Do not print provider exceptions: they can include credential-bearing URLs.
    process.stderr.write(`Route B follow-through stopped; checkpoint remains at ${out}. ` +
      (error.message === 'Wrong chain ID' ? 'Wrong chain ID.' : 'Validation/RPC/resource guard failed.') + '\n')
    process.exitCode = 1
  }
}
