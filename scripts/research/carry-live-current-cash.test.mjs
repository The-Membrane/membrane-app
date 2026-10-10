import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSubjectManifest } from '../record-carry-cash-issues.mjs'
import { readConfiguredLiveCurrentCash, readLiveCurrentCash } from './carry-live-current-cash.mjs'

const MANIFEST = await buildSubjectManifest()
const VAULT = MANIFEST.subjects.find(
  (subject) =>
    subject.source_kind === 'vault' &&
    subject.asset === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
)
const DIRECT = MANIFEST.subjects.find((subject) => subject.source_kind === 'market')
const NOW_MS = Date.parse('2026-10-04T12:00:00.000Z')
const BLOCK_AT_SECONDS = BigInt((NOW_MS - 60_000) / 1000)
const H = (number) => `0x${number.toString(16).padStart(64, '0')}`
const head = (number, hash = H(number)) => ({
  number,
  hash,
  timestamp: BLOCK_AT_SECONDS,
})

function makePair({ changedAfter = false, alternatePinnedHash = false, chainIds = [1, 1] } = {}) {
  const calls = [[], []]
  const clients = [100n, 101n].map((finalizedNumber, index) => {
    let pinnedReads = 0
    return {
      getChainId: async () => chainIds[index],
      getBlock: async (args) => {
        calls[index].push(args)
        if (args.blockTag === 'finalized') return head(finalizedNumber)
        pinnedReads++
        const hash =
          index === 1 && alternatePinnedHash
            ? H(999n)
            : changedAfter && index === 1 && pinnedReads === 2
              ? H(998n)
              : H(100n)
        return head(args.blockNumber, hash)
      },
      writeContract: async () => {
        throw new Error('write_must_never_run')
      },
      sendTransaction: async () => {
        throw new Error('write_must_never_run')
      },
    }
  })
  return {
    origins: clients.map((client, i) => ({ url: `https://cash-${i}.example/private-key`, client })),
    calls,
    clients,
  }
}

const observed = (subject, cashRaw = '123456789') => ({
  state: 'observed',
  reason: null,
  asset: subject.asset,
  shareDecimals: 18,
  assetDecimals: 6,
  cashRaw,
})

function query(subject = VAULT) {
  return { routeKey: subject.route_key, destination: subject.destination }
}

test('fresh live cash binds one exact frozen subject to two stable finalized origins without writes', async () => {
  const { origins, calls } = makePair()
  const visited = []
  const result = await readLiveCurrentCash(query(), {
    origins,
    manifest: MANIFEST,
    clock: () => NOW_MS,
    readVault: async (client, destination, blockNumber) => {
      visited.push({ client, destination, blockNumber })
      return observed(VAULT)
    },
  })
  assert.deepEqual(result, {
    status: 'available',
    routeKey: VAULT.route_key,
    destination: VAULT.destination,
    asset: VAULT.asset,
    assetDecimals: 6,
    cashRaw: '123456789',
    block: '100',
    blockHash: H(100n),
    blockAt: new Date(Number(BLOCK_AT_SECONDS) * 1000).toISOString(),
    readAtUtc: new Date(NOW_MS).toISOString(),
    sourceKind: 'live_read_only_two_origin_finalized',
  })
  assert.equal(visited.length, 2)
  assert.ok(
    visited.every(
      ({ destination, blockNumber }) => destination === VAULT.destination && blockNumber === 100n,
    ),
  )
  assert.ok(calls.every((rows) => rows.length === 3))
  assert.ok(calls.every((rows) => rows.slice(1).every((row) => row.blockNumber === 100n)))
  assert.ok(!JSON.stringify(result).includes('private-key'))
  assert.equal(Object.hasOwn(result, 'firstLocalReceiptAt'), false)
})

test('direct cash uses the exact configured market identity and fixed decimals', async () => {
  const { origins } = makePair()
  let seen = 0
  const result = await readLiveCurrentCash(query(DIRECT), {
    origins,
    manifest: MANIFEST,
    clock: () => NOW_MS,
    readDirect: async (_client, market, blockNumber) => {
      assert.equal(market.routeKey, DIRECT.route_key)
      assert.equal(market.destination.toLowerCase(), DIRECT.destination)
      assert.equal(market.underlying.toLowerCase(), DIRECT.asset)
      assert.equal(blockNumber, 100n)
      seen++
      return { ...observed(DIRECT), shareDecimals: market.decimals, assetDecimals: market.decimals }
    },
  })
  assert.equal(result.status, 'available')
  assert.equal(seen, 2)
  assert.equal(result.assetDecimals, 6)
})

test('wrong chain, nonfrozen identity, and asset mismatch fail before state reads', async () => {
  let reads = 0
  const options = {
    manifest: MANIFEST,
    clock: () => NOW_MS,
    readVault: async () => {
      reads++
      return observed(VAULT)
    },
  }
  assert.deepEqual(
    await readLiveCurrentCash(
      { ...query(), asset: '0x0000000000000000000000000000000000000001' },
      { ...options, origins: makePair().origins },
    ),
    { status: 'unavailable', reason: 'subject_not_frozen' },
  )
  assert.deepEqual(
    await readLiveCurrentCash(
      { ...query(), routeKey: 'not a frozen route' },
      { ...options, origins: makePair().origins },
    ),
    { status: 'unavailable', reason: 'subject_not_frozen' },
  )
  assert.deepEqual(
    await readLiveCurrentCash(query(), {
      ...options,
      origins: makePair({ chainIds: [1, 10] }).origins,
    }),
    { status: 'unavailable', reason: 'wrong_chain' },
  )
  assert.equal(reads, 0)
})

test('cash, decimals, and pinned headers must agree across origins', async () => {
  const base = { manifest: MANIFEST, clock: () => NOW_MS }
  let cashReads = 0
  const mismatch = await readLiveCurrentCash(query(), {
    ...base,
    origins: makePair().origins,
    readVault: async () => observed(VAULT, cashReads++ === 0 ? '1' : '2'),
  })
  assert.deepEqual(mismatch, { status: 'unavailable', reason: 'cash_origin_disagreement' })

  let count = 0
  const decimals = await readLiveCurrentCash(query(), {
    ...base,
    origins: makePair().origins,
    readVault: async () => ({ ...observed(VAULT), assetDecimals: count++ === 0 ? 6 : 18 }),
  })
  assert.deepEqual(decimals, { status: 'unavailable', reason: 'cash_origin_disagreement' })

  const divergent = await readLiveCurrentCash(query(), {
    ...base,
    origins: makePair({ alternatePinnedHash: true }).origins,
    readVault: async () => observed(VAULT),
  })
  assert.deepEqual(divergent, { status: 'unavailable', reason: 'finalized_block_disagreement' })
  const changed = await readLiveCurrentCash(query(), {
    ...base,
    origins: makePair({ changedAfter: true }).origins,
    readVault: async () => observed(VAULT),
  })
  assert.deepEqual(changed, { status: 'unavailable', reason: 'pinned_header_changed' })
})

test('state identity, missing reads, and stale or future finalized clocks are unavailable', async () => {
  const options = { origins: makePair().origins, manifest: MANIFEST }
  const identity = await readLiveCurrentCash(query(), {
    ...options,
    clock: () => NOW_MS,
    readVault: async () => ({
      ...observed(VAULT),
      asset: '0x0000000000000000000000000000000000000001',
    }),
  })
  assert.deepEqual(identity, { status: 'unavailable', reason: 'cash_identity_mismatch' })
  const missing = await readLiveCurrentCash(query(), {
    ...options,
    clock: () => NOW_MS,
    readVault: async () => ({ state: 'read_unavailable', reason: 'archive_state_read_failed' }),
  })
  assert.deepEqual(missing, { status: 'unavailable', reason: 'cash_state_unavailable' })
  const stale = await readLiveCurrentCash(query(), {
    ...options,
    clock: () => NOW_MS + 2 * 60 * 60 * 1000 + 1,
    readVault: async () => observed(VAULT),
  })
  assert.deepEqual(stale, { status: 'unavailable', reason: 'finalized_block_stale' })
  const future = await readLiveCurrentCash(query(), {
    ...options,
    clock: () => NOW_MS - 4 * 60 * 1000,
    readVault: async () => observed(VAULT),
  })
  assert.deepEqual(future, { status: 'unavailable', reason: 'finalized_clock_invalid' })
})

test('configured reader rejects one host and caches only available reads with in-flight dedupe', async () => {
  let clientFactoryCalls = 0
  const failed = await readConfiguredLiveCurrentCash(query(), {
    rpcUrls: 'https://same.example/key-a,https://same.example/key-b',
    clientFactory: () => {
      clientFactoryCalls++
      return makePair().clients[0]
    },
  })
  assert.deepEqual(failed, { status: 'unavailable', reason: 'rpc_origins_unavailable' })
  assert.equal(clientFactoryCalls, 0)
  const malformed = await readConfiguredLiveCurrentCash(query(), {
    rpcUrls: 'not-a-url,https://same.example/key-a',
    clientFactory: () => {
      clientFactoryCalls++
      return makePair().clients[0]
    },
  })
  assert.deepEqual(malformed, { status: 'unavailable', reason: 'rpc_origins_unavailable' })
  assert.equal(clientFactoryCalls, 0)

  let nowMs = NOW_MS
  let reads = 0
  const clients = makePair().clients
  const cacheOptions = {
    rpcUrls: 'https://cache-first.example/key-a,https://cache-second.example/key-b',
    clientFactory: (url) => (url.includes('first') ? clients[0] : clients[1]),
    manifest: MANIFEST,
    clock: () => nowMs,
    readVault: async () => {
      reads++
      return observed(VAULT)
    },
    cache: true,
  }
  const [one, two] = await Promise.all([
    readConfiguredLiveCurrentCash(query(), cacheOptions),
    readConfiguredLiveCurrentCash(query(), cacheOptions),
  ])
  assert.equal(one.status, 'available')
  assert.deepEqual(two, one)
  assert.equal(reads, 2)
  assert.equal((await readConfiguredLiveCurrentCash(query(), cacheOptions)).status, 'available')
  assert.equal(reads, 2)
  const mutatedManifest = {
    ...MANIFEST,
    subjects: JSON.parse(JSON.stringify(MANIFEST.subjects)),
  }
  mutatedManifest.subjects[0].asset = '0x0000000000000000000000000000000000000001'
  assert.deepEqual(
    await readConfiguredLiveCurrentCash(query(), { ...cacheOptions, manifest: mutatedManifest }),
    { status: 'unavailable', reason: 'subject_manifest_unavailable' },
  )
  assert.equal(reads, 2)
  nowMs += 5 * 60 * 1000 + 1
  assert.equal((await readConfiguredLiveCurrentCash(query(), cacheOptions)).status, 'available')
  assert.equal(reads, 4)
})

test('provider errors never expose credential-bearing messages', async () => {
  const { origins } = makePair()
  origins[1].client.getBlock = async () => {
    throw new Error('https://secret.example/key/private')
  }
  const result = await readLiveCurrentCash(query(), { origins, manifest: MANIFEST })
  assert.deepEqual(result, { status: 'unavailable', reason: 'finalized_head_unavailable' })
  assert.equal(JSON.stringify(result).includes('secret.example'), false)
})

test('cache hit rechecks the finalized block age before the five-minute TTL expires', async () => {
  let nowMs = NOW_MS + 118 * 60 * 1000
  let reads = 0
  const clients = makePair().clients
  const options = {
    rpcUrls: 'https://age-first.example/key-a,https://age-second.example/key-b',
    clientFactory: (url) => (url.includes('first') ? clients[0] : clients[1]),
    manifest: MANIFEST,
    clock: () => nowMs,
    readVault: async () => {
      reads++
      return observed(VAULT)
    },
    cache: true,
  }
  assert.equal((await readConfiguredLiveCurrentCash(query(), options)).status, 'available')
  assert.equal(reads, 2)
  nowMs += 2 * 60 * 1000
  assert.deepEqual(await readConfiguredLiveCurrentCash(query(), options), {
    status: 'unavailable',
    reason: 'finalized_block_stale',
  })
  assert.equal(reads, 4)
})

test('configured transient failures never poison the live cache', async () => {
  let reads = 0
  const clients = makePair().clients
  const options = {
    rpcUrls: 'https://retry-first.example/key-a,https://retry-second.example/key-b',
    clientFactory: (url) => (url.includes('first') ? clients[0] : clients[1]),
    manifest: MANIFEST,
    clock: () => NOW_MS,
    readVault: async () => {
      reads++
      return reads <= 2 ? { state: 'read_unavailable', reason: 'temporary' } : observed(VAULT)
    },
    cache: true,
  }
  assert.deepEqual(await readConfiguredLiveCurrentCash(query(), options), {
    status: 'unavailable',
    reason: 'cash_state_unavailable',
  })
  assert.equal((await readConfiguredLiveCurrentCash(query(), options)).status, 'available')
  assert.equal(reads, 4)
})

test('source age policy rejects invalid primitive/options before any RPC and retains default two hours', async () => {
  let calls = 0
  const clients = makePair().clients.map((client) => ({
    ...client,
    getChainId: async () => {
      calls++
      return 1
    },
  }))
  const origins = clients.map((client, index) => ({
    client,
    url: `https://policy-${index}.example/key`,
  }))
  for (const maxSourceAgeMs of [
    null,
    false,
    '900000',
    [900000],
    {},
    new Number(900000),
    0,
    -1,
    0.1,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    7200001,
  ]) {
    assert.deepEqual(
      await readLiveCurrentCash(query(), { origins, manifest: MANIFEST, maxSourceAgeMs }),
      { status: 'unavailable', reason: 'source_age_policy_invalid' },
    )
    assert.deepEqual(
      await readConfiguredLiveCurrentCash(query(), {
        maxSourceAgeMs,
        clientFactory: () => {
          calls++
          throw Error('must_not_construct_provider')
        },
      }),
      { status: 'unavailable', reason: 'source_age_policy_invalid' },
    )
  }
  assert.equal(calls, 0)
  const options = {
    origins,
    manifest: MANIFEST,
    clock: () => Number(BLOCK_AT_SECONDS) * 1000 + 7200000,
    readVault: async () => observed(VAULT),
  }
  assert.equal((await readLiveCurrentCash(query(), options)).status, 'available')
  assert.equal(
    (await readLiveCurrentCash(query(), { ...options, maxSourceAgeMs: 7200000 })).status,
    'available',
  )
})

test('strict age allows exactly900000ms and rejects900001ms at completion including time spent reading', async () => {
  const blockMs = Number(BLOCK_AT_SECONDS) * 1000
  let nowMs = blockMs + 900000
  const options = {
    origins: makePair().origins,
    manifest: MANIFEST,
    clock: () => nowMs,
    maxSourceAgeMs: 900000,
    readVault: async () => observed(VAULT),
  }
  assert.equal((await readLiveCurrentCash(query(), options)).status, 'available')
  nowMs += 1
  assert.deepEqual(await readLiveCurrentCash(query(), options), {
    status: 'unavailable',
    reason: 'finalized_block_stale',
  })
  nowMs = blockMs + 899999
  assert.deepEqual(
    await readLiveCurrentCash(query(), {
      ...options,
      readVault: async () => {
        nowMs = blockMs + 900001
        return observed(VAULT)
      },
    }),
    { status: 'unavailable', reason: 'finalized_block_stale' },
  )
})

test('strict cached source crossing15min invalidates inside five-minute TTL and performs a bounded fresh read', async () => {
  let nowMs = Number(BLOCK_AT_SECONDS) * 1000 + 14 * 60000,
    reads = 0,
    factories = 0
  const clients = makePair().clients
  const options = {
    rpcUrls: 'https://strict-age-first.example/key-a,https://strict-age-second.example/key-b',
    clientFactory: (url) => {
      factories++
      return url.includes('first') ? clients[0] : clients[1]
    },
    manifest: MANIFEST,
    clock: () => nowMs,
    maxSourceAgeMs: 900000,
    cache: true,
    readVault: async () => {
      reads++
      return observed(VAULT)
    },
  }
  const initial = await readConfiguredLiveCurrentCash(query(), options)
  assert.equal(initial.status, 'available')
  assert.equal(reads, 2)
  nowMs += 60000
  assert.deepEqual(await readConfiguredLiveCurrentCash(query(), options), initial)
  assert.equal(reads, 2)
  nowMs += 1
  assert.deepEqual(await readConfiguredLiveCurrentCash(query(), options), {
    status: 'unavailable',
    reason: 'finalized_block_stale',
  })
  assert.equal(reads, 4)
  assert.equal(factories, 4)
  nowMs = Number(BLOCK_AT_SECONDS) * 1000 + 14 * 60000
  assert.equal((await readConfiguredLiveCurrentCash(query(), options)).status, 'available')
  assert.equal(reads, 6) // rejected stale refresh did not poison or preserve the old cache
})

test('strict and permissive pending reads use distinct policies while identical strict callers deduplicate', async () => {
  const clients = makePair().clients
  let reads = 0,
    started
  const began = new Promise((resolve) => {
    started = resolve
  })
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const options = {
    rpcUrls:
      'https://pending-policy-first.example/key-a,https://pending-policy-second.example/key-b',
    clientFactory: (url) => (url.includes('first') ? clients[0] : clients[1]),
    manifest: MANIFEST,
    clock: () => Number(BLOCK_AT_SECONDS) * 1000 + 16 * 60000,
    cache: true,
    readVault: async () => {
      reads++
      started()
      await gate
      return observed(VAULT)
    },
  }
  const permissive = readConfiguredLiveCurrentCash(query(), options)
  await began
  const strictOne = readConfiguredLiveCurrentCash(query(), { ...options, maxSourceAgeMs: 900000 })
  const strictTwo = readConfiguredLiveCurrentCash(query(), { ...options, maxSourceAgeMs: 900000 })
  release()
  const [old, one, two] = await Promise.all([permissive, strictOne, strictTwo])
  assert.equal(old.status, 'available')
  assert.deepEqual(one, { status: 'unavailable', reason: 'finalized_block_stale' })
  assert.deepEqual(two, one)
  assert.equal(reads, 4) // two origin reads per policy, strict consumers share only their own
  assert.equal((await readConfiguredLiveCurrentCash(query(), options)).status, 'available')
  assert.equal(reads, 4) // permissive cache is intact
  assert.deepEqual(
    await readConfiguredLiveCurrentCash(query(), { ...options, maxSourceAgeMs: 900000 }),
    one,
  )
  assert.equal(reads, 6) // strict cannot consume the permissive cache either
})

test('default configured live cash honors active approved policy without environment mutation', async () => {
  const before = { ...process.env },
    clients = makePair().clients,
    hosts = []
  const result = await readConfiguredLiveCurrentCash(query(), {
    manifest: MANIFEST,
    clock: () => NOW_MS,
    cache: false,
    clientFactory: (url) => {
      hosts.push(new URL(url).hostname)
      return clients[hosts.length - 1]
    },
    readVault: async () => observed(VAULT),
  })
  assert.equal(result.status, 'available')
  assert.deepEqual(hosts, ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'])
  assert.equal(JSON.stringify({ ...process.env }) === JSON.stringify(before), true)
})
