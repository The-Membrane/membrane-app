// Test the exact child-vault share-shortage hypothesis for the first-20 revert.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeEventLog, parseAbi, parseAbiItem, toEventSelector, toHex } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const STUDY = 'morpho-v2-first20-child-shares-v1'
export const DRILLDOWN_SHA = 'a6164a425d2ff71c35eba99be224e23b99b3e31e4bb127d89c8ccefc133b1911'
const CHILD = '0xb0f05e4de970a1aaf77f8c2f823953a367504ba9'
const OLD_ADAPTER = '0xf55d73af1dcec32fbee3775ad5baafd476f1674b'
const SHARE_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function previewWithdraw(uint256) view returns (uint256)',
  'function asset() view returns (address)',
  'function decimals() view returns (uint8)',
])
const TRANSFER = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)')
const TOPIC = toEventSelector(TRANSFER)
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const indexed = (address) => `0x${address.slice(2).padStart(64, '0')}`

function source(path) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== DRILLDOWN_SHA) throw new Error('Pinned drilldown SHA mismatch')
  const saved = JSON.parse(bytes)
  if (saved.status !== 'complete' || saved.trace?.status !== 'ok' ||
      saved.samples?.[1]?.liquidityAdapter !== OLD_ADAPTER ||
      !saved.trace.failures.some((path) => path.some((call) => call.to === CHILD)))
    throw new Error('Frozen child trace mismatch')
  return saved
}
function atomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
  renameSync(temp, path)
}

export function verifyOffline({ out, drilldownPath }) {
  const parent = source(drilldownPath)
  const bytes = readFileSync(out)
  const saved = JSON.parse(bytes)
  if (saved.study !== STUDY || saved.status !== 'complete' || saved.drilldownSha256 !== DRILLDOWN_SHA ||
      saved.child !== CHILD || saved.adapter !== OLD_ADAPTER || saved.qAssets !== parent.qAssets ||
      saved.samples?.length !== 3 || !Array.isArray(saved.transfers))
    throw new Error('Child-share checkpoint mismatch')
  for (let i = 0; i < 3; i++) {
    const row = saved.samples[i]
    if (row.block !== parent.samples[i].block || row.blockHash !== parent.samples[i].blockHash ||
        !/^\d+$/.test(row.adapterShares) || !/^\d+$/.test(row.requiredShares) ||
        row.sufficient !== (BigInt(row.adapterShares) >= BigInt(row.requiredShares)))
      throw new Error('Child-share sample mismatch')
  }
  for (const event of saved.transfers)
    if (event.block < parent.samples[0].block || event.block > parent.samples[1].block ||
        event.from !== OLD_ADAPTER && event.to !== OLD_ADAPTER)
      throw new Error('Child-share Transfer range mismatch')
  return { checkpointSha256: sha(bytes), child: CHILD, samples: saved.samples,
    transferCount: saved.transfers.length, transfers: saved.transfers }
}

export async function run({ client, out, drilldownPath }) {
  if (existsSync(out)) return verifyOffline({ out, drilldownPath })
  const parent = source(drilldownPath)
  if ((await client.getChainId()) !== 1) throw new Error('Wrong chain ID')
  const q = BigInt(parent.qAssets)
  const samples = []
  for (const row of parent.samples) {
    const blockNumber = BigInt(row.block)
    const header = await client.getBlock({ blockNumber })
    if (header.hash.toLowerCase() !== row.blockHash.toLowerCase()) throw new Error('Historical block mismatch')
    const [shares, required, asset, decimals] = await Promise.all([
      client.readContract({ address: CHILD, abi: SHARE_ABI, functionName: 'balanceOf', args: [OLD_ADAPTER], blockNumber }),
      client.readContract({ address: CHILD, abi: SHARE_ABI, functionName: 'previewWithdraw', args: [q], blockNumber }),
      client.readContract({ address: CHILD, abi: SHARE_ABI, functionName: 'asset', blockNumber }),
      client.readContract({ address: CHILD, abi: SHARE_ABI, functionName: 'decimals', blockNumber }),
    ])
    samples.push({
      horizon: row.horizon, block: row.block, blockHash: row.blockHash,
      childAsset: asset.toLowerCase(), childShareDecimals: Number(decimals),
      adapterShares: shares.toString(), requiredShares: required.toString(),
      sufficient: shares >= required,
    })
  }
  const start = parent.samples[0].block, end = parent.samples[1].block
  const [outbound, inbound] = await Promise.all([
    client.request({ method: 'eth_getLogs', params: [{ address: CHILD, fromBlock: toHex(start), toBlock: toHex(end), topics: [TOPIC, indexed(OLD_ADAPTER)] }] }),
    client.request({ method: 'eth_getLogs', params: [{ address: CHILD, fromBlock: toHex(start), toBlock: toHex(end), topics: [TOPIC, null, indexed(OLD_ADAPTER)] }] }),
  ])
  const unique = new Map()
  for (const log of [...outbound, ...inbound]) {
    const decoded = decodeEventLog({ abi: [TRANSFER], data: log.data, topics: log.topics, strict: true })
    const event = { block: Number(log.blockNumber), txHash: log.transactionHash,
      logIndex: Number(log.logIndex), from: decoded.args.from.toLowerCase(),
      to: decoded.args.to.toLowerCase(), value: decoded.args.value.toString() }
    unique.set(`${event.txHash}:${event.logIndex}`, event)
  }
  const transfers = [...unique.values()].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
  atomic(out, { study: STUDY, status: 'complete', drilldownSha256: DRILLDOWN_SHA,
    child: CHILD, adapter: OLD_ADAPTER, qAssets: parent.qAssets, samples, transfers })
  return verifyOffline({ out, drilldownPath })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length && args.join(' ') !== '--verify offline') throw new Error('Only --verify offline is supported')
  const paths = {
    out: resolve('data/research/venue-signals/morpho-v2-first20-child-shares.json'),
    drilldownPath: resolve('data/research/venue-signals/morpho-v2-first20-revert-drilldown.json'),
  }
  try {
    const result = args.length ? verifyOffline(paths) : await run({ ...paths, client: makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')) })
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch {
    process.stderr.write('Child-share check failed; no result was published.\n')
    process.exitCode = 1
  }
}
