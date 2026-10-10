// Aave V3 Ethereum cross-reserve freeze/pause event census. Read-only RPC.
// Bounded probe:
// node scripts/research/aave-freeze-event-study.mjs --from-block 24908000 --to-block 24916000 --events-out /private/tmp/aave-freeze-probe.json
// Full bounded archive collection uses the cached Aave USDe 400d first/last
// blocks, not an unbounded query. Study preregistration is in the logic module.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { parseAbiItem } from 'viem'
import { loadConfig, makeClient, readEnv } from '../lib/venue-reads.mjs'
import {
  DAY,
  GRID_HOURS,
  independentIncidents,
  PREREG,
  response,
  summarize,
  THRESHOLDS,
} from './aave-freeze-event-logic.mjs'

const CONFIGURATOR = '0x64b761D848206f447Fe2dd461b0c635Ec39EbB27'
const PROVIDER = '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e'
const events = [
  parseAbiItem('event ReserveFrozen(address indexed asset, bool frozen)'),
  parseAbiItem('event ReservePaused(address indexed asset, bool paused)'),
]
const providerAbi = [parseAbiItem('function getPoolConfigurator() view returns (address)')]
const cashAbi = [parseAbiItem('function balanceOf(address) view returns (uint256)')]
const opts = Object.fromEntries(
  process.argv
    .slice(2)
    .flatMap((arg, i, args) => (arg.startsWith('--') ? [[arg.slice(2), args[i + 1]]] : [])),
)
const numberOpt = (name, fallback, min, max) => {
  const n = opts[name] === undefined ? fallback : Number(opts[name])
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid --${name}`)
  return n
}
const config = loadConfig().find((v) => v.name === 'aave-v3-usde' && v.enabled)
if (!config?.address || !config?.underlying) throw new Error('Aave USDe config missing')
const from = numberOpt('from-block', 23229806, 1, 100_000_000)
const to = numberOpt('to-block', 26052206, from, 100_000_000)
const chunk = numberOpt('chunk-blocks', 8000, 1, 20000)
const cache = new Map()
const rpc = opts.rpc || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
if (!rpc) throw new Error('Set RECORDER_RPC_URL or --rpc')
const client = makeClient(rpc)
const atomicJson = (path, value) => {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value))
  renameSync(tmp, path)
}
async function blockAt(block) {
  let item = cache.get(block)
  if (!item) {
    const header = await client.getBlock({ blockNumber: BigInt(block) })
    item = Number(header.timestamp)
    cache.set(block, item)
  }
  return item
}
async function assertConfigurator(block) {
  const actual = await client.readContract({
    address: PROVIDER,
    abi: providerAbi,
    functionName: 'getPoolConfigurator',
    blockNumber: BigInt(block),
  })
  if (actual.toLowerCase() !== CONFIGURATOR.toLowerCase())
    throw new Error(`Configurator proxy mismatch at ${block}: ${actual}`)
}
async function scan() {
  await assertConfigurator(from)
  await assertConfigurator(to)
  const found = []
  let chunks = 0
  for (let start = from; start <= to; start += chunk) {
    const end = Math.min(to, start + chunk - 1)
    const logs = await client.getLogs({
      address: CONFIGURATOR,
      events,
      fromBlock: BigInt(start),
      toBlock: BigInt(end),
    })
    for (const log of logs) {
      const block = Number(log.blockNumber)
      found.push({
        type: log.eventName,
        asset: log.args.asset,
        enabled: Boolean(log.args.frozen ?? log.args.paused),
        block,
        at: await blockAt(block),
        txHash: log.transactionHash,
        logIndex: Number(log.logIndex),
        targetAsset: config.underlying,
      })
    }
    chunks++
    if (opts['events-out'] && chunks % 10 === 0)
      atomicJson(opts['events-out'], {
        study: 'Aave V3 Ethereum cross-reserve configuration event census',
        status: 'partial',
        prereg: PREREG,
        from,
        to,
        through: end,
        events: found,
      })
  }
  return {
    study: 'Aave V3 Ethereum cross-reserve configuration event census',
    status: 'complete',
    prereg: PREREG,
    configurator: CONFIGURATOR,
    provider: PROVIDER,
    from,
    to,
    chunks,
    events: found,
  }
}

async function readCash(block) {
  return (
    Number(
      await client.readContract({
        address: config.underlying,
        abi: cashAbi,
        functionName: 'balanceOf',
        args: [config.address],
        blockNumber: BigInt(block),
      }),
    ) / 1e18
  )
}
async function firstBlockAtOrAfter(targetAt, left, right) {
  while (left < right) {
    const mid = Math.floor((left + right) / 2)
    if ((await blockAt(mid)) < targetAt) left = mid + 1
    else right = mid
  }
  return left
}
async function cashPath(anchorBlock, anchorAt) {
  const preBlock = Math.max(from, anchorBlock - 1)
  const preCash = await readCash(preBlock)
  const path = []
  let prior = anchorBlock
  for (const hour of GRID_HOURS) {
    const target = anchorAt + hour * 3600
    const upper = Math.min(to, anchorBlock + Math.ceil((hour * 3600) / 10))
    if ((await blockAt(upper)) < target) return null
    const block = await firstBlockAtOrAfter(target, prior, upper)
    path.push({ hour, block, at: await blockAt(block), cash: await readCash(block) })
    prior = block
  }
  return { preBlock, preCash, path }
}
function hasNearbyEvent(at, incidents) {
  return incidents.some((incident) => Math.abs(incident.at - at) <= DAY)
}
async function controlsFor(incident, incidents) {
  const candidates = []
  for (const days of [-14, -7, 7, 14]) {
    const targetAt = incident.at + days * DAY
    if (hasNearbyEvent(targetAt, incidents)) continue
    if (targetAt < (await blockAt(from)) || targetAt + DAY > (await blockAt(to))) continue
    const rough = incident.block + Math.round((days * DAY) / 12)
    const low = Math.max(from, rough - 5000)
    const high = Math.min(to, rough + 5000)
    if ((await blockAt(low)) > targetAt || (await blockAt(high)) < targetAt) continue
    const block = await firstBlockAtOrAfter(targetAt, low, high)
    const path = await cashPath(block, await blockAt(block))
    if (path) candidates.push({ days, block, at: await blockAt(block), ...path })
  }
  return candidates
}
async function analyze(census) {
  const incidents = independentIncidents(census.events)
  const studied = []
  for (const incident of incidents) {
    const path = await cashPath(incident.block, incident.at)
    if (!path) {
      studied.push({ ...incident, path: null, response: null, control: null })
      continue
    }
    const choices = await controlsFor(incident, incidents)
    const control = choices.sort(
      (a, b) =>
        Math.abs(Math.log((a.preCash + 1) / (path.preCash + 1))) -
        Math.abs(Math.log((b.preCash + 1) / (path.preCash + 1))),
    )[0]
    const toResponse = (p) =>
      Object.fromEntries(
        THRESHOLDS.map((q) => [
          q,
          response(
            p.preCash,
            p.path.map((x) => x.cash),
            q,
          ),
        ]),
      )
    studied.push({
      ...incident,
      ...path,
      response: toResponse(path),
      control: control
        ? {
            ...control,
            cashMismatchPct: (control.preCash / path.preCash - 1) * 100,
            response: toResponse(control),
          }
        : null,
    })
    if (opts['study-out'] && studied.length % 10 === 0)
      atomicJson(opts['study-out'], { status: 'partial', prereg: PREREG, incidents: studied })
  }
  return {
    status: 'complete',
    prereg: PREREG,
    census: { from, to, events: census.events.length },
    incidents: studied,
    summary: summarize(studied),
  }
}

const census = opts['events-in']
  ? JSON.parse(readFileSync(opts['events-in'], 'utf8'))
  : await scan()
if (census.status !== 'complete') throw new Error('Event census incomplete')
if (opts['events-out']) atomicJson(opts['events-out'], census)
if (opts['study-out']) {
  const study = await analyze(census)
  atomicJson(opts['study-out'], study)
  console.log(
    JSON.stringify(
      {
        eventLogs: census.events.length,
        incidents: study.incidents.length,
        summary: study.summary,
      },
      null,
      2,
    ),
  )
} else {
  console.log(
    JSON.stringify(
      {
        from,
        to,
        chunks: census.chunks,
        eventLogs: census.events.length,
        incidents: independentIncidents(census.events).length,
      },
      null,
      2,
    ),
  )
}
