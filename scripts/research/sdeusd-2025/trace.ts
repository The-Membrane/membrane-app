// Token-transfer counterparties of one address over a block range, with names.
//   tsx trace.ts <address> <fromBlock> <toBlock>
import { keccakText } from '../../../lib/curatorFeed/keccak'
import { FeedRpc, endpointsFromEnv } from '../../lib/curator-feed-rpc'
const rpc = new FeedRpc(endpointsFromEnv())
const T = keccakText('Transfer(address,address,uint256)')
const tp = (a: string) => '0x' + a.slice(2).padStart(64, '0')
const sel = (s: string) => keccakText(s).slice(0, 10)
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
const nameOf = async (a: string) => {
  const code = await rpc.call<string>('eth_getCode', [a, 'latest'])
  if (code.length <= 2) return 'EOA'
  if (code.length === 48) return '7702'
  let n: string | undefined
  try {
    n = str(await rpc.call<string>('eth_call', [{ to: a, data: sel('name()') }, 'latest']))
  } catch {}
  return n ?? `contract(${(code.length - 2) / 2}b)`
}
async function flows(
  token: string,
  dec: number,
  who: string,
  dir: 'in' | 'out',
  from: number,
  to: number,
) {
  const topics = dir === 'out' ? [T, tp(who)] : [T, null, tp(who)]
  const logs = await rpc.getLogs({ address: token, topics }, from, to, {
    dual: true,
    concurrency: 4,
  })
  const m = new Map<string, number>()
  for (const l of logs) {
    const o = '0x' + l.topics[dir === 'out' ? 2 : 1].slice(26)
    m.set(o, (m.get(o) ?? 0) + Number(BigInt(l.data)) / 10 ** dec)
  }
  const top = [...m].sort((a, b) => b[1] - a[1]).slice(0, 6)
  return Promise.all(
    top.map(async ([a, v]) => `${a} (${await nameOf(a)}) ${Math.round(v).toLocaleString()}`),
  )
}
async function main() {
  const [who, from, to] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4])]
  const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    SDE = '0x5c5b196abe0d54485975d1ec29617d42d9198326',
    DE = '0x15700b564ca08d9439c58ca5053166e8317aa138'
  console.log(who, await nameOf(who), `blocks ${from}-${to}`)
  console.log(' USDC out ->', (await flows(USDC, 6, who, 'out', from, to)).join(' | '))
  console.log(' USDC in  <-', (await flows(USDC, 6, who, 'in', from, to)).join(' | '))
  console.log(' sdeUSD in <-', (await flows(SDE, 18, who, 'in', from, to)).join(' | '))
  console.log(' sdeUSD out->', (await flows(SDE, 18, who, 'out', from, to)).join(' | '))
  console.log(' deUSD in  <-', (await flows(DE, 18, who, 'in', from, to)).join(' | '))
  console.log(' deUSD out ->', (await flows(DE, 18, who, 'out', from, to)).join(' | '))
}
main()
