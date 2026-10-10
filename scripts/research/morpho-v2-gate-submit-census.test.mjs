import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, toHex } from 'viem'
import { SUBMIT, TOPIC0 } from './morpho-v2-cap-submit-census.mjs'
import {
  classify,
  decodeGateCall,
  decodeSubmit,
  freezeRaw,
  GATE_ABI,
  RECEIVE_ASSETS_SELECTOR,
  SELECTOR_TOPICS,
  SEND_SHARES_SELECTOR,
  STUDY,
  validateCheckpoint,
} from './morpho-v2-gate-submit-census.mjs'

const vault = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const gate = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const zero = `0x${'0'.repeat(40)}`
const hash = `0x${'3'.repeat(64)}`
const tx = `0x${'4'.repeat(64)}`
const gateCall = (functionName = 'setSendSharesGate', address = gate) =>
  encodeFunctionData({ abi: GATE_ABI, functionName, args: [address] })
function rawSubmit(selector = SEND_SHARES_SELECTOR, calldata = gateCall(), executableAt = 31_600n) {
  return {
    address: vault,
    blockNumber: toHex(101),
    blockHash: hash,
    transactionIndex: toHex(1),
    transactionHash: tx,
    logIndex: toHex(3),
    topics: encodeEventTopics({ abi: [SUBMIT], eventName: 'Submit', args: { selector } }),
    data: encodeAbiParameters([{ type: 'bytes' }, { type: 'uint256' }], [calldata, executableAt]),
  }
}
const event = (selector = SEND_SHARES_SELECTOR, calldata = gateCall(), executableAt = 31_600n) =>
  decodeSubmit(rawSubmit(selector, calldata, executableAt), 10_000)

test('only the two canonical exit gate selectors are accepted', () => {
  assert.equal(SEND_SHARES_SELECTOR, '0xc21ad028')
  assert.equal(RECEIVE_ASSETS_SELECTOR, '0x04dbf0ce')
  assert.equal(SELECTOR_TOPICS[0].length, 66)
  const decoded = event()
  assert.equal(decoded.selector, SEND_SHARES_SELECTOR)
  assert.deepEqual(decodeGateCall(decoded), { kind: 'send-shares', proposedGate: gate })
  const receive = event(RECEIVE_ASSETS_SELECTOR, gateCall('setReceiveAssetsGate'))
  assert.equal(decodeGateCall(receive).kind, 'receive-assets')
  assert.equal(decodeGateCall({ ...decoded, data: `${decoded.data}00` }), null)
  assert.throws(() => decodeSubmit({ ...rawSubmit(), topics: [TOPIC0] }, 10_000))
})

test('short lead, zero address, and post-setup candidate are distinct', async () => {
  const client = {
    async readContract({ functionName }) {
      return functionName === 'totalSupply' ? 100n : functionName === 'abdicated' ? false : zero
    },
  }
  const noLogs = async () => []
  assert.equal(
    (await classify(event(SEND_SHARES_SELECTOR, gateCall(), 10_000n), client, noLogs)).class,
    'short-lead',
  )
  assert.equal(
    (
      await classify(
        event(SEND_SHARES_SELECTOR, gateCall('setSendSharesGate', zero)),
        client,
        noLogs,
      )
    ).class,
    'disabling-gate',
  )
  const result = await classify(event(), client, noLogs)
  assert.equal(result.class, 'candidate')
  assert.equal(result.preState.supplyAtSubmit, '100')
  assert.equal(result.preState.gateAtSubmit, zero)
  const alreadyGated = {
    async readContract({ functionName }) {
      return functionName === 'totalSupply' ? 100n : functionName === 'abdicated' ? false : gate
    },
  }
  assert.equal((await classify(event(), alreadyGated, noLogs)).class, 'no-op-gate')
})

test('same-block prior mint and selector abdication are included as-known at Submit', async () => {
  const client = {
    async readContract({ functionName }) {
      return functionName === 'totalSupply' ? 0n : functionName === 'abdicated' ? false : zero
    },
  }
  const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
  const topicAddress = (address) => `0x${address.slice(2).padStart(64, '0')}`
  const mint = {
    blockHash: hash,
    logIndex: toHex(1),
    topics: [transferTopic, topicAddress(zero), topicAddress(gate)],
    data: toHex(50n, { size: 32 }),
  }
  const mintOnly = await classify(event(), client, async () => [mint])
  assert.equal(mintOnly.class, 'candidate')
  assert.equal(mintOnly.preState.supplyAtSubmit, '50')
  const abdicate = {
    blockHash: hash,
    logIndex: toHex(2),
    topics: [
      '0x0049084087379246e2728d6889741a3704ee4e1690c5d16732feb5f30d40fc41',
      `${SEND_SHARES_SELECTOR}${'0'.repeat(56)}`,
    ],
    data: '0x',
  }
  // The event topic is derived from the ABI below, not the placeholder above.
  const { toEventSelector, parseAbiItem } = await import('viem')
  abdicate.topics[0] = toEventSelector(parseAbiItem('event Abdicate(bytes4 indexed selector)'))
  const result = await classify(event(), client, async () => [mint, abdicate])
  assert.equal(result.class, 'abdicated')
  assert.equal(result.preState.supplyAtSubmit, '50')
})

test('raw snapshot is frozen and checkpoint coverage cannot skip a chunk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'morpho-gate-test-'))
  const rawOut = join(dir, 'raw.json')
  const snapshot = {
    study: STUDY,
    chainId: 1,
    factoryArtifactSha256: '745062b27def710352f1b6c5ca220ebc3a953513a384077e190f7eef92ea6aaa',
    pinnedHeadHash: hash,
    from: 101,
    to: 110,
    chunkBlocks: 5,
    topic0: TOPIC0,
    selectorTopics: SELECTOR_TOPICS,
    nextChunk: 2,
    nextEvent: 0,
    rawEvents: [event()],
    classifications: [],
    status: 'partial',
    coverage: { throughBlock: 110, chunksComplete: 2, chunksExpected: 2, complete: true },
  }
  const expected = {
    from: 101,
    to: 110,
    chunkBlocks: 5,
    ranges: [{ toBlock: 105 }, { toBlock: 110 }],
    headHash: hash,
  }
  try {
    assert.doesNotThrow(() => validateCheckpoint(snapshot, expected))
    const firstSha = freezeRaw(snapshot, rawOut)
    assert.equal(firstSha.length, 64)
    assert.equal(freezeRaw(snapshot, rawOut), firstSha)
    const raw = JSON.parse(readFileSync(rawOut, 'utf8'))
    writeFileSync(rawOut, JSON.stringify({ ...raw, from: 102 }))
    assert.throws(() => freezeRaw(snapshot, rawOut), /SHA mismatch/)
    assert.throws(
      () => validateCheckpoint({ ...snapshot, nextChunk: 1 }, expected),
      /metadata mismatch/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
