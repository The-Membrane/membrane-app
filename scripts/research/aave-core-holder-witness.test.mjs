import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MARKETS, POOL } from './aave-core-forward-panel.mjs'
import {
  LOOKBACK_BLOCKS,
  MAX_LOGS_PER_MARKET,
  QUOTE_RAW,
  CANDIDATE_POLICY,
  collectBaseline,
  plan,
  rankRecipients,
  readCheckpoint,
  readPoolImplementation,
  run,
  sentinelReason,
} from './aave-core-holder-witness.mjs'

const H = (n) => `0x${n.toString(16).padStart(64, '0')}`
const A = (n) => `0x${n.toString(16).padStart(40, '0')}`
const AT = 1_700_000_000
const NOW = (AT + 100) * 1000
const BLOCK = 5000
const transfer = (market, from, to, value, id = 0) => ({
  address: market.aToken,
  blockNumber: from,
  blockHash: H(5),
  transactionHash: H(id + 10),
  logIndex: BigInt(id),
  removed: false,
  args: { from: A(0), to, value },
})

test('daily Pool implementation identity is read at the canonical baseline hash', async () => {
  const requests = []
  const identity = await readPoolImplementation(
    {
      async request({ method, params }) {
        requests.push({ method, params })
        if (method === 'eth_getStorageAt') return `0x${'0'.repeat(24)}${A(76).slice(2)}`
        if (method === 'eth_getCode') return '0x6000'
        throw new Error('Unexpected RPC')
      },
    },
    H(BLOCK),
    () => {},
    '/tmp/witness-identity-test.json',
  )
  assert.equal(identity.status, 'observed')
  assert.equal(identity.address, A(76))
  assert.ok(requests.every((request) => request.params.at(-1).blockHash === H(BLOCK)))
  assert.ok(requests.every((request) => request.params.at(-1).requireCanonical === true))
  assert.deepEqual(
    requests.map((request) => request.method),
    ['eth_getStorageAt', 'eth_getCode'],
  )
})

test('disk failure before either pinned implementation RPC is fatal, not unknown', async () => {
  for (const failAt of [1, 2]) {
    let guards = 0
    await assert.rejects(
      readPoolImplementation(
        {
          async request({ method }) {
            if (method === 'eth_getStorageAt') return `0x${'0'.repeat(24)}${A(76).slice(2)}`
            return '0x6000'
          },
        },
        H(BLOCK),
        () => {
          if (++guards === failAt) throw new Error('Disk reserve reached')
        },
        '/tmp/witness-identity-disk-test.json',
      ),
      /Disk reserve reached/,
    )
  }
})
function fixture({
  logs = true,
  overBudget = false,
  wrongAToken = false,
  reorg = false,
  priorReorg = false,
  withdrawRevert = false,
  withdrawRpcError = false,
  noHolder = false,
  code = undefined,
  missingCodeAt = null,
  duplicateLog = false,
  removedLog = false,
  missingLogIdentity = false,
  block = BLOCK,
  recipientAddresses = null,
  withPoolIdentity = false,
} = {}) {
  const calls = []
  let anchorReads = 0
  const client = {
    async getChainId() {
      calls.push('chain')
      return 1
    },
    async getBlockNumber() {
      calls.push('head')
      return BigInt(block + 64)
    },
    async getBlock({ blockNumber }) {
      calls.push(`block:${blockNumber}`)
      if (blockNumber === BigInt(block)) anchorReads++
      const altered = (reorg && anchorReads === 2) || (priorReorg && blockNumber === BigInt(BLOCK))
      return { hash: H(altered ? 2 : 1), timestamp: BigInt(AT) }
    },
    async readContract({ address, functionName, args, blockNumber }) {
      calls.push(`${functionName}:${blockNumber}`)
      if (blockNumber !== BigInt(block)) throw new Error('Unpinned contract read')
      if (functionName === 'getReserveData') {
        const market = MARKETS.find((m) => m.base.toLowerCase() === args[0].toLowerCase())
        return {
          aTokenAddress: wrongAToken && market.name === 'USDT' ? A(99) : market.aToken,
          configuration: { data: 6n << 48n },
        }
      }
      if (functionName === 'decimals') return 6
      if (functionName === 'balanceOf') return noHolder ? QUOTE_RAW - 1n : QUOTE_RAW + 1n
      throw new Error(`Unexpected ${functionName} at ${address}`)
    },
    async getLogs({ address, fromBlock, toBlock }) {
      calls.push(`logs:${address}:${fromBlock}:${toBlock}`)
      if (toBlock - fromBlock !== 499n) throw new Error('Bad chunk span')
      if (!logs) return []
      const market = MARKETS.find((m) => m.aToken.toLowerCase() === address.toLowerCase())
      if (overBudget && fromBlock === BigInt(block - LOOKBACK_BLOCKS))
        return Array.from({ length: MAX_LOGS_PER_MARKET + 1 }, (_, i) =>
          transfer(market, fromBlock, A(i + 1), BigInt(i + 1), i),
        )
      if (fromBlock !== BigInt(block - LOOKBACK_BLOCKS)) return []
      if (recipientAddresses)
        return recipientAddresses.map((address, i) =>
          transfer(market, fromBlock, address, QUOTE_RAW + BigInt(10 - i), i),
        )
      const row = transfer(market, fromBlock, A(256), QUOTE_RAW + 10n)
      if (removedLog) row.removed = true
      if (missingLogIdentity) row.transactionHash = null
      return duplicateLog ? [row, { ...row }] : [row]
    },
    async getCode({ address, blockNumber }) {
      calls.push(`code:${address}:${blockNumber}`)
      if (blockNumber !== BigInt(block)) throw new Error('Unpinned code read')
      if (address.toLowerCase() === String(missingCodeAt).toLowerCase()) return undefined
      if (
        [POOL, ...MARKETS.flatMap((market) => [market.base, market.aToken])]
          .map((item) => item.toLowerCase())
          .includes(address.toLowerCase())
      )
        return '0x6000'
      return code
    },
    async call({ account, to, data, blockNumber }) {
      calls.push(`call:${account}:${blockNumber}`)
      if (blockNumber !== BigInt(block) || to !== POOL || !data.startsWith('0x69328dec'))
        throw new Error('Malformed withdraw call')
      if (withdrawRevert) {
        const error = new Error('execution reverted')
        error.name = 'ExecutionRevertedError'
        throw error
      }
      if (withdrawRpcError) throw new Error('connection reset')
      return { data: H(QUOTE_RAW) }
    },
    ...(withPoolIdentity
      ? {
          async request({ method, params }) {
            calls.push(`request:${method}`)
            assert.deepEqual(params.at(-1), { blockHash: H(1), requireCanonical: true })
            if (method === 'eth_getStorageAt') return `0x${'0'.repeat(24)}${A(76).slice(2)}`
            if (method === 'eth_getCode') return '0x6000'
            throw new Error('Unexpected identity RPC')
          },
        }
      : {}),
  }
  return { client, calls }
}
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aave-holder-witness-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'baseline.json')
}

test('dry plan does not read RPC or write a checkpoint', (t) => {
  const out = temp(t)
  assert.equal(plan(out).status, 'dry-only')
  assert.equal(existsSync(out), false)
})

test('daily run seals an observed B Pool implementation for future outcome comparison', async (t) => {
  const out = temp(t)
  const { client, calls } = fixture({ withPoolIdentity: true })
  await run({ client, out, checkDisk: () => {}, now: () => NOW })
  const saved = readCheckpoint(out)
  assert.equal(saved.baselines[0].poolImplementation.status, 'observed')
  assert.equal(saved.baselines[0].poolImplementation.address, A(76))
  assert.ok(calls.includes('request:eth_getStorageAt'))
  assert.ok(calls.includes('request:eth_getCode'))
})

test('future baseline seals local capture start before its first RPC and legacy rows keep start unknown', async (t) => {
  const out = temp(t)
  const { client } = fixture()
  let ticks = 0
  const originalChainId = client.getChainId
  client.getChainId = async (...args) => {
    assert.equal(ticks, 1)
    return originalChainId(...args)
  }
  await run({
    client,
    out,
    checkDisk: () => {},
    now: () => (++ticks === 1 ? NOW - 5000 : NOW),
  })
  const row = readCheckpoint(out).baselines[0]
  assert.equal(row.captureStartedAtMs, NOW - 5000)
  assert.equal(row.observedAtMs, NOW)

  const sealed = JSON.parse(readFileSync(out, 'utf8'))
  sealed.payload.baselines[0].captureStartedAtMs = NOW + 1
  const withoutHash = { ...sealed.payload.baselines[0], rowSha256: undefined }
  sealed.payload.baselines[0].rowSha256 = createHash('sha256')
    .update(JSON.stringify(withoutHash))
    .digest('hex')
  sealed.sha256 = createHash('sha256').update(JSON.stringify(sealed.payload)).digest('hex')
  writeFileSync(out, JSON.stringify(sealed))
  assert.throws(() => readCheckpoint(out), /row chain mismatch/)

  const legacy = readCheckpoint('data/research/venue-signals/aave-core-holder-witness-v1.json')
  assert.equal(legacy.baselines[0].captureStartedAtMs, undefined)
})

test('append capture start precedes its previous-block canonical RPC', async (t) => {
  const out = temp(t)
  await run({ client: fixture().client, out, checkDisk: () => {}, now: () => NOW })
  const { client } = fixture({ block: BLOCK + 1 })
  let ticks = 0
  const originalGetBlock = client.getBlock
  client.getBlock = async (args) => {
    if (args.blockNumber === BigInt(BLOCK)) assert.equal(ticks, 1)
    return originalGetBlock(args)
  }
  await run({
    client,
    out,
    checkDisk: () => {},
    now: () => (++ticks === 1 ? NOW + 1000 : NOW + 2000),
  })
  assert.equal(readCheckpoint(out).baselines[1].captureStartedAtMs, NOW + 1000)
})

test('direct collector ignores caller-provided capture start and samples its own clock', async (t) => {
  const out = temp(t)
  const { client } = fixture()
  let ticks = 0
  const originalChainId = client.getChainId
  client.getChainId = async (...args) => {
    assert.equal(ticks, 1)
    return originalChainId(...args)
  }
  const row = await collectBaseline({
    client,
    out,
    checkDisk: () => {},
    captureStartedAtMs: NOW - 60_000,
    now: () => (++ticks === 1 ? NOW - 1000 : NOW),
  })
  assert.equal(row.captureStartedAtMs, NOW - 1000)
  assert.equal(row.observedAtMs, NOW)
})

test('rank uses largest incoming amount, then address ascending, without replacing candidates', () => {
  const market = MARKETS[0]
  const rows = [
    transfer(market, 1n, A(3), 5n),
    transfer(market, 1n, A(2), 10n),
    transfer(market, 1n, A(1), 10n),
    transfer(market, 1n, A(3), 20n),
  ]
  assert.deepEqual(
    rankRecipients(rows).map((x) => x.address),
    [A(3), A(1), A(2)],
  )
})

test('sentinels stay in the candidate denominator but never reach balance/code/withdraw', async (t) => {
  const dead = `0x${'0'.repeat(36)}dead`
  assert.equal(sentinelReason(A(0)), 'zero-address')
  assert.equal(sentinelReason(dead), 'dead-address')
  assert.equal(sentinelReason(A(1)), 'low-reserved-address')
  assert.equal(sentinelReason(A(255)), 'low-reserved-address')
  assert.equal(sentinelReason(A(256)), null)
  const out = temp(t)
  const recipients = [A(0), dead, A(1), A(256)]
  const { client, calls } = fixture({ recipientAddresses: recipients })
  const result = await run({ client, out, now: () => NOW, checkDisk: () => {} })
  assert.deepEqual(
    result.markets.map((market) => market.candidates),
    [4, 4],
  )
  assert.deepEqual(
    result.markets.map((market) => market.qualifyingHolders),
    [1, 1],
  )
  const baseline = readCheckpoint(out).baselines[0]
  assert.equal(baseline.candidatePolicy, CANDIDATE_POLICY)
  for (const market of baseline.markets) {
    assert.deepEqual(
      market.candidates.map((candidate) => candidate.withdraw),
      ['excluded-sentinel', 'excluded-sentinel', 'excluded-sentinel', 'success'],
    )
    assert.deepEqual(
      market.candidates.slice(0, 3).map((candidate) => candidate.exclusionReason),
      ['zero-address', 'dead-address', 'low-reserved-address'],
    )
    assert.deepEqual(
      market.candidates.slice(0, 3).map((candidate) => candidate.codeStatus),
      [null, null, null],
    )
  }
  assert.equal(calls.filter((call) => call.startsWith('balanceOf:')).length, 2)
  assert.equal(calls.filter((call) => call.startsWith('call:')).length, 2)
  for (const candidate of recipients.slice(0, 3))
    assert.ok(
      !calls.some(
        (call) => call.startsWith(`code:${candidate}:`) || call.startsWith(`call:${candidate}:`),
      ),
    )
})

test('sealed Sep 26 baseline keeps its original four selected witnesses and policy', () => {
  const frozen = readCheckpoint('data/research/venue-signals/aave-core-holder-witness-v1.json')
  const row = frozen.baselines.find((baseline) => baseline.block === 26_059_143)
  assert.ok(row)
  assert.equal(row.candidatePolicy, undefined)
  assert.deepEqual(
    row.markets.map((market) => market.qualifyingHolders),
    [
      [
        '0x56957e411ea83a0b4a0689c1fb0d1e5ea0d20149',
        '0x86fe2c68b631a19fa9722dfc0625338a6c02d26b',
        '0xd3768e1460781d1f1ee3d694601b765031caffb3',
      ],
      ['0x247f08d1f3b01b0a84fd6e417570ae49d0951770'],
    ],
  )
  assert.ok(
    row.markets.every((market) =>
      market.qualifyingHolders.every((holder) => !sentinelReason(holder)),
    ),
  )
})

test('pinned 2,000-block baseline seals every candidate and exact withdraw call', async (t) => {
  const out = temp(t)
  const { client, calls } = fixture()
  let diskChecks = 0
  const result = await run({ client, out, now: () => NOW, checkDisk: () => diskChecks++ })
  assert.equal(result.block, BLOCK)
  assert.deepEqual(
    result.markets.map((m) => m.qualifyingHolders),
    [1, 1],
  )
  assert.equal(calls.filter((x) => x.startsWith('logs:')).length, 8)
  assert.ok(diskChecks >= calls.length + 2)
  const data = readCheckpoint(out)
  assert.equal(data.baselines.length, 1)
  assert.equal(data.baselines[0].markets[0].transferWindow.fromBlock, BLOCK - LOOKBACK_BLOCKS)
  assert.equal(data.baselines[0].markets[0].transferWindow.toBlock, BLOCK - 1)
  assert.equal(data.baselines[0].markets[0].candidates[0].withdraw, 'success')
  assert.match(data.baselines[0].poolCodeHash, /^0x[0-9a-f]{64}$/)
  assert.match(data.baselines[0].markets[0].underlyingCodeHash, /^0x[0-9a-f]{64}$/)
  assert.match(data.baselines[0].markets[0].aTokenCodeHash, /^0x[0-9a-f]{64}$/)
  assert.match(data.baselines[0].markets[0].transferLogSha256, /^[0-9a-f]{64}$/)
  assert.deepEqual(data.baselines[0].markets[0].qualifyingHolders, [A(256)])
})

test('zero qualifying holders is a retained feasibility result', async (t) => {
  const out = temp(t)
  await run({
    client: fixture({ noHolder: true }).client,
    out,
    now: () => NOW,
    checkDisk: () => {},
  })
  const rows = readCheckpoint(out).baselines[0].markets
  assert.deepEqual(
    rows.map((x) => x.qualifyingHolders.length),
    [0, 0],
  )
  assert.deepEqual(
    rows.map((x) => x.candidates[0].withdraw),
    ['excluded-below-quote', 'excluded-below-quote'],
  )
})

test('contract holders are explicitly excluded, not silently dropped', async (t) => {
  const out = temp(t)
  await run({
    client: fixture({ code: '0x6000' }).client,
    out,
    now: () => NOW,
    checkDisk: () => {},
  })
  assert.equal(
    readCheckpoint(out).baselines[0].markets[0].candidates[0].withdraw,
    'excluded-contract',
  )
})

test('execution revert and transport failure stay separate in candidate ledger', async (t) => {
  const revertOut = temp(t)
  await run({
    client: fixture({ withdrawRevert: true }).client,
    out: revertOut,
    now: () => NOW,
    checkDisk: () => {},
  })
  assert.equal(readCheckpoint(revertOut).baselines[0].markets[0].candidates[0].withdraw, 'revert')
  const rpcOut = temp(t)
  await run({
    client: fixture({ withdrawRpcError: true }).client,
    out: rpcOut,
    now: () => NOW,
    checkDisk: () => {},
  })
  assert.equal(readCheckpoint(rpcOut).baselines[0].markets[0].candidates[0].withdraw, 'rpc-error')
})

test('disk guard failure during candidate balance/code/withdraw is fatal, even if disk recovers', async (t) => {
  for (const stage of ['balance', 'code', 'withdraw']) {
    const out = temp(t)
    const { client, calls } = fixture()
    let failed = false
    const checkDisk = () => {
      const last = calls.at(-1) || ''
      const atStage =
        (stage === 'balance' &&
          calls.filter((call) => call.startsWith('logs:')).length === 4 &&
          last.startsWith('logs:')) ||
        (stage === 'code' && last.startsWith('balanceOf:')) ||
        (stage === 'withdraw' && last.startsWith(`code:${A(256)}:`))
      if (!failed && atStage) {
        failed = true
        throw new Error('Disk reserve below 1 GiB')
      }
    }
    await assert.rejects(
      run({ client, out, now: () => NOW, checkDisk }),
      /Disk reserve check failed/,
    )
    assert.equal(failed, true, `guard did not trip at ${stage}`)
    assert.equal(existsSync(out), false, `${stage} failure wrote an incomplete baseline`)
  }
})

test('over-ceiling logs do not silently truncate or write a partial checkpoint', async (t) => {
  const out = temp(t)
  await assert.rejects(
    run({ client: fixture({ overBudget: true }).client, out, now: () => NOW, checkDisk: () => {} }),
    /ceiling exceeded/,
  )
  assert.equal(existsSync(out), false)
})

test('identity mismatch and pinned reorg fail without checkpoint', async (t) => {
  const out = temp(t)
  await assert.rejects(
    run({
      client: fixture({ wrongAToken: true }).client,
      out,
      now: () => NOW,
      checkDisk: () => {},
    }),
    /aToken identity mismatch/,
  )
  assert.equal(existsSync(out), false)
  await assert.rejects(
    run({ client: fixture({ reorg: true }).client, out, now: () => NOW, checkDisk: () => {} }),
    /reorganization/,
  )
  assert.equal(existsSync(out), false)
})

test('Pool and underlying/aToken must have deployed code at the anchor', async (t) => {
  for (const address of [POOL, MARKETS[0].base, MARKETS[0].aToken]) {
    const out = temp(t)
    await assert.rejects(
      run({
        client: fixture({ missingCodeAt: address }).client,
        out,
        now: () => NOW,
        checkDisk: () => {},
      }),
      /missing deployed code/,
    )
    assert.equal(existsSync(out), false)
  }
})

test('removed, missing-identity, and duplicate Transfer logs fail closed', async (t) => {
  for (const option of ['removedLog', 'missingLogIdentity', 'duplicateLog']) {
    const out = temp(t)
    await assert.rejects(
      run({ client: fixture({ [option]: true }).client, out, now: () => NOW, checkDisk: () => {} }),
      /Transfer log/,
    )
    assert.equal(existsSync(out), false)
  }
})

test('append rechecks previous block hash; tampered SHA and protocol reject', async (t) => {
  const out = temp(t)
  await run({ client: fixture().client, out, now: () => NOW, checkDisk: () => {} })
  const before = readFileSync(out, 'utf8')
  await assert.rejects(
    run({
      client: fixture({ block: BLOCK + 1, priorReorg: true }).client,
      out,
      now: () => NOW + 1000,
      checkDisk: () => {},
    }),
    /no longer canonical/,
  )
  assert.equal(readFileSync(out, 'utf8'), before)
  const saved = JSON.parse(before)
  saved.payload.protocol.maxCandidates = 101
  writeFileSync(out, JSON.stringify(saved))
  assert.throws(() => readCheckpoint(out), /SHA mismatch/)
  saved.sha256 = createHash('sha256').update(JSON.stringify(saved.payload)).digest('hex')
  writeFileSync(out, JSON.stringify(saved))
  assert.throws(() => readCheckpoint(out), /identity mismatch/)
})

test('empty transfer window records no candidates and no fabricated holder', async (t) => {
  const out = temp(t)
  const sample = await collectBaseline({
    client: fixture({ logs: false }).client,
    out,
    now: () => NOW,
    checkDisk: () => {},
  })
  assert.equal(sample.markets[0].transferWindow.logs, 0)
  assert.deepEqual(sample.markets[0].candidates, [])
})
