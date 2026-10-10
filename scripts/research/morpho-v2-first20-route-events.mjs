// Historical route changes and exact cap Accept/Revoke events for the one default-exit failure.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeEventLog, parseAbi, parseAbiItem, toEventSelector, toHex } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { STAGE1_SHA } from './morpho-v2-exit-baseline-pilot.mjs'

export const STUDY = 'morpho-v2-first20-route-events-v1'
export const SHARE_PATH_SHA = 'e461e299017b6c81feb0c413e13cd5b37ae8b361a27556fbfee34bed71c04d28'
export const DRILLDOWN_SHA = 'a6164a425d2ff71c35eba99be224e23b99b3e31e4bb127d89c8ccefc133b1911'
const ROUTE = parseAbiItem('event SetLiquidityAdapterAndData(address indexed sender,address indexed newLiquidityAdapter,bytes indexed newLiquidityData)')
const ACCEPT = parseAbiItem('event Accept(bytes4 indexed selector,bytes data)')
const REVOKE = parseAbiItem('event Revoke(address indexed sender,bytes4 indexed selector,bytes data)')
const ABI = parseAbi(['function liquidityAdapter() view returns (address)'])
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

function pinned(path, expected) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== expected) throw new Error('Pinned route source SHA mismatch')
  return JSON.parse(bytes)
}
function atomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
  renameSync(temp, path)
}
function sources(paths) {
  const shares = pinned(paths.sharePath, SHARE_PATH_SHA)
  const drill = pinned(paths.drilldownPath, DRILLDOWN_SHA)
  const stage1 = pinned(paths.stage1Path, STAGE1_SHA)
  const proposal = stage1.proposals.find((p) => p.vault.toLowerCase() === shares.vault && p.block === shares.samples[0].block + 1)
  if (shares.status !== 'complete' || drill.status !== 'complete' || !proposal ||
      drill.vault !== shares.vault || proposal.rawEventIndexes.length !== 2)
    throw new Error('Frozen route incident mismatch')
  return { shares, drill, stage1, proposal }
}

export function verifyOffline(paths) {
  const { shares, drill, stage1, proposal } = sources(paths)
  const bytes = readFileSync(paths.out)
  const saved = JSON.parse(bytes)
  if (saved.study !== STUDY || saved.status !== 'complete' ||
      saved.sharePathSha256 !== SHARE_PATH_SHA || saved.drilldownSha256 !== DRILLDOWN_SHA ||
      saved.stage1Sha256 !== STAGE1_SHA || saved.vault !== shares.vault ||
      saved.fromBlock !== shares.samples[0].block || saved.toBlock !== drill.samples[2].block ||
      !Array.isArray(saved.routeEvents) || !Array.isArray(saved.capEvents) || !Array.isArray(saved.routeStates))
    throw new Error('Route-events checkpoint mismatch')
  const exactData = new Set(proposal.rawEventIndexes.map((i) => stage1.rawEvents[i].data.toLowerCase()))
  for (const event of saved.capEvents)
    if (!exactData.has(event.data.toLowerCase()) || event.block < saved.fromBlock || event.block > saved.toBlock)
      throw new Error('Unrelated cap event in checkpoint')
  for (const event of saved.routeEvents)
    if (event.block < saved.fromBlock || event.block > saved.toBlock)
      throw new Error('Route event outside pinned range')
  return { checkpointSha256: sha(bytes), vault: saved.vault,
    routeEvents: saved.routeEvents, capEvents: saved.capEvents, routeStates: saved.routeStates }
}

export async function run({ client, ...paths }) {
  if (existsSync(paths.out)) return verifyOffline(paths)
  const { shares, drill, stage1, proposal } = sources(paths)
  if ((await client.getChainId()) !== 1) throw new Error('Wrong chain ID')
  const fromBlock = shares.samples[0].block, toBlock = drill.samples[2].block
  const routeEvents = [], capEvents = []
  for (let start = fromBlock; start <= toBlock; start += 8_000) {
    const end = Math.min(toBlock, start + 7_999)
    for (const [kind, item] of [['route', ROUTE], ['accept', ACCEPT], ['revoke', REVOKE]]) {
      const logs = await client.request({ method: 'eth_getLogs', params: [{ address: shares.vault,
        fromBlock: toHex(start), toBlock: toHex(end), topics: [toEventSelector(item)] }] })
      for (const log of logs) {
        const decoded = decodeEventLog({ abi: [item], data: log.data, topics: log.topics, strict: true })
        const base = { block: Number(log.blockNumber), blockHash: log.blockHash,
          txHash: log.transactionHash, logIndex: Number(log.logIndex) }
        if (kind === 'route') routeEvents.push({ ...base, sender: decoded.args.sender.toLowerCase(),
          adapter: decoded.args.newLiquidityAdapter.toLowerCase(), liquidityDataHash: decoded.args.newLiquidityData })
        else if (proposal.rawEventIndexes.some((i) => stage1.rawEvents[i].data.toLowerCase() === decoded.args.data.toLowerCase()))
          capEvents.push({ ...base, kind, selector: decoded.args.selector, data: decoded.args.data })
      }
    }
  }
  routeEvents.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
  capEvents.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
  const blocks = [...new Set([
    fromBlock, shares.samples.at(-1).block, drill.samples[1].block, toBlock,
    ...routeEvents.flatMap((event) => [event.block - 1, event.block]),
  ])].sort((a, b) => a - b)
  const routeStates = []
  for (const block of blocks) {
    const blockNumber = BigInt(block)
    const [header, adapter] = await Promise.all([
      client.getBlock({ blockNumber }),
      client.readContract({ address: shares.vault, abi: ABI, functionName: 'liquidityAdapter', blockNumber }),
    ])
    const expectedHash = block === fromBlock ? shares.samples[0].blockHash :
      block === shares.samples.at(-1).block ? shares.samples.at(-1).blockHash :
      block === drill.samples[1].block ? drill.samples[1].blockHash :
      block === toBlock ? drill.samples[2].blockHash :
      routeEvents.find((event) => event.block === block)?.blockHash
    if (expectedHash && header.hash.toLowerCase() !== expectedHash.toLowerCase())
      throw new Error('Historical route block hash mismatch')
    routeStates.push({ block, blockHash: header.hash, timestamp: Number(header.timestamp), adapter: adapter.toLowerCase() })
  }
  const value = { study: STUDY, status: 'complete', sharePathSha256: SHARE_PATH_SHA,
    drilldownSha256: DRILLDOWN_SHA, stage1Sha256: STAGE1_SHA, vault: shares.vault,
    fromBlock, toBlock, routeEvents, capEvents, routeStates }
  if (Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 ** 2) throw new Error('Route cache size cap reached')
  atomic(paths.out, value)
  return verifyOffline(paths)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length && args.join(' ') !== '--verify offline') throw new Error('Only --verify offline is supported')
  const paths = {
    out: resolve('data/research/venue-signals/morpho-v2-first20-route-events.json'),
    sharePath: resolve('data/research/venue-signals/morpho-v2-first20-preexec-share-path.json'),
    drilldownPath: resolve('data/research/venue-signals/morpho-v2-first20-revert-drilldown.json'),
    stage1Path: resolve(`data/research/venue-signals/${STAGE1_SHA}.json`),
  }
  try {
    const result = args.length ? verifyOffline(paths) : await run({ ...paths, client: makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')) })
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch {
    process.stderr.write('Route-event check failed; no result was published.\n')
    process.exitCode = 1
  }
}
