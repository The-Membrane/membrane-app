// Retrospective exact-data status of the separate cap pair 11 blocks after the frozen incident anchor.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeEventLog, parseAbiItem, toEventSelector, toHex } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { STAGE1_SHA } from './morpho-v2-exit-baseline-pilot.mjs'

export const STUDY = 'morpho-v2-adjacent-cap-status-v1'
export const ROUTES_SHA = '26ee816dfb68168a3cdc43d2a74b68c23688ad9beeb3e288c4e2da3de1b636da'
const ACCEPT = parseAbiItem('event Accept(bytes4 indexed selector,bytes data)')
const REVOKE = parseAbiItem('event Revoke(address indexed sender,bytes4 indexed selector,bytes data)')
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const EXPECTED_EVENTS = [
  { selector: '0xf6f98fd5', block: 24_655_564, logIndex: 807 },
  { selector: '0x2438525b', block: 24_655_564, logIndex: 809 },
]
const EXPECTED_TX = '0x9f6729e0dc56cdd7f340ba54409d5cf2dee4f51e0ebfd68a998b22d6ccaf3f17'

function pinned(path, expected) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== expected) throw new Error('Pinned adjacent-cap input SHA mismatch')
  return JSON.parse(bytes)
}
function atomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
  renameSync(temp, path)
}
function sources(paths) {
  const stage1 = pinned(paths.stage1Path, STAGE1_SHA)
  const routes = pinned(paths.routesPath, ROUTES_SHA)
  const primary = stage1.proposals.find((p) => p.vault.toLowerCase() === routes.vault && p.block === routes.fromBlock + 1)
  const adjacent = stage1.proposals.find((p) => p.vault.toLowerCase() === routes.vault && p.block === 24_636_164)
  if (!primary || !adjacent || adjacent.rawEventIndexes.length !== 2 ||
      primary.rawEventIndexes.length !== 2 || routes.status !== 'complete')
    throw new Error('Frozen adjacent-cap pair mismatch')
  const legs = adjacent.rawEventIndexes.map((i) => stage1.rawEvents[i])
  if (legs.some((leg) => leg.block !== adjacent.block || leg.vault.toLowerCase() !== adjacent.vault.toLowerCase()))
    throw new Error('Adjacent-cap raw leg mismatch')
  return { stage1, routes, adjacent, legs }
}
export function verifyOffline(paths) {
  const { routes, adjacent, legs } = sources(paths)
  const bytes = readFileSync(paths.out)
  const saved = JSON.parse(bytes)
  if (saved.study !== STUDY || saved.status !== 'complete' || saved.stage1Sha256 !== STAGE1_SHA ||
      saved.routesSha256 !== ROUTES_SHA || saved.vault !== routes.vault ||
      saved.fromBlock !== adjacent.block || saved.toBlock !== routes.toBlock ||
      saved.proposalTxHash !== adjacent.txHash || saved.legs?.length !== 2 || !Array.isArray(saved.events))
    throw new Error('Adjacent-cap checkpoint mismatch')
  const exact = new Map(legs.map((leg) => [leg.data.toLowerCase(), leg.selector.toLowerCase()]))
  for (const leg of saved.legs)
    if (exact.get(leg.data.toLowerCase()) !== leg.selector.toLowerCase())
      throw new Error('Adjacent-cap saved leg mismatch')
  for (const event of saved.events)
    if (event.block < saved.fromBlock || event.block > saved.toBlock ||
        exact.get(event.data.toLowerCase()) !== event.selector.toLowerCase() ||
        !['accept', 'revoke'].includes(event.kind))
      throw new Error('Unrelated cap event in checkpoint')
  if (saved.events.length !== EXPECTED_EVENTS.length || saved.events.some((event, i) =>
    event.kind !== 'revoke' || event.block !== EXPECTED_EVENTS[i].block ||
    event.logIndex !== EXPECTED_EVENTS[i].logIndex ||
    event.selector !== EXPECTED_EVENTS[i].selector || event.txHash.toLowerCase() !== EXPECTED_TX))
    throw new Error('Observed adjacent-cap revocation sequence mismatch')
  return { checkpointSha256: sha(bytes), vault: saved.vault, proposalTxHash: saved.proposalTxHash,
    legs: saved.legs, events: saved.events }
}
export async function run({ client, ...paths }) {
  if (existsSync(paths.out)) return verifyOffline(paths)
  const { routes, adjacent, legs } = sources(paths)
  if ((await client.getChainId()) !== 1) throw new Error('Wrong chain ID')
  const exact = new Set(legs.map((leg) => leg.data.toLowerCase()))
  const events = []
  for (let start = adjacent.block; start <= routes.toBlock; start += 8_000) {
    const end = Math.min(routes.toBlock, start + 7_999)
    for (const [kind, item] of [['accept', ACCEPT], ['revoke', REVOKE]]) {
      const logs = await client.request({ method: 'eth_getLogs', params: [{ address: routes.vault,
        fromBlock: toHex(start), toBlock: toHex(end), topics: [toEventSelector(item)] }] })
      for (const log of logs) {
        const decoded = decodeEventLog({ abi: [item], data: log.data, topics: log.topics, strict: true })
        if (!exact.has(decoded.args.data.toLowerCase())) continue
        events.push({ kind, block: Number(log.blockNumber), blockHash: log.blockHash,
          txHash: log.transactionHash, logIndex: Number(log.logIndex),
          selector: decoded.args.selector.toLowerCase(), data: decoded.args.data.toLowerCase() })
      }
    }
  }
  events.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
  const value = { study: STUDY, status: 'complete', stage1Sha256: STAGE1_SHA,
    routesSha256: ROUTES_SHA, vault: routes.vault, fromBlock: adjacent.block,
    toBlock: routes.toBlock, proposalTxHash: adjacent.txHash,
    legs: legs.map((leg) => ({ selector: leg.selector.toLowerCase(), data: leg.data.toLowerCase(),
      executableAt: leg.executableAt })), events }
  if (Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 ** 2) throw new Error('Adjacent-cap cache size cap reached')
  atomic(paths.out, value)
  return verifyOffline(paths)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length && args.join(' ') !== '--verify offline') throw new Error('Only --verify offline is supported')
  const paths = {
    out: resolve('data/research/venue-signals/morpho-v2-adjacent-cap-status.json'),
    routesPath: resolve('data/research/venue-signals/morpho-v2-first20-route-events.json'),
    stage1Path: resolve(`data/research/venue-signals/${STAGE1_SHA}.json`),
  }
  try {
    const result = args.length ? verifyOffline(paths) : await run({ ...paths,
      client: makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')) })
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch {
    process.stderr.write('Adjacent-cap status failed; no result was published.\n')
    process.exitCode = 1
  }
}
