// Adpend USDC and 1337 USDC: Deposit / Withdraw / Transfer / AccrueInterest /
// SetFeeRecipient / OwnershipTransferred since block 23,000,000, holders from Transfer
// replay checked against balanceOf, share price and fee recipient at the head.
//   tsx vaults.ts <out.json>
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
const DEP = T('Deposit(address,address,uint256,uint256)'),
  WD = T('Withdraw(address,address,address,uint256,uint256)'),
  TR = T('Transfer(address,address,uint256)')
const ACCR = T('AccrueInterest(uint256,uint256)'),
  FEE = T('SetFeeRecipient(address)'),
  OWN = T('OwnershipTransferred(address,address)'),
  CREATE = T('CreateMetaMorpho(address,address,address,uint256,address,string,string,bytes32)')
async function main() {
  const head = parseInt(
    (await rpc.call<{ number: string }>('eth_getBlockByNumber', ['finalized', false])).number,
    16,
  )
  const out: Record<string, unknown> = {}
  for (const [name, v] of [
    ['Adpend USDC', '0x55555815a5595991c3a0ff119b59aef6c8b55555'],
    ['1337 USDC', '0x94643e86aa5e38ddac6c7791c1297f4e40cd96c1'],
  ]) {
    const logs = await rpc.getLogs(
      { address: v, topics: [[DEP, WD, TR, ACCR, FEE, OWN]] },
      23_000_000,
      head,
      { dual: true, concurrency: 4 },
    )
    const blocks = [...new Set(logs.map((l) => parseInt(l.blockNumber, 16)))]
    const hd = await rpc.batch(
      blocks.map((b) => ({ method: 'eth_getBlockByNumber', params: [hex(b), false] })),
    )
    const tsOf = new Map(
      blocks.map((b, i) => [b, parseInt((hd[i] as any)?.timestamp ?? '0x0', 16)]),
    )
    const ev = logs
      .map((l) => {
        const t0 = l.topics[0].toLowerCase()
        const d = l.data.slice(2)
        const w = (i: number) => BigInt('0x' + d.slice(64 * i, 64 * (i + 1))).toString()
        const a = (i: number) => '0x' + l.topics[i].slice(26)
        const base = {
          block: parseInt(l.blockNumber, 16),
          ts: tsOf.get(parseInt(l.blockNumber, 16)),
          tx: l.transactionHash,
          logIndex: parseInt(l.logIndex, 16),
        }
        if (t0 === DEP)
          return { ...base, kind: 'Deposit', sender: a(1), owner: a(2), assets: w(0), shares: w(1) }
        if (t0 === WD)
          return {
            ...base,
            kind: 'Withdraw',
            sender: a(1),
            receiver: a(2),
            owner: a(3),
            assets: w(0),
            shares: w(1),
          }
        if (t0 === TR) return { ...base, kind: 'Transfer', from: a(1), to: a(2), value: w(0) }
        if (t0 === ACCR)
          return { ...base, kind: 'AccrueInterest', newTotalAssets: w(0), feeShares: w(1) }
        if (t0 === FEE) return { ...base, kind: 'SetFeeRecipient', recipient: a(1) }
        return { ...base, kind: 'OwnershipTransferred', from: a(1), to: a(2) }
      })
      .sort((x, y) => x.block - y.block || x.logIndex - y.logIndex)
    // balances from Transfer
    const bal = new Map<string, bigint>()
    for (const e of ev as any[])
      if (e.kind === 'Transfer') {
        bal.set(e.from, (bal.get(e.from) ?? 0n) - BigInt(e.value))
        bal.set(e.to, (bal.get(e.to) ?? 0n) + BigInt(e.value))
      }
    const holders = [...bal]
      .filter(([a, b]) => a !== '0x0000000000000000000000000000000000000000' && b > 0n)
      .sort((x, y) => (y[1] > x[1] ? 1 : -1))
    const onchain = await rpc.batch(
      holders.map(([a]) => ({
        method: 'eth_call',
        params: [
          { to: v, data: sel('balanceOf(address)') + a.slice(2).padStart(64, '0') },
          'latest',
        ],
      })),
    )
    const codes = await rpc.batch(
      holders.map(([a]) => ({ method: 'eth_getCode', params: [a, 'latest'] })),
    )
    const sp = W(
      await rpc.call<string>('eth_call', [
        {
          to: v,
          data: sel('convertToAssets(uint256)') + (10n ** 18n).toString(16).padStart(64, '0'),
        },
        'latest',
      ]),
    )!
    const feeRecipient =
      '0x' +
      (
        await rpc.call<string>('eth_call', [{ to: v, data: sel('feeRecipient()') }, 'latest'])
      ).slice(26)
    out[name] = {
      vault: v,
      head,
      sharePrice: sp.toString(),
      feeRecipient,
      holders: holders.map(([a, b], i) => ({
        address: a,
        shares: b.toString(),
        sharesOnchain: W(onchain[i] as string)?.toString(),
        isContract: ((codes[i] as string) ?? '0x').length > 2,
        value: ((b * sp) / 10n ** 18n).toString(),
      })),
      events: ev,
    }
    const deps = (ev as any[]).filter((e) => e.kind === 'Deposit'),
      wds = (ev as any[]).filter((e) => e.kind === 'Withdraw')
    console.log(
      name,
      'events',
      ev.length,
      'deposits',
      deps.length,
      'withdrawals',
      wds.length,
      'holders',
      holders.length,
      'feeRecipient',
      feeRecipient,
      'sharePrice',
      Number(sp) / 1e6,
    )
  }
  writeFileSync(process.argv[2], JSON.stringify(out))
}
main()
