// Exact historical timestamps for changes to the selected Vault V2 adapter ADDRESS.
// An adapter-data change or the first observed route for a vault is not an exposure here.
// node scripts/research/morpho-v2-route-address-headers.mjs --max-headers 10
// node scripts/research/morpho-v2-route-address-headers.mjs --verify true
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toHex } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { readFactory, validateCheckpoint as validateRoute } from './morpho-v2-route-census.mjs'

export const STUDY = 'morpho-v2-route-address-headers-v1'
export const ROUTE_SHA = '45a7182cc2c5d38616ea066522789840559242e5758958f49a228e718fbcd786'
export const RESERVE_BYTES = 2_500_000_000
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const HASH = /^0x[\da-f]{64}$/
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const core = ({ checkpointSha256, ...rest }) => rest
export const seal = (saved) => ({ ...core(saved), checkpointSha256: sha(JSON.stringify(core(saved))) })

export function readRoute(path, factoryPath) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== ROUTE_SHA) throw new Error('Pinned route artifact SHA mismatch')
  return validateRoute(JSON.parse(bytes), readFactory(factoryPath), { complete: true })
}

export function classifyAddressChanges(route) {
  if (route?.status !== 'complete' || !Array.isArray(route.events))
    throw new Error('Complete route census required')
  const previous = new Map(), changes = [], hashes = new Map()
  for (const event of route.events) {
    const old = previous.get(event.vault)
    if (old !== undefined && old !== event.adapter) {
      const knownHash = hashes.get(event.block)
      if (knownHash && knownHash !== event.blockHash)
        throw new Error('Conflicting event block hashes')
      hashes.set(event.block, event.blockHash)
      changes.push({
        vault: event.vault, block: event.block, blockHash: event.blockHash,
        transactionIndex: event.transactionIndex, txHash: event.txHash,
        logIndex: event.logIndex, fromAdapter: old, toAdapter: event.adapter,
      })
    }
    previous.set(event.vault, event.adapter)
  }
  const blocks = [...hashes.keys()].sort((a, b) => a - b)
  return { changes, blocks }
}

export function validateCheckpoint(saved, route) {
  const expected = classifyAddressChanges(route)
  if (saved?.study !== STUDY || saved.chainId !== 1 ||
      saved.routeArtifactSha256 !== ROUTE_SHA ||
      !['partial', 'complete'].includes(saved.status) ||
      !Number.isSafeInteger(saved.nextHeader) || saved.nextHeader < 0 ||
      saved.nextHeader > expected.blocks.length ||
      saved.status !== (saved.nextHeader === expected.blocks.length ? 'complete' : 'partial') ||
      !Array.isArray(saved.changes) || !Array.isArray(saved.blocks) ||
      !Array.isArray(saved.headers) || saved.headers.length !== saved.nextHeader ||
      JSON.stringify(saved.changes) !== JSON.stringify(expected.changes) ||
      JSON.stringify(saved.blocks) !== JSON.stringify(expected.blocks) ||
      !/^[\da-f]{64}$/.test(saved.checkpointSha256 || '') ||
      sha(JSON.stringify(core(saved))) !== saved.checkpointSha256)
    throw new Error('Route header checkpoint integrity or classification mismatch')
  const hashByBlock = new Map(saved.changes.map((event) => [event.block, event.blockHash]))
  let lastTime = -1
  for (let i = 0; i < saved.headers.length; i++) {
    const header = saved.headers[i]
    if (header.block !== saved.blocks[i] || !HASH.test(header.hash) ||
        header.hash !== hashByBlock.get(header.block) ||
        !Number.isSafeInteger(header.timestamp) || header.timestamp < 0 ||
        header.timestamp < lastTime)
      throw new Error('Route header/order/event hash mismatch')
    lastTime = header.timestamp
  }
  return saved
}

export function decodeHeader(raw, block, expectedHash) {
  if (!raw || Number(BigInt(raw.number)) !== block ||
      typeof raw.hash !== 'string' || raw.hash.toLowerCase() !== expectedHash ||
      !HASH.test(raw.hash.toLowerCase()))
    throw new Error('Historical block header does not match route event')
  const timestamp = Number(BigInt(raw.timestamp))
  if (!Number.isSafeInteger(timestamp) || timestamp < 0)
    throw new Error('Malformed historical timestamp')
  return { block, hash: raw.hash.toLowerCase(), timestamp }
}

function atomic(path, saved) {
  mkdirSync(dirname(path), { recursive: true })
  const bytes = JSON.stringify(saved)
  const length = Buffer.byteLength(bytes)
  if (length > MAX_OUTPUT_BYTES) throw new Error('Route header output size cap reached')
  const disk = statfsSync(dirname(path))
  if (Number(disk.bavail) * Number(disk.bsize) - length < RESERVE_BYTES)
    throw new Error('Route header disk reserve reached')
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, bytes, { mode: 0o600 })
  renameSync(temp, path)
}

async function retry(operation, retries, pause) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation() }
    catch (error) {
      if (attempt >= retries) throw new Error('RPC read failed', { cause: error })
      await pause(Math.min(10_000, 500 * 2 ** attempt))
    }
  }
}

export async function collect({
  route, client, out, maxHeaders = Infinity, retries = 3,
  rpcRead = (method, params) => client.request({ method, params }),
  pause = (ms) => new Promise((done) => setTimeout(done, ms)), onProgress = () => {},
}) {
  if ((maxHeaders !== Infinity && !Number.isSafeInteger(maxHeaders)) || maxHeaders < 0)
    throw new Error('Invalid maxHeaders')
  const chainId = await retry(() => client.getChainId(), retries, pause)
  if (chainId !== 1) throw new Error('Wrong chain ID')
  const { changes, blocks } = classifyAddressChanges(route)
  let saved = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : seal({
    study: STUDY, chainId: 1, routeArtifactSha256: ROUTE_SHA,
    status: blocks.length ? 'partial' : 'complete', nextHeader: 0,
    changes, blocks, headers: [],
  })
  validateCheckpoint(saved, route)
  if (!existsSync(out)) atomic(out, saved)
  const hashByBlock = new Map(changes.map((event) => [event.block, event.blockHash]))
  const stop = Math.min(blocks.length, saved.nextHeader + maxHeaders)
  for (let i = saved.nextHeader; i < stop; i++) {
    const block = blocks[i]
    const raw = await retry(() => rpcRead('eth_getBlockByNumber', [toHex(block), false]), retries, pause)
    const header = decodeHeader(raw, block, hashByBlock.get(block))
    saved = seal({ ...core(saved), nextHeader: i + 1,
      status: i + 1 === blocks.length ? 'complete' : 'partial',
      headers: [...saved.headers, header] })
    validateCheckpoint(saved, route)
    atomic(out, saved)
    onProgress(saved)
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
  const out = resolve(opts.out || 'data/research/venue-signals/morpho-v2-route-address-headers.json')
  const routePath = resolve(opts.route || 'data/research/venue-signals/morpho-v2-route-census.json')
  const factoryPath = resolve(opts.factory ||
    'data/research/venue-signals/745062b27def710352f1b6c5ca220ebc3a953513a384077e190f7eef92ea6aaa.json')
  try {
    const route = readRoute(routePath, factoryPath)
    const saved = opts.verify === 'true'
      ? validateCheckpoint(JSON.parse(readFileSync(out, 'utf8')), route)
      : await collect({ route, out, client: makeClient(opts.rpc || process.env.RECORDER_RPC_URL ||
          readEnv().get('RECORDER_RPC_URL')),
        maxHeaders: opts['max-headers'] === undefined ? Infinity : Number(opts['max-headers']),
        onProgress: (item) => process.stdout.write(`headers ${item.nextHeader}/${item.blocks.length}\n`),
      })
    process.stdout.write(JSON.stringify({ path: out, status: saved.status,
      addressChanges: saved.changes.length, uniqueBlocks: saved.blocks.length,
      headers: saved.nextHeader, sha256: sha(readFileSync(out)) }) + '\n')
  } catch (error) {
    // Do not print provider exceptions: they can contain credential-bearing RPC URLs.
    process.stderr.write(`Route header enrichment stopped; checkpoint remains at ${out}. ` +
      (error.message === 'RPC read failed' ? 'RPC read failed.' : 'Validation or resource guard failed.') + '\n')
    process.exitCode = 1
  }
}
