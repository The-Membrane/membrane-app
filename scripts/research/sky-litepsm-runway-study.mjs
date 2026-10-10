// Read-only, block-pinned Sky USDS→USDC LitePSM Pocket runway pilot.
// RECORDER_RPC_URL=<archive RPC> node scripts/research/sky-litepsm-runway-study.mjs \
//   --days 7 --samples-out /private/tmp/sky-litepsm-pilot.json
// Replay without RPC: node ... --samples-in /private/tmp/sky-litepsm-pilot.json
// Keep the preregistered outcome/gates in sky-litepsm-runway-logic.mjs unchanged.

import { openSync, closeSync, readFileSync, writeFileSync } from 'node:fs'
import { decodeEventLog, parseAbiItem } from 'viem'
import { loadConfig, makeClient, readEnv } from '../lib/venue-reads.mjs'
import { SKY_RUNWAY_PROTOCOL, evaluateRunway, makeRunwayRows } from './sky-litepsm-runway-logic.mjs'

const DAY = 86_400
const STEP_BLOCKS = 900
const LOG_CHUNK_BLOCKS = 1800n
const WRAPPER = '0xA188EEC8F81263234dA3622A406892F3D630f98c'
const PSM = '0xf6e72Db5454dd049d0788e411b06CfAF16853042'
const POCKET = '0x37305B1cD40574E4C5Ce33f8e8306Be057fD7341'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
)
const BUY_GEM = parseAbiItem('event BuyGem(address indexed owner, uint256 value, uint256 fee)')
const SELL_GEM = parseAbiItem('event SellGem(address indexed owner, uint256 value, uint256 fee)')
const FILE_UINT = parseAbiItem('event File(bytes32 indexed what, uint256 data)')
const balanceAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
]
const psmAbi = [
  {
    type: 'function',
    name: 'pocket',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'gem',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'tout',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
]
const wrapperAbi = [
  {
    type: 'function',
    name: 'psm',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'pocket',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'usds',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
]

const args = process.argv.slice(2)
function option(name) {
  const index = args.indexOf(`--${name}`)
  return index < 0 ? undefined : args[index + 1]
}
const days = option('days') === undefined ? 7 : Number(option('days'))
if (!Number.isSafeInteger(days) || days < 1 || days > 7)
  throw new Error('--days must be an integer from 1 to 7 for the bounded pilot')
if (option('samples-in') && option('samples-out'))
  throw new Error('--samples-in and --samples-out are mutually exclusive')
const config = loadConfig().find((venue) => venue.name === 'sUSDS' && venue.enabled)
const psmMarket = config?.depthMarkets?.find(
  (market) => market.enabled && market.kind === 'psm-buffer',
)
if (
  !psmMarket ||
  psmMarket.address.toLowerCase() !== PSM.toLowerCase() ||
  psmMarket.buffer.toLowerCase() !== POCKET.toLowerCase() ||
  psmMarket.bufferToken.toLowerCase() !== USDC.toLowerCase()
)
  throw new Error('Configured Sky PSM/Pocket/USDC addresses differ from preregistered route')

function checkedArtifact(raw) {
  if (
    raw.study !== SKY_RUNWAY_PROTOCOL.study ||
    raw.protocol?.positionUsdc !== SKY_RUNWAY_PROTOCOL.positionUsdc ||
    !Array.isArray(raw.samples) ||
    !Array.isArray(raw.transfers) ||
    !Array.isArray(raw.psmEvents)
  )
    throw new Error('Not a matching Sky LitePSM raw observation artifact')
  if (
    raw.addresses.psm.toLowerCase() !== PSM.toLowerCase() ||
    raw.addresses.pocket.toLowerCase() !== POCKET.toLowerCase() ||
    raw.addresses.usdc.toLowerCase() !== USDC.toLowerCase()
  )
    throw new Error('Sky LitePSM artifact addresses differ')
  return raw
}

let artifact
if (option('samples-in')) {
  artifact = checkedArtifact(JSON.parse(readFileSync(option('samples-in'), 'utf8')))
} else {
  const rpc = option('rpc') || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
  if (!rpc) throw new Error('Set RECORDER_RPC_URL or pass --rpc')
  const client = makeClient(rpc)
  const head = (await client.getBlockNumber()) - 64n
  async function read(address, abi, functionName, blockNumber, contractArgs = []) {
    return client.readContract({ address, abi, functionName, args: contractArgs, blockNumber })
  }
  const [wrapperPsm, wrapperPocket, wrapperUsds, psmPocket, psmGem] = await Promise.all([
    read(WRAPPER, wrapperAbi, 'psm', head),
    read(WRAPPER, wrapperAbi, 'pocket', head),
    read(WRAPPER, wrapperAbi, 'usds', head),
    read(PSM, psmAbi, 'pocket', head),
    read(PSM, psmAbi, 'gem', head),
  ])
  if (
    wrapperPsm.toLowerCase() !== PSM.toLowerCase() ||
    wrapperPocket.toLowerCase() !== POCKET.toLowerCase() ||
    psmPocket.toLowerCase() !== POCKET.toLowerCase() ||
    psmGem.toLowerCase() !== USDC.toLowerCase() ||
    wrapperUsds.toLowerCase() !== config.underlying.toLowerCase()
  )
    throw new Error('Pinned wrapper → PSM → Pocket route verification failed')

  const end = await client.getBlock({ blockNumber: head })
  const startAt = Number(end.timestamp) - days * DAY
  const samples = []
  for (let block = head; block > 0n; block -= BigInt(STEP_BLOCKS)) {
    const header = await client.getBlock({ blockNumber: block })
    const at = Number(header.timestamp)
    if (at < startAt) break
    const [balance, tout] = await Promise.all([
      read(USDC, balanceAbi, 'balanceOf', block, [POCKET]),
      read(PSM, psmAbi, 'tout', block),
    ])
    samples.push({
      block: Number(block),
      at,
      pocketUsdcRaw: balance.toString(),
      toutRaw: tout.toString(),
    })
  }
  samples.reverse()
  if (samples.length < 9 || samples.length > 65)
    throw new Error(`Unexpected pilot sample count ${samples.length}`)

  async function logs(address, event, eventArgs) {
    const out = []
    for (let from = BigInt(samples[0].block) - 7200n; from <= head; from += LOG_CHUNK_BLOCKS) {
      const to = from + LOG_CHUNK_BLOCKS - 1n > head ? head : from + LOG_CHUNK_BLOCKS - 1n
      const chunk = await client.getLogs({
        address,
        event,
        args: eventArgs,
        fromBlock: from,
        toBlock: to,
      })
      out.push(...chunk)
    }
    return out
  }
  // Include a full 24h lag before the first sample; no feature needs future logs.
  const [outLogs, inLogs, buyLogs, sellLogs, fileLogs] = await Promise.all([
    logs(USDC, TRANSFER, { from: POCKET }),
    logs(USDC, TRANSFER, { to: POCKET }),
    logs(PSM, BUY_GEM),
    logs(PSM, SELL_GEM),
    logs(PSM, FILE_UINT),
  ])
  const timeByBlock = new Map(samples.map((sample) => [sample.block, sample.at]))
  const allLogs = [...outLogs, ...inLogs, ...buyLogs, ...sellLogs, ...fileLogs]
  const eventBlocks = [...new Set(allLogs.map((log) => Number(log.blockNumber)))].filter(
    (block) => !timeByBlock.has(block),
  )
  for (let i = 0; i < eventBlocks.length; i += 8) {
    await Promise.all(
      eventBlocks.slice(i, i + 8).map(async (block) => {
        const header = await client.getBlock({ blockNumber: BigInt(block) })
        timeByBlock.set(block, Number(header.timestamp))
      }),
    )
  }
  const transfer = (log, direction) => ({
    block: Number(log.blockNumber),
    at: timeByBlock.get(Number(log.blockNumber)),
    tx: log.transactionHash,
    logIndex: Number(log.logIndex),
    usdcRaw: log.args.value.toString(),
    direction,
  })
  const transfers = [
    ...outLogs.map((log) => transfer(log, 'out')),
    ...inLogs.map((log) => transfer(log, 'in')),
  ]
  const psmEvents = [
    ...buyLogs.map((log) => ({
      type: 'BuyGem',
      block: Number(log.blockNumber),
      at: timeByBlock.get(Number(log.blockNumber)),
      tx: log.transactionHash,
      logIndex: Number(log.logIndex),
      valueRaw: log.args.value.toString(),
      feeRaw: log.args.fee.toString(),
    })),
    ...sellLogs.map((log) => ({
      type: 'SellGem',
      block: Number(log.blockNumber),
      at: timeByBlock.get(Number(log.blockNumber)),
      tx: log.transactionHash,
      logIndex: Number(log.logIndex),
      valueRaw: log.args.value.toString(),
      feeRaw: log.args.fee.toString(),
    })),
    ...fileLogs.map((log) => {
      const decoded = decodeEventLog({ abi: [FILE_UINT], data: log.data, topics: log.topics })
      return {
        type: 'File',
        block: Number(log.blockNumber),
        at: timeByBlock.get(Number(log.blockNumber)),
        tx: log.transactionHash,
        logIndex: Number(log.logIndex),
        what: decoded.args.what,
        dataRaw: decoded.args.data.toString(),
      }
    }),
  ].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
  artifact = {
    study: SKY_RUNWAY_PROTOCOL.study,
    protocol: SKY_RUNWAY_PROTOCOL,
    days,
    addresses: { wrapper: WRAPPER, psm: PSM, pocket: POCKET, usdc: USDC, usds: wrapperUsds },
    source: {
      officialDocs: 'https://developers.skyeco.com/guides/psm/litepsm/',
      psmSource: 'https://github.com/sky-ecosystem/dss-lite-psm/blob/main/src/DssLitePsm.sol',
      wrapperSource:
        'https://github.com/sky-ecosystem/usds-wrappers/blob/dev/src/UsdsPsmWrapper.sol',
      headBlock: Number(head),
      startBlock: samples[0].block,
      stepBlocks: STEP_BLOCKS,
    },
    samples,
    transfers,
    psmEvents,
  }
  if (option('samples-out')) {
    const fd = openSync(option('samples-out'), 'wx')
    try {
      writeFileSync(fd, `${JSON.stringify(artifact)}\n`)
    } finally {
      closeSync(fd)
    }
  }
}

const samples = artifact.samples.map((row) => ({
  ...row,
  pocketUsdc: Number(BigInt(row.pocketUsdcRaw)) / 1e6,
}))
const transfers = artifact.transfers.map((row) => ({
  ...row,
  usdc: Number(BigInt(row.usdcRaw)) / 1e6,
}))
const rows = makeRunwayRows(samples, transfers)
const evaluation = evaluateRunway(rows)
const psmBuyUsdc = artifact.psmEvents
  .filter((event) => event.type === 'BuyGem')
  .reduce((sum, event) => sum + Number(BigInt(event.valueRaw)) / 1e6, 0)
const totalPocketOutUsdc = transfers
  .filter((row) => row.direction === 'out')
  .reduce((sum, row) => sum + row.usdc, 0)
const buyByTx = new Map()
for (const event of artifact.psmEvents.filter((row) => row.type === 'BuyGem')) {
  buyByTx.set(event.tx, (buyByTx.get(event.tx) ?? 0n) + BigInt(event.valueRaw))
}
const outByTx = new Map()
for (const row of artifact.transfers.filter((item) => item.direction === 'out')) {
  outByTx.set(row.tx, (outByTx.get(row.tx) ?? 0n) + BigInt(row.usdcRaw))
}
const unmatchedOut = [...outByTx].filter(([tx, amount]) => (buyByTx.get(tx) ?? 0n) !== amount)
const balanceReconciliation = artifact.samples.slice(1).map((sample, index) => {
  const previous = artifact.samples[index]
  const netTransfers = artifact.transfers
    .filter((transfer) => transfer.block > previous.block && transfer.block <= sample.block)
    .reduce(
      (sum, transfer) =>
        sum + (transfer.direction === 'in' ? BigInt(transfer.usdcRaw) : -BigInt(transfer.usdcRaw)),
      0n,
    )
  const observedChange = BigInt(sample.pocketUsdcRaw) - BigInt(previous.pocketUsdcRaw)
  return { block: sample.block, residualRaw: observedChange - netTransfers }
})
const balanceMismatchIntervals = balanceReconciliation.filter((row) => row.residualRaw !== 0n)
console.log(
  JSON.stringify(
    {
      study: SKY_RUNWAY_PROTOCOL.study,
      days: artifact.days,
      sampleCount: rows.length,
      timeRange: [
        new Date(rows[0].at * 1000).toISOString(),
        new Date(rows.at(-1).at * 1000).toISOString(),
      ],
      logTimeRangeIncludingWarmup: transfers.length
        ? [
            new Date(Math.min(...transfers.map((row) => row.at)) * 1000).toISOString(),
            new Date(Math.max(...transfers.map((row) => row.at)) * 1000).toISOString(),
          ]
        : null,
      pocketUsdcRange: [
        Math.min(...rows.map((row) => row.pocketUsdc)),
        Math.max(...rows.map((row) => row.pocketUsdc)),
      ],
      maxSampleGapHours: Math.max(
        ...rows.slice(1).map((row, index) => (row.at - rows[index].at) / 3600),
      ),
      psmEventCounts: Object.fromEntries(
        ['BuyGem', 'SellGem', 'File'].map((type) => [
          type,
          artifact.psmEvents.filter((event) => event.type === type).length,
        ]),
      ),
      psmBuyUsdc,
      totalPocketOutUsdc,
      unmatchedPocketOutTx: unmatchedOut.length,
      unmatchedPocketOutUsdc: unmatchedOut.reduce(
        (sum, [, amount]) => sum + Number(amount) / 1e6,
        0,
      ),
      balanceMismatchIntervals: balanceMismatchIntervals.length,
      maxBalanceResidualUsdc: Math.max(
        0,
        ...balanceMismatchIntervals.map(
          (row) => Number(row.residualRaw < 0n ? -row.residualRaw : row.residualRaw) / 1e6,
        ),
      ),
      transferCount: transfers.length,
      toutStates: [...new Set(rows.map((row) => row.toutRaw))],
      evaluation,
    },
    null,
    2,
  ),
)
