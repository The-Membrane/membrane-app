// Verify the 15 historically grouped "USDT → supply on Spark" rows from
// primary Ethereum receipts. This proves observed operations, not that the
// borrowed token units were traced into a later deposit.
// node scripts/research/verify-spark-usdt-august-receipts.mjs
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeEventLog, parseAbiItem, toEventSelector } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const MANIFEST = resolve(ROOT, 'lib/carry/spark-usdt-august-receipts.json')
const CHECKED_IN_SOURCE = resolve(ROOT, 'scripts/route-cohort/aug-2026-ab-routes-source.json')
const SOURCE_HASH = 'a0aee85535cb4c96f09d2f3bce3af3d2bcc9d1e2ee0156e24265111263c4cf63'
const POOL = '0xc13e21b648a5ee794902342038ff3adab66be987'
const USDT_ATOKEN = '0xe7df13b8e3d6740fe17cbe928c7334243d86c92f'
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const SPARK_SAVINGS_USDT = '0xe2e7a17dff93280dec073c995595155283e3c372'
const ZERO = '0x0000000000000000000000000000000000000000'
const ADDR = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const UINT = /^(0|[1-9][0-9]*)$/
const lower = (value) => String(value || '').toLowerCase()
const same = (a, b) => lower(a) === lower(b)
const integer = (value) => Number.isSafeInteger(value) && value >= 0

const EVENTS = {
  supply: parseAbiItem(
    'event Supply(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint16 indexed referralCode)',
  ),
  borrow: parseAbiItem(
    'event Borrow(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint8 interestRateMode,uint256 borrowRate,uint16 indexed referralCode)',
  ),
  withdraw: parseAbiItem(
    'event Withdraw(address indexed reserve,address indexed user,address indexed to,uint256 amount)',
  ),
  transfer: parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)'),
  mint: parseAbiItem(
    'event Mint(address indexed caller,address indexed onBehalfOf,uint256 value,uint256 balanceIncrease,uint256 index)',
  ),
}
const TOPIC = Object.fromEntries(
  Object.entries(EVENTS).map(([key, event]) => [key, toEventSelector(event)]),
)

function fail(code) {
  throw new Error(code)
}
function eventLogs(receipt, address, kind) {
  return receipt.logs
    .filter((log) => same(log.address, address) && same(log.topics?.[0], TOPIC[kind]))
    .map(
      (log) =>
        decodeEventLog({ abi: [EVENTS[kind]], data: log.data, topics: log.topics, strict: true })
          .args,
    )
}
function poolEvent(receipt, kind, reserve, borrower, amount) {
  return eventLogs(receipt, POOL, kind).some(
    (args) =>
      same(args.reserve, reserve) &&
      same(args.user, borrower) &&
      same(args.onBehalfOf, borrower) &&
      args.amount === amount,
  )
}
function tokenTransfer(receipt, token, from, to, amount) {
  return eventLogs(receipt, token, 'transfer').some(
    (args) => same(args.from, from) && same(args.to, to) && args.value === amount,
  )
}
function mint(receipt, token, borrower, amount) {
  return eventLogs(receipt, token, 'mint').some(
    (args) =>
      same(args.caller, borrower) &&
      same(args.onBehalfOf, borrower) &&
      args.value >= args.balanceIncrease &&
      args.value - args.balanceIncrease === amount &&
      tokenTransfer(receipt, token, ZERO, borrower, args.value),
  )
}

export function validateManifest(manifest) {
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.chainId !== 1 ||
    manifest.routeKey !== 'USDT → supply on Spark' ||
    manifest.sourceArtifact?.path !== 'scripts/route-cohort/aug-2026-ab-routes-source.json' ||
    manifest.sourceArtifact.sha256 !== SOURCE_HASH ||
    !same(manifest.sparkLend?.pool, POOL) ||
    !same(manifest.sparkLend?.usdtAToken, USDT_ATOKEN) ||
    !same(manifest.sparkLend?.usdt, USDT) ||
    !same(manifest.sparkSavingsUsdtVault, SPARK_SAVINGS_USDT) ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length !== 15
  )
    fail('manifest_metadata_invalid')
  const byBorrower = new Set()
  const classes = new Map()
  for (const row of manifest.entries) {
    const borrower = lower(row.borrower)
    if (
      !ADDR.test(borrower) ||
      byBorrower.has(borrower) ||
      !integer(row.sourceBorrowBlock) ||
      !HASH.test(lower(row.sourceBorrowTx)) ||
      !(row.sourceBorrowAsset === null || same(row.sourceBorrowAsset, USDT)) ||
      !UINT.test(row.sourceBorrowAmountRaw || '') ||
      !['A atomic', 'B strong'].includes(row.sourceTier) ||
      !integer(row.proofBlock) ||
      !HASH.test(lower(row.proofTx)) ||
      row.proofBlock < row.sourceBorrowBlock ||
      row.proofBlock - row.sourceBorrowBlock > 5000
    )
      fail('manifest_entry_invalid')
    byBorrower.add(borrower)
    classes.set(row.classification, (classes.get(row.classification) || 0) + 1)
    if (
      row.classification === 'spark_lend_usdt_supply_receipt' ||
      row.classification === 'spark_lend_usdt_borrow_receipt'
    ) {
      if (
        !UINT.test(row.usdtTransferRaw || '') ||
        BigInt(row.usdtTransferRaw) <= 0n ||
        row.laterBorrowBlock !== undefined ||
        row.laterBorrowTx !== undefined
      )
        fail('manifest_amount_invalid')
    } else if (row.classification === 'usdc_supply_then_usdt_borrow') {
      if (
        !integer(row.laterBorrowBlock) ||
        !HASH.test(lower(row.laterBorrowTx)) ||
        row.laterBorrowBlock <= row.proofBlock ||
        row.laterBorrowBlock - row.sourceBorrowBlock > 5000 ||
        row.usdtTransferRaw !== undefined
      )
        fail('manifest_later_borrow_invalid')
    } else fail('manifest_classification_invalid')
  }
  if (
    classes.get('spark_lend_usdt_supply_receipt') !== 13 ||
    classes.get('spark_lend_usdt_borrow_receipt') !== 1 ||
    classes.get('usdc_supply_then_usdt_borrow') !== 1
  )
    fail('manifest_class_counts_invalid')
  return manifest
}

export function verifySourceRows(manifest, raw) {
  if (createHash('sha256').update(raw).digest('hex') !== SOURCE_HASH) fail('source_hash_mismatch')
  const source = JSON.parse(raw)
  if (!Array.isArray(source)) fail('source_shape_invalid')
  const rows = source.filter((row) => row.route === manifest.routeKey)
  if (rows.length !== 15) fail('source_member_count_invalid')
  const byBorrower = new Map()
  for (const row of rows) {
    const key = lower(row.borrower)
    if (byBorrower.has(key)) fail('source_duplicate_borrower')
    byBorrower.set(key, row)
  }
  for (const entry of manifest.entries) {
    const row = byBorrower.get(lower(entry.borrower))
    if (
      !row ||
      row.block !== entry.sourceBorrowBlock ||
      !same(row.tx, entry.sourceBorrowTx) ||
      !same(row.asset, entry.sourceBorrowAsset) ||
      row.amt !== entry.sourceBorrowAmountRaw ||
      row.tier !== entry.sourceTier ||
      row.destKind !== 'lend' ||
      row.dest !== 'Spark'
    ) {
      fail('source_member_mismatch')
    }
  }
  return rows.length
}

export function verifyRowEvidence(row, proof, later = null) {
  const borrower = lower(row.borrower)
  if (row.classification === 'spark_lend_usdt_supply_receipt') {
    const amount = BigInt(row.usdtTransferRaw)
    if (
      !poolEvent(proof, 'supply', USDT, borrower, amount) ||
      !tokenTransfer(proof, USDT, borrower, USDT_ATOKEN, amount) ||
      !mint(proof, USDT_ATOKEN, borrower, amount)
    )
      fail('usdt_supply_proof_invalid')
  } else if (row.classification === 'spark_lend_usdt_borrow_receipt') {
    const amount = BigInt(row.usdtTransferRaw)
    if (
      !poolEvent(proof, 'borrow', USDT, borrower, amount) ||
      !tokenTransfer(proof, USDT, USDT_ATOKEN, borrower, amount) ||
      eventLogs(proof, POOL, 'supply').some(
        (args) => same(args.reserve, USDT) && same(args.user, borrower),
      )
    ) {
      fail('usdt_borrow_proof_invalid')
    }
  } else if (row.classification === 'usdc_supply_then_usdt_borrow') {
    const supply = eventLogs(proof, POOL, 'supply').filter(
      (args) =>
        same(args.reserve, USDC) && same(args.user, borrower) && same(args.onBehalfOf, borrower),
    )
    const transfer = eventLogs(proof, USDC, 'transfer').filter(
      (args) => same(args.from, borrower) && supply.some((event) => event.amount === args.value),
    )
    if (
      !transfer.some((args) => mint(proof, args.to, borrower, args.value)) ||
      eventLogs(proof, POOL, 'supply').some(
        (args) => same(args.reserve, USDT) && same(args.user, borrower),
      )
    ) {
      fail('usdc_supply_proof_invalid')
    }
    if (!later) fail('later_usdt_borrow_missing')
    const borrow = eventLogs(later, POOL, 'borrow').filter(
      (args) =>
        same(args.reserve, USDT) && same(args.user, borrower) && same(args.onBehalfOf, borrower),
    )
    if (!borrow.some((args) => tokenTransfer(later, USDT, USDT_ATOKEN, borrower, args.amount))) {
      fail('later_usdt_borrow_proof_invalid')
    }
  } else fail('manifest_classification_invalid')
}

export async function verifiedReceipt(client, tx, expectedBlock, finalizedBlock, blocks, receipts) {
  if (expectedBlock > finalizedBlock) fail('receipt_not_finalized')
  const key = lower(tx)
  if (!receipts.has(key)) receipts.set(key, await client.getTransactionReceipt({ hash: tx }))
  const receipt = receipts.get(key)
  if (!blocks.has(expectedBlock))
    blocks.set(expectedBlock, await client.getBlock({ blockNumber: BigInt(expectedBlock) }))
  const block = blocks.get(expectedBlock)
  if (
    receipt.status !== 'success' ||
    !same(receipt.transactionHash, tx) ||
    Number(receipt.blockNumber) !== expectedBlock ||
    !HASH.test(lower(receipt.blockHash)) ||
    Number(block.number) !== expectedBlock ||
    !same(block.hash, receipt.blockHash)
  )
    fail('receipt_coordinate_invalid')
  return receipt
}

export async function verifySparkReceipts({ client, manifest, sourceRaw }) {
  validateManifest(manifest)
  if (!sourceRaw) fail('source_missing')
  verifySourceRows(manifest, sourceRaw)
  if ((await client.getChainId()) !== 1) fail('wrong_chain')
  const head = await client.getBlock({ blockTag: 'finalized' })
  if (!integer(Number(head.number)) || !HASH.test(lower(head.hash))) fail('finalized_head_invalid')
  const blocks = new Map(),
    receipts = new Map()
  for (const row of manifest.entries) {
    await verifiedReceipt(
      client,
      row.sourceBorrowTx,
      row.sourceBorrowBlock,
      Number(head.number),
      blocks,
      receipts,
    )
    const proof = await verifiedReceipt(
      client,
      row.proofTx,
      row.proofBlock,
      Number(head.number),
      blocks,
      receipts,
    )
    const later =
      row.classification === 'usdc_supply_then_usdt_borrow'
        ? await verifiedReceipt(
            client,
            row.laterBorrowTx,
            row.laterBorrowBlock,
            Number(head.number),
            blocks,
            receipts,
          )
        : null
    verifyRowEvidence(row, proof, later)
  }
  return {
    status: 'verified',
    rows: manifest.entries.length,
    supplies: 13,
    contraryBorrows: 2,
    sourceMembership: 'verified',
    finalizedBlock: Number(head.number),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
    const sourcePath = process.env.CARRY_ROUTES_AB_PATH || CHECKED_IN_SOURCE
    if (!existsSync(sourcePath)) fail('source_missing')
    const sourceRaw = readFileSync(sourcePath)
    const rpc =
      process.env.RECORDER_RPC_URLS ||
      process.env.RECORDER_RPC_URL ||
      readEnv().get('RECORDER_RPC_URLS') ||
      readEnv().get('RECORDER_RPC_URL')
    if (!rpc) fail('rpc_missing')
    const result = await verifySparkReceipts({ client: makeClient(rpc), manifest, sourceRaw })
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch {
    // RPC errors can contain credential-bearing URLs; never print error/cause.
    process.stderr.write('Spark August receipt verification failed closed.\n')
    process.exitCode = 1
  }
}
