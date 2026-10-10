import assert from 'node:assert/strict'
import test from 'node:test'
import { toEventSelector } from 'viem'

import { CARRY_EXIT_V2_FROZEN_ROUTES } from './carry-exit-v2-rpc-proof.mjs'
import {
  captureFreshDirectBaseline,
  discoverDirectIssuerCandidate,
  freezeDirectQLadder,
} from './carry-exit-v2-direct-issuer-prep.mjs'

const route = CARRY_EXIT_V2_FROZEN_ROUTES.find((entry) => entry.kind === 'comet')
const holder = `0x${'aa'.repeat(20)}`
const hash = `0x${'11'.repeat(32)}`
const parentHash = `0x${'22'.repeat(32)}`
const grandparentHash = `0x${'33'.repeat(32)}`
const txHash = `0x${'44'.repeat(32)}`
const word = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`
const addressWord = (address) => `0x${address.slice(2).padStart(64, '0')}`
const header = (number) => ({
  number: `0x${number.toString(16)}`,
  hash: number === 5000 ? hash : number === 4999 ? parentHash : grandparentHash,
  parentHash: number === 5000 ? parentHash : grandparentHash,
  timestamp: `0x${(1_780_000_000 + number * 12).toString(16)}`,
})
const supplyLog = {
  address: route.destination,
  topics: [
    toEventSelector('Supply(address,address,uint256)').toLowerCase(),
    addressWord(`0x${'bb'.repeat(20)}`),
    addressWord(holder),
  ],
  data: word(750),
  blockNumber: '0x1387',
  transactionIndex: '0x0',
  logIndex: '0x0',
  transactionHash: txHash,
  blockHash: parentHash,
}

function fixture() {
  const calls = []
  const request = async (method, params) => {
    calls.push({ method, params })
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_getBlockByNumber') {
      const value = params[0] === 'finalized' ? 5000 : Number(BigInt(params[0]))
      return header(value)
    }
    if (method === 'eth_getCode') return params[0] === holder ? '0x' : '0x6001'
    if (method === 'eth_getLogs') {
      const { fromBlock, toBlock } = params[0]
      return BigInt(fromBlock) <= 4999n && BigInt(toBlock) >= 4999n ? [supplyLog] : []
    }
    if (method === 'eth_getTransactionReceipt')
      return {
        status: '0x1',
        transactionHash: txHash,
        blockHash: parentHash,
        blockNumber: '0x1387',
        logs: [supplyLog],
      }
    if (method === 'eth_call') {
      const { to, data } = params[0]
      if (to === route.destination && data === '0x18160ddd') return word(1_000_000)
      if (to === route.destination && data.startsWith('0x70a08231')) return word(500)
      if (to === route.asset && data === '0x313ce567') return word(6)
      if (to === route.destination) return addressWord(route.asset)
    }
    throw Error(`unexpected_${method}`)
  }
  return { request, calls }
}

test('direct ladder keeps holder-relative Q, zero and duplicate labels explicit', () => {
  const ladder = freezeDirectQLadder({ marketSupplyRaw: '1000000', selectedAssetBalanceRaw: '500' })
  assert.equal(ladder.labels.length, 6)
  assert.equal(ladder.labels[0].assetsRaw, '10')
  assert.equal(ladder.labels[1].reason, 'duplicate_q')
  assert.equal(ladder.labels[2].assetsRaw, '100')
  assert.equal(ladder.selectedAssetBalanceRaw, '500')
})

test('Comet candidate comes from receipt-verified Supply dst and pinned positive balance', async () => {
  const { request, calls } = fixture()
  const now = () => new Date((1_780_000_000 + 5000 * 12) * 1000 + 20_000)
  const baseline = await captureFreshDirectBaseline({
    ...route,
    provider: 'https://primary.example',
    source: 'test',
    request,
    now,
  })
  const candidate = await discoverDirectIssuerCandidate({ baseline, request })
  assert.equal(candidate.holder, holder)
  assert.equal(candidate.evidenceDoc.selectedAssetBalanceRaw, '500')
  assert.equal(candidate.evidenceDoc.screenedCandidates[0].status, 'eligible_holder')
  assert.equal(candidate.evidenceDoc.ladder.labels[0].assetsRaw, '10')
  assert.ok(calls.some((call) => call.method === 'eth_getTransactionReceipt'))
  assert.ok(
    calls
      .filter((call) => call.method === 'eth_call')
      .every(
        (call) => call.params[1].blockHash === hash && call.params[1].requireCanonical === true,
      ),
  )
})

test('missing receipt cannot select a holder', async () => {
  const { request } = fixture()
  const now = () => new Date((1_780_000_000 + 5000 * 12) * 1000 + 20_000)
  const baseline = await captureFreshDirectBaseline({
    ...route,
    provider: 'https://primary.example',
    source: 'test',
    request,
    now,
  })
  const bad = async (method, params) =>
    method === 'eth_getTransactionReceipt' ? null : request(method, params)
  const candidate = await discoverDirectIssuerCandidate({ baseline, request: bad })
  assert.equal(candidate.holder, null)
  assert.equal(candidate.evidenceDoc.screenedCandidates[0].status, 'receipt_or_header_mismatch')
  assert.ok(candidate.evidenceDoc.ladder.labels[0].reason)
})
