import assert from 'node:assert/strict'
import test from 'node:test'

import { parseAbiItem, toEventSelector } from 'viem'

import { TARGET, probeKnownWyldsCompletion } from './pyusd-wylds-known-completion-probe.mjs'

const URLS = ['https://one.example', 'https://two.example']
const TIMESTAMP = 1790784647
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const blockHash = (n) => (n === TARGET.to ? TARGET.blockHash : hash(n))
const word = (n) => BigInt(n).toString(16).padStart(64, '0')
const addressWord = (address) => `0x${address.slice(2).padStart(64, '0')}`
const completeTopic = toEventSelector(
  parseAbiItem(
    'event RedemptionCompleted(address indexed user,uint256 shares,uint256 assets,uint256 timestamp)',
  ),
)
const transferTopic = toEventSelector(
  parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)'),
)

function fixture({
  disagree = false,
  noTransfer = false,
  wrongVault = false,
  malformed = false,
  extraTransfer = false,
} = {}) {
  const calls = []
  const event = {
    address: TARGET.wylds,
    blockNumber: `0x${TARGET.to.toString(16)}`,
    blockHash: TARGET.blockHash,
    transactionHash: TARGET.transactionHash,
    logIndex: `0x${TARGET.logIndex.toString(16)}`,
    removed: false,
    topics: [completeTopic, addressWord(TARGET.user)],
    data: malformed ? '0x1' : `0x${word(1062131)}${word(1062131)}${word(TIMESTAMP)}`,
  }
  const transfer = {
    address: TARGET.usdc,
    blockNumber: event.blockNumber,
    blockHash: TARGET.blockHash,
    transactionHash: TARGET.transactionHash,
    logIndex: `0x${(TARGET.logIndex + 1).toString(16)}`,
    removed: false,
    topics: [transferTopic, addressWord(TARGET.redeemVault), addressWord(TARGET.user)],
    data: `0x${word(1062131)}`,
  }
  const fetchImpl = async (url, options) => {
    const request = JSON.parse(options.body)
    calls.push({ url, request })
    const [arg] = request.params
    let result
    if (request.method === 'eth_chainId') result = '0x1'
    else if (request.method === 'eth_getBlockByNumber') {
      const number = arg === 'finalized' ? TARGET.to + 10 : Number(BigInt(arg))
      result = {
        number: `0x${number.toString(16)}`,
        hash: blockHash(number),
        parentHash: blockHash(number - 1),
        timestamp: `0x${TIMESTAMP.toString(16)}`,
      }
    } else if (request.method === 'eth_getLogs') result = disagree && url === URLS[1] ? [] : [event]
    else if (request.method === 'eth_getTransactionReceipt')
      result = {
        transactionHash: TARGET.transactionHash,
        blockHash: TARGET.blockHash,
        blockNumber: `0x${TARGET.to.toString(16)}`,
        status: '0x1',
        logs: noTransfer
          ? [event]
          : extraTransfer
            ? [event, transfer, { ...transfer, logIndex: '0x10c', data: `0x${word(1)}` }]
            : [event, transfer],
      }
    else if (request.method === 'eth_call')
      result = addressWord(wrongVault ? TARGET.user : TARGET.redeemVault)
    else throw Error(`unexpected_method_${request.method}`)
    return {
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
    }
  }
  return { fetchImpl, calls }
}

test('known completion and exact USDC receipt transfer replay at both origins', async () => {
  const source = fixture()
  const result = await probeKnownWyldsCompletion({ urls: URLS, ...source })
  assert.equal(result.status, 'wylds_completion_and_usdc_transfer_attested')
  assert.equal(result.finalPyusdPayout, 'not_attested')
  assert.equal(result.range.to, TARGET.to)
  assert.equal(result.range.from, 26091398)
  assert.equal(result.target.assetsRaw, '1062131')
  assert.equal(result.target.user, TARGET.user)
  assert.equal(result.sourceAgreement, 'two_hostname_agreed')
  assert.equal(result.limits.actual.calls, 20)
  assert.equal(result.rawReceipts.length, 20)
  assert.equal(
    source.calls.filter((call) => call.request.method === 'eth_getBlockByNumber').length,
    12,
  )
})

test('missing payout and wrong redeem vault cannot attest completion plus transfer', async () => {
  await assert.rejects(
    probeKnownWyldsCompletion({ urls: URLS, ...fixture({ noTransfer: true }) }),
    /wylds_exact_transfer_missing/,
  )
  await assert.rejects(
    probeKnownWyldsCompletion({ urls: URLS, ...fixture({ wrongVault: true }) }),
    /wylds_redeem_vault_mismatch/,
  )
  await assert.rejects(
    probeKnownWyldsCompletion({ urls: URLS, ...fixture({ extraTransfer: true }) }),
    /wylds_exact_transfer_missing/,
  )
})

test('origin disagreement and malformed completion fail closed', async () => {
  await assert.rejects(
    probeKnownWyldsCompletion({ urls: URLS, ...fixture({ disagree: true }) }),
    /direct_flow_origin_disagreement/,
  )
  await assert.rejects(
    probeKnownWyldsCompletion({ urls: URLS, ...fixture({ malformed: true }) }),
    /wylds_completion_log_invalid/,
  )
})
