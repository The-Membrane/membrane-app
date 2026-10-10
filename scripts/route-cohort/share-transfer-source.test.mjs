import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_LOGS,
  MAX_LOG_BLOCK_HEADERS,
  MAX_RPC_CALLS,
  TRANSFER_TOPIC,
  TOKENS,
  collect,
  main,
  selectRpcUrls,
  verify,
} from './share-transfer-source.mjs'

const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const address = (n) => `0x${n.toString(16).padStart(40, '0')}`
const topic = (a) => `0x${a.slice(2).padStart(64, '0')}`
const stat = () => ({ bavail: 2_000_000_000, bsize: 1 })
const config = {
  chainId: 1,
  token: 'sGHO',
  address: TOKENS.sGHO,
  deploymentBlock: 10,
  startBlock: 10,
}
const header = (n) => ({
  number: `0x${n.toString(16)}`,
  hash: hash(n),
  parentHash: hash(n - 1),
  timestamp: `0x${n.toString(16)}`,
})
const logs = [
  {
    address: TOKENS.sGHO,
    topics: [TRANSFER_TOPIC, topic(address(0)), topic(address(1))],
    data: hash(2),
    blockNumber: '0xa',
    blockHash: hash(10),
    transactionHash: hash(101),
    logIndex: '0x0',
  },
  {
    address: TOKENS.sGHO,
    topics: [TRANSFER_TOPIC, topic(address(1)), topic(address(2))],
    data: hash(1),
    blockNumber: '0xb',
    blockHash: hash(11),
    transactionHash: hash(102),
    logIndex: '0x0',
  },
]
const rpc = async (method, params) => {
  if (method === 'eth_chainId') return '0x1'
  if (method === 'eth_getBlockByNumber')
    return header(params[0] === 'finalized' ? 11 : Number(BigInt(params[0])))
  if (method === 'eth_getCode') {
    assert.equal(typeof params[1], 'object')
    assert.equal(params[1].requireCanonical, true)
    return Number(BigInt(params[1].blockHash)) === 9 ? '0x' : '0x6001'
  }
  if (method === 'eth_getLogs')
    return logs.filter(
      (l) =>
        Number(BigInt(l.blockNumber)) >= Number(BigInt(params[0].fromBlock)) &&
        Number(BigInt(l.blockNumber)) <= Number(BigInt(params[0].toBlock)),
    )
  throw Error('unexpected method')
}

test('RPC host selection requires two exact distinct configured hosts and never echoes keys', () => {
  const secret = 'TOP_SECRET_RPC_KEY'
  const infura = `https://mainnet.infura.io/v3/${secret}`
  const ankr = `https://rpc.ankr.com/eth/${secret}`
  const other = `https://eth.llamarpc.com/${secret}`
  assert.deepEqual(selectRpcUrls(`${other},${ankr},${infura}`, 'mainnet.infura.io,rpc.ankr.com'), [
    infura,
    ankr,
  ])
  const errors = [
    [`${other},${ankr},${infura}`, undefined, 'two_rpc_hosts_required'],
    [`${infura},${infura}`, 'mainnet.infura.io,rpc.ankr.com', 'rpc_host_ambiguous'],
    [`${infura},${ankr}`, 'mainnet.infura.io,mainnet.infura.io', 'rpc_host_selection_invalid'],
    [`${infura},${ankr}`, 'mainnet.infura.io,missing.example', 'rpc_host_missing'],
    [undefined, 'mainnet.infura.io,rpc.ankr.com', 'two_rpc_hosts_required'],
    [`${infura},bad://${secret}`, 'mainnet.infura.io,rpc.ankr.com', 'rpc_config_invalid'],
  ]
  for (const [raw, hosts, code] of errors)
    assert.throws(
      () => selectRpcUrls(raw, hosts),
      (error) => error.message === `share_source_${code}` && !error.message.includes(secret),
    )
})

test('CLI selects named hosts from RECORDER_RPC_URL without printing credentials', async () => {
  const out = mkdtempSync(join(tmpdir(), 'share-hosts-'))
  const secret = 'TOP_SECRET_RPC_KEY'
  const first = `https://mainnet.infura.io/v3/${secret}`
  const second = `https://rpc.ankr.com/eth/${secret}`
  const third = `https://eth.llamarpc.com/${secret}`
  const seen = []
  const args = [
    '--run',
    '--token',
    'sGHO',
    '--deployment-block',
    '10',
    '--out',
    out,
    '--pace-ms',
    '0',
    '--rpc-hosts',
    'mainnet.infura.io,rpc.ankr.com',
  ]
  try {
    const result = await main(args, {
      env: new Map([['RECORDER_RPC_URL', `${third},${first},${second}`]]),
      makeClient: (url) => {
        seen.push(url)
        return { request: ({ method, params }) => rpc(method, params) }
      },
      stat,
      now: () => new Date(11_000),
    })
    assert.deepEqual(seen, [first, second])
    assert.equal(result.throughBlock, 11)
    await assert.rejects(
      main(args.slice(0, -2), {
        env: new Map([['RECORDER_RPC_URL', `${third},${first},${second}`]]),
        makeClient: () => {
          throw Error('must not create client')
        },
        stat,
      }),
      (error) =>
        error.message === 'share_source_two_rpc_hosts_required' && !error.message.includes(secret),
    )
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('seals contiguous finalized transfer recipients and replays the source', async () => {
  const out = mkdtempSync(join(tmpdir(), 'share-source-'))
  try {
    const result = await collect({
      out,
      config,
      rpcRead: rpc,
      peerRpcRead: rpc,
      stat,
      now: () => new Date(11_000),
    })
    assert.deepEqual(result.candidateRecipients, [address(1), address(2)])
    assert.equal(result.contiguousFromDeployment, true)
    assert.equal(result.logCompleteness, 'not_independently_proven')
    assert.equal(result.throughBlock, 11)
    assert.deepEqual(verify({ out, config }).candidateRecipients, result.candidateRecipients)
    const name = readdirSync(out)[0]
    const record = JSON.parse(readFileSync(join(out, name)))
    assert.equal(record.providerAgreement, true)
    assert.equal(record.logs.length, 2)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('quiet range is sealed; gaps and modified segment bytes fail offline replay', async () => {
  const out = mkdtempSync(join(tmpdir(), 'share-quiet-'))
  try {
    const quiet = async (method, params) => (method === 'eth_getLogs' ? [] : rpc(method, params))
    await collect({
      out,
      config,
      rpcRead: quiet,
      peerRpcRead: quiet,
      stat,
      now: () => new Date(11_000),
    })
    assert.deepEqual(verify({ out, config }).candidateRecipients, [])
    const name = readdirSync(out)[0]
    writeFileSync(join(out, name), `${readFileSync(join(out, name), 'utf8')} `)
    assert.throws(() => verify({ out, config }), /share_source_hash_mismatch/)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('deployment proof, peer disagreement and disk floor fail closed', async () => {
  const out = mkdtempSync(join(tmpdir(), 'share-fail-'))
  try {
    const wrongDeployment = async (method, params) =>
      method === 'eth_getCode' && Number(BigInt(params[1].blockHash)) === 9
        ? '0x6001'
        : rpc(method, params)
    await assert.rejects(
      collect({ out, config, rpcRead: wrongDeployment, peerRpcRead: wrongDeployment, stat }),
      /deployment_code_invalid/,
    )
    const badPeer = async (method, params) => (method === 'eth_getLogs' ? [] : rpc(method, params))
    await assert.rejects(
      collect({ out, config, rpcRead: rpc, peerRpcRead: badPeer, stat }),
      /provider_logs_mismatch/,
    )
    await assert.rejects(
      collect({
        out,
        config,
        rpcRead: rpc,
        peerRpcRead: rpc,
        stat: () => ({ bavail: 1, bsize: 1 }),
      }),
      /disk_reserve_reached/,
    )
    assert.equal(readdirSync(out).length, 0)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

export { rpc, stat, config, address, logs, hash }

test('exclusive lock rejects a second collector until first seal and replay finish', async () => {
  const out = mkdtempSync(join(tmpdir(), 'share-lock-'))
  let entered
  let resume
  const reached = new Promise((done) => {
    entered = done
  })
  const gate = new Promise((done) => {
    resume = done
  })
  const slow = async (method, params) => {
    if (method === 'eth_getLogs') {
      entered()
      await gate
    }
    return rpc(method, params)
  }
  try {
    const first = collect({ out, config, rpcRead: slow, peerRpcRead: rpc, stat })
    await reached
    await assert.rejects(
      collect({ out, config, rpcRead: rpc, peerRpcRead: rpc, stat }),
      /share_source_lock_held/,
    )
    resume()
    assert.equal((await first).segments.length, 1)
    assert.equal(readdirSync(out).length, 1)
  } finally {
    resume?.()
    rmSync(out, { recursive: true, force: true })
  }
})

test('a stale lock fails closed without an RPC call or automatic unlink', async () => {
  const out = mkdtempSync(join(tmpdir(), 'share-stale-lock-'))
  const path = join(out, '.share-transfer-source.lock')
  let calls = 0
  const counted = async (method, params) => {
    calls++
    return rpc(method, params)
  }
  try {
    writeFileSync(
      path,
      JSON.stringify({
        pid: 999_999_999,
        startedAt: '2020-01-01T00:00:00.000Z',
        token: '00000000-0000-4000-8000-000000000001',
      }),
    )
    await assert.rejects(
      collect({ out, config, rpcRead: counted, peerRpcRead: counted, stat }),
      /share_source_lock_held/,
    )
    assert.equal(calls, 0)
    assert.equal(readdirSync(out).length, 1)
    assert.match(readFileSync(path, 'utf8'), /999999999/)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('dense log-bearing blocks fail before unbounded header reads; smaller window can proceed', async () => {
  const out = mkdtempSync(join(tmpdir(), 'share-dense-'))
  const dense = Array.from({ length: MAX_LOG_BLOCK_HEADERS + 1 }, (_, i) => ({
    ...logs[0],
    blockNumber: `0x${(10 + i).toString(16)}`,
    blockHash: hash(10 + i),
    transactionHash: hash(1000 + i),
  }))
  let calls = 0
  const denseRpc = async (method, params) => {
    calls++
    if (method === 'eth_getBlockByNumber')
      return header(params[0] === 'finalized' ? 74 : Number(BigInt(params[0])))
    if (method === 'eth_getLogs')
      return dense.filter(
        (log) =>
          Number(BigInt(log.blockNumber)) >= Number(BigInt(params[0].fromBlock)) &&
          Number(BigInt(log.blockNumber)) <= Number(BigInt(params[0].toBlock)),
      )
    return rpc(method, params)
  }
  try {
    await assert.rejects(
      collect({ out, config, rpcRead: denseRpc, peerRpcRead: denseRpc, stat }),
      /share_source_log_header_budget_exceeded/,
    )
    assert.ok(calls < 50, `unexpected ${calls} RPC calls before header-budget rejection`)
    assert.equal(readdirSync(out).length, 0)
    const result = await collect({
      out,
      config,
      rpcRead: denseRpc,
      peerRpcRead: denseRpc,
      stat,
      windowBlocks: 32,
    })
    assert.equal(result.throughBlock, 41)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('provider result at the log cap is rejected, even when providers agree', async () => {
  const out = mkdtempSync(join(tmpdir(), 'share-saturated-'))
  const saturated = Array.from({ length: MAX_LOGS }, (_, i) => ({
    ...logs[0],
    transactionHash: hash(1000 + i),
    logIndex: `0x${i.toString(16)}`,
  }))
  const capped = async (method, params) =>
    method === 'eth_getLogs' ? saturated : rpc(method, params)
  try {
    await assert.rejects(
      collect({ out, config, rpcRead: capped, peerRpcRead: capped, stat }),
      /share_source_log_bound_invalid/,
    )
    assert.equal(readdirSync(out).length, 0)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('the whole-run RPC budget stops a four-chunk dense replay without corrupting sealed prefix', async () => {
  const out = mkdtempSync(join(tmpdir(), 'share-request-budget-'))
  const dense = Array.from({ length: MAX_LOG_BLOCK_HEADERS * 4 }, (_, i) => ({
    ...logs[0],
    blockNumber: `0x${(10 + i).toString(16)}`,
    blockHash: hash(10 + i),
    transactionHash: hash(2000 + i),
  }))
  let calls = 0
  const denseRpc = async (method, params) => {
    calls++
    if (method === 'eth_getBlockByNumber')
      return header(params[0] === 'finalized' ? 265 : Number(BigInt(params[0])))
    if (method === 'eth_getLogs')
      return dense.filter(
        (log) =>
          Number(BigInt(log.blockNumber)) >= Number(BigInt(params[0].fromBlock)) &&
          Number(BigInt(log.blockNumber)) <= Number(BigInt(params[0].toBlock)),
      )
    return rpc(method, params)
  }
  try {
    await assert.rejects(
      collect({
        out,
        config,
        rpcRead: denseRpc,
        peerRpcRead: denseRpc,
        stat,
        maxChunks: 4,
        windowBlocks: 64,
      }),
      /share_source_request_budget_exceeded/,
    )
    assert.equal(calls, MAX_RPC_CALLS)
    assert.equal(verify({ out, config }).segments.length, 3)
    assert.equal(readdirSync(out).length, 3)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('RPC diagnostics name fixed side, stage and failure kind without leaking provider text', async () => {
  const secret = 'https://user:secret@example.invalid/rpc?token=hidden'
  const cases = [
    {
      side: 'primary',
      stage: 'chain',
      fails: (method) => method === 'eth_chainId',
      error: Object.assign(new Error(`HTTP status: 429 ${secret}`), { status: 429 }),
      kind: 'rate_limited',
    },
    {
      side: 'peer',
      stage: 'head',
      fails: (method, params) => method === 'eth_getBlockByNumber' && params[0] === 'finalized',
      error: Object.assign(new Error(secret), {
        cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
      }),
      kind: 'transport_failure',
    },
    {
      side: 'primary',
      stage: 'code',
      fails: (method) => method === 'eth_getCode',
      error: new Error(`blockHash is not supported ${secret}`),
      kind: 'block_reference_unsupported',
    },
    {
      side: 'peer',
      stage: 'code',
      fails: (method) => method === 'eth_getCode',
      error: new Error(`missing trie node ${secret}`),
      kind: 'historical_state_unavailable',
    },
    {
      side: 'primary',
      stage: 'logs',
      fails: (method) => method === 'eth_getLogs',
      error: Object.assign(new Error(secret), { code: -32005 }),
      kind: 'rate_limited',
    },
    {
      side: 'peer',
      stage: 'logs',
      fails: (method) => method === 'eth_getLogs',
      error: new Error(secret),
      kind: 'failure',
    },
  ]
  for (const scenario of cases) {
    const out = mkdtempSync(join(tmpdir(), 'share-rpc-diagnostic-'))
    try {
      const broken = async (method, params) => {
        if (scenario.fails(method, params)) throw scenario.error
        return rpc(method, params)
      }
      const primary = scenario.side === 'primary' ? broken : rpc
      const peer = scenario.side === 'peer' ? broken : rpc
      let caught
      try {
        await collect({ out, config, rpcRead: primary, peerRpcRead: peer, stat })
      } catch (error) {
        caught = error
      }
      assert.equal(
        caught?.message,
        `share_source_rpc_${scenario.side}_${scenario.stage}_${scenario.kind}`,
      )
      assert.equal(caught?.cause, undefined)
      assert.equal(readdirSync(out).length, 0)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  }
})

test('a failed later RPC read preserves the already sealed prefix and releases its lock', async () => {
  const out = mkdtempSync(join(tmpdir(), 'share-rpc-prefix-'))
  const extended = async (method, params) => {
    if (method === 'eth_getBlockByNumber' && params[0] === 'finalized') return header(12)
    return rpc(method, params)
  }
  try {
    await collect({ out, config, rpcRead: rpc, peerRpcRead: rpc, stat })
    const before = readdirSync(out)
    const failed = async (method, params) => {
      if (method === 'eth_getLogs')
        throw Object.assign(new Error('private provider response'), { status: 429 })
      return extended(method, params)
    }
    await assert.rejects(
      collect({ out, config, rpcRead: failed, peerRpcRead: extended, stat }),
      /share_source_rpc_primary_logs_rate_limited/,
    )
    assert.deepEqual(readdirSync(out), before)
    assert.equal(verify({ out, config }).throughBlock, 11)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})
