// Vault depositor runs around the Nov 2025 write-offs: ERC-4626 Withdraw/Deposit per owner per day
// for the lender vaults, Oct 28 – Nov 20 2025; and the Safe behind the Nov 13 Relend exit.
import { writeFileSync } from 'fs'
import { keccakText } from '../../../lib/curatorFeed/keccak'
import { FeedRpc, endpointsFromEnv } from '../../lib/curator-feed-rpc'
const rpc = new FeedRpc(endpointsFromEnv())
const T = keccakText,
  sel = (s: string) => keccakText(s).slice(0, 10)
const hex = (n: number) => '0x' + n.toString(16)
const DEP = T('Deposit(address,address,uint256,uint256)'),
  WD = T('Withdraw(address,address,address,uint256,uint256)')
const VAULTS: [string, string][] = [
  ['Relend USDC', '0x0f359fd18bda75e9c49bc027e7da59a4b01bf32a'],
  ['Usual Boosted USDC', '0xd63070114470f685b75b74d60eec7c1113d33a3d'],
  ['Avantgarde USDC Core', '0x5b56f90340dbaa6a8693dadb141d620f0e154fe6'],
]
const a = (t: string) => '0x' + t.slice(26)
async function main() {
  const from = 23_670_000,
    to = 23_830_000 // ~Oct 28 – Nov 19 2025
  const out: any = {}
  for (const [name, v] of VAULTS) {
    const logs = await rpc.getLogs({ address: v, topics: [[DEP, WD]] }, from, to, {
      dual: true,
      concurrency: 4,
    })
    const blocks = [...new Set(logs.map((l) => parseInt(l.blockNumber, 16)))]
    const hd = await rpc.batch(
      blocks.map((b) => ({ method: 'eth_getBlockByNumber', params: [hex(b), false] })),
    )
    const tsOf = new Map(
      blocks.map((b, i) => [b, parseInt((hd[i] as any)?.timestamp ?? '0x0', 16)]),
    )
    const ev = logs
      .map((l) => {
        const dep = l.topics[0].toLowerCase() === DEP
        const d = l.data.slice(2)
        const b = parseInt(l.blockNumber, 16)
        return {
          block: b,
          ts: tsOf.get(b)!,
          tx: l.transactionHash,
          kind: dep ? 'deposit' : 'withdraw',
          owner: a(dep ? l.topics[2] : l.topics[3]),
          assets: Number(BigInt('0x' + d.slice(0, 64))) / 1e6,
        }
      })
      .sort((x, y) => x.block - y.block)
    out[name] = ev
    const byDay = new Map<
      string,
      { dep: number; wd: number; n: number; owners: Map<string, number> }
    >()
    for (const e of ev) {
      const day = new Date(e.ts * 1000).toISOString().slice(0, 10)
      const r = byDay.get(day) ?? { dep: 0, wd: 0, n: 0, owners: new Map() }
      if (e.kind === 'deposit') r.dep += e.assets
      else {
        r.wd += e.assets
        r.owners.set(e.owner, (r.owners.get(e.owner) ?? 0) + e.assets)
      }
      r.n++
      byDay.set(day, r)
    }
    console.log('==', name)
    for (const [day, r] of byDay) {
      const top = [...r.owners]
        .sort((x, y) => y[1] - x[1])
        .slice(0, 4)
        .map(([o, x]) => `${o.slice(0, 10)}:${Math.round(x)}`)
        .join(' ')
      console.log(
        '  ',
        day,
        'dep',
        Math.round(r.dep),
        'wd',
        Math.round(r.wd),
        'n',
        r.n,
        'owners',
        r.owners.size,
        top,
      )
    }
  }
  // The Safe
  const safe = '0xc2902ec94b67a6115e94be104c99055c0a13e978'
  const [owners, thr, ver] = await rpc.batch([
    { method: 'eth_call', params: [{ to: safe, data: sel('getOwners()') }, 'latest'] },
    { method: 'eth_call', params: [{ to: safe, data: sel('getThreshold()') }, 'latest'] },
    { method: 'eth_call', params: [{ to: safe, data: sel('VERSION()') }, 'latest'] },
  ])
  const o = owners as string | null
  const n = o ? Number(BigInt('0x' + o.slice(66, 130))) : 0
  const list = o
    ? Array.from({ length: n }, (_, i) => '0x' + o.slice(130 + 64 * i + 24, 130 + 64 * (i + 1)))
    : []
  console.log(
    'SAFE',
    safe,
    'owners',
    list,
    'threshold',
    thr ? BigInt(thr as string).toString() : null,
    'ver',
    ver ? Buffer.from((ver as string).slice(130).replace(/0+$/, ''), 'hex').toString() : null,
  )
  // Relend share balance of the Safe before/after
  for (const b of [23790003, 23790812, 23790908]) {
    const r = await rpc.call<string>('eth_call', [
      { to: VAULTS[0][1], data: sel('balanceOf(address)') + safe.slice(2).padStart(64, '0') },
      hex(b),
    ])
    console.log('  safe Relend shares @', b, Number(BigInt(r)) / 1e18)
  }
  writeFileSync(process.argv[2], JSON.stringify(out))
}
main().then(
  () => process.exit(0),
  (e) => {
    console.error(rpc.scrub(String(e?.stack ?? e)))
    process.exit(1)
  },
)
