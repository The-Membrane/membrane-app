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

import { writeFileSync } from 'node:fs'
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
import { erc20ReadAbi } from '@/lib/position-exec/abis'
import { leverUnits } from '@/lib/position-exec/amount'
import type { ExecProtocol } from '@/lib/position-exec/read'
import { simulateLever } from '@/lib/position-exec/simulate'
import { TOUCH_TABLE } from '@/lib/position/touchHistory'
import { ADAPTERS, runAdapter } from '@/lib/position-sim/adapters'
import { getMainnetClient } from '@/lib/position-sim/rpc'
import type { ActionRow } from '@/lib/position/reverseSolve'

const OUT = path.resolve(__dirname, '../../components/PositionV0/dev/slipFixtures.json')
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

async function main() {
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
}

void main()
