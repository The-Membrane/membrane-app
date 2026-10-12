// Compound v3 cUSDCv3 and Hyperithm reads for the sdeUSD/USDC borrower (0x1597…5763):
// sdeUSD collateral, AbsorbDebt / AbsorbCollateral, and USDC flows. Prints to stdout.
import { keccakText } from '../../../lib/curatorFeed/keccak'
import { FeedRpc, endpointsFromEnv } from '../../lib/curator-feed-rpc'
const rpc = new FeedRpc(endpointsFromEnv())
const sel = (s: string) => keccakText(s).slice(0, 10)
const pad = (x: string | bigint) =>
  (typeof x === 'bigint' ? x.toString(16) : x.toLowerCase().replace(/^0x/, '')).padStart(64, '0')
const hex = (n: number) => '0x' + n.toString(16)
const c = async (to: string, data: string, b: number | 'latest' = 'latest') => {
  try {
    return await rpc.call<string>('eth_call', [{ to, data }, typeof b === 'number' ? hex(b) : b])
  } catch (e) {
    return 'ERR ' + String(e).slice(0, 120)
  }
}
const W = (r: string, i = 0) =>
  r && r.startsWith('0x') && r.length >= 2 + 64 * (i + 1)
    ? BigInt('0x' + r.slice(2 + 64 * i, 2 + 64 * (i + 1)))
    : undefined
const COMET = '0xc3d688b66703497daa19211eedff47f25384cdc3',
  SDE = '0x5c5b196abe0d54485975d1ec29617d42d9198326',
  B = '0x1597e4b7cf6d2877a1d690b6088668afdb045763'
const T = keccakText
async function main() {
  // Compound v3: is sdeUSD a collateral asset? AssetInfo(offset, asset, priceFeed, scale, borrowCF, liquidateCF, liquidationFactor, supplyCap)
  const info = await c(COMET, sel('getAssetInfoByAddress(address)') + pad(SDE))
  console.log('comet assetInfo(sdeUSD)', info.slice(0, 2 + 64 * 8))
  if (info.startsWith('0x')) {
    const feed = '0x' + info.slice(2 + 64 * 2 + 24, 2 + 64 * 3)
    console.log(
      ' priceFeed',
      feed,
      'borrowCF',
      Number(W(info, 4)) / 1e18,
      'liqCF',
      Number(W(info, 5)) / 1e18,
      'supplyCap',
      Number(W(info, 7)) / 1e18,
    )
    console.log(' getPrice now', await c(COMET, sel('getPrice(address)') + pad(feed)))
  }
  console.log(
    ' userCollateral(B, sdeUSD) now',
    await c(COMET, sel('userCollateral(address,address)') + pad(B) + pad(SDE)),
  )
  console.log(' borrowBalanceOf(B) now', await c(COMET, sel('borrowBalanceOf(address)') + pad(B)))
  console.log(
    ' totalsCollateral(sdeUSD)',
    await c(COMET, sel('totalsCollateral(address)') + pad(SDE)),
  )
  // Absorb events involving B
  const head = parseInt(
    (await rpc.call<{ number: string }>('eth_getBlockByNumber', ['finalized', false])).number,
    16,
  )
  const absorbDebt = T('AbsorbDebt(address,address,uint256,uint256)'),
    absorbColl = T('AbsorbCollateral(address,address,address,uint256,uint256)')
  const logs = await rpc.getLogs(
    { address: COMET, topics: [[absorbDebt, absorbColl], null, '0x' + pad(B)] },
    23500000,
    head,
    { dual: true, concurrency: 4 },
  )
  for (const l of logs)
    console.log(
      ' absorb',
      parseInt(l.blockNumber, 16),
      l.topics[0] === absorbDebt ? 'AbsorbDebt' : 'AbsorbCollateral',
      l.data.slice(0, 2 + 64 * 3),
    )
  // Supply/withdraw collateral events of sdeUSD by B on Comet
  const sc = T('SupplyCollateral(address,address,address,uint256)'),
    wc = T('WithdrawCollateral(address,address,address,uint256)')
  const cl = await rpc.getLogs(
    { address: COMET, topics: [[sc, wc], null, null, '0x' + pad(SDE)] },
    23000000,
    head,
    { dual: true, concurrency: 4 },
  )
  const agg = new Map<string, number>()
  for (const l of cl) {
    const k = (l.topics[0] === sc ? 'S ' : 'W ') + '0x' + l.topics[2].slice(26)
    agg.set(k, (agg.get(k) ?? 0) + Number(BigInt(l.data)) / 1e18)
  }
  console.log(
    ' sdeUSD collateral flows on Comet (by dst/src):',
    JSON.stringify([...agg].sort((a, b) => b[1] - a[1]).slice(0, 10)),
  )
  // Hyperithm vault: Withdraw events with owner = B, Oct 20 - Nov 5 2025
  const HY = '0x777791c4d6dc2ce140d00d2828a7c93503c67777'
  const WD = T('Withdraw(address,address,address,uint256,uint256)'),
    DEP = T('Deposit(address,address,uint256,uint256)')
  const hy = await rpc.getLogs({ address: HY, topics: [[WD, DEP]] }, 23600000, 23760000, {
    dual: true,
    concurrency: 4,
  })
  const hagg = new Map<string, number>()
  for (const l of hy) {
    const isW = l.topics[0] === WD
    const o = '0x' + (isW ? l.topics[3] : l.topics[2]).slice(26)
    const k = (isW ? 'W ' : 'D ') + o
    hagg.set(k, (hagg.get(k) ?? 0) + Number(BigInt('0x' + l.data.slice(2, 66))) / 1e6)
  }
  console.log(
    ' Hyperithm USDC Apex deposits/withdrawals blocks 23.60M-23.76M (Oct 20-Nov 11 2025), top:',
    JSON.stringify(
      [...hagg]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([k, v]) => [k, Math.round(v)]),
    ),
  )
}
main()
