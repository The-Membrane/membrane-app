import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  assayEndpoint,
  candidatesAtEndpoint,
  chooseQ,
  compareQuotes,
  FIXED_SMALL_Q_RAW,
  independentUrls,
  preferredIndependentUrls,
} from './aave-usdc-holder-flow-pair.mjs'

const hash = (digit) => `0x${digit.repeat(64)}`
const address = (digit) => `0x${digit.repeat(40)}`
const B = 100
const endpoint = { blockNumber: B, blockHash: hash('a'), cashRaw: '100000000' }
const source = { joinedContentSha256: 'a'.repeat(64) }
const rpcOperators = ['rpc.one', 'rpc.two']
const assay = (options) => assayEndpoint({ source, rpcOperators, ...options })
const candidate = (holder, blockNumber = B - 1) => ({
  holder,
  kind: 'supply',
  blockNumber,
  blockHash: blockNumber === B ? endpoint.blockHash : hash('b'),
  transactionHash: hash('1'),
  logIndex: 1,
})
const event = (kind, blockNumber, evidence, digit = '1') => ({
  kind,
  blockNumber,
  event: {
    blockHash: blockNumber === B ? endpoint.blockHash : hash('b'),
    transactionHash: hash(digit),
    logIndex: 1,
    reconciliation: {
      status: kind === 'supply' ? 'reconciled_supplier_supply' : 'reconciled_supplier_withdrawal',
      evidence,
    },
  },
})
const market = {
  kind: 'aaveV3Usdc',
  address: '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c',
  assetAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  assetDecimals: 6,
  identity: 'pinned_market_and_live_underlying',
}
const quote = (owner, balance = '2000000', assets = '1000000', blockHash = endpoint.blockHash) => ({
  status: 'checked_at_finalized_block',
  source: { chainId: 1, blockNumber: B, blockHash },
  routeKey: 'USDC → supply on Aave V3',
  market,
  position: { suppliedBalanceRaw: balance },
  request: { assetsRaw: assets },
  simulation: { status: 'success' },
  owner,
})
const expected = (balanceRaw = '2000000') => ({
  ...endpoint,
  destination: market.address,
  underlying: market.assetAddress,
  routeKey: 'USDC → supply on Aave V3',
  holder: address('1'),
  balanceRaw,
  assetsRaw: '1000000',
})

test('Supply beneficiary, never supplier, becomes candidate; withdrawal holder qualifies', () => {
  const supplier = address('1')
  const beneficiary = address('2')
  const withdrawHolder = address('3')
  const rows = [
    event('supply', 99, { supplier, beneficiary }, '1'),
    event('withdraw', B, { holder: withdrawHolder, receiver: address('4') }, '2'),
  ]
  assert.deepEqual(
    candidatesAtEndpoint(rows, B, endpoint.blockHash).map((row) => row.holder),
    [withdrawHolder, beneficiary],
  )
  assert.ok(
    !candidatesAtEndpoint(rows, B, endpoint.blockHash).some((row) => row.holder === supplier),
  )
})

test('Post-endpoint rows cannot reorder, select, or duplicate a prior holder', () => {
  const prior = address('2')
  const rows = [
    event('supply', 98, { supplier: address('1'), beneficiary: prior }, '1'),
    event('withdraw', 101, { holder: address('3') }, '2'),
    event('withdraw', 102, { holder: prior }, '3'),
  ]
  assert.deepEqual(
    candidatesAtEndpoint(rows, B, endpoint.blockHash).map((row) => row.holder),
    [prior],
  )
  assert.deepEqual(
    candidatesAtEndpoint([...rows, { blockNumber: B + 1 }], B, endpoint.blockHash).map(
      (row) => row.holder,
    ),
    [prior],
  )
  assert.throws(
    () =>
      candidatesAtEndpoint(
        [event('withdraw', B, { holder: prior }, '4')].map((row) => ({
          ...row,
          event: { ...row.event, blockHash: hash('f') },
        })),
        B,
        endpoint.blockHash,
      ),
    /holder_pair_event_invalid/,
  )
})

test('candidate order follows descending chain log index within one block', () => {
  const low = event('supply', B, { beneficiary: address('1') }, 'f')
  const high = event('supply', B, { beneficiary: address('2') }, '1')
  high.event.logIndex = 2
  assert.deepEqual(
    candidatesAtEndpoint([low, high], B, endpoint.blockHash).map((row) => row.holder),
    [address('2'), address('1')],
  )
})

test('Q is exactly one USDC only for a sufficient pinned balance', () => {
  assert.equal(FIXED_SMALL_Q_RAW, 1_000_000n)
  assert.equal(chooseQ(3n), null)
  assert.equal(chooseQ(1_000_000n), 1_000_000n)
  assert.equal(chooseQ(2_000_000n), 1_000_000n)
  assert.throws(() => chooseQ(0n), /holder_pair_balance_invalid/)
})

test('inspects a small balance then issues the same exact Q for the next eligible holder', async () => {
  const candidates = [candidate(address('1')), candidate(address('2'))]
  let quotes = 0
  const clients = [0, 1].map(() => ({
    request: async () => '0x',
    readContract: async ({ args }) => (args[0] === candidates[0].holder ? 500_000n : 2_000_000n),
  }))
  const result = await assay({
    endpoint,
    candidates,
    clients,
    quoteReader: async (_client, request) => {
      quotes++
      assert.equal(request.owner, candidates[1].holder)
      assert.equal(request.assetsRaw, '1000000')
      return quote(request.owner)
    },
  })
  assert.equal(result.status, 'same_holder_same_block_two_origin_assay')
  assert.equal(result.holder, candidates[1].holder)
  assert.equal(result.assetsRaw, '1000000')
  assert.equal(result.inspected.length, 2)
  assert.equal(result.inspected[0].aUsdcBalanceRaw, '500000')
  assert.equal(quotes, 2)
})

test('only sub-Q holders produce no baseline quote', async () => {
  const clients = [0, 1].map(() => ({
    request: async () => '0x',
    readContract: async () => 500_000n,
  }))
  const result = await assay({
    endpoint,
    candidates: [candidate(address('1'))],
    clients,
    quoteReader: async () => {
      throw Error('must_not_quote')
    },
  })
  assert.equal(result.status, 'no_eligible_holder_within_bounded_scan')
  assert.equal(result.inspected[0].aUsdcBalanceRaw, '500000')
})

test('Contract or undefined code and zero balance cannot select a holder', async () => {
  const candidates = [address('1'), address('2'), address('3')].map((holder) => candidate(holder))
  const codeByHolder = new Map([
    [candidates[0].holder, undefined],
    [candidates[1].holder, '0x6000'],
    [candidates[2].holder, '0x'],
  ])
  let quotes = 0
  const clients = [0, 1].map(() => ({
    request: async ({ method, params: [holder, block] }) => {
      assert.equal(method, 'eth_getCode')
      assert.equal(block.blockHash, endpoint.blockHash)
      assert.equal(block.requireCanonical, true)
      return codeByHolder.get(holder)
    },
    readContract: async ({ args, blockHash, requireCanonical }) => {
      assert.equal(blockHash, endpoint.blockHash)
      assert.equal(requireCanonical, true)
      return args[0] === candidates[2].holder ? 2_000_000n : 0n
    },
  }))
  const result = await assay({
    endpoint,
    candidates,
    clients,
    quoteReader: async (_client, request, _now, historic) => {
      quotes++
      assert.equal(request.owner, candidates[2].holder)
      assert.equal(request.assetsRaw, '1000000')
      assert.equal(historic.blockNumber, 100n)
      assert.equal(historic.blockHash, endpoint.blockHash)
      return quote(request.owner)
    },
  })
  assert.equal(result.holder, candidates[2].holder)
  assert.equal(result.inspected.length, 3)
  assert.deepEqual(
    result.inspected.map((row) => row.code),
    ['unavailable', 'deployed_code', 'no_deployed_code'],
  )
  assert.equal(quotes, 2)
  assert.equal(result.keyControlVerified, false)
  assert.equal(result.futureExitVerified, false)
  assert.equal(result.source.joinedContentSha256, source.joinedContentSha256)
  assert.deepEqual(result.rpcOperators, rpcOperators)
})

test('No eligible candidate returns a negative bounded assay without a quote', async () => {
  const clients = [0, 1].map(() => ({
    request: async () => undefined,
    readContract: async () => 10n,
  }))
  const result = await assay({
    endpoint,
    candidates: [candidate(address('1'))],
    clients,
    quoteReader: async () => {
      throw Error('must_not_quote')
    },
  })
  assert.equal(result.status, 'no_eligible_holder_within_bounded_scan')
  assert.equal(result.inspected[0].code, 'unavailable')
})

test('Quote comparison enforces exact endpoint hash and independent output agreement', () => {
  const holder = address('1')
  assert.deepEqual(compareQuotes(quote(holder), quote(holder), expected()).simulation, {
    status: 'success',
  })
  assert.throws(
    () => compareQuotes(quote(holder, '2000000', '1000000', hash('f')), quote(holder), expected()),
    /holder_pair_quote_identity_mismatch/,
  )
  assert.throws(
    () =>
      compareQuotes(
        quote(holder),
        {
          ...quote(holder),
          simulation: { status: 'evm_revert', reason: 'unknown_execution_constraint' },
        },
        expected(),
      ),
    /holder_pair_two_origin_disagreement/,
  )
  assert.throws(
    () => compareQuotes(quote(address('2')), quote(address('2')), expected()),
    /holder_pair_quote_identity_mismatch/,
  )
  assert.throws(
    () => compareQuotes({ ...quote(holder), owner: undefined }, quote(holder), expected()),
    /holder_pair_quote_identity_mismatch/,
  )
  assert.throws(
    () => compareQuotes(quote(holder), quote(address('2')), expected()),
    /holder_pair_quote_identity_mismatch/,
  )
})

test('Pinned code or balance disagreement fails closed', async () => {
  const candidates = [candidate(address('1'))]
  const clients = [
    { request: async () => '0x', readContract: async () => 2_000_000n },
    { request: async () => '0x6000', readContract: async () => 2_000_000n },
  ]
  await assert.rejects(
    () => assay({ endpoint, candidates, clients }),
    /holder_pair_two_origin_disagreement/,
  )
})

test('assay rejects an arbitrary or post-endpoint candidate', async () => {
  const clients = [{}, {}]
  await assert.rejects(
    () => assay({ endpoint, candidates: [candidate(address('1'), B + 1)], clients }),
    /holder_pair_assay_input_invalid/,
  )
  await assert.rejects(
    () => assay({ endpoint, candidates: [{ holder: address('1') }], clients }),
    /holder_pair_assay_input_invalid/,
  )
})

test('RPC selection skips hostname aliases and requires independent origins', () => {
  assert.deepEqual(
    preferredIndependentUrls([
      'https://eth-mainnet.g.alchemy.com/key',
      'https://lb.drpc.live/key',
      'https://rpc.ankr.com/eth',
    ]),
    ['https://rpc.ankr.com/eth', 'https://lb.drpc.live/key'],
  )
  assert.deepEqual(
    independentUrls([
      'https://mainnet.infura.io/path',
      'https://www.mainnet.infura.io./other',
      'https://rpc.ankr.com/path',
    ]),
    ['https://mainnet.infura.io/path', 'https://rpc.ankr.com/path'],
  )
  assert.throws(
    () => independentUrls(['http://127.0.0.1:8545', 'http://localhost:8545']),
    /holder_pair_two_origins_required/,
  )
  assert.throws(
    () => independentUrls(['https://mainnet.infura.io/a', 'https://rpc.infura.io/b']),
    /holder_pair_two_origins_required/,
  )
  assert.throws(
    () => independentUrls(['https://unknown-one.example/a', 'https://unknown-two.example/b']),
    /holder_pair_two_origins_required/,
  )
})
