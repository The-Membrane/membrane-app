// Read-only drilldown of the one first-20 +24h fixed-withdrawal revert.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeFunctionData, keccak256, parseAbi, toHex } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const STUDY = 'morpho-v2-first20-revert-drilldown-v1'
export const PILOT_SHA = '7fb48d74c07eb49d06ac133fd147dcef5d80885a19815cea4c58035a2aa9b6a4'
export const BOUNDARY_SHA = 'ef634f845f4dc207b9d378bec2a6d1c75695f3ddc59e803978c39dc316b15223'
const VAULT_ABI = parseAbi([
  'function asset() view returns (address)',
  'function liquidityAdapter() view returns (address)',
  'function liquidityData() view returns (bytes)',
  'function withdraw(uint256 assets,address receiver,address onBehalf) returns (uint256)',
])
const TOKEN_ABI = parseAbi(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'])
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const ERROR_SELECTOR = '0xe450d38c'
const ERROR_SENDER = '0xf55d73af1dcec32fbee3775ad5baafd476f1674b'

function pinned(path, expected) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== expected) throw new Error('Pinned incident source SHA mismatch')
  return JSON.parse(bytes)
}
function atomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
  renameSync(temp, path)
}
function incident(pilotPath, boundaryPath) {
  const pilot = pinned(pilotPath, PILOT_SHA)
  const proof = pinned(boundaryPath, BOUNDARY_SHA)
  const row = pilot.results?.[15]
  if (pilot.status !== 'complete' || proof.status !== 'complete' ||
      row?.verdict !== 'plus24h-revert' ||
      row.probes?.plus24h?.errorChain?.[0]?.data?.slice(0, 10) !== ERROR_SELECTOR)
    throw new Error('Frozen revert incident mismatch')
  return row
}

export function summarizeTrace(root) {
  const failures = []
  let nodes = 0
  function visit(call, path) {
    nodes++
    const item = {
      type: call.type || null, from: call.from?.toLowerCase() || null,
      to: call.to?.toLowerCase() || null, selector: call.input?.slice(0, 10) || null,
      error: call.error || null, outputSelector: call.output?.slice(0, 10) || null,
    }
    const next = [...path, item]
    if ((item.error || item.outputSelector === ERROR_SELECTOR) && failures.length < 40)
      failures.push(next)
    for (const child of call.calls || []) visit(child, next)
  }
  visit(root, [])
  return { nodes, failures }
}

export function verifyOffline({ out, pilotPath, boundaryPath }) {
  const row = incident(pilotPath, boundaryPath)
  const bytes = readFileSync(out)
  const saved = JSON.parse(bytes)
  if (saved.study !== STUDY || saved.status !== 'complete' || saved.pilotSha256 !== PILOT_SHA ||
      saved.boundarySha256 !== BOUNDARY_SHA || saved.vault !== row.anchor.vault ||
      saved.qAssets !== row.anchor.qAssets || saved.holder !== row.anchor.holder ||
      saved.samples?.length !== 3 || !['ok', 'unavailable'].includes(saved.trace?.status))
    throw new Error('Revert drilldown checkpoint mismatch')
  const keys = ['preExecutable', 'plus24h', 'plus7d']
  for (let i = 0; i < 3; i++) {
    const probe = row.probes[keys[i]]
    if (saved.samples[i].horizon !== keys[i] || saved.samples[i].block !== probe.block || saved.samples[i].blockHash !== probe.hash)
      throw new Error('Revert drilldown block mismatch')
  }
  return { checkpointSha256: sha(bytes), vault: saved.vault, samples: saved.samples, trace: saved.trace }
}

export async function run({ client, out, pilotPath, boundaryPath }) {
  if (existsSync(out)) return verifyOffline({ out, pilotPath, boundaryPath })
  const row = incident(pilotPath, boundaryPath)
  if ((await client.getChainId()) !== 1) throw new Error('Wrong chain ID')
  const samples = []
  for (const key of ['preExecutable', 'plus24h', 'plus7d']) {
    const probe = row.probes[key]
    const blockNumber = BigInt(probe.block)
    const header = await client.getBlock({ blockNumber })
    if (header.hash.toLowerCase() !== probe.hash.toLowerCase()) throw new Error('Historical block mismatch')
    const asset = await client.readContract({ address: row.anchor.vault, abi: VAULT_ABI, functionName: 'asset', blockNumber })
    const adapter = await client.readContract({ address: row.anchor.vault, abi: VAULT_ABI, functionName: 'liquidityAdapter', blockNumber })
    const liquidityData = await client.readContract({ address: row.anchor.vault, abi: VAULT_ABI, functionName: 'liquidityData', blockNumber })
    const [assetDecimals, vaultIdle, senderAssetBalance, adapterCode] = await Promise.all([
      client.readContract({ address: asset, abi: TOKEN_ABI, functionName: 'decimals', blockNumber }),
      client.readContract({ address: asset, abi: TOKEN_ABI, functionName: 'balanceOf', args: [row.anchor.vault], blockNumber }),
      client.readContract({ address: asset, abi: TOKEN_ABI, functionName: 'balanceOf', args: [ERROR_SENDER], blockNumber }),
      client.getCode({ address: adapter, blockNumber }),
    ])
    samples.push({
      horizon: key, block: probe.block, blockHash: probe.hash,
      asset: asset.toLowerCase(), assetDecimals: Number(assetDecimals),
      liquidityAdapter: adapter.toLowerCase(), liquidityDataSha256: sha(Buffer.from(liquidityData)),
      vaultIdleAssets: vaultIdle.toString(), senderAssetBalance: senderAssetBalance.toString(),
      adapterCodeHash: adapterCode && adapterCode !== '0x' ? keccak256(adapterCode) : null,
    })
  }
  let trace = { status: 'unavailable' }
  try {
    const data = encodeFunctionData({ abi: VAULT_ABI, functionName: 'withdraw',
      args: [BigInt(row.anchor.qAssets), row.anchor.holder, row.anchor.holder] })
    const raw = await client.request({ method: 'debug_traceCall', params: [
      { from: row.anchor.holder, to: row.anchor.vault, data, gas: toHex(20_000_000) },
      toHex(row.probes.plus24h.block), { tracer: 'callTracer', timeout: '10s' },
    ] })
    trace = { status: 'ok', ...summarizeTrace(raw) }
  } catch {
    // A debug namespace may be disabled by the provider; never store its URL-bearing error.
  }
  atomic(out, { study: STUDY, status: 'complete', pilotSha256: PILOT_SHA,
    boundarySha256: BOUNDARY_SHA, vault: row.anchor.vault, holder: row.anchor.holder,
    qAssets: row.anchor.qAssets, revertSelector: ERROR_SELECTOR, errorSender: ERROR_SENDER,
    samples, trace })
  return verifyOffline({ out, pilotPath, boundaryPath })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length && args.join(' ') !== '--verify offline') throw new Error('Only --verify offline is supported')
  const paths = {
    out: resolve('data/research/venue-signals/morpho-v2-first20-revert-drilldown.json'),
    pilotPath: resolve('data/research/venue-signals/morpho-v2-treated-exit-first20.json'),
    boundaryPath: resolve('data/research/venue-signals/morpho-v2-first20-boundary-proof.json'),
  }
  try {
    const result = args.length ? verifyOffline(paths) : await run({ ...paths, client: makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')) })
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch {
    process.stderr.write('Revert drilldown stopped; no result was published.\n')
    process.exitCode = 1
  }
}
