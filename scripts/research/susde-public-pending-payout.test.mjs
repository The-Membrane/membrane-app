import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeFunctionData, parseAbi, toEventSelector } from 'viem'
import {
  ROUTE_KEY,
  SILO,
  USDE,
  VAULT,
  WITHDRAW_TOPIC,
  sha,
} from './susde-public-pending-exit-common.mjs'
import {
  discoverAcrossPairs,
  discoverCandidateHashes,
  validatePayout,
} from './susde-public-pending-payout.mjs'

const H = '0x1111111111111111111111111111111111111111'
const TX = `0x${'c'.repeat(64)}`
const BLOCK = `0x${'b'.repeat(64)}`
const ANCHOR = `0x${'a'.repeat(64)}`
const PARENT = `0x${'d'.repeat(64)}`
const AMOUNT = 10n ** 18n
const topic = (address) => `0x${address.slice(2).padStart(64, '0')}`
const word = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`
const abi = parseAbi(['function unstake(address receiver)'])
const transfer = {
  address: USDE,
  topics: [toEventSelector('Transfer(address,address,uint256)'), topic(SILO), topic(H)],
  data: word(AMOUNT),
  blockNumber: '0x66',
  blockHash: BLOCK,
  transactionHash: TX,
  transactionIndex: '0x2',
  logIndex: '0x9',
  removed: false,
}
const issue = {
  sequence: 1,
  sha256: 'issuehash',
  holder: H,
  pendingAssetsRaw: AMOUNT.toString(),
  issuedAtUtc: '2026-10-01T00:00:00.000Z',
  cooldownEndUtc: '2026-10-01T23:00:00.000Z',
  anchor: { blockNumber: '100', blockHash: ANCHOR },
  measurement: {
    evidence: [
      {
        calls: {
          vaultCode: {
            result: {
              sha256: sha(Buffer.from('1234', 'hex')),
              byteLength: 2,
            },
          },
          assetCode: {
            result: { sha256: sha(Buffer.from('5678', 'hex')), byteLength: 2 },
          },
          siloCode: {
            result: { sha256: sha(Buffer.from('9abc', 'hex')), byteLength: 2 },
          },
        },
      },
    ],
  },
}
const make = () => {
  const proof = {
    provider: 'https://a.example',
    chainId: '0x1',
    tx: {
      hash: TX,
      blockHash: BLOCK,
      blockNumber: '0x66',
      transactionIndex: '0x2',
      from: H,
      to: VAULT,
      input: encodeFunctionData({ abi, functionName: 'unstake', args: [H] }),
      nonce: '0x7',
    },
    receipt: {
      transactionHash: TX,
      blockHash: BLOCK,
      blockNumber: '0x66',
      transactionIndex: '0x2',
      status: '0x1',
      logs: [structuredClone(transfer)],
    },
    block: {
      number: '0x66',
      hash: BLOCK,
      parentHash: PARENT,
      timestamp: `0x${Math.floor(Date.parse('2026-10-02T01:00:00.000Z') / 1000).toString(16)}`,
    },
    finalized: {
      number: '0x67',
      hash: `0x${'e'.repeat(64)}`,
      parentHash: BLOCK,
      timestamp: '0x68df246c',
    },
    anchorNonce: '0x7',
    postNonce: '0x8',
    ownerCode: '0x',
    vaultCode: structuredClone(issue.measurement.evidence[0].calls.vaultCode.result),
    assetCode: structuredClone(issue.measurement.evidence[0].calls.assetCode.result),
    siloCode: structuredClone(issue.measurement.evidence[0].calls.siloCode.result),
    asset: `0x${USDE.slice(2).padStart(64, '0')}`,
    silo: `0x${SILO.slice(2).padStart(64, '0')}`,
    postCooldown: `0x${'0'.repeat(128)}`,
    continuity: [{ range: { fromBlock: '0x65', toBlock: '0x66' }, logs: [] }],
  }
  const paidAtUtc = new Date(Number(BigInt(proof.block.timestamp)) * 1000).toISOString()
  return {
    study: 'susde_public_pending_payout_v1',
    sequence: 1,
    issueSequence: 1,
    issueSha256: issue.sha256,
    routeKey: ROUTE_KEY,
    vault: VAULT,
    asset: USDE,
    silo: SILO,
    holder: H,
    pendingAssetsRaw: issue.pendingAssetsRaw,
    cooldownEndUtc: issue.cooldownEndUtc,
    transactionHash: TX,
    paidAtUtc,
    witnessedAtUtc: paidAtUtc,
    outcome: 'mined_payout_episode_attested',
    sameEpisodeEvidenceLevel: 'two_origin_rpc_log_attested',
    cryptographicAbsenceProven: false,
    minedDeliveryProven: true,
    origins: [proof, structuredClone({ ...proof, provider: 'https://b.example' })],
  }
}
const bad = (mutate, code) => {
  const row = make()
  mutate(row)
  assert.throws(() => validatePayout(row, [issue]), new RegExp(code))
}

test('two finalized origins, exact EOA nonce and Silo transfer prove one pending episode', () => {
  const row = make()
  assert.equal(validatePayout(row, [issue]), row)
  row.origins[1].finalized.number = '0x68' // independent head lag is permitted
  assert.equal(validatePayout(row, [issue]), row)
})

test('one RPC host with different URL schemes cannot attest two origins', () => {
  bad((r) => {
    r.origins[0].provider = 'https://same.example'
    r.origins[1].provider = 'http://same.example:8545'
  }, 'issue_binding')
})

test('nonce, transfer, cleared queue and code identity fail closed', () => {
  bad((r) => {
    r.origins.forEach((o) => {
      o.anchorNonce = '0x6'
    })
  }, 'tx_proof')
  bad((r) => {
    r.origins.forEach((o) => {
      o.postNonce = '0x9'
    })
  }, 'tx_proof')
  bad((r) => {
    r.origins.forEach((o) => {
      o.receipt.logs[0].data = word(AMOUNT - 1n)
    })
  }, 'transfer')
  bad((r) => {
    r.origins.forEach((o) => {
      o.postCooldown = `${word(1).slice(0, 66)}${word(1).slice(2)}`
    })
  }, 'queue_not_cleared')
  bad((r) => {
    r.origins.forEach((o) => {
      o.vaultCode.sha256 = '0'.repeat(64)
    })
  }, 'tx_proof')
})

test('incomplete or reset continuity never proves paid', () => {
  bad((r) => {
    r.origins.forEach((o) => {
      o.continuity = []
    })
  }, 'continuity_incomplete')
  const log = {
    address: VAULT,
    topics: [WITHDRAW_TOPIC, topic(H), topic(SILO), topic(H)],
    data: `0x${word(AMOUNT).slice(2)}${word(AMOUNT).slice(2)}`,
    blockNumber: '0x66',
    blockHash: BLOCK,
    transactionHash: `0x${'f'.repeat(64)}`,
    transactionIndex: '0x1',
    logIndex: '0x1',
    removed: false,
  }
  bad((r) => {
    r.origins.forEach((o) => {
      o.continuity[0].logs = [log]
    })
  }, 'reset_ambiguous')
  bad((r) => {
    r.origins[1].continuity[0].logs = [log]
  }, 'origin_disagreement')
})

test('same-block order and finalized state are explicit', () => {
  bad((r) => {
    r.origins.forEach((o) => {
      o.chainId = '0x2'
    })
  }, 'chain_invalid')
  bad((r) => {
    r.origins[0].finalized.number = '0x65'
  }, 'not_finalized')
  bad((r) => {
    r.origins.forEach((o) => {
      o.tx.transactionIndex = '0x1'
    })
  }, 'tx_proof')
  bad((r) => {
    r.origins.forEach((o) => {
      o.tx.input = '0x1234'
    })
  }, 'tx_proof')
})

test('same-episode log completeness remains explicitly RPC-attested', () => {
  bad((r) => {
    r.cryptographicAbsenceProven = true
  }, 'issue_binding')
  bad((r) => {
    r.sameEpisodeEvidenceLevel = 'cryptographic'
  }, 'issue_binding')
})

const discoveredTransfer = { ...transfer, blockNumber: '0x66', transactionIndex: '0x2' }
const discoveryPeer = (provider, options = {}) => {
  const calls = []
  const request = async (method, params) => {
    calls.push({ method, params })
    if (method === 'eth_chainId') {
      if (options.chainError) throw Error('public_rpc_unavailable')
      return options.chainId ?? '0x1'
    }
    if (method === 'eth_getBlockByNumber') {
      return {
        number: options.finalizedNumber ?? '0x66',
        hash: BLOCK,
        parentHash: PARENT,
        timestamp: '0x68df2460',
      }
    }
    if (method === 'eth_getLogs')
      return typeof options.logs === 'function'
        ? options.logs(params[0])
        : (options.logs ?? [discoveredTransfer])
    throw Error('unexpected_discovery_call')
  }
  return { provider, request, calls }
}

test('complete two-origin Silo transfer scan returns candidate hashes only', async () => {
  const a = discoveryPeer('a')
  const b = discoveryPeer('b')
  const found = await discoverCandidateHashes(issue, a, b)
  assert.deepEqual(found, {
    status: 'complete',
    candidateTransactionHashes: [TX],
    fromBlock: '101',
    throughFinalizedBlock: '102',
    scannedWindows: 1,
  })
  assert.deepEqual(a.calls.find((call) => call.method === 'eth_getLogs').params[0], {
    address: USDE,
    topics: [toEventSelector('Transfer(address,address,uint256)'), topic(SILO), topic(H)],
    fromBlock: '0x65',
    toBlock: '0x66',
  })
})

test('discovery never returns partial candidates on log disagreement or unavailable range', async () => {
  const mismatch = await discoverCandidateHashes(
    issue,
    discoveryPeer('a'),
    discoveryPeer('b', { logs: [] }),
  )
  assert.deepEqual(mismatch, { status: 'susde_payout_discovery_origin_disagreement' })
  const tooLong = await discoverCandidateHashes(
    issue,
    discoveryPeer('a', { finalizedNumber: '0x10100' }),
    discoveryPeer('b', { finalizedNumber: '0x10100' }),
  )
  assert.deepEqual(tooLong, { status: 'susde_payout_discovery_range_unavailable' })
  const wrongChain = await discoverCandidateHashes(
    issue,
    discoveryPeer('a', { chainId: '0x2' }),
    discoveryPeer('b'),
  )
  assert.deepEqual(wrongChain, { status: 'susde_payout_discovery_chain_invalid' })
})

test('discovery scans contiguous windows and discards earlier candidates on later RPC failure', async () => {
  const logs = (range) => (range.fromBlock === '0x65' ? [discoveredTransfer] : [])
  const a = discoveryPeer('a', { finalizedNumber: '0x265', logs })
  const b = discoveryPeer('b', { finalizedNumber: '0x265', logs })
  const complete = await discoverCandidateHashes(issue, a, b)
  assert.equal(complete.status, 'complete')
  assert.equal(complete.scannedWindows, 2)
  assert.deepEqual(complete.candidateTransactionHashes, [TX])
  assert.deepEqual(
    a.calls
      .filter((call) => call.method === 'eth_getLogs')
      .map((call) => [call.params[0].fromBlock, call.params[0].toBlock]),
    [
      ['0x65', '0x264'],
      ['0x265', '0x265'],
    ],
  )
  const failing = discoveryPeer('c', {
    finalizedNumber: '0x265',
    logs: (range) => {
      if (range.fromBlock === '0x265') throw Error('provider outage')
      return [discoveredTransfer]
    },
  })
  const incomplete = await discoverCandidateHashes(issue, a, failing)
  assert.deepEqual(incomplete, { status: 'susde_payout_discovery_rpc_unavailable' })
})

test('discovery withholds candidates when the final response exceeds its deadline', async () => {
  let clock = 0
  const lateLogs = async () => {
    await Promise.resolve()
    clock = 180_001
    return [discoveredTransfer]
  }
  const result = await discoverCandidateHashes(
    issue,
    discoveryPeer('a', { logs: lateLogs }),
    discoveryPeer('b', { logs: lateLogs }),
    () => clock,
  )
  assert.deepEqual(result, { status: 'susde_payout_discovery_budget_exhausted' })
})

test('discovery skips an Infura-like transport failure and uses two healthy origins', async () => {
  const a = discoveryPeer('alchemy')
  const infura = discoveryPeer('infura', { chainError: true })
  const ankr = discoveryPeer('ankr')
  const result = await discoverAcrossPairs(issue, [a, infura, ankr])
  assert.equal(result.status, 'complete')
  assert.deepEqual(result.candidateTransactionHashes, [TX])
  assert.equal(infura.calls.filter((call) => call.method === 'eth_getLogs').length, 0)
  assert.equal(a.calls.filter((call) => call.method === 'eth_getLogs').length, 1)
  assert.equal(ankr.calls.filter((call) => call.method === 'eth_getLogs').length, 1)
})

test('discovery does not rotate away from a proven origin disagreement', async () => {
  const a = discoveryPeer('alchemy')
  const b = discoveryPeer('ankr', { logs: [] })
  const c = discoveryPeer('quicknode')
  const result = await discoverAcrossPairs(issue, [a, b, c])
  assert.deepEqual(result, { status: 'susde_payout_discovery_origin_disagreement' })
  assert.equal(c.calls.filter((call) => call.method === 'eth_getLogs').length, 0)
})
