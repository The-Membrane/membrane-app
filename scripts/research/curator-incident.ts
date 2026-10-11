// curator-incident.ts — the on-chain timeline of one Morpho Blue market and one vault that
// lent into it, for incident write-ups (first used for the 2026 msY / AZND write-offs).
//
//   tsx scripts/research/curator-incident.ts --slug msy-alpha-2026 --name msy-delta \
//     --market 0x23a7…c8 --vault 0x0bf0…a334 --adapter 0x3d01…bf00 [--from <block>]
//
// Writes <datasets>/curator-incidents/<slug>/<name>.json (board rule N18: data goes to the
// private datasets repo; lib/curatorFeed/paths.ts). Reads, all at archive blocks:
//   - the market's params, its oracle's price() (and the first block of the current run of
//     reverts, lib/curatorFeed/flags.ts revertOnset);
//   - one row per 7,200 blocks from --from (default: the market's CreateMarket block) to the
//     finalized head: market() supply/borrow, oracle price, collateral convertToAssets(1e18)
//     when it is an ERC-4626, vault totalAssets/totalSupply, the adapter's position;
//   - every Supply / Withdraw / Borrow / Repay / SupplyCollateral / WithdrawCollateral /
//     Liquidate on the market, and every ERC-4626 Deposit / Withdraw on the vault (each log
//     chunk read from two endpoints and unioned, scripts/lib/curator-feed-rpc.ts).
// RPC: the curator collector's endpoints (labels only are printed).

import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

import { revertOnset } from '../../lib/curatorFeed/flags'
import { keccakText } from '../../lib/curatorFeed/keccak'
import { datasetsRoot } from '../../lib/curatorFeed/paths'
import { MAINNET } from '../lib/curator-feed-chain'
import { FeedRpc, endpointsFromEnv } from '../lib/curator-feed-rpc'

const arg = (k: string): string | undefined => {
  const i = process.argv.indexOf(`--${k}`)
  return i > 0 ? process.argv[i + 1] : undefined
}
const need = (k: string): string => {
  const v = arg(k)
  if (!v) throw new Error(`--${k} is required`)
  return v.toLowerCase()
}
const SLUG = need('slug')
const NAME = need('name')
const MARKET = need('market')
const VAULT = need('vault')
const ADAPTER = arg('adapter')?.toLowerCase()

const rpc = new FeedRpc(endpointsFromEnv())
const MORPHO = MAINNET.morpho
const sel = (s: string) => keccakText(s).slice(0, 10)
const hex = (n: number) => '0x' + n.toString(16)
const pad = (x: string | bigint) =>
  (typeof x === 'bigint' ? x.toString(16) : x.toLowerCase().replace(/^0x/, '')).padStart(64, '0')
const call = (to: string, data: string, b: number) => ({
  method: 'eth_call',
  params: [{ to, data }, hex(b)],
})
const W = (r: string | null, i: number) =>
  r && r.length >= 2 + 64 * (i + 1)
    ? BigInt('0x' + r.slice(2 + 64 * i, 2 + 64 * (i + 1)))
    : undefined
const addr = (r: string | null, i: number) => {
  const w = W(r, i)
  return w === undefined ? undefined : '0x' + w.toString(16).padStart(40, '0')
}
const log = (...a: unknown[]) => console.log('[incident]', ...a)

async function main() {
  const head = parseInt(
    (await rpc.call<{ number: string }>('eth_getBlockByNumber', ['finalized', false])).number,
    16,
  )
  const params = await rpc.call<string>('eth_call', [
    { to: MORPHO, data: sel('idToMarketParams(bytes32)') + pad(MARKET) },
    'latest',
  ])
  const [loan, collateral, oracle, irm] = [0, 1, 2, 3].map((i) => addr(params, i)!)
  const lltv = W(params, 4)!.toString()
  const T = (s: string) => keccakText(s)
  let from = Number(arg('from') ?? 0)
  if (!from) {
    const created = await rpc.getLogs(
      {
        address: MORPHO,
        topics: [T('CreateMarket(bytes32,(address,address,address,address,uint256))'), MARKET],
      },
      18_883_124, // Morpho Blue deployment
      head,
      { dual: true, concurrency: 4 },
    )
    from = created.length ? parseInt(created[0].blockNumber, 16) : head - 200 * 7200
  }
  log(
    `market ${MARKET} loan ${loan} collateral ${collateral} oracle ${oracle}; blocks ${from}–${head}`,
  )

  // Oracle: reverting now? Since when?
  const revertsAt = async (b: number) => {
    try {
      await rpc.call('eth_call', [{ to: oracle, data: sel('price()') }, hex(b)])
      return false
    } catch (e) {
      if (/revert/i.test(String(e))) return true
      throw e
    }
  }
  const oracleRevert = (await revertsAt(head)) ? await revertOnset(revertsAt, head, from) : null

  // Daily rows.
  const blocks: number[] = []
  for (let b = from + 1; b <= head; b += 7200) blocks.push(b)
  if (blocks[blocks.length - 1] !== head) blocks.push(head)
  const per = 7
  const res = await rpc.batch(
    blocks.flatMap((b) => [
      call(MORPHO, sel('market(bytes32)') + pad(MARKET), b),
      call(oracle, sel('price()'), b),
      call(collateral, sel('convertToAssets(uint256)') + pad(10n ** 18n), b),
      call(VAULT, sel('totalAssets()'), b),
      call(VAULT, sel('totalSupply()'), b),
      ADAPTER
        ? call(MORPHO, sel('position(bytes32,address)') + pad(MARKET) + pad(ADAPTER), b)
        : call(MORPHO, sel('position(bytes32,address)') + pad(MARKET) + pad(VAULT), b),
      { method: 'eth_getBlockByNumber', params: [hex(b), false] },
    ]),
    50,
  )
  const rows = blocks.map((b, i) => {
    const r = res.slice(i * per, i * per + per) as (string | null)[]
    const S = W(r[0], 0)
    const Sh = W(r[0], 1)
    const B = W(r[0], 2)
    const pos = W(r[5], 0)
    const ts = parseInt((r[6] as unknown as { timestamp?: string })?.timestamp ?? '0x0', 16)
    return {
      block: b,
      ts,
      day: new Date(ts * 1000).toISOString().slice(0, 10),
      totalSupplyAssets: S?.toString() ?? null,
      totalBorrowAssets: B?.toString() ?? null,
      oraclePrice: r[1] ? BigInt(r[1]).toString() : 'REVERT',
      collateralConvertToAssets1e18: W(r[2], 0)?.toString() ?? null,
      vaultTotalAssets: W(r[3], 0)?.toString() ?? null,
      vaultTotalSupply: W(r[4], 0)?.toString() ?? null,
      positionAssets:
        pos !== undefined && S !== undefined && Sh !== undefined
          ? ((pos * (S + 1n)) / (Sh + 1_000_000n)).toString()
          : null,
    }
  })

  // Market events.
  const EV: Record<string, string> = {
    [T('Supply(bytes32,address,address,uint256,uint256)')]: 'Supply',
    [T('Withdraw(bytes32,address,address,address,uint256,uint256)')]: 'Withdraw',
    [T('Borrow(bytes32,address,address,address,uint256,uint256)')]: 'Borrow',
    [T('Repay(bytes32,address,address,uint256,uint256)')]: 'Repay',
    [T('SupplyCollateral(bytes32,address,address,uint256)')]: 'SupplyCollateral',
    [T('WithdrawCollateral(bytes32,address,address,address,uint256)')]: 'WithdrawCollateral',
    [T('Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)')]: 'Liquidate',
  }
  const logs = await rpc.getLogs(
    { address: MORPHO, topics: [Object.keys(EV), MARKET] },
    from,
    head,
    {
      dual: true,
      concurrency: 4,
    },
  )
  const a = (t: string) => '0x' + t.slice(26)
  const marketEvents = logs
    .map((l) => {
      const name = EV[l.topics[0].toLowerCase()]
      const d = l.data.slice(2)
      const w = (i: number) => BigInt('0x' + d.slice(64 * i, 64 * (i + 1))).toString()
      const base = {
        block: parseInt(l.blockNumber, 16),
        logIndex: parseInt(l.logIndex, 16),
        tx: l.transactionHash,
        name,
      }
      switch (name) {
        case 'Supply':
        case 'Repay':
          return {
            ...base,
            caller: a(l.topics[2]),
            onBehalf: a(l.topics[3]),
            assets: w(0),
            shares: w(1),
          }
        case 'SupplyCollateral':
          return { ...base, caller: a(l.topics[2]), onBehalf: a(l.topics[3]), assets: w(0) }
        case 'Withdraw':
        case 'Borrow':
          return {
            ...base,
            caller: '0x' + d.slice(24, 64),
            onBehalf: a(l.topics[2]),
            receiver: a(l.topics[3]),
            assets: w(1),
            shares: w(2),
          }
        case 'WithdrawCollateral':
          return {
            ...base,
            caller: '0x' + d.slice(24, 64),
            onBehalf: a(l.topics[2]),
            receiver: a(l.topics[3]),
            assets: w(1),
          }
        default:
          return {
            ...base,
            caller: a(l.topics[2]),
            borrower: a(l.topics[3]),
            repaidAssets: w(0),
            repaidShares: w(1),
            seizedAssets: w(2),
            badDebtAssets: w(3),
            badDebtShares: w(4),
          }
      }
    })
    .sort((x, y) => x.block - y.block || x.logIndex - y.logIndex)

  // Vault ERC-4626 deposits / withdrawals (from a month before the market).
  const DEP = T('Deposit(address,address,uint256,uint256)')
  const WD = T('Withdraw(address,address,address,uint256,uint256)')
  const vlogs = await rpc.getLogs(
    { address: VAULT, topics: [[DEP, WD]] },
    Math.max(0, from - 30 * 7200),
    head,
    {
      dual: true,
      concurrency: 4,
    },
  )
  const vaultEvents = vlogs
    .map((l) => {
      const dep = l.topics[0].toLowerCase() === DEP
      const d = l.data.slice(2)
      return {
        block: parseInt(l.blockNumber, 16),
        logIndex: parseInt(l.logIndex, 16),
        tx: l.transactionHash,
        kind: dep ? 'deposit' : 'withdraw',
        owner: a(dep ? l.topics[2] : l.topics[3]),
        assets: BigInt('0x' + d.slice(0, 64)).toString(),
        shares: BigInt('0x' + d.slice(64, 128)).toString(),
      }
    })
    .sort((x, y) => x.block - y.block || x.logIndex - y.logIndex)

  const dir = join(datasetsRoot(), 'curator-incidents', SLUG)
  mkdirSync(dir, { recursive: true })
  const out = {
    market: MARKET,
    params: { loan, collateral, oracle, irm, lltv },
    vault: VAULT,
    adapter: ADAPTER ?? null,
    fromBlock: from,
    head,
    readAt: new Date().toISOString(),
    oracleRevert,
    rows,
    marketEvents,
    vaultEvents,
    logStats: rpc.logStats,
  }
  writeFileSync(join(dir, `${NAME}.json`), JSON.stringify(out) + '\n')
  log(
    `wrote curator-incidents/${SLUG}/${NAME}.json: ${rows.length} rows, ${marketEvents.length} market events, ${vaultEvents.length} vault events`,
  )
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`[incident] failed: ${rpc.scrub(String(e?.stack ?? e))}`)
    process.exit(1)
  },
)
