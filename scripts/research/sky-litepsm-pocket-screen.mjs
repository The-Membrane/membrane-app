// Sparse prerequisite screen: does Sky Pocket USDC ever approach a hypothetical
// $20M user's direct USDS→USDC exit size? This is not an alert backtest.
// Weekly pinned state only; no logs and no development server.

import { openSync, closeSync, readFileSync, writeFileSync } from 'node:fs'
import { loadConfig, makeClient, readEnv } from '../lib/venue-reads.mjs'

const STUDY = 'sky-litepsm-pocket-weekly-screen-v1'
const POSITION_USDC = 20_000_000
const PSM = '0xf6e72Db5454dd049d0788e411b06CfAF16853042'
const POCKET = '0x37305B1cD40574E4C5Ce33f8e8306Be057fD7341'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WEEK_BLOCKS = 50_400n // ~7d at 12s/block; actual timestamps are preserved.
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
const args = process.argv.slice(2)
function option(name) {
  const index = args.indexOf(`--${name}`)
  return index < 0 ? undefined : args[index + 1]
}
if (option('samples-in') && option('samples-out'))
  throw new Error('--samples-in and --samples-out are mutually exclusive')
const config = loadConfig().find((venue) => venue.name === 'sUSDS' && venue.enabled)
const market = config?.depthMarkets?.find((item) => item.enabled && item.kind === 'psm-buffer')
if (
  !market ||
  market.address.toLowerCase() !== PSM.toLowerCase() ||
  market.buffer.toLowerCase() !== POCKET.toLowerCase() ||
  market.bufferToken.toLowerCase() !== USDC.toLowerCase()
)
  throw new Error('Configured Sky PSM/Pocket/USDC route changed')

let artifact
if (option('samples-in')) {
  artifact = JSON.parse(readFileSync(option('samples-in'), 'utf8'))
  if (
    artifact.study !== STUDY ||
    !Array.isArray(artifact.samples) ||
    artifact.addresses.psm.toLowerCase() !== PSM.toLowerCase()
  )
    throw new Error('Not a matching Sky Pocket screen artifact')
} else {
  const rpc = option('rpc') || process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')
  if (!rpc) throw new Error('Set RECORDER_RPC_URL or pass --rpc')
  const client = makeClient(rpc)
  const head = (await client.getBlockNumber()) - 64n
  const [pocket, gem] = await Promise.all([
    client.readContract({ address: PSM, abi: psmAbi, functionName: 'pocket', blockNumber: head }),
    client.readContract({ address: PSM, abi: psmAbi, functionName: 'gem', blockNumber: head }),
  ])
  if (pocket.toLowerCase() !== POCKET.toLowerCase() || gem.toLowerCase() !== USDC.toLowerCase())
    throw new Error('Pinned PSM → Pocket/USDC route verification failed')
  const end = await client.getBlock({ blockNumber: head })
  const startAt = Number(end.timestamp) - 400 * 86_400
  const samples = []
  for (let block = head; block >= WEEK_BLOCKS; block -= WEEK_BLOCKS) {
    const header = await client.getBlock({ blockNumber: block })
    if (Number(header.timestamp) < startAt) break
    const [balance, tout] = await Promise.all([
      client.readContract({
        address: USDC,
        abi: balanceAbi,
        functionName: 'balanceOf',
        args: [POCKET],
        blockNumber: block,
      }),
      client.readContract({ address: PSM, abi: psmAbi, functionName: 'tout', blockNumber: block }),
    ])
    samples.push({
      block: Number(block),
      at: Number(header.timestamp),
      pocketUsdcRaw: balance.toString(),
      toutRaw: tout.toString(),
    })
  }
  samples.reverse()
  if (samples.length < 50 || samples.length > 65)
    throw new Error(`Unexpected sparse-screen sample count ${samples.length}`)
  artifact = {
    study: STUDY,
    horizonDays: 400,
    positionUsdc: POSITION_USDC,
    addresses: { psm: PSM, pocket: POCKET, usdc: USDC },
    source: {
      headBlock: Number(head),
      stepBlocks: Number(WEEK_BLOCKS),
      docs: 'https://developers.skyeco.com/guides/psm/litepsm/',
    },
    samples,
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

for (let i = 0; i < artifact.samples.length; i++) {
  const row = artifact.samples[i]
  if (
    !Number.isSafeInteger(row.block) ||
    !Number.isSafeInteger(row.at) ||
    !/^\d+$/.test(row.pocketUsdcRaw) ||
    !/^\d+$/.test(row.toutRaw) ||
    (i && (row.block <= artifact.samples[i - 1].block || row.at <= artifact.samples[i - 1].at))
  )
    throw new Error('Malformed or non-monotonic Sky Pocket screen sample')
}
const amounts = artifact.samples.map((row) => Number(BigInt(row.pocketUsdcRaw)) / 1e6)
const fees = [...new Set(artifact.samples.map((row) => row.toutRaw))]
console.log(
  JSON.stringify(
    {
      study: STUDY,
      samples: amounts.length,
      first: new Date(artifact.samples[0].at * 1000).toISOString(),
      last: new Date(artifact.samples.at(-1).at * 1000).toISOString(),
      minPocketUsdc: Math.min(...amounts),
      maxPocketUsdc: Math.max(...amounts),
      minCoverageFor20m: Math.min(...amounts) / POSITION_USDC,
      samplesBelow20m: amounts.filter((amount) => amount < POSITION_USDC).length,
      samplesBelow25m: amounts.filter((amount) => amount < POSITION_USDC * 1.25).length,
      toutStates: fees,
    },
    null,
    2,
  ),
)
