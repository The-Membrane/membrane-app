import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeFunctionData, parseAbi, toEventSelector } from 'viem'
import { ROUTE_KEY, SILO, USDE, VAULT, sha } from './susde-public-pending-exit-common.mjs'
import { captureDelivery, validateDelivery } from './susde-public-mined-delivery.mjs'

const H = '0x1111111111111111111111111111111111111111'
const TX = `0x${'c'.repeat(64)}`
const BLOCK = `0x${'b'.repeat(64)}`
const PARENT = `0x${'d'.repeat(64)}`
const AMOUNT = 10n ** 18n
const topic = (address) => `0x${address.slice(2).padStart(64, '0')}`
const word = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`
const code = (value) => ({
  sha256: sha(Buffer.from(value.slice(2), 'hex')),
  byteLength: (value.length - 2) / 2,
})
const abi = parseAbi([
  'function unstake(address)',
  'function asset() view returns (address)',
  'function silo() view returns (address)',
])
const issue = {
  sequence: 3,
  sha256: 'verified-issue-hash',
  holder: H,
  pendingAssetsRaw: AMOUNT.toString(),
  issuedAtUtc: '2026-10-01T00:00:00.000Z',
  anchor: { blockNumber: '100' },
  measurement: {
    evidence: [
      {
        calls: {
          vaultCode: { result: code('0x1234') },
          assetCode: { result: code('0x5678') },
          siloCode: { result: code('0x9abc') },
        },
      },
    ],
  },
}
const timestamp = `0x${Math.floor(Date.parse('2026-10-02T01:00:00.000Z') / 1000).toString(16)}`
const transfer = {
  address: USDE,
  topics: [toEventSelector('Transfer(address,address,uint256)'), topic(SILO), topic(H)],
  data: word(AMOUNT),
  transactionHash: TX,
  blockHash: BLOCK,
  blockNumber: '0x66',
  transactionIndex: '0x2',
  logIndex: '0x9',
  removed: false,
}
const proof = (provider) => ({
  provider,
  chainId: '0x1',
  tx: {
    hash: TX,
    blockHash: BLOCK,
    blockNumber: '0x66',
    transactionIndex: '0x2',
    from: H,
    to: VAULT,
    input: encodeFunctionData({ abi, functionName: 'unstake', args: [H] }),
  },
  receipt: {
    transactionHash: TX,
    blockHash: BLOCK,
    blockNumber: '0x66',
    transactionIndex: '0x2',
    status: '0x1',
    logs: [structuredClone(transfer)],
  },
  block: { number: '0x66', hash: BLOCK, parentHash: PARENT, timestamp },
  finalized: { number: '0x67', hash: `0x${'e'.repeat(64)}`, parentHash: BLOCK, timestamp },
  holderCode: '0x',
  vaultCode: code('0x1234'),
  assetCode: code('0x5678'),
  siloCode: code('0x9abc'),
  asset: `0x${USDE.slice(2).padStart(64, '0')}`,
  silo: `0x${SILO.slice(2).padStart(64, '0')}`,
})
const make = () => ({
  study: 'susde_public_mined_delivery_v1',
  sequence: 1,
  issueSequence: 3,
  issueSha256: issue.sha256,
  routeKey: ROUTE_KEY,
  vault: VAULT,
  asset: USDE,
  silo: SILO,
  holder: H,
  frozenPendingAssetsRaw: AMOUNT.toString(),
  transactionHash: TX,
  deliveredAtUtc: new Date(Number(BigInt(timestamp)) * 1000).toISOString(),
  witnessedAtUtc: '2026-10-02T01:10:00.000Z',
  deliveryStatus: 'mined_transfer_attested',
  episodeAttribution: 'unresolved',
  durationEstimated: false,
  forecastValidated: false,
  minedDeliveryProven: true,
  origins: [proof('alchemy'), proof('ankr')],
})
const issues = [null, null, issue]
const bad = (edit, expected) => {
  const row = make()
  edit(row)
  assert.throws(() => validateDelivery(row, issues), new RegExp(expected))
}

test('positive two-origin mined delivery leaves queue attribution unresolved', () => {
  const row = make()
  assert.equal(validateDelivery(row, issues), row)
  row.origins[1].finalized.number = '0x68'
  assert.equal(validateDelivery(row, issues), row)
})

test('episode attribution, duration and transfer value cannot be promoted by resealing', () => {
  bad((r) => {
    r.episodeAttribution = 'same_episode'
  }, 'binding')
  bad((r) => {
    r.durationEstimated = true
  }, 'binding')
  bad((r) => {
    r.forecastValidated = true
  }, 'binding')
  bad((r) => {
    r.origins.forEach((o) => {
      o.receipt.logs[0].data = word(AMOUNT - 1n)
    })
  }, 'transfer')
  bad((r) => {
    r.origins.forEach((o) => {
      o.tx.input = '0x1234'
    })
  }, 'tx_proof')
  bad((r) => {
    r.origins.forEach((o) => {
      o.holderCode = '0x1234'
    })
  }, 'tx_proof')
})

const peer = (provider, options = {}) => {
  const calls = []
  const request = async (method, params) => {
    calls.push(method)
    if (method === 'eth_chainId') {
      if (options.chainError) throw Error('public_rpc_unavailable')
      return '0x1'
    }
    if (method === 'eth_getTransactionByHash') return proof(provider).tx
    if (method === 'eth_getTransactionReceipt') {
      const value = proof(provider).receipt
      if (options.badTransfer) value.logs[0].data = word(AMOUNT - 1n)
      return value
    }
    if (method === 'eth_getBlockByNumber')
      return params[0] === 'finalized' ? proof(provider).finalized : proof(provider).block
    if (method === 'eth_getCode') {
      if (params[0] === H) return '0x'
      if (params[0] === VAULT) return '0x1234'
      if (params[0] === USDE) return '0x5678'
      if (params[0] === SILO) return '0x9abc'
    }
    if (method === 'eth_call') {
      if (params[0].data === encodeFunctionData({ abi, functionName: 'asset' }))
        return `0x${USDE.slice(2).padStart(64, '0')}`
      if (params[0].data === encodeFunctionData({ abi, functionName: 'silo' }))
        return `0x${SILO.slice(2).padStart(64, '0')}`
    }
    throw Error('unexpected_mock_rpc')
  }
  return { provider, request, calls }
}

test('transport-failed origin is skipped; healthy independent pair captures bounded proof', async () => {
  const alchemy = peer('alchemy')
  const infura = peer('infura', { chainError: true })
  const ankr = peer('ankr')
  const result = await captureDelivery(issue, TX, [alchemy, infura, ankr])
  assert.equal(result.status, 'captured')
  assert.deepEqual(
    result.origins.map((o) => o.provider),
    ['alchemy', 'ankr'],
  )
  assert.equal(infura.calls.filter((call) => call === 'eth_getTransactionReceipt').length, 0)
})

test('economic origin disagreement does not rotate to a third origin', async () => {
  const alchemy = peer('alchemy')
  const ankr = peer('ankr', { badTransfer: true })
  const quicknode = peer('quicknode')
  const result = await captureDelivery(issue, TX, [alchemy, ankr, quicknode])
  assert.deepEqual(result, { status: 'susde_delivery_origin_disagreement' })
  assert.equal(quicknode.calls.filter((call) => call === 'eth_getTransactionReceipt').length, 0)
})

test('different URLs on one host cannot attest as independent origins', async () => {
  const first = peer('https://same.example')
  const second = peer('http://same.example:8545')
  const third = peer('https://independent.example')
  const result = await captureDelivery(issue, TX, [first, second, third])
  assert.equal(result.status, 'captured')
  assert.equal(
    result.origins.some((origin) => origin.provider === 'https://independent.example'),
    true,
  )
  assert.equal(
    result.origins.filter((origin) => new URL(origin.provider).hostname === 'same.example').length,
    1,
  )
  const row = make()
  row.origins = [proof('https://same.example'), proof('http://same.example:8545')]
  assert.throws(() => validateDelivery(row, issues), /susde_delivery_binding_invalid/)
})
