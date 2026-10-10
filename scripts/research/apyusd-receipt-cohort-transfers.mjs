// Retrospective ERC721 continuity for the predeclared 96-receipt ApyUSD cohort.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { keccak256, stringToHex } from 'viem'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import {
  FROM,
  RECEIPT,
  requestWithRetries,
  verifySource,
  writeExclusive,
} from './apyusd-receipt-cohort-source.mjs'

export const OUT = resolve('data/research/venue-signals/apyusd-receipt-cohort-transfers-v1.json')
export const TO = 26_107_206
const STEP = 10_000
const TOPIC = keccak256(stringToHex('Transfer(address,address,uint256)'))
const ZERO = `0x${'0'.repeat(64)}`
const WORD = /^0x[0-9a-f]{64}$/
const SHA = /^[0-9a-f]{64}$/
const sha = (value) => createHash('sha256').update(value).digest('hex')
const canonical = JSON.stringify
const hex = (n) => `0x${n.toString(16)}`
const id = (event) => BigInt(event.topics[3]).toString()

export function normalizeTransfer(log, low, high) {
  const blockNumber = Number(BigInt(log.blockNumber ?? '0x0'))
  const logIndex = Number(BigInt(log.logIndex ?? '0x0'))
  const topics = log.topics?.map((topic) => topic.toLowerCase())
  if (
    log.address?.toLowerCase() !== RECEIPT ||
    log.removed === true ||
    blockNumber < low ||
    blockNumber > high ||
    typeof log.logIndex !== 'string' ||
    !Number.isSafeInteger(logIndex) ||
    !WORD.test(log.blockHash ?? '') ||
    !WORD.test(log.transactionHash ?? '') ||
    topics?.length !== 4 ||
    topics[0] !== TOPIC ||
    !topics.slice(1).every((topic) => WORD.test(topic)) ||
    !/^0x[0-9a-f]*$/.test(log.data ?? '')
  )
    throw Error('apyusd_cohort_transfer_invalid')
  return {
    blockNumber,
    blockHash: log.blockHash.toLowerCase(),
    transactionHash: log.transactionHash.toLowerCase(),
    logIndex,
    topics,
    data: log.data.toLowerCase(),
  }
}

function validateWindow(row, low, high) {
  if (
    row?.study !== 'apyusd_receipt_transfer_window_v1' ||
    row.fromBlock !== low ||
    row.toBlock !== high ||
    canonical(row.origins) !== canonical(['rpc.ankr.com', 'mainnet.infura.io']) ||
    !Array.isArray(row.transfers) ||
    !SHA.test(row.sha256 ?? '')
  )
    throw Error('apyusd_cohort_transfer_window_invalid')
  const { sha256: _seal, ...body } = row
  if (row.sha256 !== sha(canonical(body))) throw Error('apyusd_cohort_transfer_window_hash_invalid')
  for (const event of row.transfers)
    if (
      canonical(
        normalizeTransfer(
          {
            ...event,
            address: RECEIPT,
            blockNumber: hex(event.blockNumber),
            logIndex: hex(event.logIndex),
          },
          low,
          high,
        ),
      ) !== canonical(event)
    )
      throw Error('apyusd_cohort_transfer_window_event_invalid')
  return row
}

async function checkpoint(path, low, high) {
  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  if (bytes.length > 131_072) throw Error('apyusd_cohort_transfer_window_oversize')
  const row = JSON.parse(bytes.toString('utf8'))
  if (bytes.toString('utf8') !== `${canonical(row)}\n`)
    throw Error('apyusd_cohort_transfer_window_encoding_invalid')
  return validateWindow(row, low, high)
}

export function classifyCohort(source, transfers) {
  const selected = new Map(source.mints.map((mint) => [id(mint), mint]))
  const events = transfers.filter((event) => selected.has(id(event)))
  const mints = events.filter((event) => event.topics[1] === ZERO)
  const burns = events.filter((event) => event.topics[2] === ZERO)
  const intermediate = events.filter(
    (event) => event.topics[1] !== ZERO && event.topics[2] !== ZERO,
  )
  if (canonical(mints) !== canonical(source.mints))
    throw Error('apyusd_cohort_transfer_mints_disagree')
  if (
    new Set(burns.map(id)).size !== burns.length ||
    burns.some(
      (event) =>
        event.blockNumber < selected.get(id(event)).blockNumber ||
        (event.blockNumber === selected.get(id(event)).blockNumber &&
          event.logIndex <= selected.get(id(event)).logIndex),
    )
  )
    throw Error('apyusd_cohort_transfer_burn_invalid')
  const openIds = source.mints
    .map(id)
    .filter((token) => !burns.some((event) => id(event) === token))
  return { minted: mints.length, burned: burns.length, intermediate: intermediate.length, openIds }
}

export function validateTransfers(row, source) {
  if (
    row?.study !== 'apyusd_receipt_cohort_transfers_v1' ||
    row.sourceSha256 !== source.sha256 ||
    row.receipt !== RECEIPT ||
    row.fromBlock !== FROM ||
    row.toBlock !== TO ||
    canonical(row.origins) !== canonical(['rpc.ankr.com', 'mainnet.infura.io']) ||
    !Array.isArray(row.windows) ||
    row.windows.length !== Math.ceil((TO - FROM + 1) / STEP) ||
    !Array.isArray(row.transfers) ||
    !SHA.test(row.transfersSha256 ?? '') ||
    row.transfersSha256 !== sha(canonical(row.transfers)) ||
    !SHA.test(row.sha256 ?? '')
  )
    throw Error('apyusd_cohort_transfers_invalid')
  const { sha256: _seal, ...body } = row
  if (row.sha256 !== sha(canonical(body))) throw Error('apyusd_cohort_transfers_hash_invalid')
  for (let index = 1; index < row.transfers.length; index++) {
    const before = row.transfers[index - 1]
    const after = row.transfers[index]
    if (
      after.blockNumber < before.blockNumber ||
      (after.blockNumber === before.blockNumber && after.logIndex <= before.logIndex)
    )
      throw Error('apyusd_cohort_transfer_order_invalid')
  }
  let cursor = FROM
  for (const window of row.windows) {
    const slice = row.transfers.filter(
      (event) => event.blockNumber >= window.fromBlock && event.blockNumber <= window.toBlock,
    )
    if (
      window.fromBlock !== cursor ||
      window.toBlock !== Math.min(TO, cursor + STEP - 1) ||
      window.transfers !== slice.length ||
      window.sha256 !== sha(canonical(slice))
    )
      throw Error('apyusd_cohort_transfer_coverage_invalid')
    for (const event of slice)
      if (
        canonical(
          normalizeTransfer(
            {
              ...event,
              address: RECEIPT,
              blockNumber: hex(event.blockNumber),
              logIndex: hex(event.logIndex),
            },
            window.fromBlock,
            window.toBlock,
          ),
        ) !== canonical(event)
      )
        throw Error('apyusd_cohort_transfer_event_invalid')
    cursor = window.toBlock + 1
  }
  if (
    cursor !== TO + 1 ||
    canonical(row.cohort) !== canonical(classifyCohort(source, row.transfers))
  )
    throw Error('apyusd_cohort_transfer_classification_invalid')
  return row
}

export async function captureTransfers({
  source = null,
  urls = configuredPublicRpcUrls(readEnv()),
  out = OUT,
} = {}) {
  source = source ?? (await verifySource())
  const origins = publicRpcClients(urls)
  const ankr = origins.find((origin) => new URL(origin.url).hostname === 'rpc.ankr.com')
  const infura = origins.find((origin) => new URL(origin.url).hostname === 'mainnet.infura.io')
  if (!ankr || !infura) throw Error('apyusd_cohort_transfer_origins_unavailable')
  const windows = []
  const transfers = []
  for (let low = FROM; low <= TO; low += STEP) {
    const high = Math.min(TO, low + STEP - 1)
    const path = `${out}.windows/${low}-${high}.json`
    let row = await checkpoint(path, low, high)
    if (!row) {
      const query = { address: RECEIPT, topics: [TOPIC], fromBlock: hex(low), toBlock: hex(high) }
      const a = (await requestWithRetries(ankr, 'eth_getLogs', [query])).map((log) =>
        normalizeTransfer(log, low, high),
      )
      const b = (await requestWithRetries(infura, 'eth_getLogs', [query])).map((log) =>
        normalizeTransfer(log, low, high),
      )
      if (canonical(a) !== canonical(b)) throw Error('apyusd_cohort_transfer_origins_disagree')
      const body = {
        study: 'apyusd_receipt_transfer_window_v1',
        fromBlock: low,
        toBlock: high,
        origins: ['rpc.ankr.com', 'mainnet.infura.io'],
        transfers: a,
      }
      row = validateWindow({ ...body, sha256: sha(canonical(body)) }, low, high)
      await writeExclusive(path, row)
      console.error(`apyusd_transfer_window ${low}-${high} transfers=${a.length}`)
    }
    windows.push({
      fromBlock: low,
      toBlock: high,
      transfers: row.transfers.length,
      sha256: sha(canonical(row.transfers)),
    })
    transfers.push(...row.transfers)
  }
  const body = {
    study: 'apyusd_receipt_cohort_transfers_v1',
    sourceSha256: source.sha256,
    receipt: RECEIPT,
    fromBlock: FROM,
    toBlock: TO,
    origins: ['rpc.ankr.com', 'mainnet.infura.io'],
    windows,
    transfers,
    transfersSha256: sha(canonical(transfers)),
    cohort: classifyCohort(source, transfers),
  }
  const row = validateTransfers({ ...body, sha256: sha(canonical(body)) }, source)
  await writeExclusive(out, row)
  return row
}

export async function verifyTransfers(out = OUT) {
  const source = await verifySource()
  const bytes = await readFile(out)
  if (bytes.length > 512_000) throw Error('apyusd_cohort_transfers_oversize')
  const row = JSON.parse(bytes.toString('utf8'))
  if (bytes.toString('utf8') !== `${canonical(row)}\n`)
    throw Error('apyusd_cohort_transfers_encoding_invalid')
  return validateTransfers(row, source)
}

export async function verifyPartial(out = OUT) {
  const source = await verifySource()
  const selected = new Set(source.mints.map(id))
  let windows = 0
  let transfers = 0
  let lastBlock = FROM - 1
  let gap = false
  for (let low = FROM; low <= TO; low += STEP) {
    const high = Math.min(TO, low + STEP - 1)
    const row = await checkpoint(`${out}.windows/${low}-${high}.json`, low, high)
    if (!row) {
      gap = true
      continue
    }
    if (gap) throw Error('apyusd_cohort_transfer_checkpoint_gap')
    const observed = row.transfers.filter(
      (event) => event.topics[1] === ZERO && selected.has(id(event)),
    )
    const expected = source.mints.filter(
      (mint) => mint.blockNumber >= low && mint.blockNumber <= high,
    )
    if (canonical(observed) !== canonical(expected))
      throw Error('apyusd_cohort_transfer_checkpoint_mint_mismatch')
    windows++
    transfers += row.transfers.length
    lastBlock = high
  }
  return { windows, totalWindows: Math.ceil((TO - FROM + 1) / STEP), lastBlock, transfers }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--verify-partial')) {
    console.log(JSON.stringify(await verifyPartial()))
    process.exit(0)
  }
  const row = process.argv.includes('--verify') ? await verifyTransfers() : await captureTransfers()
  console.log(
    JSON.stringify({
      study: row.study,
      fromBlock: row.fromBlock,
      toBlock: row.toBlock,
      transfers: row.transfers.length,
      cohort: row.cohort,
      transfersSha256: row.transfersSha256,
      sha256: row.sha256,
    }),
  )
}
