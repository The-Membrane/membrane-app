// Receipts of given transactions: tx from / to, USDC transfers, ERC-4626 Deposit / Withdraw;
// then code / nonce / USDC balance of every from / to (and EXTRA=a,b,…). Used for the
// 2025-11-13 Relend USDC exit funded by supply on behalf of 0x6c44…281a.
//   tsx nov13.ts <txhash> …
import { keccakText } from '../../../lib/curatorFeed/keccak'
import { FeedRpc, endpointsFromEnv } from '../../lib/curator-feed-rpc'
const rpc = new FeedRpc(endpointsFromEnv())
const T = keccakText
const TXS = process.argv.slice(2)
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const TR = T('Transfer(address,address,uint256)'),
  WD = T('Withdraw(address,address,address,uint256,uint256)'),
  DEP = T('Deposit(address,address,uint256,uint256)')
const a = (t: string) => '0x' + t.slice(26)
async function main() {
  const seen = new Set<string>()
  for (const h of TXS) {
    const [tx, rc] = await Promise.all([
      rpc.call<any>('eth_getTransactionByHash', [h]),
      rpc.call<any>('eth_getTransactionReceipt', [h]),
    ])
    if (!tx || !rc) {
      console.log('TX', h, 'not served (retry)')
      continue
    }
    console.log(
      'TX',
      h.slice(0, 14),
      'block',
      parseInt(tx.blockNumber, 16),
      'from',
      tx.from,
      'to',
      tx.to,
      'type',
      tx.type,
      'input',
      tx.input.slice(0, 10),
      'logs',
      rc.logs.length,
      'contracts',
      rc.contractAddress,
    )
    for (const l of rc.logs) {
      const t0 = l.topics[0]?.toLowerCase()
      if (t0 === TR && l.address.toLowerCase() === USDC)
        console.log('   USDC', a(l.topics[1]), '->', a(l.topics[2]), Number(BigInt(l.data)) / 1e6)
      else if (t0 === TR)
        console.log(
          '   TR',
          l.address.slice(0, 10),
          a(l.topics[1]),
          '->',
          a(l.topics[2]),
          BigInt(l.data.slice(0, 66)).toString(),
        )
      else if (t0 === WD)
        console.log(
          '   4626-Withdraw on',
          l.address,
          'sender',
          a(l.topics[1]),
          'recv',
          a(l.topics[2]),
          'owner',
          a(l.topics[3]),
          'assets',
          Number(BigInt('0x' + l.data.slice(2, 66))) / 1e6,
        )
      else if (t0 === DEP)
        console.log(
          '   4626-Deposit on',
          l.address,
          'sender',
          a(l.topics[1]),
          'owner',
          a(l.topics[2]),
          'assets',
          Number(BigInt('0x' + l.data.slice(2, 66))) / 1e6,
        )
      for (const x of [tx.from, tx.to]) seen.add(x.toLowerCase())
    }
  }
  const addrs = [...seen]
  const extra = process.env.EXTRA ? process.env.EXTRA.split(',') : []
  for (const x of [...addrs, ...extra]) {
    const [code, nonce, bal] = await Promise.all([
      rpc.call<string>('eth_getCode', [x, 'latest']),
      rpc.call<string>('eth_getTransactionCount', [x, 'latest']),
      rpc.call<string>('eth_call', [
        { to: USDC, data: '0x70a08231' + x.slice(2).padStart(64, '0') },
        'latest',
      ]),
    ])
    console.log(
      'ADDR',
      x,
      'code',
      (code.length - 2) / 2,
      code.slice(0, 50),
      'nonce',
      parseInt(nonce, 16),
      'usdc',
      Number(BigInt(bal)) / 1e6,
    )
  }
}
main().then(
  () => process.exit(0),
  (e) => {
    console.error(rpc.scrub(String(e?.stack ?? e)))
    process.exit(1)
  },
)
