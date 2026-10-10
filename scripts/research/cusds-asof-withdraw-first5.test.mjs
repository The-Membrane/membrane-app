import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeFunctionData, encodeErrorResult, encodeFunctionResult, parseAbi } from 'viem'
import { BASE, COMET, Q } from './cusds-holder-feasibility-first5.mjs'
import { EIP1967_IMPLEMENTATION_SLOT } from './cusds-holder-withdraw-first5.mjs'
import {
  INPUT_SHA256,
  assertCanonicalSavedBlocks,
  diskOk,
  explicitCashEvidence,
  freezeInput,
  loadOutcomeCheckpoint,
  run,
  scrubStage,
  secondaryHolderAttrition,
  validateOutcomeCheckpoint,
  verdict,
} from './cusds-asof-withdraw-first5.mjs'

const ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function isWithdrawPaused() view returns (bool)',
  'function withdraw(address asset, uint256 amount)',
])
const POST_HASH = `0x${'b'.repeat(64)}`
const IMPL = `0x${'c'.repeat(40)}`
const ZERO_SLOT = `0x${'0'.repeat(64)}`
const withTemp = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'cusds-asof-withdraw-'))
  try {
    await fn(join(dir, 'outcome.json'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
function mockClient(
  frozen,
  {
    preBalance = BigInt(frozen.rows[0].frozenBalanceRaw),
    postBalance = Q,
    preError = null,
    postError = null,
  } = {},
) {
  const first = frozen.rows[0]
  const calls = []
  return {
    calls,
    async getBlock({ blockNumber }) {
      const block = Number(blockNumber)
      calls.push({ method: 'getBlock', block })
      return { number: blockNumber, hash: block === first.asofBlock ? first.asofHash : POST_HASH }
    },
    async request({ method, params }) {
      calls.push({ method, params })
      if (method === 'eth_chainId') return '0x1'
      const hash = params[method === 'eth_getStorageAt' ? 2 : 1].blockHash
      assert.deepEqual(params[method === 'eth_getStorageAt' ? 2 : 1], {
        blockHash: hash,
        requireCanonical: true,
      })
      assert.ok([first.asofHash, POST_HASH].includes(hash))
      if (method === 'eth_getCode') return '0x6000'
      if (method === 'eth_getStorageAt') {
        assert.equal(params[1], EIP1967_IMPLEMENTATION_SLOT)
        return params[0] === COMET ? `0x${'0'.repeat(24)}${IMPL.slice(2)}` : ZERO_SLOT
      }
      assert.equal(method, 'eth_call')
      const tx = params[0]
      const decoded = decodeFunctionData({ abi: ABI, data: tx.data })
      if (decoded.functionName === 'withdraw') {
        assert.equal(tx.from, first.holder)
        assert.equal(tx.to, COMET)
        assert.equal(decoded.args[0].toLowerCase(), BASE)
        assert.equal(decoded.args[1], Q)
        if (hash === first.asofHash && preError) throw preError
        if (hash === POST_HASH && postError) throw postError
        return '0x'
      }
      if (decoded.functionName === 'isWithdrawPaused')
        return encodeFunctionResult({ abi: ABI, functionName: 'isWithdrawPaused', result: false })
      assert.equal(decoded.functionName, 'balanceOf')
      const result =
        tx.to === COMET
          ? hash === first.asofHash
            ? preBalance
            : postBalance
          : hash === POST_HASH && postError
            ? 0n
            : Q
      return encodeFunctionResult({ abi: ABI, functionName: 'balanceOf', result })
    },
  }
}

test('only a SHA-pinned frozen five-holder artifact can seed outcomes', () => {
  const frozen = freezeInput()
  assert.equal(frozen.inputFileSha256, INPUT_SHA256)
  assert.equal(frozen.rows.length, 5)
  assert.ok(frozen.rows.every((row) => BigInt(row.frozenBalanceRaw) >= Q))
  assert.equal(new Set(frozen.rows.map((row) => row.holder)).size, 1)
})

test('bounded A/B replay uses one frozen holder, hash-pinned state, and sanitized cash revert', async () => {
  await withTemp(async (out) => {
    const frozen = freezeInput()
    const client = mockClient(frozen, {
      postError: new Error(
        'execution reverted: Usds/insufficient-balance https://secret.example/key',
      ),
    })
    const result = await run({ out, client, maxEvents: 1, checkDisk: () => {} })
    assert.equal(result.processed, 1)
    assert.equal(result.rows.length, 5)
    assert.equal(result.rows[0].verdict, 'insufficient-cash')
    assert.equal(result.rows[1].verdict, 'pending')
    const saved = loadOutcomeCheckpoint(out, frozen)
    assert.equal(saved.results[0].pre.blockHash, frozen.rows[0].asofHash)
    assert.equal(saved.results[0].pre.balanceRaw, frozen.rows[0].frozenBalanceRaw)
    assert.equal(saved.results[0].post.blockHash, POST_HASH)
    assert.doesNotMatch(readFileSync(out, 'utf8'), /secret\.example|\/key/)
    assert.equal((await run({ out, client, maxEvents: 0, checkDisk: () => {} })).processed, 0)
    assert.ok(
      client.calls
        .filter((x) => ['eth_call', 'eth_getCode', 'eth_getStorageAt'].includes(x.method))
        .every((x) => {
          const pin = x.params[x.method === 'eth_getStorageAt' ? 2 : 1]
          return (
            pin.requireCanonical && [frozen.rows[0].asofHash, POST_HASH].includes(pin.blockHash)
          )
        }),
    )
  })
})

test('A balance mismatch stops before B and is retained as provider/read failure', async () => {
  await withTemp(async (out) => {
    const frozen = freezeInput()
    const client = mockClient(frozen, { preBalance: Q })
    const result = await run({ out, client, maxEvents: 1, checkDisk: () => {} })
    assert.equal(result.rows[0].verdict, 'provider-error')
    assert.equal(result.rows[0].readError, 'pre-read-failed')
    assert.ok(
      !client.calls.some((x) => x.method === 'getBlock' && x.block === frozen.rows[0].onset),
    )
    assert.equal(loadOutcomeCheckpoint(out, frozen).results[0].post, null)
  })
})

test('ABI-only Error(string) cash reason is recognized without retaining provider text', async () => {
  await withTemp(async (out) => {
    const frozen = freezeInput()
    const failure = new Error('RPC failed https://secret.example/key')
    failure.code = 3
    failure.data = encodeErrorResult({
      abi: parseAbi(['error Error(string)']),
      errorName: 'Error',
      args: ['Usds/insufficient-balance'],
    })
    assert.equal(explicitCashEvidence({ message: 'RPC failed', data: failure.data }), true)
    const result = await run({
      out,
      client: mockClient(frozen, { postError: failure }),
      maxEvents: 1,
      checkDisk: () => {},
    })
    assert.equal(result.rows[0].verdict, 'insufficient-cash')
    assert.doesNotMatch(
      readFileSync(out, 'utf8'),
      /secret\.example|\/key|Usds\/insufficient-balance/,
    )
    assert.match(readFileSync(out, 'utf8'), /ERC20InsufficientBalance/)
  })
})

test('offline validation rejects corruption; canonical saved B hash is checked on resume', async () => {
  await withTemp(async (out) => {
    const frozen = freezeInput()
    const client = mockClient(frozen)
    await run({ out, client, maxEvents: 1, checkDisk: () => {} })
    const sealed = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(validateOutcomeCheckpoint(sealed, frozen).results[0].verdict, 'success')
    sealed.payload.results[0].post.blockHash = `0x${'d'.repeat(64)}`
    assert.throws(() => validateOutcomeCheckpoint(sealed, frozen), /SHA mismatch/)
    await assert.rejects(
      assertCanonicalSavedBlocks(
        {
          getBlock: async ({ blockNumber }) => ({
            number: blockNumber,
            hash: `0x${'d'.repeat(64)}`,
          }),
        },
        loadOutcomeCheckpoint(out, frozen),
        frozen,
      ),
      /Pinned block header mismatch/,
    )
  })
})

test('classification retains preexisting, attrition, provider, and code-change interpretations', () => {
  const code = {
    comet: { hash: `0x${'1'.repeat(64)}`, bytes: 1 },
    base: { hash: `0x${'2'.repeat(64)}`, bytes: 1 },
    cometImplementation: { address: IMPL, hash: `0x${'3'.repeat(64)}`, bytes: 1 },
    baseImplementation: null,
  }
  const ok = {
    status: 'success',
    balanceRaw: Q.toString(),
    cashRaw: Q.toString(),
    paused: false,
    code,
  }
  assert.equal(
    verdict({
      pre: { ...ok, status: 'revert', error: { message: 'execution reverted' } },
      post: ok,
    }),
    'preexisting-revert',
  )
  const preexistingThenAttrition = {
    pre: { ...ok, status: 'revert', error: { message: 'execution reverted' } },
    post: { ...ok, status: 'attrition', balanceRaw: '0' },
  }
  assert.equal(verdict(preexistingThenAttrition), 'preexisting-revert')
  assert.equal(secondaryHolderAttrition(preexistingThenAttrition), true)
  assert.equal(
    verdict({ pre: ok, post: { ...ok, status: 'attrition', balanceRaw: '0' } }),
    'holder-attrition',
  )
  assert.equal(verdict({ pre: ok, post: { ...ok, status: 'provider-error' } }), 'provider-error')
  assert.equal(
    verdict({
      pre: ok,
      post: { ...ok, code: { ...code, comet: { hash: `0x${'4'.repeat(64)}`, bytes: 1 } } },
    }),
    'code-change',
  )
  assert.equal(
    scrubStage({ ...ok, status: 'revert', error: { message: 'execution reverted; token=secret' } })
      .error.message,
    'execution reverted',
  )
})

test('disk floor probe walks to nearest existing output ancestor', async () => {
  await withTemp(async (out) => {
    assert.doesNotThrow(() => diskOk(join(out, 'uncreated', 'nested', 'result.json')))
  })
})
