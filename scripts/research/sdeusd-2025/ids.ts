// Who the sdeUSD/USDC lenders are: for each position in <market json> (zombie.ts output) and
// any extra address: code, nonce, name(), MetaMorpho v1.0 / v1.1 factory membership, owner,
// curator, guardian, timelock, fee, totalAssets, share price, lostAssets, withdraw queue,
// Safe owners. One JSON line per address on stdout.
//   tsx ids.ts <market.json> [address …]
import { readFileSync } from 'fs'
import { keccakText } from '../../../lib/curatorFeed/keccak'
import { FeedRpc, endpointsFromEnv } from '../../lib/curator-feed-rpc'
const rpc = new FeedRpc(endpointsFromEnv())
const sel = (s: string) => keccakText(s).slice(0, 10)
const pad = (x: string) => x.toLowerCase().replace(/^0x/, '').padStart(64, '0')
const c = async (to: string, data: string) => {
  try {
    return await rpc.call<string>('eth_call', [{ to, data }, 'latest'])
  } catch {
    return null
  }
}
const str = (r: string | null) => {
  if (!r || r.length < 130) return undefined
  try {
    const b = Buffer.from(r.slice(2), 'hex')
    const o = Number(BigInt('0x' + b.subarray(0, 32).toString('hex')))
    const n = Number(BigInt('0x' + b.subarray(o, o + 32).toString('hex')))
    return b.subarray(o + 32, o + 32 + n).toString()
  } catch {
    return undefined
  }
}
const addr = (r: string | null) => (r && r.length >= 66 ? '0x' + r.slice(26, 66) : undefined)
const W = (r: string | null, i = 0) =>
  r && r.length >= 2 + 64 * (i + 1)
    ? BigInt('0x' + r.slice(2 + 64 * i, 2 + 64 * (i + 1)))
    : undefined
const F10 = '0xa9c3d3a366466fa809d1ae982fb2c46e5fc41101',
  F11 = '0x1897a8997241c1cd4bd0698647e4eb7213535c24'
async function main() {
  const d = JSON.parse(readFileSync(process.argv[2], 'utf8'))
  const extra = process.argv.slice(3)
  const S2 = BigInt(d.accrual.S)
  const rows: any[] = d.positions.map((p: any) => ({ ...p }))
  for (const x of extra)
    if (!rows.find((r) => r.address === x))
      rows.push({ address: x, supplyAssetsAtHead: '0', borrowAssetsAtHead: '0', collateral: '0' })
  for (const r of rows) {
    const a = r.address
    const code = await rpc.call<string>('eth_getCode', [a, 'latest'])
    r.codeBytes = (code.length - 2) / 2
    r.nonce = parseInt(await rpc.call<string>('eth_getTransactionCount', [a, 'latest']), 16)
    if (r.codeBytes > 0) {
      r.name = str(await c(a, sel('name()')))
      r.isMetaMorphoV10 = W(await c(F10, sel('isMetaMorpho(address)') + pad(a))) === 1n
      r.isMetaMorphoV11 = W(await c(F11, sel('isMetaMorpho(address)') + pad(a))) === 1n
      const own = await c(a, sel('getOwners()'))
      if (own && own.length > 130) {
        const n = Number(W(own, 1))
        r.safeOwners = Array.from(
          { length: n },
          (_, i) => '0x' + own.slice(2 + 128 + 64 * i + 24, 2 + 128 + 64 * (i + 1)),
        )
        r.safeThreshold = Number(W(await c(a, sel('getThreshold()'))))
      }
      if (r.isMetaMorphoV10 || r.isMetaMorphoV11) {
        r.owner = addr(await c(a, sel('owner()')))
        r.curator = addr(await c(a, sel('curator()')))
        r.guardian = addr(await c(a, sel('guardian()')))
        r.timelock = W(await c(a, sel('timelock()')))?.toString()
        r.fee = W(await c(a, sel('fee()')))?.toString()
        r.totalAssets = W(await c(a, sel('totalAssets()')))?.toString()
        r.totalSupply = W(await c(a, sel('totalSupply()')))?.toString()
        r.sharePrice = W(
          await c(a, sel('convertToAssets(uint256)') + (10n ** 18n).toString(16).padStart(64, '0')),
        )?.toString()
        r.lastTotalAssets = W(await c(a, sel('lastTotalAssets()')))?.toString()
        r.lostAssets = W(await c(a, sel('lostAssets()')))?.toString()
        const wql = Number(W(await c(a, sel('withdrawQueueLength()'))) ?? 0n)
        r.withdrawQueue = []
        for (let i = 0; i < wql; i++)
          r.withdrawQueue.push(
            '0x' +
              (await c(a, sel('withdrawQueue(uint256)') + i.toString(16).padStart(64, '0')))!.slice(
                2,
                66,
              ),
          )
        r.idleUSDC = W(
          await c('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', sel('balanceOf(address)') + pad(a)),
        )?.toString()
      }
    }
    r.claimShareOfMarket = Number((BigInt(r.supplyAssetsAtHead) * 1_000_000n) / (S2 || 1n)) / 1e6
  }
  rows.sort((a, b) => (BigInt(b.supplyAssetsAtHead) > BigInt(a.supplyAssetsAtHead) ? 1 : -1))
  console.log(JSON.stringify(rows, null, 0))
}
main()
