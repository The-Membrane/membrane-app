import assert from 'node:assert/strict'
import test from 'node:test'
import { locate, main, MAX_RPC_CALLS } from './share-deployment-locator.mjs'
import { TOKENS } from './share-transfer-source.mjs'

const hash = (n) =>
  `0x${BigInt(n + 1)
    .toString(16)
    .padStart(64, '0')}`
const code = '0x60016000'

function fixture({ token = 'sGHO', boundary = 17, head = 63, peerHead = head, mutate } = {}) {
  let calls = 0
  const reader = (side) => async (method, params) => {
    calls++
    if (mutate) {
      const override = mutate({ side, method, params })
      if (override !== undefined) return override
    }
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_getBlockByNumber') {
      const n =
        params[0] === 'finalized' ? (side === 'primary' ? head : peerHead) : Number(params[0])
      return { number: `0x${n.toString(16)}`, hash: hash(n), parentHash: hash(n - 1) }
    }
    if (method === 'eth_getCode') {
      assert.equal(params[0], TOKENS[token])
      assert.equal(params[1].requireCanonical, true)
      const n = Number(BigInt(params[1].blockHash)) - 1
      return n >= boundary ? code : '0x'
    }
    throw Error('unexpected method')
  }
  return {
    rpcRead: reader('primary'),
    peerRpcRead: reader('peer'),
    calls: () => calls,
  }
}

test('locates an adjacent empty/code boundary at a shared finalized head', async () => {
  const readers = fixture({ peerHead: 60 })
  assert.deepEqual(await locate({ token: 'sGHO', ...readers }), {
    token: 'sGHO',
    deploymentBlock: 17,
    deploymentHash: hash(17),
  })
  assert.ok(readers.calls() <= MAX_RPC_CALLS)
})

test('finds the first eligible block and accepts the other known token', async () => {
  const found = await locate({
    token: 'sUSDe',
    ...fixture({ token: 'sUSDe', boundary: 1, head: 3 }),
  })
  assert.equal(found.deploymentBlock, 1)
})

test('stays within the RPC ceiling at an Ethereum-sized finalized head', async () => {
  const readers = fixture({ boundary: 18_000_123, head: 26_000_000 })
  const found = await locate({ token: 'sGHO', ...readers })
  assert.equal(found.deploymentBlock, 18_000_123)
  assert.ok(readers.calls() <= MAX_RPC_CALLS)
})

test('rejects a token with no finalized code or code already present at genesis', async () => {
  await assert.rejects(locate({ token: 'sGHO', ...fixture({ boundary: 100 }) }), /boundary_missing/)
  await assert.rejects(locate({ token: 'sGHO', ...fixture({ boundary: 0 }) }), /boundary_missing/)
})

test('rejects wrong chain, mismatched finalized hash, and code disagreement', async () => {
  await assert.rejects(
    locate({
      token: 'sGHO',
      ...fixture({
        mutate: ({ side, method }) =>
          side === 'peer' && method === 'eth_chainId' ? '0x89' : undefined,
      }),
    }),
    /response_peer_chain_wrong_network/,
  )
  await assert.rejects(
    locate({
      token: 'sGHO',
      ...fixture({
        mutate: ({ side, method, params }) =>
          side === 'peer' && method === 'eth_getBlockByNumber' && params[0] === '0x3f'
            ? { number: '0x3f', hash: hash(100), parentHash: hash(62) }
            : undefined,
      }),
    }),
    /head_mismatch/,
  )
  await assert.rejects(
    locate({
      token: 'sGHO',
      ...fixture({
        mutate: ({ side, method, params }) =>
          side === 'peer' && method === 'eth_getCode' && params[1].blockHash === hash(63)
            ? '0x6002'
            : undefined,
      }),
    }),
    /code_mismatch/,
  )
})

test('provider failures identify side and read stage without copying provider data', async () => {
  const secret = 'https://key.example/private'
  for (const [side, stage, method, param] of [
    ['primary', 'chain', 'eth_chainId'],
    ['peer', 'chain', 'eth_chainId'],
    ['primary', 'head', 'eth_getBlockByNumber', 'finalized'],
    ['peer', 'head', 'eth_getBlockByNumber', 'finalized'],
    ['primary', 'header', 'eth_getBlockByNumber', '0x3f'],
    ['peer', 'header', 'eth_getBlockByNumber', '0x3f'],
    ['primary', 'code', 'eth_getCode'],
    ['peer', 'code', 'eth_getCode'],
  ]) {
    await assert.rejects(
      locate({
        token: 'sGHO',
        ...fixture({
          mutate: ({ side: callSide, method: callMethod, params }) => {
            if (callSide === side && callMethod === method && (!param || params[0] === param))
              throw Error(secret)
            return undefined
          },
        }),
      }),
      (error) => error.message === `share_deployment_rpc_${side}_${stage}_failure`,
    )
  }
})

test('malformed provider responses identify side and read stage', async () => {
  for (const [side, stage, method, param, value] of [
    ['primary', 'chain', 'eth_chainId', undefined, 'not-a-chain'],
    ['peer', 'chain', 'eth_chainId', undefined, 'not-a-chain'],
    ['primary', 'head', 'eth_getBlockByNumber', 'finalized', null],
    ['peer', 'head', 'eth_getBlockByNumber', 'finalized', null],
    ['primary', 'header', 'eth_getBlockByNumber', '0x3f', null],
    ['peer', 'header', 'eth_getBlockByNumber', '0x3f', null],
    ['primary', 'code', 'eth_getCode', undefined, '0xzz'],
    ['peer', 'code', 'eth_getCode', undefined, '0xzz'],
  ]) {
    await assert.rejects(
      locate({
        token: 'sGHO',
        ...fixture({
          mutate: ({ side: callSide, method: callMethod, params }) =>
            callSide === side && callMethod === method && (!param || params[0] === param)
              ? value
              : undefined,
        }),
      }),
      (error) => error.message === `share_deployment_response_${side}_${stage}_invalid`,
    )
  }
})

test('classifies historical-code and transport failures with fixed redacted codes', async () => {
  const secret = 'https://key.example/private?token=secret'
  const failures = [
    [new Error(`missing trie node ${secret}`), 'historical_state_unavailable'],
    [new Error(`blockHash not supported ${secret}`), 'block_reference_unsupported'],
    [Object.assign(new Error(secret), { status: 429 }), 'rate_limited'],
    [Object.assign(new Error(secret), { code: 'ETIMEDOUT' }), 'transport_failure'],
    [
      new Error(secret, { cause: new Error(`state is pruned ${secret}`) }),
      'historical_state_unavailable',
    ],
  ]
  for (const [providerError, kind] of failures) {
    await assert.rejects(
      locate({
        token: 'sGHO',
        ...fixture({
          mutate: ({ side, method }) => {
            if (side === 'peer' && method === 'eth_getCode') throw providerError
            return undefined
          },
        }),
      }),
      (error) =>
        error.message === `share_deployment_rpc_peer_code_${kind}` &&
        !error.message.includes(secret),
    )
  }
})

test('parses only an exact known-token CLI', async () => {
  await assert.rejects(main(['--token', 'unknown']), /cli_invalid/)
  await assert.rejects(main(['--token', 'sGHO', '--run']), /cli_invalid/)
})

test('CLI selects explicit host order from RECORDER_RPC_URL and hides credentials', async () => {
  const secret = 'TOP_SECRET_RPC_KEY'
  const first = `https://mainnet.infura.io/v3/${secret}`
  const second = `https://rpc.ankr.com/eth/${secret}`
  const third = `https://eth.llamarpc.com/${secret}`
  const readers = fixture()
  const seen = []
  const result = await main(['--rpc-hosts', 'mainnet.infura.io,rpc.ankr.com', '--token', 'sGHO'], {
    env: new Map([['RECORDER_RPC_URL', `${third},${second},${first}`]]),
    makeClient: (url) => {
      seen.push(url)
      const read = seen.length === 1 ? readers.rpcRead : readers.peerRpcRead
      return { request: ({ method, params }) => read(method, params) }
    },
    paceMs: 0,
  })
  assert.deepEqual(seen, [first, second])
  assert.equal(result.deploymentBlock, 17)
  await assert.rejects(
    main(['--token', 'sGHO'], {
      env: new Map([['RECORDER_RPC_URL', `${third},${second},${first}`]]),
      makeClient: () => {
        throw Error('must not create client')
      },
    }),
    (error) =>
      error.message === 'share_deployment_two_rpc_hosts_required' &&
      !error.message.includes(secret),
  )
  await assert.rejects(
    main(['--token', 'sGHO', '--rpc-hosts', 'mainnet.infura.io,missing.example'], {
      env: new Map([['RECORDER_RPC_URL', `${first},${second}`]]),
    }),
    (error) =>
      error.message === 'share_deployment_rpc_host_missing' && !error.message.includes(secret),
  )
})
