// Bounded, read-only historical drilldown of the two frozen B-block Panic reverts.
// This diagnoses the simulated default withdraw path, not venue-wide exit ability.
// node scripts/research/morpho-v2-route-exit-panic-drilldown.mjs
// node scripts/research/morpho-v2-route-exit-panic-drilldown.mjs --verify offline
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeFunctionData, keccak256, parseAbi, toHex } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const STUDY = 'morpho-v2-route-exit-panic-drilldown-v1'
export const BASELINE_SHA = '2f6129caafe1a28753a94d9ad0faea24724284b44f383abee3701931ac05600c'
export const FOLLOWTHROUGH_SHA = '431e3272d96edb351d13126bb6f152e7a6c8dbd8bedab3792d50e1be9c703dc2'
export const PANIC_SELECTOR = '0x4e487b71'
const RESERVE_BYTES = 2_500_000_000
const MAX_OUTPUT_BYTES = 256 * 1024
const HASH = /^0x[\da-f]{64}$/i
const ADDRESS = /^0x[\da-f]{40}$/i
const PANIC_OUTPUT = /^0x4e487b71[\da-f]{64}$/i
const VAULT_ABI = parseAbi([
  'function asset() view returns (address)',
  'function liquidityAdapter() view returns (address)',
  'function liquidityData() view returns (bytes)',
  'function withdraw(uint256 assets,address receiver,address onBehalf) returns (uint256)',
])
const TOKEN_ABI = parseAbi(['function balanceOf(address) view returns (uint256)'])
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const unseal = ({ checkpointSha256, ...rest }) => rest
const seal = (value) => ({ ...unseal(value), checkpointSha256: sha(JSON.stringify(unseal(value))) })

function pinned(path, expected, label) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== expected) throw new Error(`${label} SHA mismatch`)
  return JSON.parse(bytes)
}
function atomicBounded(path, value) {
  const bytes = JSON.stringify(value)
  if (Buffer.byteLength(bytes) > MAX_OUTPUT_BYTES) throw new Error('Output size cap reached')
  mkdirSync(dirname(path), { recursive: true })
  const disk = statfsSync(dirname(path))
  if (Number(disk.bavail) * Number(disk.bsize) - Buffer.byteLength(bytes) < RESERVE_BYTES)
    throw new Error('Disk reserve reached')
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, bytes, { mode: 0o600 })
  renameSync(temp, path)
}

export function selectIncidents(baseline, followthrough) {
  if (baseline?.study !== 'morpho-v2-route-exit-baseline-first20-v1' ||
      followthrough?.study !== 'morpho-v2-route-exit-followthrough-first20-v1' ||
      baseline.chainId !== 1 || followthrough.chainId !== 1 ||
      baseline.status !== 'complete' || followthrough.status !== 'complete' ||
      baseline.frozenDenominator !== 20 || followthrough.frozenDenominator !== 20 ||
      followthrough.baselineSha256 !== BASELINE_SHA ||
      baseline.anchors?.length !== 20 || baseline.results?.length !== 20 ||
      followthrough.results?.length !== 5)
    throw new Error('Frozen cohort mismatch')
  const selected = []
  for (const b of followthrough.results) {
    const before = baseline.results[b.index]
    const anchor = baseline.anchors[b.index]
    if (!before || !anchor || before.status !== 'baseline-success' ||
        b.vault !== anchor.vault || b.block !== anchor.block ||
        b.blockHash?.toLowerCase() !== anchor.blockHash?.toLowerCase() ||
        before.vault !== anchor.vault || before.block !== anchor.block ||
        before.txHash !== anchor.txHash || b.holder !== before.holder ||
        b.qAssets !== before.qAssets)
      throw new Error('Frozen B/B-1 row mismatch')
    if (b.status === 'b-evm-revert' && b.errorSelector === PANIC_SELECTOR) {
      if (!HASH.test(b.blockHash) || !HASH.test(anchor.txHash) ||
          !ADDRESS.test(b.vault) || !ADDRESS.test(b.holder) ||
          !ADDRESS.test(b.asset) || !ADDRESS.test(b.adapter) ||
          !/^\d+$/.test(b.qAssets) || BigInt(b.qAssets) <= 0n ||
          !Number.isSafeInteger(anchor.transactionIndex) ||
          !Number.isSafeInteger(anchor.logIndex))
        throw new Error('Invalid pinned panic row')
      selected.push({ index: b.index, vault: b.vault, block: b.block,
        blockHash: b.blockHash.toLowerCase(), transactionIndex: anchor.transactionIndex,
        txHash: anchor.txHash, logIndex: anchor.logIndex, holder: b.holder,
        qAssets: b.qAssets, asset: b.asset, adapter: b.adapter,
        runtimeCodeHash: b.runtimeCodeHash })
    }
  }
  if (selected.length !== 2 || selected[0].index !== 15 || selected[1].index !== 18)
    throw new Error('Frozen panic pair changed')
  return selected
}

// Keep only the deepest failing call chain. Never serialize raw callTracer trees.
export function summarizeTrace(root) {
  let nodes = 0
  let deepest = []
  let panicOutput = null
  function visit(call, path, depth) {
    if (!call || typeof call !== 'object' || ++nodes > 2000 || depth > 48)
      throw new Error('Trace complexity cap reached')
    const output = typeof call.output === 'string' ? call.output.toLowerCase() : null
    const item = {
      type: String(call.type || '').slice(0, 24) || null,
      from: ADDRESS.test(call.from || '') ? call.from.toLowerCase() : null,
      to: ADDRESS.test(call.to || '') ? call.to.toLowerCase() : null,
      inputSelector: /^0x[\da-f]{8}/i.test(call.input || '') ? call.input.slice(0, 10).toLowerCase() : null,
      error: call.error ? String(call.error).slice(0, 120) : null,
      output: PANIC_OUTPUT.test(output || '') ? output : null,
    }
    const next = [...path, item]
    if (item.error || item.output) {
      if (next.length > deepest.length || (next.length === deepest.length && item.output)) deepest = next
      if (item.output) panicOutput = item.output
    }
    if (!Array.isArray(call.calls)) return
    if (call.calls.length > 2000) throw new Error('Trace fanout cap reached')
    for (const child of call.calls) visit(child, next, depth + 1)
  }
  visit(root, [], 0)
  return { nodes, failurePath: deepest, panicOutput,
    panicCode: panicOutput ? BigInt(`0x${panicOutput.slice(10)}`).toString() : null }
}

export function validateOutput(saved, selected) {
  if (saved?.study !== STUDY || saved.chainId !== 1 || saved.status !== 'complete' ||
      saved.baselineSha256 !== BASELINE_SHA || saved.followthroughSha256 !== FOLLOWTHROUGH_SHA ||
      JSON.stringify(saved.incidents) !== JSON.stringify(selected) ||
      saved.results?.length !== 2 ||
      sha(JSON.stringify(unseal(saved))) !== saved.checkpointSha256)
    throw new Error('Drilldown checkpoint mismatch')
  for (let i = 0; i < 2; i++) {
    const source = selected[i], row = saved.results[i]
    if (row.index !== source.index || row.vault !== source.vault ||
        row.block !== source.block || row.blockHash !== source.blockHash ||
        row.txHash !== source.txHash || row.transactionIndex !== source.transactionIndex ||
        row.logIndex !== source.logIndex || row.asset !== source.asset ||
        row.adapter !== source.adapter || !/^\d+$/.test(row.vaultIdleAssets || '') ||
        !HASH.test(row.adapterCodeHash || '') || !/^[\da-f]{64}$/.test(row.liquidityDataSha256 || '') ||
        !['ok', 'unavailable', 'trace-cap'].includes(row.trace?.status))
      throw new Error('Drilldown row mismatch')
    if (row.trace.status === 'ok' &&
        (row.trace.panicOutput !== null && !PANIC_OUTPUT.test(row.trace.panicOutput) ||
         row.trace.panicCode !== null && row.trace.panicCode !== BigInt(`0x${row.trace.panicOutput.slice(10)}`).toString() ||
         row.trace.failurePath?.length > 49 || row.trace.nodes > 2000))
      throw new Error('Drilldown trace mismatch')
  }
  return saved
}
export function verifyOffline({ baselinePath, followthroughPath, out }) {
  const selected = selectIncidents(pinned(baselinePath, BASELINE_SHA, 'Baseline'),
    pinned(followthroughPath, FOLLOWTHROUGH_SHA, 'Follow-through'))
  return validateOutput(JSON.parse(readFileSync(out, 'utf8')), selected)
}
export async function run({ client, baselinePath, followthroughPath, out }) {
  const selected = selectIncidents(pinned(baselinePath, BASELINE_SHA, 'Baseline'),
    pinned(followthroughPath, FOLLOWTHROUGH_SHA, 'Follow-through'))
  if (existsSync(out)) return validateOutput(JSON.parse(readFileSync(out, 'utf8')), selected)
  if ((await client.getChainId()) !== 1) throw new Error('Wrong chain ID')
  const results = []
  for (const incident of selected) {
    const blockNumber = BigInt(incident.block)
    const header = await client.getBlock({ blockNumber })
    if (header.number !== blockNumber || header.hash?.toLowerCase() !== incident.blockHash)
      throw new Error('Historical B block mismatch')
    const read = (address, abi, functionName, args = []) =>
      client.readContract({ address, abi, functionName, args, blockNumber })
    const [asset, adapter, liquidityData, vaultCode] = await Promise.all([
      read(incident.vault, VAULT_ABI, 'asset'),
      read(incident.vault, VAULT_ABI, 'liquidityAdapter'),
      read(incident.vault, VAULT_ABI, 'liquidityData'),
      client.getCode({ address: incident.vault, blockNumber }),
    ])
    if (asset.toLowerCase() !== incident.asset || adapter.toLowerCase() !== incident.adapter ||
        !vaultCode || keccak256(vaultCode) !== incident.runtimeCodeHash)
      throw new Error('Historical B state mismatch')
    const [vaultIdle, adapterCode] = await Promise.all([
      read(asset, TOKEN_ABI, 'balanceOf', [incident.vault]),
      client.getCode({ address: adapter, blockNumber }),
    ])
    if (!adapterCode || adapterCode === '0x') throw new Error('Historical adapter code missing')
    const result = { index: incident.index, vault: incident.vault, block: incident.block,
      blockHash: incident.blockHash, transactionIndex: incident.transactionIndex,
      txHash: incident.txHash, logIndex: incident.logIndex, holder: incident.holder,
      qAssets: incident.qAssets, asset: incident.asset, adapter: incident.adapter,
      vaultIdleAssets: vaultIdle.toString(), adapterCodeHash: keccak256(adapterCode),
      liquidityDataSha256: sha(Buffer.from(liquidityData.slice(2), 'hex')) }
    try {
      const data = encodeFunctionData({ abi: VAULT_ABI, functionName: 'withdraw',
        args: [BigInt(incident.qAssets), incident.holder, incident.holder] })
      const raw = await client.request({ method: 'debug_traceCall', params: [
        { from: incident.holder, to: incident.vault, data, gas: toHex(20_000_000) },
        toHex(blockNumber), { tracer: 'callTracer', timeout: '10s' },
      ] })
      result.trace = { status: 'ok', ...summarizeTrace(raw) }
    } catch (error) {
      // Provider exceptions can contain credentials; never save them.
      result.trace = { status: error?.message === 'Trace complexity cap reached' ||
        error?.message === 'Trace fanout cap reached' ? 'trace-cap' : 'unavailable' }
    }
    results.push(result)
  }
  const saved = seal({ study: STUDY, chainId: 1, status: 'complete',
    baselineSha256: BASELINE_SHA, followthroughSha256: FOLLOWTHROUGH_SHA,
    incidents: selected, results })
  validateOutput(saved, selected)
  atomicBounded(out, saved)
  return saved
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const paths = {
    baselinePath: resolve('data/research/venue-signals/morpho-v2-route-exit-baseline-first20.json'),
    followthroughPath: resolve('data/research/venue-signals/morpho-v2-route-exit-followthrough-first20.json'),
    out: resolve('data/research/venue-signals/morpho-v2-route-exit-panic-drilldown.json'),
  }
  try {
    if (args.length && args.join(' ') !== '--verify offline') throw new Error('Unsupported arguments')
    const saved = args.length ? verifyOffline(paths) : await run({ ...paths,
      client: makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')) })
    process.stdout.write(JSON.stringify({ status: saved.status, rows: saved.results.length,
      sha256: sha(readFileSync(paths.out)) }) + '\n')
  } catch {
    process.stderr.write('Route panic drilldown stopped; no result was published.\n')
    process.exitCode = 1
  }
}
