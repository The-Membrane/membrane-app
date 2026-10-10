import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BOARD_ROUTES } from '../research/carry-local-morpho-holder-v2.mjs'
import {
  auditMorphoHistoricalTransferCandidateLive,
  discoverMorphoHistoricalTransferCandidate,
  validateMorphoHistoricalTransferCandidateEvidence,
} from './carry-exit-v2-morpho-historical-transfer-candidate.mjs'

const route = BOARD_ROUTES[38]
const hash = `0x${'a'.repeat(64)}`
const parent = `0x${'b'.repeat(64)}`
const discoveryHash = `0x${'c'.repeat(64)}`
const tx = `0x${'d'.repeat(64)}`
const owner = `0x${'1'.repeat(40)}`
const transfer = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const topic = (address) => `0x${address.slice(2).padStart(64, '0')}`
const log = {
  address: route.destination,
  blockNumber: '0x64',
  blockHash: discoveryHash,
  transactionHash: tx,
  transactionIndex: '0x0',
  logIndex: '0x1',
  topics: [transfer, topic(`0x${'2'.repeat(40)}`), topic(owner)],
  data: `0x${'0'.repeat(63)}a`,
  removed: false,
}
const baseline = {
  routeKey: route.routeKey,
  destination: route.destination,
  asset: route.asset,
  targetBlock: '200',
  targetHash: hash,
  targetParentHash: parent,
  totalAssetsRaw: '1000000',
  assetDecimals: 6,
  canonicalityEvidenceDoc: {
    schema: 'carry_exit_v2_headers_v1',
    targetHeader: { hash, number: '200' },
  },
}
const clone = (value) => structuredClone(value)
const rpc = (provider, overrides = {}) => ({
  provider,
  request: async (method, params) => {
    if (method === 'eth_getLogs') {
      assert.equal(params[0].address, route.destination)
      assert.equal(params[0].fromBlock, '0x64')
      assert.equal(params[0].toBlock, overrides.toBlock ?? '0x65')
      return overrides.logs ?? [log]
    }
    if (method === 'eth_getBlockByNumber') {
      const number = Number(BigInt(params[0]))
      return {
        number: params[0],
        hash: number === 100 ? discoveryHash : `0x${'e'.repeat(64)}`,
        parentHash: `0x${'f'.repeat(64)}`,
      }
    }
    if (method === 'eth_getTransactionReceipt')
      return (
        overrides.receipt ?? {
          transactionHash: tx,
          blockNumber: '0x64',
          blockHash: discoveryHash,
          status: '0x1',
          logs: [log],
        }
      )
    throw Error(`unexpected ${method}`)
  },
})
const primary = rpc('https://rpc.ankr.com/eth')
const secondary = rpc('https://eth-mainnet.g.alchemy.com/v2/test')
const windows = [{ fromBlock: '100', toBlock: '101' }]
const pinnedRead = async () => ({ status: 'eligible_holder', sharesRaw: '10', claimRaw: '9' })

test('historical Transfer source seals two-host logs, receipt, headers, and pinned claim', async () => {
  const output = await discoverMorphoHistoricalTransferCandidate({
    baseline,
    primary,
    secondary,
    windows,
    pinnedRead,
  })
  assert.equal(output.holder, owner)
  assert.equal(output.evidenceDoc.discovery.scope, 'non_exhaustive_explicit_historical_windows')
  assert.equal(output.evidenceDoc.discovery.windows[0].logs.length, 1)
  assert.equal(
    validateMorphoHistoricalTransferCandidateEvidence(output.evidenceDoc),
    output.evidenceDoc,
  )
  const forged = clone(output.evidenceDoc)
  forged.screenedCandidates[0].sourceProof.second.receipt.status = '0x0'
  assert.throws(
    () => validateMorphoHistoricalTransferCandidateEvidence(forged),
    /candidate_invalid/,
  )
  const ladder = clone(output.evidenceDoc)
  ladder.selectedClaimRaw = '10'
  assert.throws(
    () => validateMorphoHistoricalTransferCandidateEvidence(ladder),
    /candidate_invalid/,
  )
  const oneOrigin = clone(output.evidenceDoc)
  oneOrigin.discovery.hostCommitments[1] = oneOrigin.discovery.hostCommitments[0]
  assert.throws(
    () => validateMorphoHistoricalTransferCandidateEvidence(oneOrigin),
    /candidate_invalid/,
  )
})

test('different logs, forged receipts, and out-of-range windows fail closed', async () => {
  await assert.rejects(
    discoverMorphoHistoricalTransferCandidate({
      baseline,
      primary,
      secondary: rpc('https://eth-mainnet.g.alchemy.com', { logs: [] }),
      windows,
      pinnedRead,
    }),
    /candidate_invalid/,
  )
  await assert.rejects(
    discoverMorphoHistoricalTransferCandidate({
      baseline,
      primary,
      secondary: rpc('https://eth-mainnet.g.alchemy.com', {
        receipt: {
          transactionHash: tx,
          blockNumber: '0x64',
          blockHash: discoveryHash,
          status: '0x0',
          logs: [log],
        },
      }),
      windows,
      pinnedRead,
    }),
    /candidate_invalid/,
  )
  await assert.rejects(
    discoverMorphoHistoricalTransferCandidate({
      baseline,
      primary,
      secondary,
      windows: [{ fromBlock: '100', toBlock: '164' }],
      pinnedRead,
    }),
    /candidate_invalid/,
  )
})

test('single-block historical window replays within the issue size budget', async () => {
  const output = await discoverMorphoHistoricalTransferCandidate({
    baseline,
    primary: rpc('https://rpc.ankr.com/eth', { toBlock: '0x64' }),
    secondary: rpc('https://eth-mainnet.g.alchemy.com/v2/test', { toBlock: '0x64' }),
    windows: [{ fromBlock: '100', toBlock: '100' }],
    pinnedRead,
  })
  assert.equal(output.holder, owner)
  assert.equal(output.evidenceDoc.discovery.windows[0].boundary.length, 2)
  assert.ok(Buffer.byteLength(JSON.stringify(output.evidenceDoc)) < 512 * 1024)
  assert.equal(
    validateMorphoHistoricalTransferCandidateEvidence(output.evidenceDoc),
    output.evidenceDoc,
  )
  const audited = await auditMorphoHistoricalTransferCandidateLive(
    output.evidenceDoc,
    rpc('https://rpc.ankr.com/eth', { toBlock: '0x64' }),
    rpc('https://eth-mainnet.g.alchemy.com/v2/test', { toBlock: '0x64' }),
  )
  assert.equal(audited.verifiedWindows, 1)
  assert.equal(audited.verifiedCandidates, 1)
  await assert.rejects(
    auditMorphoHistoricalTransferCandidateLive(
      output.evidenceDoc,
      rpc('https://rpc.ankr.com/eth', { toBlock: '0x64' }),
      rpc('https://eth-mainnet.g.alchemy.com/v2/test', { toBlock: '0x64', logs: [] }),
    ),
    /candidate_invalid/,
  )
})
