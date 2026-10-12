// Per lender vault: curator config events for the sdeUSD/USDC market + the vault's
// Deposit/Withdraw/AccrueInterest/UpdateLostAssets, and totalAssets / share price one block
// before and at every config event. Output JSON to argv[2].
import { writeFileSync } from 'fs'
import { keccakText } from '../../../lib/curatorFeed/keccak'
import { FeedRpc, endpointsFromEnv } from '../../lib/curator-feed-rpc'
const rpc = new FeedRpc(endpointsFromEnv())
const T = keccakText,
  sel = (s: string) => keccakText(s).slice(0, 10)
const hex = (n: number) => '0x' + n.toString(16)
const W = (r: string | null, i = 0) =>
  r && r.length >= 2 + 64 * (i + 1)
    ? BigInt('0x' + r.slice(2 + 64 * i, 2 + 64 * (i + 1)))
    : undefined
const M = '0x0f9563442d64ab3bd3bcb27058db0b0d4046a4c46f0acd811dacae9551d2b129'
const MORPHO = '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb'
const VAULTS: [string, string][] = [
  ['Relend USDC', '0x0f359fd18bda75e9c49bc027e7da59a4b01bf32a'],
  ['Usual Boosted USDC', '0xd63070114470f685b75b74d60eec7c1113d33a3d'],
  ['Avantgarde USDC Core', '0x5b56f90340dbaa6a8693dadb141d620f0e154fe6'],
  ['Adpend USDC', '0x55555815a5595991c3a0ff119b59aef6c8b55555'],
  ['1337 USDC', '0x94643e86aa5e38ddac6c7791c1297f4e40cd96c1'],
]
const EV: Record<string, string> = {
  [T('SubmitCap(address,bytes32,uint256)')]: 'SubmitCap',
  [T('SetCap(address,bytes32,uint256)')]: 'SetCap',
  [T('SubmitMarketRemoval(address,bytes32)')]: 'SubmitMarketRemoval',
  [T('RevokePendingMarketRemoval(address,bytes32)')]: 'RevokePendingMarketRemoval',
  [T('SetWithdrawQueue(address,bytes32[])')]: 'SetWithdrawQueue',
  [T('SetSupplyQueue(address,bytes32[])')]: 'SetSupplyQueue',
  [T('ReallocateSupply(address,bytes32,uint256,uint256)')]: 'ReallocateSupply',
  [T('ReallocateWithdraw(address,bytes32,uint256,uint256)')]: 'ReallocateWithdraw',
  [T('UpdateLostAssets(uint256)')]: 'UpdateLostAssets',
  [T('SetCurator(address)')]: 'SetCurator',
  [T('OwnershipTransferred(address,address)')]: 'OwnershipTransferred',
  [T('SetIsAllocator(address,bool)')]: 'SetIsAllocator',
  [T('SetName(string)')]: 'SetName',
}
const mkt = (l: any) => l.topics[2]?.toLowerCase() === M
async function main() {
  const head = parseInt(
    (await rpc.call<{ number: string }>('eth_getBlockByNumber', ['finalized', false])).number,
    16,
  )
  const out: any = { head, market: M, vaults: {} }
  for (const [name, v] of VAULTS) {
    const logs = await rpc.getLogs({ address: v, topics: [Object.keys(EV)] }, 21_700_000, head, {
      dual: true,
      concurrency: 4,
    })
    const keep = logs.filter((l) => {
      const k = EV[l.topics[0].toLowerCase()]
      if (
        [
          'SubmitCap',
          'SetCap',
          'SubmitMarketRemoval',
          'RevokePendingMarketRemoval',
          'ReallocateSupply',
          'ReallocateWithdraw',
        ].includes(k)
      )
        return mkt(l)
      if (k === 'SetWithdrawQueue') return true // filtered below by membership change
      return true
    })
    const blocks = [...new Set(keep.map((l) => parseInt(l.blockNumber, 16)))]
    const hd = await rpc.batch(
      blocks.map((b) => ({ method: 'eth_getBlockByNumber', params: [hex(b), false] })),
    )
    const tsOf = new Map(
      blocks.map((b, i) => [b, parseInt((hd[i] as any)?.timestamp ?? '0x0', 16)]),
    )
    let prevHas: boolean | undefined
    const ev: any[] = []
    for (const l of keep.sort(
      (a, b) =>
        parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16) ||
        parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16),
    )) {
      const k = EV[l.topics[0].toLowerCase()]
      const d = l.data.slice(2)
      const w = (i: number) => BigInt('0x' + d.slice(64 * i, 64 * (i + 1)))
      const b = parseInt(l.blockNumber, 16)
      const base: any = {
        block: b,
        ts: tsOf.get(b),
        utc: new Date((tsOf.get(b) ?? 0) * 1000).toISOString().slice(0, 16),
        tx: l.transactionHash,
        kind: k,
      }
      if (k === 'SetWithdrawQueue' || k === 'SetSupplyQueue') {
        const n = Number(w(1))
        const ids: string[] = []
        for (let i = 0; i < n; i++) ids.push('0x' + d.slice(64 * (2 + i), 64 * (3 + i)))
        const has = ids.includes(M)
        if (k === 'SetWithdrawQueue') {
          if (has === prevHas) continue
          prevHas = has
        } else if (!has && !ev.some((e) => e.kind === 'SetSupplyQueue' && e.has)) continue
        ev.push({ ...base, caller: '0x' + l.topics[1].slice(26), has, queueLen: n })
        continue
      }
      if (k === 'SubmitCap' || k === 'SetCap') {
        ev.push({ ...base, caller: '0x' + l.topics[1].slice(26), cap: w(0).toString() })
        continue
      }
      if (k === 'ReallocateSupply' || k === 'ReallocateWithdraw') {
        ev.push({
          ...base,
          caller: '0x' + l.topics[1].slice(26),
          assets: w(0).toString(),
          shares: w(1).toString(),
        })
        continue
      }
      if (k === 'UpdateLostAssets') {
        ev.push({ ...base, lostAssets: w(0).toString() })
        continue
      }
      if (k === 'SetCurator' || k === 'OwnershipTransferred') {
        ev.push({ ...base, topics: l.topics.slice(1).map((t: string) => '0x' + t.slice(26)) })
        continue
      }
      if (k === 'SetIsAllocator') {
        ev.push({ ...base, allocator: '0x' + l.topics[1].slice(26), on: w(0) === 1n })
        continue
      }
      ev.push({ ...base, kind: k })
    }
    // State one block before and at each removal-type event (queue change / removal submit / lost assets jump)
    const probe = [
      ...new Set(
        ev
          .filter((e) =>
            ['SetWithdrawQueue', 'SubmitMarketRemoval', 'UpdateLostAssets', 'SetCap'].includes(
              e.kind,
            ),
          )
          .flatMap((e) => [e.block - 1, e.block]),
      ),
    ].sort((a, b) => a - b)
    const per = 4
    const st = await rpc.batch(
      probe.flatMap((b) => [
        { method: 'eth_call', params: [{ to: v, data: sel('totalAssets()') }, hex(b)] },
        { method: 'eth_call', params: [{ to: v, data: sel('totalSupply()') }, hex(b)] },
        {
          method: 'eth_call',
          params: [
            {
              to: v,
              data: sel('convertToAssets(uint256)') + (10n ** 18n).toString(16).padStart(64, '0'),
            },
            hex(b),
          ],
        },
        {
          method: 'eth_call',
          params: [
            {
              to: MORPHO,
              data: sel('position(bytes32,address)') + M.slice(2) + v.slice(2).padStart(64, '0'),
            },
            hex(b),
          ],
        },
      ]),
    )
    const state = probe.map((b, i) => ({
      block: b,
      totalAssets: W(st[i * per] as string)?.toString(),
      totalSupply: W(st[i * per + 1] as string)?.toString(),
      sharePrice1e18: W(st[i * per + 2] as string)?.toString(),
      supplyShares: W(st[i * per + 3] as string)?.toString(),
    }))
    out.vaults[name] = { address: v, events: ev, state }
    console.log('==', name, v, 'events', ev.length)
    for (const e of ev)
      if (e.kind !== 'UpdateLostAssets')
        console.log(
          '  ',
          e.utc,
          e.block,
          e.kind,
          e.cap ?? e.assets ?? (e.has !== undefined ? 'has=' + e.has : ''),
          e.caller ?? e.allocator ?? '',
          e.tx,
        )
    for (const s of state)
      console.log(
        '    st',
        s.block,
        'TA',
        Number(s.totalAssets ?? 0) / 1e6,
        'px',
        Number(s.sharePrice1e18 ?? 0) / 1e6,
        'mktShares',
        s.supplyShares,
      )
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
