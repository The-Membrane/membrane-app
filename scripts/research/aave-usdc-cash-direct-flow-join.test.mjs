import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  CONTINUATION_STUDY,
  FROM_BLOCK,
  canonicalJoinNames,
  createVerifiedJoinSession,
  joinVerifiedCashSlice,
  replayJoin,
  selectCommonThrough,
  selectContinuationThrough,
} from './aave-usdc-cash-direct-flow-join.mjs'
import { DIRECT_FLOW_DIR } from '../record-carry-direct-supplier-flow.mjs'
import {
  OUT as CASH_OUT,
  DRPC_ORIGIN,
  QUICKNODE_ORIGIN,
  QUICKNODE_SLICE_BLOCKS,
  ORIGINS,
  TO_BLOCK,
  economicProjection,
} from './aave-usdc-market-cash-archive.mjs'
import { ROOT as V2_ROOT, STUDY as V2_STUDY } from './aave-usdc-market-cash-archive-v2.mjs'

const HASH_A = `0x${'aa'.repeat(32)}`
const HASH_B = `0x${'bb'.repeat(32)}`
const HASH_C = `0x${'cc'.repeat(32)}`
const TX_A = `0x${'11'.repeat(32)}`
const TX_B = `0x${'22'.repeat(32)}`
const TX_C = `0x${'33'.repeat(32)}`
const TX_D = `0x${'44'.repeat(32)}`
const ATOKEN = '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c'
const HOLDER = '0x1111111111111111111111111111111111111111'
const RECEIVER = '0x2222222222222222222222222222222222222222'
const digest = (value) => createHash('sha256').update(value).digest('hex')

test('verified-session enumeration ignores noncanonical metadata but retains intended JSON', () => {
  assert.deepEqual(
    canonicalJoinNames(
      ['.DS_Store', 'slice-26079860-26079988.json', '._slice-26079860-26079988.json'],
      'cash_v1',
    ),
    ['slice-26079860-26079988.json'],
  )
  assert.deepEqual(canonicalJoinNames(['.DS_Store', 'epoch-000'], 'cash_v2_root'), ['epoch-000'])
  assert.deepEqual(
    canonicalJoinNames(
      ['.DS_Store', 'genesis.json', 'slice-26095417-26095673.json'],
      'cash_v2_epoch',
    ),
    ['genesis.json', 'slice-26095417-26095673.json'],
  )
  assert.throws(
    () => canonicalJoinNames(['slice-26079860-26079988.json', 'notes.txt'], 'cash_v1'),
    /join_unexpected_archive_entry/,
  )
  assert.throws(
    () => canonicalJoinNames(['epoch-000', '.hidden-epoch-001'], 'cash_v2_root'),
    /join_unexpected_archive_entry/,
  )
  assert.throws(
    () => canonicalJoinNames(['._slice-26079860-26079988.json'], 'cash_v1'),
    /join_unexpected_archive_entry/,
  )
})

const coord = (tx, logIndex) => ({
  blockNumber: 101,
  blockHash: HASH_B,
  transactionHash: tx,
  logIndex,
})

function fixture() {
  const cash = {
    market: 'USDC',
    chainId: 1,
    aToken: ATOKEN,
    from: { blockNumber: 100, blockHash: HASH_A, cashRaw: '1000' },
    to: { blockNumber: 101, blockHash: HASH_B, cashRaw: '970' },
    operations: [
      { ...coord(TX_A, 1), kind: 'Withdraw', amountRaw: '100' },
      { ...coord(TX_B, 3), kind: 'Supply', amountRaw: '40' },
      { ...coord(TX_C, 5), kind: 'Borrow', amountRaw: '30' },
      { ...coord(TX_D, 7), kind: 'Repay', amountRaw: '60' },
    ],
    transfers: [
      { ...coord(TX_A, 2), from: ATOKEN, to: RECEIVER, amountRaw: '100' },
      { ...coord(TX_B, 2), from: HOLDER, to: ATOKEN, amountRaw: '40' },
      { ...coord(TX_C, 4), from: ATOKEN, to: RECEIVER, amountRaw: '30' },
      { ...coord(TX_D, 6), from: HOLDER, to: ATOKEN, amountRaw: '60' },
    ],
    reconciliation: {
      endpointReconciled: true,
      totals: { transferInRaw: '100', transferOutRaw: '130' },
    },
  }
  const withdrawal = {
    ...coord(TX_A, 1),
    reconciliation: {
      status: 'reconciled_supplier_withdrawal',
      evidence: { amountRaw: '100', withdrawLogIndex: 1, payoutLogIndex: 2, receiver: RECEIVER },
    },
  }
  const supply = {
    ...coord(TX_B, 3),
    reconciliation: {
      status: 'reconciled_supplier_supply',
      evidence: { amountRaw: '40', supplyLogIndex: 3, transferLogIndex: 2, supplier: HOLDER },
    },
  }
  const headers = [
    {
      kind: 'withdraw',
      headers: [
        { number: 100, hash: HASH_A },
        { number: 101, hash: HASH_B },
      ],
    },
    {
      kind: 'supply',
      headers: [
        { number: 100, hash: HASH_A },
        { number: 101, hash: HASH_B },
      ],
    },
  ]
  return { cash, withdrawal, supply, headers }
}

test('retains verified sparse header times and rejects contradictory time witnesses', () => {
  const { cash, withdrawal, supply, headers } = fixture()
  for (const part of headers)
    part.headers.forEach((header, index) => {
      header.timestampSec = 1000 + index * 31
    })
  const row = joinVerifiedCashSlice(cash, [withdrawal], [supply], headers, {
    retainVerifiedTimes: true,
  })
  assert.deepEqual(row.verifiedTimeHeaders, [
    { blockNumber: 100, blockHash: HASH_A, timestampSec: 1000 },
    { blockNumber: 101, blockHash: HASH_B, timestampSec: 1031 },
  ])
  assert.equal(
    joinVerifiedCashSlice(cash, [withdrawal], [supply], headers).verifiedTimeHeaders,
    undefined,
  )
  headers[1].headers[1].timestampSec = 1032
  assert.throws(
    () => joinVerifiedCashSlice(cash, [withdrawal], [supply], headers),
    /join_header_time_mismatch/,
  )
})

test('separates gross matched supplier flows from other reserve-changing cash', () => {
  const { cash, withdrawal, supply, headers } = fixture()
  const row = joinVerifiedCashSlice(cash, [withdrawal], [supply], headers)
  assert.deepEqual(row.blockFlows, [
    {
      blockNumber: 101,
      blockHash: HASH_B,
      reserveInRaw: '100',
      reserveOutRaw: '130',
      supplierInRaw: '40',
      supplierOutRaw: '100',
      cashAfterRaw: '970',
    },
  ])
  assert.deepEqual(
    [
      row.grossSupplierWithdrawalRaw,
      row.grossSupplierSupplyRaw,
      row.otherReserveOutRaw,
      row.otherReserveInRaw,
      row.netCashChangeRaw,
    ],
    ['100', '40', '30', '60', '-30'],
  )
})

test('requires transfer identity and economic amount, not equal event log indices', () => {
  const { cash, withdrawal, supply, headers } = fixture()
  cash.transfers[0].amountRaw = '99'
  assert.throws(
    () => joinVerifiedCashSlice(cash, [withdrawal], [supply], headers),
    /join_direct_cash_mismatch/,
  )
  cash.transfers[0].amountRaw = '100'
  withdrawal.reconciliation.evidence.payoutLogIndex = 1
  assert.throws(
    () => joinVerifiedCashSlice(cash, [withdrawal], [supply], headers),
    /join_direct_cash_mismatch/,
  )
})

test('rejects a duplicated direct payout and a contradictory shared chain header', () => {
  const { cash, withdrawal, supply, headers } = fixture()
  assert.throws(
    () => joinVerifiedCashSlice(cash, [withdrawal, withdrawal], [supply], headers),
    /join_direct_cash_mismatch/,
  )
  headers[1].headers[1].hash = HASH_A
  assert.throws(
    () => joinVerifiedCashSlice(cash, [withdrawal], [supply], headers),
    /join_chain_hash_mismatch/,
  )
})

test('requires every cash Supply and Withdraw operation to have a direct receipt witness', () => {
  const { cash, withdrawal, supply, headers } = fixture()
  assert.throws(
    () => joinVerifiedCashSlice(cash, [], [supply], headers),
    /join_unmatched_supplier_operation/,
  )
  assert.throws(
    () => joinVerifiedCashSlice(cash, [withdrawal], [], headers),
    /join_unmatched_supplier_operation/,
  )
})

test('preserves exact raw integers and fails closed on unreconciled cash', () => {
  const { cash, withdrawal, supply, headers } = fixture()
  const huge = 10n ** 39n
  cash.from.cashRaw = huge.toString()
  cash.to.cashRaw = (huge - 30n).toString()
  assert.equal(
    joinVerifiedCashSlice(cash, [withdrawal], [supply], headers).cashAfterRaw,
    (huge - 30n).toString(),
  )
  cash.reconciliation.endpointReconciled = false
  assert.throws(
    () => joinVerifiedCashSlice(cash, [withdrawal], [supply], headers),
    /join_invalid_cash_slice/,
  )
})

test('finds a depleted end-of-block cash level before a later block replenishes it', () => {
  const { cash, withdrawal, supply, headers } = fixture()
  cash.to = { blockNumber: 102, blockHash: HASH_C, cashRaw: '970' }
  for (const index of [1, 3]) {
    cash.operations[index].blockNumber = 102
    cash.operations[index].blockHash = HASH_C
    cash.transfers[index].blockNumber = 102
    cash.transfers[index].blockHash = HASH_C
  }
  supply.blockNumber = 102
  supply.blockHash = HASH_C
  for (const header of headers) header.headers.push({ number: 102, hash: HASH_C })
  // The two reserve outflows occur first; the two inflows replenish in block 102.
  cash.transfers = [cash.transfers[0], cash.transfers[2], cash.transfers[1], cash.transfers[3]]
  const row = joinVerifiedCashSlice(cash, [withdrawal], [supply], headers)
  assert.equal(row.minEndOfBlockCashRaw, '870')
  assert.equal(row.minEndOfBlockCashAtBlock, 101)
  assert.equal(row.cashAfterRaw, '970')
})

test('nets all transfers in a block before evaluating the trough, including the opening endpoint', () => {
  const { cash } = fixture()
  cash.from.cashRaw = '10'
  cash.to.cashRaw = '10'
  cash.operations = []
  cash.transfers = [
    { ...coord(TX_A, 1), from: ATOKEN, to: RECEIVER, amountRaw: '100' },
    { ...coord(TX_B, 2), from: HOLDER, to: ATOKEN, amountRaw: '100' },
  ]
  cash.reconciliation.totals = { transferInRaw: '100', transferOutRaw: '100' }
  const row = joinVerifiedCashSlice(cash, [], [])
  assert.equal(row.minEndOfBlockCashRaw, '10')
  assert.equal(row.minEndOfBlockCashAtBlock, 100)
})

test('rejects negative block cash, conflicting hashes/order, and a mismatched endpoint', () => {
  const { cash } = fixture()
  cash.from.cashRaw = '10'
  cash.to = { blockNumber: 102, blockHash: HASH_C, cashRaw: '10' }
  cash.operations = []
  cash.transfers = [
    { ...coord(TX_A, 1), from: ATOKEN, to: RECEIVER, amountRaw: '20' },
    {
      ...coord(TX_B, 2),
      blockNumber: 102,
      blockHash: HASH_C,
      from: HOLDER,
      to: ATOKEN,
      amountRaw: '20',
    },
  ]
  cash.reconciliation.totals = { transferInRaw: '20', transferOutRaw: '20' }
  assert.throws(() => joinVerifiedCashSlice(cash, [], []), /join_negative_block_cash/)
  cash.transfers[1].blockNumber = 101
  assert.throws(() => joinVerifiedCashSlice(cash, [], []), /join_chain_hash_mismatch/)
  cash.transfers[1].blockNumber = 102
  cash.transfers[1].blockHash = HASH_B
  cash.transfers.reverse()
  assert.throws(() => joinVerifiedCashSlice(cash, [], []), /join_chain_hash_mismatch/)
  cash.transfers[0].blockHash = HASH_C
  assert.throws(() => joinVerifiedCashSlice(cash, [], []), /join_transfer_block_order/)
  cash.transfers.reverse()
  cash.transfers[1].blockNumber = 102
  cash.transfers[1].blockHash = HASH_C
  cash.from.cashRaw = '100'
  cash.to.cashRaw = '101'
  assert.throws(() => joinVerifiedCashSlice(cash, [], []), /join_cash_accounting_mismatch/)
})

test('selects the latest common sealed cash boundary, and requires explicit exact boundary', () => {
  const cashNames = [
    'slice-26079860-26079988.json',
    'slice-26079988-26080116.json',
    'slice-26080116-26080244.json',
  ]
  const directNames = [
    'aaveV3Usdc-26079847-26079910.json',
    'aaveV3Usdc-26079911-26080000.json',
    'aaveV3Usdc-26080001-26080150.json',
    'supply-aaveV3Usdc-26079847-26080000.json',
    'supply-aaveV3Usdc-26080001-26080250.json',
  ]
  const input = { cashNames, directNames, archiveThrough: 26080244 }
  assert.deepEqual(selectCommonThrough(input), {
    throughBlock: 26080116,
    archiveThrough: 26080244,
    withdrawalThrough: 26080150,
    supplyThrough: 26080250,
  })
  assert.equal(selectCommonThrough({ ...input, explicitThrough: 26079988 }).throughBlock, 26079988)
  assert.throws(
    () => selectCommonThrough({ ...input, explicitThrough: 26080000 }),
    /join_common_range_unavailable/,
  )
  assert.throws(
    () =>
      selectCommonThrough({
        ...input,
        directNames: directNames.filter((name) => !name.includes('26079911')),
      }),
    /join_common_range_unavailable/,
  )
})

function continuationFixture(t, left = { origin: ORIGINS[0], label: 'infura' }) {
  const home = mkdtempSync(join(tmpdir(), 'aave-join-v2-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const cashOut = join(home, 'v1')
  const cashV2Root = join(home, 'v2')
  const epoch = join(cashV2Root, 'epoch-000')
  const directOut = join(home, 'direct')
  mkdirSync(join(cashOut, 'infura'), { recursive: true })
  mkdirSync(join(epoch, left.label), { recursive: true })
  mkdirSync(directOut)
  const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
  const makeCash = (fromBlock, toBlock) => {
    const body = {
      market: 'USDC',
      chainId: 1,
      pool: 'pool',
      underlying: 'usdc',
      aToken: ATOKEN,
      from: { blockNumber: fromBlock, blockHash: hash(fromBlock), cashRaw: '1000' },
      to: { blockNumber: toBlock, blockHash: hash(toBlock), cashRaw: '1000' },
      identities: [],
      chunks: { poolOperations: [], underlyingTransfers: [] },
      operations: [],
      transfers: [],
      reconciliation: {
        endpointReconciled: true,
        totals: { transferInRaw: '0', transferOutRaw: '0' },
      },
    }
    return { ...body, sha256: digest(JSON.stringify(body)) }
  }
  const putSlice = (out, fromBlock, toBlock, isV2) => {
    const source = makeCash(fromBlock, toBlock)
    const sourceFile = `USDC-${fromBlock}-${toBlock}-${hash(toBlock).slice(2)}.json`
    const sourcePath = join(out, isV2 ? left.label : 'infura', sourceFile)
    writeFileSync(sourcePath, JSON.stringify(source))
    const sidecarBody = {
      ...(isV2 ? { study: V2_STUDY, epoch: 0 } : {}),
      fromBlock,
      toBlock,
      toHash: hash(toBlock),
      originSha256: [digest(isV2 ? left.origin : ORIGINS[0]), digest(ORIGINS[1])],
      leftFile: sourceFile,
      leftSha256: source.sha256,
      rightFile: sourceFile,
      rightSha256: digest('right'),
      projectionSha256: digest(JSON.stringify(economicProjection(source))),
    }
    const sidecar = { ...sidecarBody, sha256: digest(JSON.stringify(sidecarBody)) }
    const sidecarFile = `slice-${fromBlock}-${toBlock}.json`
    const sidecarPath = join(out, sidecarFile)
    writeFileSync(sidecarPath, JSON.stringify(sidecar))
    return { sourcePath, source, sidecarPath, sidecar, sidecarFile }
  }
  const v2ToBlock = TO_BLOCK + (left.origin === QUICKNODE_ORIGIN ? QUICKNODE_SLICE_BLOCKS : 256)
  const v1 = putSlice(cashOut, FROM_BLOCK, TO_BLOCK, false)
  const v2 = putSlice(epoch, TO_BLOCK, v2ToBlock, true)
  const descriptor = {
    epoch: 0,
    file: v2.sidecarPath,
    sidecarSha256: digest(JSON.stringify(v2.sidecar)),
    fromBlock: TO_BLOCK,
    toBlock: v2ToBlock,
    fromHash: hash(TO_BLOCK),
    toHash: hash(v2ToBlock),
    leftOrigin: left.label,
    leftFile: v2.sourcePath,
    leftSha256: v2.source.sha256,
    rightOrigin: 'ankr',
    rightFile: join(epoch, 'ankr', 'right.json'),
    rightSha256: digest('right'),
    projectionSha256: v2.sidecar.projectionSha256,
  }
  for (const prefix of ['aaveV3Usdc-', 'supply-aaveV3Usdc-'])
    writeFileSync(join(directOut, `${prefix}${FROM_BLOCK + 1}-${v2ToBlock}.json`), '')
  const archive = {
    study: 'aave-usdc-market-cash-archive-v1',
    complete: true,
    acceptedSlices: 1,
    throughBlock: TO_BLOCK,
    lastHash: hash(TO_BLOCK),
  }
  const continuation = {
    study: V2_STUDY,
    completeV1: true,
    acceptedSlices: 1,
    throughBlock: v2ToBlock,
    lastHash: hash(v2ToBlock),
    slices: [descriptor],
  }
  const args = {
    cashOut,
    cashV2Root,
    directOut,
    verifyCashArchive: () => archive,
    verifyContinuationArchive: () => continuation,
    loadVerifiedDirect: (_out, kind, from, to) => ({
      sourceFiles: [{ file: `${kind}.json`, sha256: digest(kind) }],
      segments: [
        {
          fromBlock: from + 1,
          toBlock: to,
          headers: [],
          events: [],
          sourceFile: `${kind}.json`,
          sourceSha256: digest(kind),
        },
      ],
    }),
  }
  return { args, archive, continuation, descriptor, v1, v2, directOut, epoch, putSlice, hash }
}

test('full replay crosses the V1/V2 boundary with exact source stamps and cash continuity', (t) => {
  const fixture = continuationFixture(t)
  const joined = replayJoin(fixture.args)
  assert.equal(joined.study, CONTINUATION_STUDY)
  assert.deepEqual(
    joined.slices.map((part) => [part.fromExclusive, part.toInclusive]),
    [
      [FROM_BLOCK, TO_BLOCK],
      [TO_BLOCK, TO_BLOCK + 256],
    ],
  )
  assert.equal(joined.slices[1].sources.cashSidecarFile, `epoch-000/${fixture.v2.sidecarFile}`)
  assert.equal(joined.slices[1].sources.cashLeftSha256, fixture.v2.source.sha256)
  assert.equal(joined.slices[1].cashArchiveStudy, V2_STUDY)
  assert.equal(joined.continuity.v1LastHash, fixture.archive.lastHash)
  assert.match(joined.continuity.archivePrefixSha256, /^[0-9a-f]{64}$/)
  assert.equal(joined.continuity.windowed, false)
  assert.equal(
    replayJoin({ ...fixture.args, throughBlock: TO_BLOCK }).study,
    'aave-usdc-cash-direct-flow-join-v1',
  )
})

test('V2 join accepts verified dRPC-left and stamps its exact source', (t) => {
  const fixture = continuationFixture(t, { origin: DRPC_ORIGIN, label: 'drpc' })
  const joined = replayJoin(fixture.args)
  assert.equal(joined.slices[1].sources.cashLeftOrigin, 'drpc')
  assert.equal(
    joined.slices[1].sources.cashLeftFile,
    `epoch-000/drpc/${fixture.v2.sourcePath.split('/').at(-1)}`,
  )
  assert.equal(joined.slices[1].sources.cashLeftSha256, fixture.v2.source.sha256)
  assert.equal(joined.slices[1].sources.cashSidecarSha256, fixture.v2.sidecar.sha256)
})

test('V2 join accepts verified QuickNode-left and stamps its exact source', (t) => {
  const fixture = continuationFixture(t, { origin: QUICKNODE_ORIGIN, label: 'quicknode' })
  const joined = replayJoin(fixture.args)
  assert.equal(joined.slices[1].sources.cashLeftOrigin, 'quicknode')
  assert.equal(
    joined.slices[1].sources.cashLeftFile,
    'epoch-000/quicknode/' + fixture.v2.sourcePath.split('/').at(-1),
  )
  assert.equal(joined.slices[1].sources.cashLeftSha256, fixture.v2.source.sha256)
})

test('V2 join rejects mismatched, unknown, or nonindependent origins', (t) => {
  const fixture = continuationFixture(t, { origin: DRPC_ORIGIN, label: 'drpc' })
  fixture.descriptor.leftOrigin = 'infura'
  assert.throws(() => replayJoin(fixture.args), /join_cash_source_missing/)
  fixture.descriptor.leftOrigin = 'drpc'
  fixture.descriptor.rightOrigin = 'drpc'
  assert.throws(() => replayJoin(fixture.args), /join_cash_source_missing/)
  fixture.descriptor.rightOrigin = 'ankr'
  const sidecarBody = { ...fixture.v2.sidecar }
  delete sidecarBody.sha256
  sidecarBody.originSha256 = [digest(DRPC_ORIGIN), digest(DRPC_ORIGIN)]
  fixture.v2.sidecar = { ...sidecarBody, sha256: digest(JSON.stringify(sidecarBody)) }
  writeFileSync(fixture.v2.sidecarPath, JSON.stringify(fixture.v2.sidecar))
  fixture.descriptor.sidecarSha256 = digest(JSON.stringify(fixture.v2.sidecar))
  assert.throws(() => replayJoin(fixture.args), /join_cash_source_missing/)

  const unknown = continuationFixture(t, { origin: 'https://unknown.example', label: 'drpc' })
  assert.throws(() => replayJoin(unknown.args), /join_cash_source_missing/)
})

test('V2 selection requires an exact direct-covered boundary', (t) => {
  const fixture = continuationFixture(t)
  const cashNames = [fixture.v1.sidecarFile]
  const directNames = [
    `aaveV3Usdc-${FROM_BLOCK + 1}-${TO_BLOCK + 255}.json`,
    `supply-aaveV3Usdc-${FROM_BLOCK + 1}-${TO_BLOCK + 256}.json`,
  ]
  assert.throws(
    () =>
      selectContinuationThrough({
        cashNames,
        directNames,
        archive: fixture.archive,
        continuation: fixture.continuation,
        explicitThrough: TO_BLOCK + 256,
      }),
    /join_common_range_unavailable/,
  )
})

test('V2 replay rejects changed source bytes, descriptor digest, and boundary hash', (t) => {
  const fixture = continuationFixture(t)
  fixture.descriptor.sidecarSha256 = digest('wrong')
  assert.throws(() => replayJoin(fixture.args), /join_cash_slice_gap/)
  fixture.descriptor.sidecarSha256 = digest(JSON.stringify(fixture.v2.sidecar))
  fixture.descriptor.fromHash = HASH_A
  assert.throws(() => replayJoin(fixture.args), /join_cash_source_range/)
  fixture.descriptor.fromHash = fixture.archive.lastHash
  writeFileSync(fixture.v2.sourcePath, JSON.stringify({ ...fixture.v2.source, market: 'DAI' }))
  assert.throws(() => replayJoin(fixture.args), /join_cash_source_digest/)
})

test('long V2 continuation retains a bounded recent window and verified archive continuity', (t) => {
  const fixture = continuationFixture(t)
  let from = TO_BLOCK + 256
  for (let index = 1; index < 129; index += 1) {
    const to = from + 256
    const row = fixture.putSlice(fixture.epoch, from, to, true)
    fixture.continuation.slices.push({
      ...fixture.descriptor,
      file: row.sidecarPath,
      sidecarSha256: digest(JSON.stringify(row.sidecar)),
      fromBlock: from,
      toBlock: to,
      fromHash: fixture.hash(from),
      toHash: fixture.hash(to),
      leftFile: row.sourcePath,
      leftSha256: row.source.sha256,
      projectionSha256: row.sidecar.projectionSha256,
    })
    from = to
  }
  fixture.continuation.acceptedSlices = 129
  fixture.continuation.throughBlock = from
  fixture.continuation.lastHash = fixture.hash(from)
  for (const prefix of ['aaveV3Usdc-', 'supply-aaveV3Usdc-'])
    writeFileSync(join(fixture.directOut, `${prefix}${TO_BLOCK + 257}-${from}.json`), '')
  const joined = replayJoin(fixture.args)
  assert.equal(joined.slices.length, 127)
  assert.equal(joined.fromBlock, TO_BLOCK + 512)
  assert.equal(joined.toBlock, from)
  assert.equal(joined.continuity.archivedSlices, 130)
  assert.equal(joined.continuity.windowed, true)
  assert.equal(joined.slices[0].fromHash, fixture.hash(TO_BLOCK + 512))
})

test(
  'verified session matches the independent replay on the local V1/V2 corpus and rejects unpinned endpoints',
  { skip: !existsSync(CASH_OUT) || !existsSync(DIRECT_FLOW_DIR) },
  () => {
    const session = createVerifiedJoinSession()
    const latest = session.latest()
    const independent = replayJoin()
    assert.deepEqual(latest, independent)
    const pins = session.pinEndpoints()
    assert.equal(pins.at(-1), latest.toBlock)
    assert.equal(pins.includes(TO_BLOCK), true)
    assert.equal(session.at(TO_BLOCK).toBlock, TO_BLOCK)
    assert.equal(session.at(pins[pins.indexOf(TO_BLOCK) + 1]).study, CONTINUATION_STUDY)
    assert.throws(() => session.at(TO_BLOCK + 1), /join_session_unverified_endpoint/)
    pins.pop()
    assert.equal(session.pinEndpoints().at(-1), latest.toBlock)
  },
)

test(
  'verified session rejects a V1 origin witness replaced after archive verification',
  { skip: !existsSync(CASH_OUT) || !existsSync(DIRECT_FLOW_DIR) },
  (t) => {
    const out = realpathSync(mkdtempSync(join(tmpdir(), 'aave-proof-session-')))
    t.after(() => rmSync(out, { recursive: true, force: true }))
    const mirror = (source, target) => {
      mkdirSync(target, { recursive: true })
      for (const name of readdirSync(source)) {
        const from = join(source, name)
        const to = join(target, name)
        if (lstatSync(from).isDirectory()) mirror(from, to)
        else linkSync(from, to)
      }
    }
    mirror(CASH_OUT, out)
    const session = createVerifiedJoinSession({ cashOut: out })
    const witness = readdirSync(out).find((name) =>
      /^origin-(?:infura|alchemy|drpc|quicknode)-[0-9]+-[0-9]+\.json$/.test(name),
    )
    assert.ok(witness)
    unlinkSync(join(out, witness))
    writeFileSync(join(out, witness), '{}')
    assert.throws(() => session.latest(), /join_session_proof_source_changed/)
  },
)

test(
  'verified session rejects a selected direct receipt replaced after its raw snapshot',
  { skip: !existsSync(CASH_OUT) || !existsSync(DIRECT_FLOW_DIR) },
  (t) => {
    const out = mkdtempSync(join(tmpdir(), 'aave-join-session-'))
    t.after(() => rmSync(out, { recursive: true, force: true }))
    for (const name of readdirSync(DIRECT_FLOW_DIR).filter((name) =>
      /^(?:supply-)?aaveV3Usdc-[0-9]+-[0-9]+\.json$/.test(name),
    ))
      linkSync(join(DIRECT_FLOW_DIR, name), join(out, name))
    const session = createVerifiedJoinSession({ directOut: out })
    const latest = session.latest()
    const selected = latest.slices.at(-1).sources.directWithdrawalFiles.at(-1).file
    assert.ok(selected)
    unlinkSync(join(out, selected)) // break the hard link; never edit the original corpus
    writeFileSync(join(out, selected), '{}')
    assert.throws(() => session.latest(), /join_direct_source_changed/)
  },
)

test(
  'verified session rejects a selected V2 right receipt replaced after its raw snapshot',
  { skip: !existsSync(CASH_OUT) || !existsSync(DIRECT_FLOW_DIR) || !existsSync(V2_ROOT) },
  (t) => {
    const out = realpathSync(mkdtempSync(join(tmpdir(), 'aave-right-session-')))
    t.after(() => rmSync(out, { recursive: true, force: true }))
    const mirror = (source, target) => {
      mkdirSync(target, { recursive: true })
      for (const name of readdirSync(source)) {
        const from = join(source, name)
        const to = join(target, name)
        if (lstatSync(from).isDirectory()) mirror(from, to)
        else linkSync(from, to)
      }
    }
    mirror(V2_ROOT, out)
    const session = createVerifiedJoinSession({ cashV2Root: out })
    const latest = session.latest()
    const selected = latest.slices.at(-1).sources.cashRightFile
    assert.ok(selected)
    unlinkSync(join(out, selected)) // replace temp link, preserving the original receipt
    writeFileSync(join(out, selected), '{}')
    assert.throws(() => session.latest(), /join_session_right_source_changed/)
  },
)
