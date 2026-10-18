// capture-slip-fixtures.ts — READ-ONLY. Captures real mainnet reads for the order slip's
// design-states page (pages/dev/slip-states.tsx): the page's own prepareLever and
// simulateLever on real borrowers, written to components/PositionV0/dev/slipFixtures.json.
// Nothing is signed or sent.
//
//   npx tsx scripts/position/capture-slip-fixtures.ts
//
//   ready    an Aave V3 borrower who holds the repay amount: gates pass, simulation passes
//   short    an Aave V3 borrower who does not: the balance gate blocks
//   add      the same ready borrower's top-up lever (for the cap state)
//   spark    a Spark borrower's repay lever (for the stable-debt state)
//   txs      real mainnet hashes of Aave repays, for the transaction states
//
// It also writes the cost-vs-reward tracker's history (pages/dev/cost-reward.tsx) to
// components/PositionV0/dev/costRewardFixture.json: for the ready borrower's position,
// Pool.getReserveData of every leg at one archive block per day for RATE_DAYS days back
// from the capture block: the variable borrow rate, the supply (liquidity) rate and both
// indexes, so the history is what the venue itself accrued, not a rebuilt rate.
//
//   npx tsx scripts/position/capture-slip-fixtures.ts           both files
//   npx tsx scripts/position/capture-slip-fixtures.ts --rates   the rate history only,
//                                                               for the position already
//                                                               in slipFixtures.json
//   npx tsx scripts/position/capture-slip-fixtures.ts --baseline
//                                                               BASELINE_DAYS of the same
//                                                               legs' borrow and supply APR,
//                                                               ending at the rate fixture's
//                                                               block, for the spread's
//                                                               untested baseline (model-only)
//   npx tsx scripts/position/capture-slip-fixtures.ts --incentives
//                                                               the current incentive
//                                                               campaigns per leg (Merkl
//                                                               v4) into the rate fixture;
//                                                               current only, no history
//   npx tsx scripts/position/capture-slip-fixtures.ts --dust [address]
//                                                               the collect-dust slip's
//                                                               read only (dustFixtures.json)
//
// The dust read (pages/dev/slip-states.tsx, dust-* states): every supply position of a
// real lender on Morpho Blue (the discovery list's markets) and Aave V3, read at one block
// (lib/position-exec/dustRead.ts), and the sweep's batch simulated from that address.
// Default address: a Morpho lender with zero-asset supplies and one under $1.

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  createPublicClient,
  http,
  parseAbiItem,
  type Address,
  type Hash,
  type PublicClient,
} from 'viem'
import { mainnet } from 'viem/chains'

import {
  legFor,
  positionKeyOf,
  prepareLever,
  type LeverIntent,
} from '@/components/PositionV0/leverExec'
import { buildPositionView } from '@/components/PositionV0/viewModel'
import { aavePoolAbi, erc20ReadAbi } from '@/lib/position-exec/abis'
import { leverUnits } from '@/lib/position-exec/amount'
import type { ExecProtocol } from '@/lib/position-exec/read'
import { simulateLever } from '@/lib/position-exec/simulate'
import { dustCalls, dustTotals, dustVerdict, splitDust } from '@/lib/position-exec/dust'
import { readDust } from '@/lib/position-exec/dustRead'
import { TOUCH_TABLE } from '@/lib/position/touchHistory'
import { ADAPTERS, runAdapter } from '@/lib/position-sim/adapters'
import { getMainnetClient } from '@/lib/position-sim/rpc'
import type { ActionRow } from '@/lib/position/reverseSolve'
import type { ProtocolPosition } from '@/lib/position-sim/types'
import {
  MERKL_AAVE_TYPES,
  RATE_DAYS,
  BASELINE_DAYS,
  merklCampaigns,
  type BaselineFixture,
  type IncentiveRead,
  type MerklOpportunity,
  type RateFixture,
  type RatePoint,
} from '@/lib/position/costReward'

const OUT = path.resolve(__dirname, '../../components/PositionV0/dev/slipFixtures.json')
const DUST_OUT = path.resolve(__dirname, '../../components/PositionV0/dev/dustFixtures.json')
const MARKETS = path.resolve(__dirname, '../../public/data/oct10-2025/protocols.json')
const DUST_LENDER = '0x711a68a82dd80cb0435b281af76b0b80804efab9' as Address
const RATES_OUT = path.resolve(__dirname, '../../components/PositionV0/dev/costRewardFixture.json')
const BASELINE_OUT = path.resolve(__dirname, '../../components/PositionV0/dev/costRewardBaseline.json')
/** Mainnet blocks per day at 12 s slots. Each point records its own block time. */
const BLOCKS_PER_DAY = 7200n
const logs = createPublicClient({
  chain: mainnet,
  transport: http('https://ethereum-rpc.publicnode.com', { timeout: 30_000 }),
}) as PublicClient
const AAVE_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'
const SPARK_POOL = '0xC13e21B648A5Ee794902342038FF3aDAB66BE987'
const STABLES = [
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  '0xdac17f958d2ee523a2206206994597c13d831ec7',
  '0x6b175474e89094c44da98b954eedeac495271d0f',
] as Address[]

const borrow = parseAbiItem(
  'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)',
)
const repay = parseAbiItem(
  'event Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens)',
)

async function borrowers(pool: Address, windows = 1): Promise<Address[]> {
  const head = await logs.getBlockNumber()
  const out: Address[] = []
  for (let i = 0; i < windows; i++) {
    const to = head - BigInt(i) * 1000n
    try {
      const found = await logs.getLogs({
        address: pool,
        event: borrow,
        args: { reserve: STABLES },
        fromBlock: to - 999n,
        toBlock: to,
      })
      out.push(...found.map((l) => l.args.onBehalfOf!.toLowerCase() as Address))
    } catch {
      /* a window the RPC refuses */
    }
  }
  return [...new Set(out)]
}

const deps = {
  readAdapter: (id: ExecProtocol, o: Address) => runAdapter(ADAPTERS.find((a) => a.id === id)!, o),
  client: getMainnetClient(),
  table: TOUCH_TABLE,
}

function intentFor(
  protocol: ExecProtocol,
  owner: Address,
  p: Parameters<typeof positionKeyOf>[0],
  row: ActionRow,
): LeverIntent {
  return {
    owner,
    positionKey: positionKeyOf(p),
    protocol,
    title: buildPositionView(p, TOUCH_TABLE).title,
    kind: row.kind,
    targetPct: row.targetPct,
    level: row.level,
    horizon: '7d',
    stale: false,
    row,
    openedAt: 0,
  }
}

/** First borrower whose lever of `kind` exists and whose balance check is `holds`. */
async function find(
  protocol: ExecProtocol,
  pool: Address,
  kind: 'repay' | 'add',
  holds: boolean | null,
) {
  const adapter = ADAPTERS.find((a) => a.id === protocol)!
  for (const who of (await borrowers(pool, protocol === 'spark' ? 12 : 10)).slice(0, 250)) {
    let positions
    try {
      positions = await adapter.read(who)
    } catch {
      continue
    }
    for (const p of positions) {
      const row = buildPositionView(p, TOUCH_TABLE).forecast?.byHorizon['7d'].actions.find(
        (r) => r.kind === kind,
      )
      if (!row) continue
      if (holds !== null) {
        const leg = legFor(p, row)
        const bal = await logs.readContract({
          address: leg.address as Address,
          abi: erc20ReadAbi,
          functionName: 'balanceOf',
          args: [who],
        })
        if (holds !== bal >= leverUnits(row.amount, row.amountDecimals, leg.decimals)) continue
      }
      const intent = intentFor(protocol, who, p, row)
      const prepared = await prepareLever(intent, deps)
      if (prepared.kind !== 'ready') continue
      const sim = prepared.gates.every((g) => g.ok)
        ? await simulateLever(getMainnetClient(), who, prepared.calls)
        : null
      console.log(
        `${protocol} ${kind} ${who.slice(0, 6)}…${who.slice(-4)}: ${prepared.row.action} · gates ${prepared.gates.every((g) => g.ok) ? 'pass' : prepared.gates.find((g) => !g.ok)!.text} · sim ${sim ? (sim.ok ? 'ok' : sim.reason) : '—'}`,
      )
      // The view is rebuilt from the position on the page (buildPositionView), as the slip does.
      const { view, ...rest } = prepared
      return { intent, prepared: { ...rest, position: view.position }, sim }
    }
  }
  throw new Error(`no ${protocol} ${kind} borrower found`)
}

const RAY = 1e27
const pool = (p: ProtocolPosition): Address => {
  if (p.protocol === 'aave-v3') return AAVE_POOL
  if (p.protocol === 'spark') return SPARK_POOL
  throw new Error(`rate history: no pool reader for ${p.protocol}`)
}

/**
 * One archive read per day for every leg of the position: Pool.getReserveData at that
 * block. Rays are kept as decimal strings (exact) and as numbers for the chart.
 */
async function captureRates(owner: Address, position: ProtocolPosition): Promise<RateFixture> {
  const client = getMainnetClient()
  const at = BigInt(position.provenance.block ?? 0)
  if (at === 0n) throw new Error('rate history: the position has no read block')
  const assets = [
    ...position.collateral.map((l) => ({ side: 'collateral' as const, symbol: l.symbol, address: l.address as Address })),
    ...position.debt.map((l) => ({ side: 'debt' as const, symbol: l.symbol, address: l.address as Address })),
  ]
  const series: Record<string, RatePoint[]> = Object.fromEntries(assets.map((a) => [a.address.toLowerCase(), []]))
  for (let d = RATE_DAYS; d >= 0; d--) {
    const blockNumber = at - BigInt(d) * BLOCKS_PER_DAY
    const [blk, ...reads] = await Promise.all([
      client.getBlock({ blockNumber }),
      ...assets.map((a) =>
        client.readContract({
          address: pool(position),
          abi: aavePoolAbi,
          functionName: 'getReserveData',
          args: [a.address],
          blockNumber,
        }),
      ),
    ])
    reads.forEach((r, i) => {
      series[assets[i].address.toLowerCase()].push({
        block: Number(blockNumber),
        ts: Number(blk.timestamp),
        borrowApr: Number(r.currentVariableBorrowRate) / RAY,
        supplyApr: Number(r.currentLiquidityRate) / RAY,
        borrowIndex: r.variableBorrowIndex.toString(),
        supplyIndex: r.liquidityIndex.toString(),
      })
    })
    if (d % 15 === 0) console.log(`rates: day −${d} block ${blockNumber}`)
  }
  return {
    capturedAt: new Date().toISOString(),
    owner,
    block: Number(at),
    source: `${position.label} Pool ${pool(position)} getReserveData at one archive block per day (${BLOCKS_PER_DAY} blocks), public rpc`,
    position: {
      label: position.label,
      collateral: position.collateral.map((l) => ({ symbol: l.symbol, address: l.address, amount: l.amount, priceUsd: l.priceUsd })),
      debt: position.debt.map((l) => ({ symbol: l.symbol, address: l.address, amount: l.amount, priceUsd: l.priceUsd })),
    },
    series,
  }
}

/**
 * The spread baseline's input: Pool.getReserveData's two rates for every leg of the rate
 * fixture, one archive block a day for BASELINE_DAYS days ending at that fixture's block, so
 * the baseline is the same series as the history, only longer. Rates only (no indexes).
 */
async function captureBaseline(fx: RateFixture): Promise<BaselineFixture> {
  const client = getMainnetClient()
  if (!fx.source.includes(AAVE_POOL)) throw new Error('baseline: only the Aave V3 pool is read')
  const at = BigInt(fx.block)
  const legs = [...fx.position.collateral, ...fx.position.debt].map((l) => l.address.toLowerCase() as Address)
  const series: BaselineFixture['series'] = Object.fromEntries(legs.map((a) => [a, []]))
  for (let d = BASELINE_DAYS; d >= 0; d--) {
    const blockNumber = at - BigInt(d) * BLOCKS_PER_DAY
    for (let attempt = 0; ; attempt++) {
      try {
        const [blk, ...reads] = await Promise.all([
          client.getBlock({ blockNumber }),
          ...legs.map((a) => client.readContract({ address: AAVE_POOL, abi: aavePoolAbi, functionName: 'getReserveData', args: [a], blockNumber })),
        ])
        reads.forEach((r, i) =>
          series[legs[i]].push({
            block: Number(blockNumber),
            ts: Number(blk.timestamp),
            borrowApr: Number(r.currentVariableBorrowRate) / RAY,
            supplyApr: Number(r.currentLiquidityRate) / RAY,
          }),
        )
        break
      } catch (e) {
        if (attempt >= 4) throw e
        await new Promise((ok) => setTimeout(ok, 2000 * 2 ** attempt))
      }
    }
    if (d % 30 === 0) console.log(`baseline: day −${d} block ${blockNumber}`)
  }
  return {
    capturedAt: new Date().toISOString(),
    block: fx.block,
    source: `Aave V3 Pool ${AAVE_POOL} getReserveData at one archive block per day (${BLOCKS_PER_DAY} blocks), public rpc`,
    series,
  }
}

const MERKL = 'https://api.merkl.xyz/v4/opportunities'

/**
 * The live Merkl campaigns for each leg of an Aave V3 position: every LIVE opportunity of
 * the Aave V3 supply and borrow types on chain 1, matched to a leg by token. Merkl serves
 * the current APR only, so this is a snapshot at the fetch time, never a history.
 */
async function captureIncentives(fx: RateFixture): Promise<IncentiveRead> {
  const types = [...MERKL_AAVE_TYPES.supply, ...MERKL_AAVE_TYPES.borrow]
  const ops: MerklOpportunity[] = []
  for (const type of types) {
    const res = await fetch(`${MERKL}?chainId=1&type=${type}&status=LIVE&items=100`)
    if (!res.ok) throw new Error(`merkl ${type}: HTTP ${res.status}`)
    ops.push(...((await res.json()) as MerklOpportunity[]))
  }
  const legs = [
    ...fx.position.collateral.map((l) => ({ address: l.address.toLowerCase(), side: 'supply' as const })),
    ...fx.position.debt.map((l) => ({ address: l.address.toLowerCase(), side: 'borrow' as const })),
  ].map((l) => ({ ...l, campaigns: merklCampaigns(ops, l) }))
  for (const l of legs) console.log(`incentives: ${l.side} ${l.address} · ${l.campaigns.length} live`)
  return {
    source: `Merkl v4 /opportunities · chainId 1 · ${types.join(', ')} · status LIVE`,
    fetchedAt: new Date().toISOString(),
    searched: ops.length,
    legs,
  }
}

async function writeRates(owner: Address, position: ProtocolPosition) {
  const fx = await captureRates(owner, position)
  fx.incentives = await captureIncentives(fx)
  writeFileSync(RATES_OUT, JSON.stringify(fx) + '\n')
  console.log(`wrote ${RATES_OUT} · ${Object.values(fx.series)[0].length} days × ${Object.keys(fx.series).length} legs`)
}

/** Morpho Blue's deployment block. */
const MORPHO_FROM = 18_883_124n
const supplyEv = parseAbiItem(
  'event Supply(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares)',
)
/**
 * Morpho has no reverse index, so the discovery list misses a lender's markets outside
 * it: the owner's own Supply events (onBehalf = owner) name every market they ever
 * supplied. The Tenderly public gateway serves these spans; publicnode does not.
 */
async function ownSupplyMarkets(owner: Address): Promise<string[]> {
  const c = createPublicClient({
    chain: mainnet,
    transport: http('https://gateway.tenderly.co/public/mainnet', { timeout: 60_000 }),
  }) as PublicClient
  const head = await c.getBlockNumber()
  const step = 2_000_000n
  const ids = new Set<string>()
  for (let from = MORPHO_FROM; from <= head; from += step) {
    const to = from + step - 1n > head ? head : from + step - 1n
    const found = await c.getLogs({
      address: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
      event: supplyEv,
      args: { onBehalf: owner },
      fromBlock: from,
      toBlock: to,
    })
    found.forEach((l) => ids.add(l.args.id!.toLowerCase()))
  }
  return [...ids]
}

const listedMarkets = () =>
  Object.keys(
    (JSON.parse(readFileSync(MARKETS, 'utf8')) as { morphoBlue: { markets: Record<string, unknown> } })
      .morphoBlue.markets,
  ).map((m) => m.toLowerCase()) as `0x${string}`[]

/** One address's dust read and the sweep's simulation (null when it holds no dust). */
async function dustOf(owner: Address, markets: `0x${string}`[], from: string) {
  const client = getMainnetClient()
  const read = await readDust(client, owner, markets, 'public rpc', from)
  const { dust } = splitDust(read.candidates)
  const sim = dust.length ? await simulateLever(client, owner, dustCalls(owner, dust)) : null
  return { read, dust, sim }
}

/**
 * The dust states' reads:
 *   lender  DUST_LENDER (or the address given), every supply position: zero-asset Morpho
 *           supplies and one worth a fraction of a cent, swept for more gas than they
 *           return (dust-gas-exceeds-value); the zero-asset subset simulated on its own
 *           (dust-nothing-to-receive)
 *   ready   the first recent Aave V3 borrower holding priced dust whose sweep returns more
 *           than its gas at today's fee (dust-ready). Its Morpho read covers the listed
 *           markets only (no Supply-event scan per borrower)
 */
async function captureDust(owner: Address) {
  const markets = listedMarkets()
  const own = await ownSupplyMarkets(owner)
  const all = [...new Set([...markets, ...own])] as `0x${string}`[]
  console.log(`dust: ${markets.length} listed markets + ${own.length} from ${owner}'s Supply events = ${all.length}`)
  const lender = await dustOf(owner, all, "the discovery list and the owner's Supply events")
  for (const c of lender.read.candidates) {
    console.log(`dust: ${c.label} · assets ${c.assets} · $${c.priceUsd ?? '—'} · ${dustVerdict(c).why}`)
  }
  if (!lender.sim) throw new Error(`dust: ${owner} holds no dust`)
  // The zero-asset subset alone, for the "nothing to receive" state: its own simulation.
  const zero = lender.dust.filter((c) => c.assets === 0n)
  const simZero = zero.length
    ? await simulateLever(getMainnetClient(), owner, dustCalls(owner, zero))
    : null
  const t = dustTotals(lender.dust, lender.sim, lender.read.ethUsd)
  console.log(`dust lender: ${lender.dust.length} qualify · gas $${t.gasUsd} for $${t.receiveUsd} · ${t.warning}`)

  let ready: Awaited<ReturnType<typeof dustOf>> | null = null
  for (const who of (await borrowers(AAVE_POOL, 10)).slice(0, 200)) {
    let r
    try {
      r = await dustOf(who, markets, 'the discovery list only')
    } catch {
      continue
    }
    if (!r.sim || !r.sim.ok) continue
    const rt = dustTotals(r.dust, r.sim, r.read.ethUsd)
    if (rt.warning !== null) continue
    console.log(`dust ready ${who}: ${r.dust.length} qualify · gas $${rt.gasUsd} for $${rt.receiveUsd}`)
    ready = r
    break
  }
  if (!ready) throw new Error('dust: no borrower whose dust returns more than its gas')

  const strip = (x: { read: unknown; sim: unknown }) => ({ read: x.read, sim: x.sim })
  const json = JSON.stringify(
    { capturedAt: new Date().toISOString(), lender: strip(lender), simZero, ready: strip(ready) },
    (_k, v) => (typeof v === 'bigint' ? { $bigint: v.toString() } : v),
  )
  writeFileSync(DUST_OUT, json + '\n')
  console.log(`wrote ${DUST_OUT} (${json.length} bytes)`)
}

async function main() {
  const d = process.argv.indexOf('--dust')
  if (d >= 0) return captureDust((process.argv[d + 1] as Address | undefined) ?? DUST_LENDER)
  if (process.argv.includes('--baseline')) {
    const fx = JSON.parse(readFileSync(RATES_OUT, 'utf8')) as RateFixture
    const b = await captureBaseline(fx)
    writeFileSync(BASELINE_OUT, JSON.stringify(b) + '\n')
    console.log(`wrote ${BASELINE_OUT} · ${Object.values(b.series)[0].length} days × ${Object.keys(b.series).length} legs`)
    return
  }
  if (process.argv.includes('--incentives')) {
    const fx = JSON.parse(readFileSync(RATES_OUT, 'utf8')) as RateFixture
    fx.incentives = await captureIncentives(fx)
    writeFileSync(RATES_OUT, JSON.stringify(fx) + '\n')
    console.log(`wrote ${RATES_OUT} · incentives from ${fx.incentives.searched} live opportunities`)
    return
  }
  if (process.argv.includes('--rates')) {
    const fx = JSON.parse(readFileSync(OUT, 'utf8')) as {
      ready: { intent: { owner: Address }; prepared: { position: ProtocolPosition } }
    }
    return writeRates(fx.ready.intent.owner, fx.ready.prepared.position)
  }
  const ready = await find('aave-v3', AAVE_POOL, 'repay', true)
  const short = await find('aave-v3', AAVE_POOL, 'repay', false)
  const add = await find('aave-v3', AAVE_POOL, 'add', null)
  const spark = await find('spark', SPARK_POOL, 'repay', null)
  const head = await logs.getBlockNumber()
  const repays = await logs.getLogs({
    address: AAVE_POOL,
    event: repay,
    fromBlock: head - 300n,
    toBlock: head,
  })
  const txs = [...new Set(repays.map((l) => l.transactionHash as Hash))].slice(0, 3)
  const capturedAt = new Date().toISOString()
  const json = JSON.stringify({ capturedAt, ready, short, add, spark, txs }, (_k, v) =>
    typeof v === 'bigint' ? { $bigint: v.toString() } : v,
  )
  writeFileSync(OUT, json + '\n')
  console.log(`wrote ${OUT} (${json.length} bytes) · ${txs.length} repay hashes`)
  await writeRates(ready.intent.owner, ready.prepared.position)
}

void main()
