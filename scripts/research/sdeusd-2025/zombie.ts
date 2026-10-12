// Full on-chain record of one Morpho Blue market: events since creation, every position at the
// finalized head with interest accrued to the head timestamp (Morpho's own math), the oracle
// path and its failure point, and a weekly series. Output JSON.
import { writeFileSync } from 'fs'
import { keccakText } from '../../../lib/curatorFeed/keccak'
import { FeedRpc, endpointsFromEnv } from '../../lib/curator-feed-rpc'
import { revertOnset } from '../../../lib/curatorFeed/flags'
const rpc = new FeedRpc(endpointsFromEnv())
const MORPHO = '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb'
const [MARKET, FROM, OUT] = [
  process.argv[2].toLowerCase(),
  Number(process.argv[3]),
  process.argv[4],
]
const sel = (s: string) => keccakText(s).slice(0, 10)
const T = (s: string) => keccakText(s)
const hex = (n: number) => '0x' + n.toString(16)
const pad = (x: string | bigint) =>
  (typeof x === 'bigint' ? x.toString(16) : x.toLowerCase().replace(/^0x/, '')).padStart(64, '0')
const W = (r: string | null | undefined, i: number) =>
  r && r.length >= 2 + 64 * (i + 1)
    ? BigInt('0x' + r.slice(2 + 64 * i, 2 + 64 * (i + 1)))
    : undefined
const A = (r: string | null | undefined, i: number) => {
  const w = W(r, i)
  return w === undefined ? undefined : '0x' + w.toString(16).padStart(40, '0')
}
const ethCall = async (to: string, data: string, b: number | 'latest' = 'latest') => {
  try {
    return await rpc.call<string>('eth_call', [{ to, data }, typeof b === 'number' ? hex(b) : b])
  } catch (e) {
    return 'ERR:' + String(e).slice(0, 300)
  }
}
const str = (r: string) => {
  try {
    const b = Buffer.from(r.slice(2), 'hex')
    const o = Number(BigInt('0x' + b.subarray(0, 32).toString('hex')))
    const n = Number(BigInt('0x' + b.subarray(o, o + 32).toString('hex')))
    return b.subarray(o + 32, o + 32 + n).toString()
  } catch {
    return undefined
  }
}
const WAD = 10n ** 18n
const taylor = (x: bigint, n: bigint) => {
  const f = x * n
  const s = (f * f) / (2n * WAD)
  const t = (s * f) / (3n * WAD)
  return f + s + t
}
async function main() {
  const headB = await rpc.call<{ number: string; timestamp: string }>('eth_getBlockByNumber', [
    'finalized',
    false,
  ])
  const head = parseInt(headB.number, 16),
    headTs = BigInt(parseInt(headB.timestamp, 16))
  const p = await ethCall(MORPHO, sel('idToMarketParams(bytes32)') + pad(MARKET))
  const [loan, coll, oracle, irm] = [0, 1, 2, 3].map((i) => A(p, i)!)
  const lltv = W(p, 4)!
  // Oracle path
  const og: Record<string, string> = {}
  for (const g of [
    'BASE_FEED_1()',
    'BASE_FEED_2()',
    'QUOTE_FEED_1()',
    'QUOTE_FEED_2()',
    'BASE_VAULT()',
    'QUOTE_VAULT()',
    'BASE_VAULT_CONVERSION_SAMPLE()',
    'QUOTE_VAULT_CONVERSION_SAMPLE()',
    'SCALE_FACTOR()',
  ])
    og[g] = await ethCall(oracle, sel(g))
  const feeds = ['BASE_FEED_1()', 'BASE_FEED_2()', 'QUOTE_FEED_1()', 'QUOTE_FEED_2()']
    .map((g) => A(og[g], 0))
    .filter((x) => x && x !== '0x' + '0'.repeat(40)) as string[]
  const feedInfo: Record<string, unknown> = {}
  for (const f of feeds)
    feedInfo[f] = {
      description: str(await ethCall(f, sel('description()'))),
      decimals: W(await ethCall(f, sel('decimals()')), 0)?.toString(),
      latestNow: await ethCall(f, sel('latestRoundData()')),
    }
  const priceRevertsAt = async (b: number) =>
    (await ethCall(oracle, sel('price()'), b)).startsWith('ERR')
  const onset = (await priceRevertsAt(head))
    ? await revertOnset(priceRevertsAt, head, FROM + 1)
    : null
  const lastOk = onset && !onset.beforeWindow ? onset.since - 1 : null
  const atLastOk: Record<string, unknown> = {}
  if (lastOk) {
    atLastOk.block = lastOk
    atLastOk.ts = parseInt(
      (await rpc.call<{ timestamp: string }>('eth_getBlockByNumber', [hex(lastOk), false]))
        .timestamp,
      16,
    )
    atLastOk.price = W(await ethCall(oracle, sel('price()'), lastOk), 0)?.toString()
    for (const f of feeds) atLastOk[f] = await ethCall(f, sel('latestRoundData()'), lastOk)
    atLastOk.revertAtOnset = await ethCall(oracle, sel('price()'), onset!.since)
    for (const f of feeds)
      atLastOk['feedAtOnset:' + f] = await ethCall(f, sel('latestRoundData()'), onset!.since)
  }
  // Events since creation
  const EV: Record<string, string> = {
    [T('Supply(bytes32,address,address,uint256,uint256)')]: 'Supply',
    [T('Withdraw(bytes32,address,address,address,uint256,uint256)')]: 'Withdraw',
    [T('Borrow(bytes32,address,address,address,uint256,uint256)')]: 'Borrow',
    [T('Repay(bytes32,address,address,uint256,uint256)')]: 'Repay',
    [T('SupplyCollateral(bytes32,address,address,uint256)')]: 'SupplyCollateral',
    [T('WithdrawCollateral(bytes32,address,address,address,uint256)')]: 'WithdrawCollateral',
    [T('Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)')]: 'Liquidate',
    [T('AccrueInterest(bytes32,uint256,uint256,uint256)')]: 'AccrueInterest',
    [T('SetFee(bytes32,uint256)')]: 'SetFee',
  }
  const logs = await rpc.getLogs(
    { address: MORPHO, topics: [Object.keys(EV), MARKET] },
    FROM,
    head,
    { dual: true, concurrency: 4 },
  )
  const a = (t: string) => '0x' + t.slice(26)
  const events = logs
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
        case 'Liquidate':
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
        case 'AccrueInterest':
          return { ...base, prevBorrowRate: w(0), interest: w(1), feeShares: w(2) }
        default:
          return { ...base, data: l.data }
      }
    })
    .sort((x, y) => x.block - y.block || x.logIndex - y.logIndex)
  const blocks = [...new Set(events.map((e) => e.block))]
  const tsOf = new Map<number, number>()
  const hdrs = await rpc.batch(
    blocks.map((b) => ({ method: 'eth_getBlockByNumber', params: [hex(b), false] })),
  )
  blocks.forEach(
    (b, i) => hdrs[i] && tsOf.set(b, parseInt((hdrs[i] as { timestamp: string }).timestamp, 16)),
  )
  for (const e of events) (e as Record<string, unknown>).ts = tsOf.get(e.block)
  // Market at head + accrual to head
  const m = await ethCall(MORPHO, sel('market(bytes32)') + pad(MARKET))
  let [S, Ss, B, Bs, last, fee] = [0, 1, 2, 3, 4, 5].map((i) => W(m, i)!)
  const ivals = [
    '0x' + [loan, coll, oracle, irm].map(pad).join('') + pad(lltv),
    [S, Ss, B, Bs, last, fee].map(pad).join(''),
  ]
  const rate =
    W(
      await ethCall(
        irm,
        sel(
          'borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128))',
        ) +
          ivals[0].slice(2) +
          ivals[1],
      ),
      0,
    ) ?? 0n
  const elapsed = headTs - last
  const interest = (B * taylor(rate, elapsed)) / WAD
  const feeAmt = (interest * fee) / WAD
  const S2 = S + interest,
    B2 = B + interest
  const feeShares = feeAmt ? (feeAmt * (Ss + 1_000_000n)) / (S2 - feeAmt + 1n) : 0n
  const Ss2 = Ss + feeShares
  // Positions of every address seen
  const addrs = [
    ...new Set(events.flatMap((e: any) => [e.onBehalf, e.borrower].filter(Boolean))),
  ] as string[]
  const pos = await rpc.batch(
    addrs.map((u) => ({
      method: 'eth_call',
      params: [
        { to: MORPHO, data: sel('position(bytes32,address)') + pad(MARKET) + pad(u) },
        hex(head),
      ],
    })),
  )
  const codes = await rpc.batch(
    addrs.map((u) => ({ method: 'eth_getCode', params: [u, 'latest'] })),
  )
  const positions = addrs
    .map((u, i) => {
      const supplyShares = W(pos[i], 0) ?? 0n,
        borrowShares = W(pos[i], 1) ?? 0n,
        collateral = W(pos[i], 2) ?? 0n
      return {
        address: u,
        isContract: ((codes[i] as string) ?? '0x').length > 2,
        supplyShares: supplyShares.toString(),
        borrowShares: borrowShares.toString(),
        collateral: collateral.toString(),
        supplyAssetsStored: ((supplyShares * (S + 1n)) / (Ss + 1_000_000n)).toString(),
        supplyAssetsAtHead: ((supplyShares * (S2 + 1n)) / (Ss2 + 1_000_000n)).toString(),
        borrowAssetsAtHead: (
          (borrowShares * (B2 + 1n) + (Bs + 1_000_000n) - 1n) /
          (Bs + 1_000_000n)
        ).toString(),
      }
    })
    .filter((x) => x.supplyShares !== '0' || x.borrowShares !== '0' || x.collateral !== '0')
  // Weekly series since creation (stored state, oracle, collateral rate, feed answers)
  const pts: number[] = []
  for (let b = FROM + 1; b < head; b += 50_400) pts.push(b)
  pts.push(head)
  const ser = await rpc.batch(
    pts.flatMap((b) => [
      {
        method: 'eth_call',
        params: [{ to: MORPHO, data: sel('market(bytes32)') + pad(MARKET) }, hex(b)],
      },
      { method: 'eth_call', params: [{ to: oracle, data: sel('price()') }, hex(b)] },
      {
        method: 'eth_call',
        params: [{ to: coll, data: sel('convertToAssets(uint256)') + pad(WAD) }, hex(b)],
      },
      { method: 'eth_getBlockByNumber', params: [hex(b), false] },
      ...feeds.map((f) => ({
        method: 'eth_call',
        params: [{ to: f, data: sel('latestRoundData()') }, hex(b)],
      })),
    ]),
    40,
  )
  const per = 4 + feeds.length
  const series = pts.map((b, i) => {
    const r = ser.slice(i * per, i * per + per) as any[]
    return {
      block: b,
      ts: parseInt(r[3]?.timestamp ?? '0x0', 16),
      supply: W(r[0], 0)?.toString(),
      borrow: W(r[0], 2)?.toString(),
      lastUpdate: W(r[0], 4)?.toString(),
      oraclePrice: r[1] ? BigInt(r[1]).toString() : 'REVERT',
      collateralRate: W(r[2], 0)?.toString(),
      feeds: feeds.map((f, k) => ({
        feed: f,
        answer: W(r[4 + k], 1)?.toString(),
        updatedAt: W(r[4 + k], 3)?.toString(),
      })),
    }
  })
  const out = {
    market: MARKET,
    params: { loan, collateral: coll, oracle, irm, lltv: lltv.toString() },
    fromBlock: FROM,
    head,
    headTs: Number(headTs),
    oracleGetters: og,
    feeds: feedInfo,
    oracleRevert: onset,
    atLastOk,
    stored: {
      S: S.toString(),
      Ss: Ss.toString(),
      B: B.toString(),
      Bs: Bs.toString(),
      lastUpdate: last.toString(),
      fee: fee.toString(),
    },
    accrual: {
      borrowRatePerSec: rate.toString(),
      elapsed: elapsed.toString(),
      interest: interest.toString(),
      S: S2.toString(),
      B: B2.toString(),
      feeShares: feeShares.toString(),
    },
    positions,
    events,
    series,
    logStats: rpc.logStats,
  }
  writeFileSync(OUT, JSON.stringify(out))
  console.log(
    'events',
    events.length,
    'positions',
    positions.length,
    'series',
    series.length,
    'onset',
    JSON.stringify(onset),
    'rate/s',
    rate.toString(),
  )
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
