// Exact known wYLDS completion and USDC receipt transfer, not a PYUSD payout.
import { pathToFileURL } from 'node:url'

import { decodeEventLog, encodeFunctionData, parseAbi, parseAbiItem, toEventSelector } from 'viem'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls } from './carry-public-direct-exit-issue.mjs'
import {
  compareOrigins,
  header,
  makeRpc,
  requireResult,
  selectOrigins,
  verifyHeaderChain,
} from './carry-direct-vault-flow-preflight.mjs'

export const TARGET = Object.freeze({
  from: 26091398,
  to: 26091402,
  blockHash: '0xdd778b60efa90f10a5ca1e7831cef7393976e83bb4ceb5c95da3a68e37de361c',
  transactionHash: '0xe6f35a5ca4b824cbce28e9fbd01f435336c85b175624b54105efa0182649f5b2',
  logIndex: 266,
  user: '0x6e2eaaec940e529cb428eaeedc7f5566a870de43',
  assetsRaw: '1062131',
  wylds: '0x6ad038ca6c04e885630851278ca0a856ad9a66cc',
  usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  redeemVault: '0xa8c3cf6183d49d5d372f8fc149bd2cb5cfc0facd',
})
const COMPLETE = parseAbiItem(
  'event RedemptionCompleted(address indexed user,uint256 shares,uint256 assets,uint256 timestamp)',
)
const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from,address indexed to,uint256 value)',
)
const COMPLETE_TOPIC = toEventSelector(COMPLETE)
const TRANSFER_TOPIC = toEventSelector(TRANSFER)
const REDEEM_VAULT_DATA = encodeFunctionData({
  abi: parseAbi(['function redeemVault() view returns (address)']),
  functionName: 'redeemVault',
})
const HASH = /^0x[0-9a-fA-F]{64}$/
const QUANTITY = /^0x[0-9a-fA-F]+$/
const WORD_ADDRESS = /^0x0{24}[0-9a-fA-F]{40}$/
const DATA = /^0x[0-9a-fA-F]{192}$/
const hex = (n) => `0x${n.toString(16)}`
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function normalizeCompletion(log, headers) {
  if (
    log?.address?.toLowerCase() !== TARGET.wylds ||
    !QUANTITY.test(log.blockNumber ?? '') ||
    !HASH.test(log.blockHash ?? '') ||
    !HASH.test(log.transactionHash ?? '') ||
    !QUANTITY.test(log.logIndex ?? '') ||
    !Array.isArray(log.topics) ||
    log.topics.length !== 2 ||
    log.topics[0]?.toLowerCase() !== COMPLETE_TOPIC ||
    !WORD_ADDRESS.test(log.topics[1] ?? '') ||
    !DATA.test(log.data ?? '') ||
    log.removed === true
  )
    throw Error('wylds_completion_log_invalid')
  const blockNumber = Number(BigInt(log.blockNumber))
  const logIndex = Number(BigInt(log.logIndex))
  if (
    !Number.isSafeInteger(blockNumber) ||
    !Number.isSafeInteger(logIndex) ||
    blockNumber < TARGET.from ||
    blockNumber > TARGET.to ||
    log.blockHash.toLowerCase() !== headers[blockNumber - TARGET.from]?.hash
  )
    throw Error('wylds_completion_header_mismatch')
  let decoded
  try {
    decoded = decodeEventLog({ abi: [COMPLETE], topics: log.topics, data: log.data, strict: true })
  } catch {
    throw Error('wylds_completion_decode_invalid')
  }
  return {
    blockNumber,
    blockHash: log.blockHash.toLowerCase(),
    transactionHash: log.transactionHash.toLowerCase(),
    logIndex,
    user: decoded.args.user.toLowerCase(),
    sharesRaw: decoded.args.shares.toString(),
    assetsRaw: decoded.args.assets.toString(),
    timestamp: Number(decoded.args.timestamp),
    topics: log.topics.map((topic) => topic.toLowerCase()),
    data: log.data.toLowerCase(),
  }
}

function materialLog(log) {
  if (
    !/^0x[0-9a-fA-F]{40}$/.test(log?.address ?? '') ||
    !HASH.test(log?.blockHash ?? '') ||
    !HASH.test(log?.transactionHash ?? '') ||
    log.blockHash.toLowerCase() !== TARGET.blockHash ||
    log.transactionHash.toLowerCase() !== TARGET.transactionHash ||
    !QUANTITY.test(log?.logIndex ?? '') ||
    !Array.isArray(log?.topics) ||
    log.topics.some((topic) => !HASH.test(topic)) ||
    typeof log?.data !== 'string' ||
    !/^0x(?:[0-9a-fA-F]{2})*$/.test(log.data)
  )
    throw Error('wylds_receipt_log_invalid')
  return {
    address: log.address?.toLowerCase(),
    blockHash: log.blockHash.toLowerCase(),
    transactionHash: log.transactionHash.toLowerCase(),
    logIndex: Number(BigInt(log.logIndex)),
    topics: log.topics.map((topic) => topic.toLowerCase()),
    data: log.data.toLowerCase(),
  }
}

function materialReceipt(receipt) {
  if (
    receipt?.transactionHash?.toLowerCase() !== TARGET.transactionHash ||
    receipt?.blockHash?.toLowerCase() !== TARGET.blockHash ||
    !QUANTITY.test(receipt?.blockNumber ?? '') ||
    Number(BigInt(receipt.blockNumber)) !== TARGET.to ||
    receipt.status !== '0x1' ||
    !Array.isArray(receipt.logs) ||
    receipt.logs.length > 1024
  )
    throw Error('wylds_receipt_invalid')
  return {
    transactionHash: TARGET.transactionHash,
    blockHash: TARGET.blockHash,
    blockNumber: TARGET.to,
    status: '0x1',
    logs: receipt.logs.map(materialLog),
  }
}

export async function probeKnownWyldsCompletion({
  urls,
  fetchImpl = fetch,
  nowMs = Date.now,
} = {}) {
  const origins = selectOrigins(urls ?? configuredPublicRpcUrls(readEnv()))
  const { rpc, budget } = makeRpc(fetchImpl, nowMs)
  const receipts = []
  const get = async (origin, method, params) => {
    const receipt = await rpc(origin, method, params)
    receipts.push(receipt)
    return receipt
  }
  for (const origin of origins) {
    const chain = requireResult(await get(origin, 'eth_chainId', []))
    if (typeof chain !== 'string' || !QUANTITY.test(chain) || BigInt(chain) !== 1n)
      throw Error('wylds_wrong_chain')
  }
  const finalizedHeads = []
  for (const origin of origins)
    finalizedHeads.push(header(await get(origin, 'eth_getBlockByNumber', ['finalized', false])))
  if (finalizedHeads.some((head) => head.number < TARGET.to))
    throw Error('wylds_target_not_finalized')
  const chains = []
  for (const origin of origins) {
    const chain = []
    for (let number = TARGET.from; number <= TARGET.to; number++)
      chain.push(header(await get(origin, 'eth_getBlockByNumber', [hex(number), false])))
    verifyHeaderChain(chain, TARGET.from, TARGET.to)
    chains.push(chain)
  }
  compareOrigins(chains[0], chains[1])
  const headers = chains[0]
  if (headers.at(-1).hash !== TARGET.blockHash) throw Error('wylds_target_hash_mismatch')
  const candidates = []
  for (const origin of origins) {
    const logs = requireResult(
      await get(origin, 'eth_getLogs', [
        {
          address: TARGET.wylds,
          fromBlock: hex(TARGET.from),
          toBlock: hex(TARGET.to),
          topics: [COMPLETE_TOPIC],
        },
      ]),
    )
    if (!Array.isArray(logs) || logs.length > 1024) throw Error('wylds_completion_logs_invalid')
    candidates.push(logs.map((log) => normalizeCompletion(log, headers)))
  }
  compareOrigins(candidates[0], candidates[1])
  const target = candidates[0].filter(
    (log) =>
      log.blockNumber === TARGET.to &&
      log.blockHash === TARGET.blockHash &&
      log.transactionHash === TARGET.transactionHash &&
      log.logIndex === TARGET.logIndex &&
      log.user === TARGET.user &&
      log.assetsRaw === TARGET.assetsRaw &&
      log.timestamp === headers.at(-1).timestamp,
  )
  if (target.length !== 1) throw Error('wylds_known_completion_missing')
  const txReceipts = []
  for (const origin of origins)
    txReceipts.push(
      materialReceipt(
        requireResult(await get(origin, 'eth_getTransactionReceipt', [TARGET.transactionHash])),
      ),
    )
  if (!same(txReceipts[0], txReceipts[1])) throw Error('wylds_receipt_disagreement')
  const eventInReceipt = txReceipts[0].logs.filter(
    (log) =>
      log.address === TARGET.wylds &&
      log.logIndex === TARGET.logIndex &&
      log.transactionHash === TARGET.transactionHash &&
      log.blockHash === TARGET.blockHash &&
      same(log.topics, target[0].topics) &&
      log.data === target[0].data,
  )
  if (eventInReceipt.length !== 1) throw Error('wylds_completion_receipt_missing')
  const redeemVaults = []
  for (const origin of origins) {
    const word = requireResult(
      await get(origin, 'eth_call', [
        { to: TARGET.wylds, data: REDEEM_VAULT_DATA },
        { blockHash: TARGET.blockHash, requireCanonical: true },
      ]),
    )
    if (typeof word !== 'string' || !WORD_ADDRESS.test(word))
      throw Error('wylds_redeem_vault_invalid')
    redeemVaults.push(`0x${word.slice(-40).toLowerCase()}`)
  }
  if (redeemVaults[0] !== TARGET.redeemVault || redeemVaults[1] !== TARGET.redeemVault)
    throw Error('wylds_redeem_vault_mismatch')
  const pairTransfers = txReceipts[0].logs.filter((log) => {
    if (log.address !== TARGET.usdc || log.topics[0] !== TRANSFER_TOPIC) return false
    let decoded
    try {
      decoded = decodeEventLog({
        abi: [TRANSFER],
        topics: log.topics,
        data: log.data,
        strict: true,
      })
    } catch {
      throw Error('wylds_transfer_decode_invalid')
    }
    return (
      decoded.args.from.toLowerCase() === TARGET.redeemVault &&
      decoded.args.to.toLowerCase() === TARGET.user
    )
  })
  if (pairTransfers.length !== 1) throw Error('wylds_exact_transfer_missing')
  const transfer = decodeEventLog({
    abi: [TRANSFER],
    topics: pairTransfers[0].topics,
    data: pairTransfers[0].data,
    strict: true,
  })
  if (transfer.args.value.toString() !== TARGET.assetsRaw)
    throw Error('wylds_exact_transfer_missing')
  const actual = budget()
  if (actual.calls > 44) throw Error('wylds_rpc_budget_exhausted')
  return {
    schema: 'pyusd_wylds_known_completion_probe_v1',
    routeKey: 'PYUSD → StakingVault [wYLDS]',
    range: { from: TARGET.from, to: TARGET.to, targetHash: TARGET.blockHash },
    target: { ...TARGET, sharesRaw: target[0].sharesRaw, eventTimestamp: target[0].timestamp },
    status: 'wylds_completion_and_usdc_transfer_attested',
    finalPyusdPayout: 'not_attested',
    sourceAgreement: 'two_hostname_agreed',
    finalizedHeads: finalizedHeads.map((head, i) => ({ origin: origins[i].host, ...head })),
    headerChains: chains.map((headers, i) => ({ origin: origins[i].host, headers })),
    rawReceipts: receipts,
    limits: {
      maxRpcCalls: 44,
      maxResponseBytes: 256 * 1024,
      maxTotalResponseBytes: 2 * 1024 * 1024,
      maxRunMs: 90_000,
      actual,
    },
    limitation:
      'This exact wYLDS completion and USDC Transfer do not attest a final PYUSD payout, future exit availability, or a duration distribution.',
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw Error('usage: node pyusd-wylds-known-completion-probe.mjs')
  probeKnownWyldsCompletion()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${String(error?.message ?? error)}\n`)
      process.exitCode = 1
    })
}
