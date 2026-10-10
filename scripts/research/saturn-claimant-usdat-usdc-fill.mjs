// One exact queue claimant's post-claim USDat -> USDC settlement; not final AUSD.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { keccak256, stringToHex } from 'viem'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import { requestWithRetries, writeExclusive } from './apyusd-receipt-cohort-source.mjs'
import { verifyEpisodes } from './saturn-queue-episode-cohort.mjs'
import { verifyPayouts } from './saturn-queue-claim-payouts.mjs'

export const OUT = resolve('data/research/venue-signals/saturn-claimant-usdat-usdc-fill-v1.json')
const HOLDER = '0xf5b0157404f9147b737a6b65bcd10b3f37168d3b'
const ESCROW = '0xe39b012ab3b20e94a9beea557eb0de4171d4d3e4'
const COUNTERPARTY = '0x71401fd427e2a525acff575294ab8af4721828c4'
const USDAT = '0x23238f20b894f29041f48d88ee91131c395aaa71'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const TICKET = '1581'
const USDAT_RAW = '20621112655'
const USDC_RAW = '20610802098'
const TXS = [
  '0xbfbc53c68c0f8a70ce7601f9c775625acde53a6a431511fe0cdda35e083a6d97',
  '0x42464623a8428747e47a03cce8252f63effe8eae28290518c91dc13a9f48b5ba',
]
const ORIGINS = ['rpc.ankr.com', 'eth-mainnet.g.alchemy.com']
const TRANSFER = keccak256(stringToHex('Transfer(address,address,uint256)'))
const sha = (body) => createHash('sha256').update(JSON.stringify(body)).digest('hex')
const addressTopic = (topic) => `0x${topic.slice(-40).toLowerCase()}`

async function verifiedSource() {
  const [episodes, payouts] = await Promise.all([verifyEpisodes(), verifyPayouts()])
  const episode = episodes.episodes.find((row) => row.ticketId === TICKET)
  const payout = payouts.transactions.flatMap((tx) =>
    tx.payouts
      .filter((row) => row.ticketId === TICKET)
      .map((row) => ({ ...row, transactionHash: tx.transactionHash })),
  )
  if (
    episode?.status !== 'claimed' ||
    episode.claimedHolder?.toLowerCase() !== HOLDER ||
    episode.usdatOwedRaw !== USDAT_RAW ||
    payout.length !== 1 ||
    payout[0].to?.toLowerCase() !== HOLDER ||
    payout[0].amountRaw !== USDAT_RAW
  )
    throw Error('saturn_claimant_fill_source_invalid')
  return {
    episodeSha256: episodes.sha256,
    payoutSha256: payouts.sha256,
    claimBlock: episode.claimedBlock,
    claimTransactionHash: payout[0].transactionHash,
  }
}

async function readTransaction(origin, hash) {
  const [transaction, receipt] = await Promise.all([
    requestWithRetries(origin, 'eth_getTransactionByHash', [hash]),
    requestWithRetries(origin, 'eth_getTransactionReceipt', [hash]),
  ])
  if (
    transaction?.hash?.toLowerCase() !== hash ||
    receipt?.transactionHash?.toLowerCase() !== hash ||
    receipt.status !== '0x1' ||
    transaction.blockHash?.toLowerCase() !== receipt.blockHash?.toLowerCase()
  )
    throw Error('saturn_claimant_fill_transaction_invalid')
  return {
    transactionHash: hash,
    blockNumber: Number(BigInt(receipt.blockNumber)),
    blockHash: receipt.blockHash.toLowerCase(),
    from: transaction.from.toLowerCase(),
    to: transaction.to?.toLowerCase(),
    transfers: receipt.logs
      .filter(
        (log) =>
          [USDAT, USDC].includes(log.address?.toLowerCase()) &&
          log.topics?.[0]?.toLowerCase() === TRANSFER,
      )
      .map((log) => ({
        token: log.address.toLowerCase(),
        from: addressTopic(log.topics[1]),
        to: addressTopic(log.topics[2]),
        amountRaw: BigInt(log.data).toString(),
        logIndex: Number(BigInt(log.logIndex)),
      })),
  }
}

export function verifyRow(row, source) {
  const [deposit, fill] = row?.transactions ?? []
  const exactly = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected)
  if (
    row?.study !== 'saturn_claimant_usdat_usdc_fill_v1' ||
    row.episodeEvidenceSha256 !== source.episodeSha256 ||
    row.payoutEvidenceSha256 !== source.payoutSha256 ||
    row.ticketId !== TICKET ||
    row.holder !== HOLDER ||
    row.claimBlock !== source.claimBlock ||
    row.claimTransactionHash !== source.claimTransactionHash ||
    row.finalAusdPaidProof !== false ||
    row.transactions?.length !== 2 ||
    deposit?.transactionHash !== TXS[0] ||
    fill?.transactionHash !== TXS[1] ||
    deposit.from !== HOLDER ||
    deposit.to !== ESCROW ||
    fill.from !== COUNTERPARTY ||
    fill.to !== ESCROW ||
    !(deposit.blockNumber > row.claimBlock && fill.blockNumber > deposit.blockNumber) ||
    !exactly(
      deposit.transfers.map(({ token, from, to, amountRaw }) => ({ token, from, to, amountRaw })),
      [{ token: USDAT, from: HOLDER, to: ESCROW, amountRaw: USDAT_RAW }],
    ) ||
    !exactly(
      fill.transfers.map(({ token, from, to, amountRaw }) => ({ token, from, to, amountRaw })),
      [
        { token: USDC, from: COUNTERPARTY, to: HOLDER, amountRaw: USDC_RAW },
        { token: USDAT, from: ESCROW, to: COUNTERPARTY, amountRaw: USDAT_RAW },
      ],
    ) ||
    ![deposit, fill].every(
      (tx) =>
        /^0x[0-9a-f]{64}$/.test(tx.blockHash ?? '') &&
        Number.isSafeInteger(tx.blockNumber) &&
        tx.transfers.every((transfer) => Number.isSafeInteger(transfer.logIndex)),
    )
  )
    throw Error('saturn_claimant_fill_invalid')
  const { sha256, ...body } = row
  if (sha256 !== sha(body)) throw Error('saturn_claimant_fill_hash_invalid')
  return row
}

export async function verifySaved(out = OUT) {
  const source = await verifiedSource()
  const bytes = await readFile(out, 'utf8')
  if (bytes.length > 8_192) throw Error('saturn_claimant_fill_oversize')
  const row = verifyRow(JSON.parse(bytes), source)
  if (bytes !== `${JSON.stringify(row)}\n`) throw Error('saturn_claimant_fill_encoding_invalid')
  return row
}

export async function capture({ urls = configuredPublicRpcUrls(readEnv()), out = OUT } = {}) {
  const source = await verifiedSource()
  const clients = publicRpcClients(urls)
  const origins = ORIGINS.map((host) => clients.find((client) => new URL(client.url).host === host))
  if (origins.some((origin) => !origin)) throw Error('saturn_claimant_fill_origin_missing')
  const [a, b] = await Promise.all(
    origins.map((origin) => Promise.all(TXS.map((hash) => readTransaction(origin, hash)))),
  )
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw Error('saturn_claimant_fill_origin_disagreement')
  const body = {
    study: 'saturn_claimant_usdat_usdc_fill_v1',
    origins: ORIGINS,
    episodeEvidenceSha256: source.episodeSha256,
    payoutEvidenceSha256: source.payoutSha256,
    ticketId: TICKET,
    holder: HOLDER,
    claimBlock: source.claimBlock,
    claimTransactionHash: source.claimTransactionHash,
    transactions: a,
    finalAusdPaidProof: false,
  }
  const row = { ...body, sha256: sha(body) }
  verifyRow(row, source)
  await writeExclusive(out, row)
  return verifySaved(out)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv[2]
  const row = mode === '--run' ? await capture() : mode === '--verify' ? await verifySaved() : null
  if (!row) throw Error('usage: --run | --verify')
  console.log(
    JSON.stringify({
      sha256: row.sha256,
      ticketId: row.ticketId,
      transactions: row.transactions.length,
      finalAusdPaidProof: row.finalAusdPaidProof,
    }),
  )
}
