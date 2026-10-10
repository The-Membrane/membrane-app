import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { keccak256, stringToHex } from 'viem'

import {
  captureProspectiveIntake,
  verifyProspectiveIntake,
} from './apyusd-prospective-receipt-intake.mjs'
import { RECEIPT } from './carry-public-apyusd-exit-common.mjs'

const START = Date.parse('2026-10-03T12:00:00.000Z')
const TOPIC = keccak256(stringToHex('Transfer(address,address,uint256)'))
const ZERO = `0x${'0'.repeat(64)}`
const HOLDER = '0x1111111111111111111111111111111111111111'
const ALT_HOLDER = '0x2222222222222222222222222222222222222222'
const word = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`
const block = (number) => ({
  number: `0x${number.toString(16)}`,
  hash: word(number),
  parentHash: word(number - 1),
  timestamp: `0x${(Math.floor(START / 1_000) - 600 + (number - 100) * 12).toString(16)}`,
})
const mint = (holder = HOLDER) => ({
  address: RECEIPT,
  blockNumber: '0x65',
  blockHash: word(101),
  transactionHash: word(501),
  transactionIndex: '0x0',
  logIndex: '0x0',
  topics: [TOPIC, ZERO, word(holder), word(951)],
  data: '0x',
  removed: false,
})
const transfer = () => ({
  ...mint(),
  blockNumber: '0x66',
  blockHash: word(102),
  transactionHash: word(502),
  topics: [TOPIC, word(HOLDER), word(ALT_HOLDER), word(951)],
})
const burn = () => ({
  ...mint(),
  blockNumber: '0x67',
  blockHash: word(103),
  transactionHash: word(503),
  topics: [TOPIC, word(ALT_HOLDER), ZERO, word(951)],
})
const mintAt = (number, tokenId) => ({
  ...mint(),
  blockNumber: `0x${number.toString(16)}`,
  blockHash: word(number),
  transactionHash: word(500 + number),
  topics: [TOPIC, ZERO, word(HOLDER), word(tokenId)],
})

function fakeClients(state) {
  return () =>
    ['alpha.example', 'beta.example'].map((host, index) => ({
      url: `https://${host}/rpc`,
      provider: `https://${host}`,
      async request(method, params) {
        state.calls.push({ host, method, params })
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_getBlockByNumber') {
          const number = params[0] === 'finalized' ? state.head : Number(BigInt(params[0]))
          return index === 1 && state.badHeader && number === state.head
            ? { ...block(number), hash: word(8_888) }
            : block(number)
        }
        if (method === 'eth_getLogs') {
          const query = params[0]
          if (state.dense)
            return Array.from({ length: 19 }, (_, offset) =>
              mintAt(101 + offset, 1_101 + offset),
            ).filter(
              (log) =>
                Number(BigInt(log.blockNumber)) >= Number(BigInt(query.fromBlock)) &&
                Number(BigInt(log.blockNumber)) <= Number(BigInt(query.toBlock)),
            )
          if (state.badLogs && index === 1) return [mint(ALT_HOLDER)]
          return [
            ...(Number(BigInt(query.fromBlock)) <= 101 && Number(BigInt(query.toBlock)) >= 101
              ? [mint()]
              : []),
            ...(Number(BigInt(query.fromBlock)) <= 102 && Number(BigInt(query.toBlock)) >= 102
              ? [transfer()]
              : []),
            ...(Number(BigInt(query.fromBlock)) <= 103 && Number(BigInt(query.toBlock)) >= 103
              ? [burn()]
              : []),
            ...(state.remint &&
            Number(BigInt(query.fromBlock)) <= 103 &&
            Number(BigInt(query.toBlock)) >= 103
              ? [{ ...mintAt(103, 951), logIndex: '0x1' }]
              : []),
          ]
        }
        throw Error('unexpected_test_method')
      },
    }))
}

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'apyusd-intake-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function options(out, state) {
  return {
    out,
    urls: ['https://alpha.example/rpc', 'https://beta.example/rpc'],
    clientsForUrls: fakeClients(state),
    now: () => START + (state.head - 100) * 12_000,
    freeBytes: () => 2_000_000_000,
  }
}

async function reseal(path, modify) {
  const row = JSON.parse(await readFile(path, 'utf8'))
  modify(row)
  const { sha256: _old, ...body } = row
  row.sha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  await writeFile(path, `${JSON.stringify(row)}\n`)
}

test('first run anchors at observed finalized head; next run enrolls every mint from anchor+1', async (t) => {
  const out = await temporary(t)
  const state = { head: 100, calls: [] }
  const first = await captureProspectiveIntake(options(out, state))
  assert.deepEqual(first, {
    status: 'anchored',
    anchorBlock: 100,
    coveredThrough: 100,
    mints: 0,
    windows: 0,
  })
  assert.equal(state.calls.filter((call) => call.method === 'eth_getLogs').length, 0)
  const anchor = (await verifyProspectiveIntake(out)).anchor
  assert.equal(anchor.enrollmentFromBlock, 101)
  assert.deepEqual(anchor.origins, ['alpha.example', 'beta.example'])

  state.head = 102
  state.calls = []
  const second = await captureProspectiveIntake(options(out, state))
  assert.equal(second.status, 'captured')
  assert.equal(second.coveredThrough, 102)
  const verified = await verifyProspectiveIntake(out)
  assert.equal(verified.mints, 1)
  assert.equal(verified.windows[0].fromBlock, 101)
  assert.equal(verified.windows[0].toBlock, 102)
  assert.equal(verified.windows[0].previousSha256, anchor.sha256)
  assert.equal(verified.windows[0].mints[0].tokenId, '951')
  assert.equal(verified.windows[0].mints[0].initialHolder, HOLDER)
  assert.equal(verified.windows[0].mints[0].issueBlockNumber, 101)
  assert.equal(verified.windows[0].mints[0].issueBlockHash, word(101))
  assert.equal(verified.windows[0].mints[0].transactionHash, word(501))
  assert.equal(verified.windows[0].mints[0].logIndex, 0)
  assert.deepEqual(verified.windows[0].mints[0].rawLog, mint())
  assert.equal(verified.windows[0].transfers.length, 2)
  assert.deepEqual(
    verified.windows[0].transfers.map((event) => event.blockNumber),
    [101, 102],
  )
  assert.deepEqual(verified.windows[0].transfers[1].topics[1], word(HOLDER))
  assert.deepEqual(verified.windows[0].transfers[1].topics[2], word(ALT_HOLDER))
  assert.deepEqual(verified.windows[0].mints[0].requestAssets, {
    status: 'unknown',
    assetsRaw: null,
    source: null,
  })
  assert.deepEqual(
    state.calls
      .filter((call) => call.method === 'eth_getLogs')
      .map((call) => call.params[0].fromBlock),
    ['0x65', '0x65'],
  )

  state.head = 103
  await captureProspectiveIntake(options(out, state))
  const continued = await verifyProspectiveIntake(out)
  assert.equal(continued.windows[1].fromBlock, 103)
  assert.equal(continued.windows[1].previousSha256, continued.windows[0].sha256)
  assert.equal(continued.windows[1].transfers.length, 1)
  assert.equal(continued.windows[1].transfers[0].topics[2], ZERO)
  assert.equal(continued.mints, 1)
})

test('provider header or mint disagreement aborts without adding a window', async (t) => {
  const out = await temporary(t)
  const state = { head: 100, calls: [] }
  await captureProspectiveIntake(options(out, state))
  state.head = 102
  state.badHeader = true
  await assert.rejects(
    captureProspectiveIntake(options(out, state)),
    /apyusd_intake_headers_disagree/,
  )
  state.badHeader = false
  state.badLogs = true
  await assert.rejects(captureProspectiveIntake(options(out, state)), /apyusd_intake_logs_disagree/)
  assert.deepEqual(await readdir(out), ['anchor.json'])
})

test('an orphaned parent staging file cannot stall the committed ledger', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'apyusd-intake-crash-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const out = join(root, 'ledger')
  const state = { head: 100, calls: [] }
  await captureProspectiveIntake(options(out, state))
  await writeFile(join(root, '.ledger-crashed.tmp'), '{incomplete')
  state.head = 102
  const result = await captureProspectiveIntake(options(out, state))
  assert.equal(result.status, 'captured')
  assert.equal(result.coveredThrough, 102)
  assert.deepEqual((await readdir(out)).sort(), ['00000001.json', 'anchor.json'])
  assert.equal((await verifyProspectiveIntake(out)).mints, 1)
})

test('offline verifier rejects mutable membership, optimistic amount, and omitted ranges even if resealed', async (t) => {
  const out = await temporary(t)
  const state = { head: 100, calls: [] }
  await captureProspectiveIntake(options(out, state))
  state.head = 102
  await captureProspectiveIntake(options(out, state))
  const path = join(out, '00000001.json')
  const pristine = await readFile(path)
  await reseal(path, (row) => {
    row.mints[0].requestAssets = { status: 'verified', assetsRaw: '1000', source: 'mint' }
  })
  await assert.rejects(verifyProspectiveIntake(out), /apyusd_intake_mint_invalid/)
  await writeFile(path, pristine)
  await reseal(path, (row) => {
    row.mints.pop()
  })
  await assert.rejects(verifyProspectiveIntake(out), /apyusd_intake_events_invalid/)
  await writeFile(path, pristine)
  await reseal(path, (row) => {
    row.fromBlock = 102
  })
  await assert.rejects(verifyProspectiveIntake(out), /apyusd_intake_window_invalid/)
  await writeFile(path, pristine)
  await rename(path, join(out, '00000002.json'))
  await assert.rejects(verifyProspectiveIntake(out), /apyusd_intake_chain_gap/)
})

test('disk reserve fails before origin creation or RPC', async (t) => {
  const out = await temporary(t)
  let created = 0
  await assert.rejects(
    captureProspectiveIntake({
      out,
      freeBytes: () => 0,
      clientsForUrls: () => {
        created++
        throw Error('should_not_run')
      },
    }),
    /apyusd_intake_disk_reserve/,
  )
  assert.equal(created, 0)
})

test('RPC clock budget aborts an unbounded collector before writing', async (t) => {
  const out = await temporary(t)
  const state = { head: 100, calls: [] }
  let clock = 0
  await assert.rejects(
    captureProspectiveIntake({
      ...options(out, state),
      rpcClock: () => {
        clock += 30_000
        return clock
      },
    }),
    /apyusd_intake_rpc_budget/,
  )
  assert.equal((await readdir(out)).length, 0)
})

test('dense first blocks halve to a capturable contiguous window under the RPC cap', async (t) => {
  const out = await temporary(t)
  const state = { head: 100, calls: [] }
  await captureProspectiveIntake(options(out, state))
  state.head = 1_100
  state.dense = true
  state.calls = []
  const result = await captureProspectiveIntake(options(out, state))
  assert.equal(result.status, 'captured')
  assert.equal(result.coveredThrough, 116)
  assert.equal(result.mints, 16)
  assert.ok(state.calls.filter((call) => call.method === 'eth_getLogs').length > 6)
  assert.ok(state.calls.length <= 70)
  assert.equal((await verifyProspectiveIntake(out)).coveredThrough, 116)
})

test('a remint of an enrolled token ID fails before append and on offline verification', async (t) => {
  const out = await temporary(t)
  const state = { head: 100, calls: [] }
  await captureProspectiveIntake(options(out, state))
  state.head = 102
  await captureProspectiveIntake(options(out, state))
  state.head = 103
  state.remint = true
  await assert.rejects(captureProspectiveIntake(options(out, state)), /apyusd_intake_token_remint/)
  assert.deepEqual((await readdir(out)).sort(), ['00000001.json', 'anchor.json'])
  state.remint = false
  await captureProspectiveIntake(options(out, state))
  const path = join(out, '00000002.json')
  await reseal(path, (row) => {
    const rawLog = mintAt(103, 951)
    row.transfers[0].topics = rawLog.topics
    row.mints = [
      {
        tokenId: '951',
        initialHolder: HOLDER,
        issueBlockNumber: 103,
        issueBlockHash: word(103),
        issueBlockTimestamp: row.eventBlockHeaders[0].timestamp,
        transactionHash: rawLog.transactionHash,
        logIndex: 0,
        rawLog,
        requestAssets: { status: 'unknown', assetsRaw: null, source: null },
      },
    ]
    row.transfers[0].transactionHash = rawLog.transactionHash
  })
  await assert.rejects(verifyProspectiveIntake(out), /apyusd_intake_token_remint/)
})
