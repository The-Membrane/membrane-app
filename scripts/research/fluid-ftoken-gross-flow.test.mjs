import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbiItem } from 'viem'
import { ROUTES } from './carry-fluid-ftoken-payout.mjs'
import {
  MAX_ARCHIVE_RANGES,
  capture,
  captureNext,
  createPlan,
  verify,
} from './fluid-ftoken-gross-flow.mjs'

test('archive capacity spans roughly 52 days at four ranges per six-minute tick', () => {
  assert.equal(MAX_ARCHIVE_RANGES, 50_000)
  assert.ok((MAX_ARCHIVE_RANGES / 4) * 6 >= 52 * 24 * 60)
})

const hash = (digit) => `0x${digit.repeat(64)}`
const blockHash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const runtime = '0x6000'
const runtimeHash = keccak256(runtime)
const liquidity = '0x52aa899454998be5b000ad077a46bbe360f4e497'
const owner = '0x1111111111111111111111111111111111111111'
const deposit = parseAbiItem(
  'event Deposit(address indexed sender,address indexed owner,uint256 assets,uint256 shares)',
)
const withdraw = parseAbiItem(
  'event Withdraw(address indexed sender,address indexed receiver,address indexed owner,uint256 assets,uint256 shares)',
)
const proofBody = {
  schemaVersion: 1,
  kind: 'fluid_ftoken_two_origin_identity',
  blockNumber: 10,
  blockHash: hash('a'),
  originWitnesses: [],
  routes: ROUTES.map((route) => ({
    ...route,
    liquidity,
    factory: owner,
    implementation: route.vault,
    deploymentKind: 'direct_runtime_code_with_empty_eip1967_slots',
    codeHashes: { implementation: runtimeHash, liquidity: runtimeHash },
  })),
  sourceAttestation: 'deployed_direct_runtime_and_liquidity_code_hashes_only',
}
proofBody.originWitnesses = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'].map((origin) => ({
  origin,
  blockHash: proofBody.blockHash,
  routes: proofBody.routes,
}))
const proof = {
  ...proofBody,
  sha256: createHash('sha256').update(JSON.stringify(proofBody)).digest('hex'),
}
function rawEvent(kind, blockNumber, logIndex) {
  const event = kind === 'deposit' ? deposit : withdraw
  return {
    address: ROUTES[0].vault,
    topics: encodeEventTopics({
      abi: [event],
      eventName: event.name,
      args:
        kind === 'deposit' ? { sender: owner, owner } : { sender: owner, receiver: owner, owner },
    }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [100n, 99n]),
    blockNumber: `0x${blockNumber.toString(16)}`,
    blockHash: blockHash(blockNumber),
    transactionHash: hash('f'),
    logIndex: `0x${logIndex.toString(16)}`,
  }
}
function client(logs = []) {
  return {
    getBlock: async ({ blockTag, blockNumber }) => {
      const n = blockTag ? 12 : Number(blockNumber)
      return {
        number: BigInt(n),
        hash: blockHash(n),
        parentHash: blockHash(n - 1),
        timestamp: BigInt(n * 12),
      }
    },
    readContract: async ({ address, functionName }) => {
      const route = ROUTES.find((r) => r.vault === address)
      return functionName === 'asset' ? route.asset : [liquidity]
    },
    getCode: async () => runtime,
    getBalance: async () => 123n,
    request: async ({ params }) => (params[0].address === ROUTES[0].vault ? logs : []),
  }
}
function origins(left = [], right = left) {
  return [
    { origin: 'eth-mainnet.g.alchemy.com', client: client(left) },
    { origin: 'rpc.ankr.com', client: client(right) },
  ]
}
function withDir(callback) {
  const out = mkdtempSync(join(tmpdir(), 'fluid-flow-test-'))
  return Promise.resolve()
    .then(() => callback(out))
    .finally(() => rmSync(out, { recursive: true, force: true }))
}

test('two origins seal a bounded range including gross Deposit and Withdraw', () =>
  withDir(async (out) => {
    const pair = origins([rawEvent('deposit', 12, 0), rawEvent('withdraw', 12, 1)])
    await createPlan(pair, proof, out)
    // The plan is at finalized block 12; move finalized head to 13 for the range.
    for (const item of pair) {
      item.client.getBlock = async ({ blockTag, blockNumber }) => {
        const n = blockTag ? 13 : Number(blockNumber)
        return {
          number: BigInt(n),
          hash: blockHash(n),
          parentHash: blockHash(n - 1),
          timestamp: BigInt(n * 12),
        }
      }
      item.client.request = async ({ params }) =>
        params[0].address === ROUTES[0].vault
          ? [rawEvent('deposit', 13, 0), rawEvent('withdraw', 13, 1)]
          : []
    }
    const row = await capture(pair, out)
    assert.equal(row.grossTotals[0].depositAssetsRaw, '100')
    assert.equal(row.grossTotals[0].withdrawAssetsRaw, '100')
    assert.equal(verify(out).ranges, 1)
    assert.equal(verify(out).through, 13)
  }))

test('quiet range requires agreeing independent witnesses and verifies offline', () =>
  withDir(async (out) => {
    const pair = origins()
    await createPlan(pair, proof, out)
    for (const item of pair) {
      item.client.getBlock = async ({ blockTag, blockNumber }) => {
        const n = blockTag ? 13 : Number(blockNumber)
        return {
          number: BigInt(n),
          hash: blockHash(n),
          parentHash: blockHash(n - 1),
          timestamp: BigInt(n * 12),
        }
      }
    }
    await capture(pair, out)
    assert.deepEqual(
      verify(out).grossTotals.map((v) => v.depositCount),
      [0, 0, 0],
    )
    assert.deepEqual(
      verify(out).grossTotals.map((v) => v.withdrawCount),
      [0, 0, 0],
    )
  }))

test('disagreement fails without publishing a range', () =>
  withDir(async (out) => {
    const pair = origins()
    await createPlan(pair, proof, out)
    for (const item of pair) {
      item.client.getBlock = async ({ blockTag, blockNumber }) => {
        const n = blockTag ? 13 : Number(blockNumber)
        return {
          number: BigInt(n),
          hash: blockHash(n),
          parentHash: blockHash(n - 1),
          timestamp: BigInt(n * 12),
        }
      }
    }
    pair[0].client.request = async ({ params }) =>
      params[0].address === ROUTES[0].vault ? [rawEvent('deposit', 13, 0)] : []
    await assert.rejects(capture(pair, out), /fluid_flow_origin_disagreement/)
    assert.equal(verify(out).ranges, 0)
    assert.equal(existsSync(join(out, 'range-13-13.json')), false)
  }))

test('offline SHA verification rejects altered gross totals', () =>
  withDir(async (out) => {
    const pair = origins()
    await createPlan(pair, proof, out)
    for (const item of pair) {
      item.client.getBlock = async ({ blockTag, blockNumber }) => {
        const n = blockTag ? 13 : Number(blockNumber)
        return {
          number: BigInt(n),
          hash: blockHash(n),
          parentHash: blockHash(n - 1),
          timestamp: BigInt(n * 12),
        }
      }
    }
    await capture(pair, out)
    const path = join(out, 'range-13-13.json')
    const row = JSON.parse(readFileSync(path, 'utf8'))
    row.grossTotals[0].depositAssetsRaw = '999'
    writeFileSync(path, `${JSON.stringify(row)}\n`)
    assert.throws(() => verify(out), /fluid_flow_sha/)
  }))

test('offline verifier rejects a rehashed range with insufficient finalized receipt', () =>
  withDir(async (out) => {
    const pair = origins()
    await createPlan(pair, proof, out)
    for (const item of pair) {
      item.client.getBlock = async ({ blockTag, blockNumber }) => {
        const n = blockTag ? 13 : Number(blockNumber)
        return {
          number: BigInt(n),
          hash: blockHash(n),
          parentHash: blockHash(n - 1),
          timestamp: BigInt(n * 12),
        }
      }
    }
    await capture(pair, out)
    const path = join(out, 'range-13-13.json')
    const { sha256: _digest, ...row } = JSON.parse(readFileSync(path, 'utf8'))
    row.finalizedHeads[1].header.number = 12
    const tampered = {
      ...row,
      sha256: createHash('sha256').update(JSON.stringify(row)).digest('hex'),
    }
    writeFileSync(path, `${JSON.stringify(tampered)}\n`)
    assert.throws(() => verify(out), /fluid_flow_finalized_receipt/)
  }))

test('offline verifier reports missing prospective plan explicitly', () =>
  withDir((out) => {
    assert.throws(() => verify(out), /fluid_flow_plan_missing/)
  }))

function setHead(pair, head, logs = []) {
  for (const item of pair) {
    item.client.getBlock = async ({ blockTag, blockNumber }) => {
      const n = blockTag ? head : Number(blockNumber)
      return {
        number: BigInt(n),
        hash: blockHash(n),
        parentHash: blockHash(n - 1),
        timestamp: BigInt(n * 12),
      }
    }
    item.client.request = async ({ params }) =>
      params[0].address === ROUTES[0].vault
        ? logs.filter((log) => {
            const height = Number(BigInt(log.blockNumber))
            return (
              height >= Number(BigInt(params[0].fromBlock)) &&
              height <= Number(BigInt(params[0].toBlock))
            )
          })
        : []
  }
}
function reseal(row) {
  const { sha256: _digest, ...body } = row
  return { ...body, sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex') }
}

test('rolling archive links four contiguous ranges and aggregates gross events', () =>
  withDir(async (out) => {
    const pair = origins()
    await createPlan(pair, proof, out)
    setHead(pair, 50, [rawEvent('deposit', 13, 0), rawEvent('withdraw', 30, 0)])
    const tick = await captureNext(pair, out)
    assert.equal(tick.captured, 4)
    assert.equal(tick.through, 44)
    assert.ok(tick.rpcCalls <= 192)
    const status = verify(out)
    assert.equal(status.ranges, 4)
    assert.equal(status.through, 44)
    assert.equal(status.grossTotals[0].depositAssetsRaw, '100')
    assert.equal(status.grossTotals[0].withdrawAssetsRaw, '100')
    const first = JSON.parse(readFileSync(join(out, 'range-13-20.json')))
    const second = JSON.parse(readFileSync(join(out, 'range-21-28.json')))
    assert.equal(first.kind, 'fluid_ftoken_gross_range_v1')
    assert.equal(second.kind, 'fluid_ftoken_gross_range_v2')
    assert.equal(second.previousRangeSha256, first.sha256)
    assert.equal(second.previousEndpointHash, first.witnesses[0].headers.at(-1).hash)
    assert.deepEqual(
      second.endpointCanonicality.map((receipt) => receipt.balanceRaw),
      ['123', '123'],
    )
  }))

test('a quiet rolling interval advances with zero events and preserves v1 first row', () =>
  withDir(async (out) => {
    const pair = origins()
    await createPlan(pair, proof, out)
    setHead(pair, 13)
    await capture(pair, out)
    setHead(pair, 21)
    const tick = await captureNext(pair, out)
    assert.equal(tick.captured, 1)
    assert.equal(verify(out).ranges, 2)
    assert.equal(verify(out).through, 21)
    assert.deepEqual(
      verify(out).grossTotals.map((r) => r.depositCount),
      [0, 0, 0],
    )
  }))

test('offline replay rejects resealed broken predecessor SHA and endpoint hash', () =>
  withDir(async (out) => {
    const pair = origins()
    await createPlan(pair, proof, out)
    setHead(pair, 21)
    await captureNext(pair, out)
    const path = join(out, 'range-21-21.json')
    const original = JSON.parse(readFileSync(path))
    for (const field of ['previousRangeSha256', 'previousEndpointHash']) {
      const tampered = reseal({ ...original, [field]: hash('f').slice(2) })
      writeFileSync(path, `${JSON.stringify(tampered)}\n`)
      assert.throws(() => verify(out), /fluid_flow_previous_range/)
    }
  }))

test('offline replay rejects resealed broken middle header', () =>
  withDir(async (out) => {
    const pair = origins()
    await createPlan(pair, proof, out)
    setHead(pair, 29)
    await captureNext(pair, out)
    const middlePath = join(out, 'range-21-28.json')
    const middle = JSON.parse(readFileSync(middlePath))
    middle.witnesses[0].headers[1].parentHash = hash('e')
    writeFileSync(middlePath, `${JSON.stringify(reseal(middle))}\n`)
    assert.throws(() => verify(out), /fluid_flow_header_chain/)
  }))

test('transient origin failure leaves cursor at last sealed range', () =>
  withDir(async (out) => {
    const pair = origins()
    await createPlan(pair, proof, out)
    setHead(pair, 13)
    await capture(pair, out)
    setHead(pair, 21)
    pair[1].client.request = async () => {
      throw new Error('rate limited')
    }
    await assert.rejects(captureNext(pair, out), /rate limited/)
    assert.equal(verify(out).ranges, 1)
    assert.equal(verify(out).through, 13)
  }))

test('missing middle range blocks both replay and the next capture', () =>
  withDir(async (out) => {
    const pair = origins()
    await createPlan(pair, proof, out)
    setHead(pair, 29)
    await captureNext(pair, out)
    rmSync(join(out, 'range-21-28.json'))
    assert.throws(() => verify(out), /fluid_flow_range/)
    setHead(pair, 30)
    await assert.rejects(capture(pair, out), /fluid_flow_filename_chain/)
    assert.equal(existsSync(join(out, 'range-30-30.json')), false)
  }))

test('failure after first rolling range resumes exactly at the failed interval', () =>
  withDir(async (out) => {
    const pair = origins()
    await createPlan(pair, proof, out)
    setHead(pair, 29)
    const normal = pair[1].client.request
    pair[1].client.request = async (args) => {
      if (Number(BigInt(args.params[0].fromBlock)) >= 21) throw new Error('rate limited')
      return normal(args)
    }
    await assert.rejects(captureNext(pair, out), /rate limited/)
    assert.equal(verify(out).through, 20)
    assert.equal(verify(out).ranges, 1)
    pair[1].client.request = normal
    const resumed = await captureNext(pair, out)
    assert.equal(resumed.captured, 2)
    assert.equal(verify(out).through, 29)
    assert.equal(verify(out).ranges, 3)
  }))

test('orphan temporary hard-link name cannot obscure a sealed range', () =>
  withDir(async (out) => {
    const pair = origins()
    await createPlan(pair, proof, out)
    setHead(pair, 13)
    await capture(pair, out)
    writeFileSync(join(out, 'range-13-13.json.00000000-0000-0000-0000-000000000000.tmp'), 'orphan')
    assert.equal(verify(out).through, 13)
    setHead(pair, 14)
    await capture(pair, out)
    assert.equal(verify(out).through, 14)
  }))

test('v2 endpoint canonicality probes exact hash on both origins before append', () =>
  withDir(async (out) => {
    const pair = origins()
    await createPlan(pair, proof, out)
    setHead(pair, 13)
    await capture(pair, out)
    setHead(pair, 21)
    const calls = []
    for (const item of pair) {
      item.client.getBalance = async (args) => {
        calls.push({ origin: item.origin, ...args })
        return 123n
      }
    }
    await capture(pair, out)
    assert.deepEqual(
      calls,
      pair.map((item) => ({
        origin: item.origin,
        address: ROUTES[0].vault,
        blockHash: blockHash(21),
        requireCanonical: true,
      })),
    )
    assert.equal(verify(out).through, 21)
  }))

test('rehashed v2 canonicality receipt mismatch fails offline replay', () =>
  withDir(async (out) => {
    const pair = origins()
    await createPlan(pair, proof, out)
    setHead(pair, 21)
    await captureNext(pair, out)
    const path = join(out, 'range-21-21.json')
    const original = JSON.parse(readFileSync(path))
    const corruptions = [
      ['origin', 'wrong-origin'],
      ['blockHash', hash('f')],
      ['blockNumber', 20],
      ['account', owner],
      ['balanceRaw', 'not-an-amount'],
    ]
    for (const [field, value] of corruptions) {
      const row = structuredClone(original)
      row.endpointCanonicality[1][field] = value
      writeFileSync(path, `${JSON.stringify(reseal(row))}\n`)
      assert.throws(() => verify(out), /fluid_flow_endpoint_canonicality/)
    }
  }))

test('failed canonicality probe publishes no v2 range', () =>
  withDir(async (out) => {
    const pair = origins()
    await createPlan(pair, proof, out)
    setHead(pair, 13)
    await capture(pair, out)
    setHead(pair, 21)
    pair[1].client.getBalance = async () => {
      throw new Error('canonicality rejected')
    }
    await assert.rejects(captureNext(pair, out), /canonicality rejected/)
    assert.equal(verify(out).through, 13)
    assert.equal(existsSync(join(out, 'range-14-21.json')), false)
  }))

test('rolling tick audits old rows before any RPC or successor append', () =>
  withDir(async (out) => {
    const pair = origins()
    await createPlan(pair, proof, out)
    setHead(pair, 29)
    await captureNext(pair, out)
    const path = join(out, 'range-13-20.json')
    const row = JSON.parse(readFileSync(path))
    row.grossTotals[0].depositAssetsRaw = '999'
    writeFileSync(path, `${JSON.stringify(row)}\n`)
    let calls = 0
    for (const item of pair) {
      item.client.getBlock = async () => {
        calls++
        throw new Error('RPC should not run')
      }
    }
    await assert.rejects(captureNext(pair, out), /fluid_flow_sha/)
    assert.equal(calls, 0)
    assert.equal(existsSync(join(out, 'range-30-30.json')), false)
  }))

test('canonicality balance disagreement stops before publication', () =>
  withDir(async (out) => {
    const pair = origins()
    await createPlan(pair, proof, out)
    setHead(pair, 13)
    await capture(pair, out)
    setHead(pair, 21)
    pair[1].client.getBalance = async () => 124n
    await assert.rejects(captureNext(pair, out), /fluid_flow_origin_disagreement/)
    assert.equal(verify(out).through, 13)
  }))
