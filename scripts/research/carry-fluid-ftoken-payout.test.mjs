import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from 'viem'
import {
  captureEventProof,
  capturePilot,
  classifyReceipt,
  ROUTES,
  verify,
} from './carry-fluid-ftoken-payout.mjs'

const vault = ROUTES[0]
const liquidity = '0x52aa899454998be5b000ad077a46bbe360f4e497'
const receiver = '0x1111111111111111111111111111111111111111'
const owner = '0x2222222222222222222222222222222222222222'
const sender = owner
const hash = `0x${'3'.repeat(64)}`
const blockHash = `0x${'4'.repeat(64)}`
const withdraw = parseAbiItem(
  'event Withdraw(address indexed sender,address indexed receiver,address indexed owner,uint256 assets,uint256 shares)',
)
const operate = parseAbiItem(
  'event LogOperate(address indexed user,address indexed token,int256 supplyAmount,int256 borrowAmount,address withdrawTo,address borrowTo,uint256 totalAmounts,uint256 exchangePricesAndConfig)',
)
const transfer = parseAbiItem(
  'event Transfer(address indexed from,address indexed to,uint256 value)',
)

function syntheticProof() {
  const routes = ROUTES.map((route) => ({
    ...route,
    liquidity,
    factory: '0x4444444444444444444444444444444444444444',
    implementation: route.vault,
    deploymentKind: 'direct_runtime_code_with_empty_eip1967_slots',
    codeHashes: { implementation: blockHash, liquidity: blockHash },
  }))
  const body = {
    schemaVersion: 1,
    kind: 'fluid_ftoken_two_origin_identity',
    blockNumber: 10,
    blockHash,
    originWitnesses: ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'].map((origin) => ({
      origin,
      blockHash,
      routes,
    })),
    routes,
    sourceAttestation: 'deployed_direct_runtime_and_liquidity_code_hashes_only',
  }
  return { ...body, sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex') }
}

function log(address, abi, args, values, parameters, logIndex) {
  return {
    address,
    topics: encodeEventTopics({ abi: [abi], eventName: abi.name, args }),
    data: encodeAbiParameters(parameters, values),
    logIndex,
    blockNumber: 1,
    blockHash,
    transactionHash: hash,
  }
}

function receipt({
  includeOperate = true,
  includeTransfer = true,
  duplicateTransfer = false,
  transferAmount = 100n,
} = {}) {
  const entries = []
  if (includeTransfer)
    entries.push(
      log(
        vault.asset,
        transfer,
        { from: liquidity, to: receiver },
        [transferAmount],
        [{ type: 'uint256' }],
        1,
      ),
    )
  if (duplicateTransfer)
    entries.push(
      log(
        vault.asset,
        transfer,
        { from: liquidity, to: receiver },
        [100n],
        [{ type: 'uint256' }],
        2,
      ),
    )
  if (includeOperate)
    entries.push(
      log(
        liquidity,
        operate,
        { user: vault.vault, token: vault.asset },
        [-100n, 0n, receiver, '0x0000000000000000000000000000000000000000', 0n, 0n],
        [
          { type: 'int256' },
          { type: 'int256' },
          { type: 'address' },
          { type: 'address' },
          { type: 'uint256' },
          { type: 'uint256' },
        ],
        3,
      ),
    )
  entries.push(
    log(
      vault.vault,
      withdraw,
      { sender, receiver, owner },
      [100n, 99n],
      [{ type: 'uint256' }, { type: 'uint256' }],
      4,
    ),
  )
  return { status: 'success', logs: entries, transactionHash: hash, blockHash, blockNumber: 1 }
}

test('same-tx fToken Withdraw, Liquidity LogOperate and exact underlying Transfer reconcile', () => {
  const result = classifyReceipt(vault, liquidity, receipt())
  assert.equal(result.status, 'reconciled')
  assert.equal(result.withdrawals[0].assetsRaw, '100')
  assert.equal(result.withdrawals[0].receiver, receiver)
})

test('missing or wrong amount delivery does not become a payout', () => {
  assert.equal(
    classifyReceipt(vault, liquidity, receipt({ includeTransfer: false })).status,
    'missing',
  )
  assert.equal(
    classifyReceipt(vault, liquidity, receipt({ transferAmount: 99n })).status,
    'missing',
  )
  assert.equal(
    classifyReceipt(vault, liquidity, receipt({ includeOperate: false })).status,
    'missing',
  )
})

test('duplicate exact transfers are ambiguous rather than credited twice', () => {
  assert.equal(
    classifyReceipt(vault, liquidity, receipt({ duplicateTransfer: true })).status,
    'ambiguous',
  )
})

test('failed receipts cannot reconcile', () => {
  assert.equal(
    classifyReceipt(vault, liquidity, { ...receipt(), status: 'reverted' }).status,
    'ambiguous',
  )
})

test('duplicate identical Withdraw logs cannot reuse one Liquidity operation and Transfer', () => {
  const duplicate = receipt()
  duplicate.logs.push(
    log(
      vault.vault,
      withdraw,
      { sender, receiver, owner },
      [100n, 99n],
      [{ type: 'uint256' }, { type: 'uint256' }],
      5,
    ),
  )
  const result = classifyReceipt(vault, liquidity, duplicate)
  assert.equal(result.status, 'ambiguous')
  assert.equal(result.withdrawals.filter((item) => item.status === 'reconciled').length, 0)
})

test('agreeing malformed raw logs are rejected before an immutable pilot is published', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fluid-payout-invalid-'))
  try {
    const badReceipt = receipt()
    badReceipt.transactionHash = '0xnot_a_hash'
    badReceipt.logs.at(-1).transactionHash = '0xnot_a_hash'
    const badRawLog = badReceipt.logs.at(-1)
    const proof = syntheticProof()
    const origins = proof.originWitnesses.map(({ origin }) => ({
      origin,
      client: {
        getBlock: async () => ({ hash: blockHash }),
        request: async () => [badRawLog],
        getTransactionReceipt: async () => badReceipt,
      },
    }))
    await assert.rejects(
      capturePilot(origins, proof, 0, 1, 2, root),
      /fluid_payout_pilot_log_invalid/,
    )
    assert.equal(existsSync(join(root, 'pilot-0-1-2.json')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a self-hashed forged route proof fails before any RPC or pilot publication', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fluid-payout-forged-proof-'))
  try {
    const { sha256: _old, ...body } = syntheticProof()
    body.routes[0].asset = '0x5555555555555555555555555555555555555555'
    const forged = {
      ...body,
      sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    }
    let calls = 0
    const origins = forged.originWitnesses.map(({ origin }) => ({
      origin,
      client: {
        getBlock: async () => {
          calls++
          throw new Error('rpc_should_not_run')
        },
      },
    }))
    await assert.rejects(capturePilot(origins, forged, 0, 1, 2, root), /fluid_payout_proof_invalid/)
    assert.equal(calls, 0)
    assert.equal(existsSync(join(root, 'pilot-0-1-2.json')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a receipt with an extra fToken Withdraw omitted by raw logs cannot publish', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fluid-payout-incomplete-logs-'))
  try {
    const proof = syntheticProof()
    const mined = receipt()
    mined.logs.push(
      log(
        vault.vault,
        withdraw,
        { sender, receiver, owner },
        [100n, 99n],
        [{ type: 'uint256' }, { type: 'uint256' }],
        5,
      ),
    )
    const raw = mined.logs.find((item) => item.logIndex === 4)
    const origins = proof.originWitnesses.map(({ origin }) => ({
      origin,
      client: {
        getBlock: async () => ({ hash: blockHash }),
        request: async () => [raw],
        getTransactionReceipt: async () => mined,
      },
    }))
    await assert.rejects(
      capturePilot(origins, proof, 0, 1, 2, root),
      /fluid_payout_receipt_log_disagreement/,
    )
    assert.equal(existsSync(join(root, 'pilot-0-1-2.json')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('event-block route identity requires agreeing historical asset and runtime witnesses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fluid-payout-event-proof-'))
  try {
    const origins = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'].map((origin) => ({
      origin,
      client: {
        getBlock: async ({ blockTag, blockNumber }) =>
          blockTag === 'finalized' ? { number: 10n } : { number: blockNumber, hash: blockHash },
        readContract: async ({ functionName }) =>
          functionName === 'asset'
            ? vault.asset
            : [liquidity, '0x4444444444444444444444444444444444444444'],
        getCode: async () => '0x6001',
        getStorageAt: async () => `0x${'0'.repeat(64)}`,
      },
    }))
    const proof = await captureEventProof(origins, 0, 1, root)
    assert.equal(proof.blockNumber, 1)
    assert.equal(verify(root).eventProofs, 1)
    assert.equal(verify(root).byRoute[0].eventIdentityReconciled, 0)
    origins[1].client.readContract = async ({ functionName }) =>
      functionName === 'asset'
        ? ROUTES[1].asset
        : [liquidity, '0x4444444444444444444444444444444444444444']
    await assert.rejects(captureEventProof(origins, 0, 2, root), /fluid_payout_route_identity/)
    assert.equal(existsSync(join(root, 'event-proof-0-2.json')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('payout count requires event-block identity and rejects a repeated transaction', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fluid-payout-count-'))
  try {
    const proof = syntheticProof()
    writeFileSync(join(root, 'proof-10.json'), `${JSON.stringify(proof)}\n`)
    const mined = receipt()
    const raw = mined.logs.at(-1)
    const origins = proof.originWitnesses.map(({ origin }) => ({
      origin,
      client: {
        getBlock: async ({ blockTag, blockNumber }) =>
          blockTag === 'finalized' ? { number: 10n } : { number: blockNumber, hash: blockHash },
        request: async () => [raw],
        getTransactionReceipt: async () => mined,
        readContract: async ({ functionName }) =>
          functionName === 'asset'
            ? vault.asset
            : [liquidity, '0x4444444444444444444444444444444444444444'],
        getCode: async () => '0x6001',
        getStorageAt: async () => `0x${'0'.repeat(64)}`,
      },
    }))
    await capturePilot(origins, proof, 0, 1, 1, root)
    assert.equal(verify(root).byRoute[0].reconciled, 1)
    assert.equal(verify(root).byRoute[0].eventIdentityReconciled, 0)
    await captureEventProof(origins, 0, 1, root)
    assert.equal(verify(root).byRoute[0].eventIdentityReconciled, 1)
    await capturePilot(origins, proof, 0, 1, 2, root)
    assert.throws(() => verify(root), /fluid_payout_duplicate_payout_transaction/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
