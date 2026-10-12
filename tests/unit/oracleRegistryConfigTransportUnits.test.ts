// Config cards — lane T (2026-10-11): the transport helpers themselves. `retryRpc` (what is
// retried, the backoff schedule, Retry-After, the per-call budget), `createLimiter` (pacing),
// `hostLabel` / `describeRpcError` / `scrub` (no key, subdomain, path or port ever survives — the
// repo is PUBLIC and gap texts are committed), and `deployBlockGap` (a deploy block that could not
// be confirmed is a READ GAP the card lists and counts). These helpers are new in lane T; the
// behaviour tests that also ran against the code before it are in
// oracleRegistryConfigTransport.test.ts.

import { HttpRequestError, RpcRequestError, TimeoutError } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildSubject, type RawSubject } from '@/lib/oracleRegistry/config/engine'
import type { ConfigSubject } from '@/lib/oracleRegistry/config/types'
import type { DvnRegistry } from '@/lib/oracleRegistry/config/uln'
import { ccipDeployGapOnCard, deployBlockGap } from '@/scripts/oracle-registry/config/lib/admin.mjs'
import {
  classifyRpcError,
  createLimiter,
  describeRpcError,
  hostLabel,
  notingFetch,
  parseRetryAfter,
  registerRpcSecrets,
  retryRpc,
  rpcFailure,
  rpcTuning,
  scrub,
} from '@/scripts/oracle-registry/config/lib/rpc.mjs'

afterEach(() => vi.useRealTimers())

const PROD = { tries: 5, baseMs: 1000, capMs: 20_000, budgetMs: 60_000 }
const http429 = (headers?: Record<string, string>) =>
  new HttpRequestError({
    url: 'https://mainnet.infura.io/v3/0123456789abcdef0123456789abcdef',
    status: 429,
    details: 'Too Many Requests',
    headers: headers ? new Headers(headers) : undefined,
  })
const revert = () =>
  Object.assign(new Error('execution reverted'), { name: 'ContractFunctionRevertedError' })

// =====================================================================================================
describe('retryRpc: what is retried, and how long it waits', () => {
  it('(production defaults) 5 tries, 1 s doubling, 20 s cap, 60 s budget, 1 req/s cross-check', () => {
    expect(rpcTuning({} as NodeJS.ProcessEnv)).toEqual({
      tries: 5,
      baseMs: 1000,
      capMs: 20_000,
      budgetMs: 60_000,
      crossCheckIntervalMs: 1000,
    })
    expect(
      rpcTuning({ ORACLE_REGISTRY_XCHECK_INTERVAL_MS: '2500' } as unknown as NodeJS.ProcessEnv)
        .crossCheckIntervalMs,
    ).toBe(2500)
  })
  it('429 then success: one retry, after a jittered first backoff in [½, 1] of 1 s', async () => {
    const delays: number[] = []
    let n = 0
    const v = await retryRpc(
      async () => {
        if (n++ === 0) throw http429()
        return 'ok'
      },
      {
        ...PROD,
        baseMs: 1,
        random: () => 0.5,
        onRetry: (r: { delayMs: number }) => delays.push(r.delayMs),
      },
    )
    expect(v).toBe('ok')
    expect(n).toBe(2)
    expect(delays).toEqual([0.75])
  })
  it('the schedule doubles per try and is capped; five failures throw the last error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const delays: number[] = []
    let n = 0
    const p = retryRpc(
      async () => {
        n++
        throw http429()
      },
      {
        ...PROD,
        capMs: 5_000,
        random: () => 1,
        onRetry: (r: { delayMs: number }) => delays.push(r.delayMs),
      },
    ).catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(60_000)
    const e = await p
    expect(n).toBe(5)
    expect(delays).toEqual([1000, 2000, 4000, 5000])
    expect(e).toBeInstanceOf(HttpRequestError)
  })
  it('Retry-After is a floor (clamped to the cap); Infura `backoff_seconds` and "retry in Ns" count', async () => {
    const run = async (err: unknown) => {
      const delays: number[] = []
      let n = 0
      await retryRpc(
        async () => {
          if (n++ === 0) throw err
          return 1
        },
        {
          ...PROD,
          baseMs: 1,
          capMs: 10,
          random: () => 0,
          onRetry: (r: { delayMs: number }) => delays.push(r.delayMs),
        },
      )
      return delays[0]
    }
    // capMs 10 in this run: a 3 s Retry-After is clamped to 10 ms
    expect(await run(http429({ 'Retry-After': '3' }))).toBe(10)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const delays: number[] = []
    let n = 0
    const p = retryRpc(
      async () => {
        if (n++ === 0) throw http429({ 'Retry-After': '3' })
        return 1
      },
      { ...PROD, random: () => 0, onRetry: (r: { delayMs: number }) => delays.push(r.delayMs) },
    )
    await vi.advanceTimersByTimeAsync(2_999)
    expect(n).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await p
    expect(n).toBe(2)
    expect(delays).toEqual([3000])
    expect(
      classifyRpcError(
        new RpcRequestError({
          url: 'https://mainnet.infura.io/v3/x',
          body: {},
          error: { code: -32005, message: 'rate exceeded', data: { backoff_seconds: 30 } },
        }),
      ).retryAfterMs,
    ).toBe(30_000)
    expect(classifyRpcError(new Error('Too many requests, retry in 4s')).retryAfterMs).toBe(4_000)
    expect(
      parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT', Date.parse('Wed, 21 Oct 2026 07:27:00 GMT')),
    ).toBe(60_000)
  })
  it('a deterministic revert and a refused block range are never retried; an unknown error twice', async () => {
    const count = async (err: unknown) => {
      let n = 0
      await retryRpc(
        async () => {
          n++
          throw err
        },
        { ...PROD, baseMs: 1, capMs: 2 },
      ).catch(() => null)
      return n
    }
    expect(await count(revert())).toBe(1)
    expect(await count(new Error('query returned more than 10000 results'))).toBe(1)
    expect(
      await count(
        Object.assign(new Error('x'), {
          code: -32005,
          message: 'query returned more than 10000 results',
        }),
      ),
    ).toBe(1)
    expect(await count(new Error('header not found'))).toBe(2)
    expect(await count(new TimeoutError({ body: {}, url: 'https://rpc.ankr.com/eth/k' }))).toBe(3)
    expect(
      await count(Object.assign(new Error('fetch failed'), { name: 'HttpRequestError' })),
    ).toBe(5)
    expect(await count(Object.assign(new Error('HTTP 503'), { name: 'HttpRequestError' }))).toBe(5)
  })
  it('the per-call budget stops the retries before the tries run out', async () => {
    let n = 0
    await retryRpc(
      async () => {
        n++
        throw http429()
      },
      { ...PROD, baseMs: 1, budgetMs: 2.5, random: () => 1 },
    ).catch(() => null)
    // waits 1 + 2 = 3 > 2.5: the second wait is not taken
    expect(n).toBe(2)
  })
})

describe('createLimiter: one in flight, starts ≥ the interval apart, Retry-After holds the host', () => {
  it('fast jobs start 1 s apart; a slow job holds the next one until it ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const lim = createLimiter({ minIntervalMs: 1000 })
    const t0 = Date.now()
    const starts: number[] = []
    const job = (ms: number) => () =>
      new Promise<void>((r) => {
        starts.push(Date.now() - t0)
        setTimeout(r, ms)
      })
    const all = Promise.all([
      lim.run(job(10)),
      lim.run(job(1500)),
      lim.run(job(10)),
      lim.run(job(10)),
    ])
    await vi.advanceTimersByTimeAsync(10_000)
    await all
    expect(starts).toEqual([0, 1000, 2500, 3500])
  })
  it('penalize(5 s) holds every later start', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const lim = createLimiter({ minIntervalMs: 1000 })
    const t0 = Date.now()
    const starts: number[] = []
    await lim.run(async () => starts.push(Date.now() - t0))
    lim.penalize(5_000)
    const p = lim.run(async () => starts.push(Date.now() - t0))
    await vi.advanceTimersByTimeAsync(10_000)
    await p
    expect(starts).toEqual([0, 5000])
  })
  it('a rejected job rejects its caller and does not stall the queue', async () => {
    const lim = createLimiter({ minIntervalMs: 0 })
    await expect(lim.run(async () => Promise.reject(new Error('x')))).rejects.toThrow('x')
    await expect(lim.run(async () => 2)).resolves.toBe(2)
  })
})

// =====================================================================================================
describe('host labels: the registrable domain only — never a key, a subdomain, a path or a port', () => {
  const KEYS = {
    alchemy: 'Zx9_kQ2-vB7mN4pL8rT1wY6cF3hJ5sD0',
    infura: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
    ankr: 'c0ffee00deadbeef0123456789abcdef0123456789abcdef0123456789abcd12',
    quiknodeToken: '5f4e3d2c1b0a99887766554433221100ffeeddcc',
    drpc: 'AqLmZ7b3-XyQ9w2RtE5uI8oP1aS4dF6gH0jK',
  }
  const QN_ID = 'shy-frost-river'
  const SHAPES = [
    {
      url: `https://eth-mainnet.g.alchemy.com/v2/${KEYS.alchemy}`,
      label: 'alchemy.com',
      secret: [KEYS.alchemy, 'eth-mainnet.g'],
    },
    {
      url: `https://mainnet.infura.io/v3/${KEYS.infura}`,
      label: 'infura.io',
      secret: [KEYS.infura, '/v3/'],
    },
    {
      url: `https://rpc.ankr.com/eth/${KEYS.ankr}`,
      label: 'ankr.com',
      secret: [KEYS.ankr, '/eth/'],
    },
    {
      url: `https://${QN_ID}.ethereum-mainnet.quiknode.pro/${KEYS.quiknodeToken}/`,
      label: 'quiknode.pro',
      secret: [KEYS.quiknodeToken, QN_ID, 'ethereum-mainnet'],
    },
    {
      url: `https://lb.drpc.org:8443/ogrpc?network=ethereum&dkey=${KEYS.drpc}`,
      label: 'drpc.org',
      // (a provider echoing its own path keeps the path NAME — "ogrpc?…dkey=[key]" — never the key)
      secret: [KEYS.drpc, '8443'],
    },
  ]
  registerRpcSecrets(SHAPES.map((s) => s.url))
  const errorsFor = (url: string) => {
    const bare = url.replace(/^https:\/\//, '')
    return [
      new HttpRequestError({
        url,
        status: 429,
        details: 'Too Many Requests',
        body: { method: 'eth_getLogs' },
      }),
      new HttpRequestError({ url, status: 502, details: `<html>bad gateway for ${bare}</html>` }),
      new HttpRequestError({
        url,
        cause: Object.assign(new Error(`connect ECONNRESET ${bare}`), { code: 'ECONNRESET' }),
      }),
      new TimeoutError({ url, body: { method: 'eth_getLogs' } }),
      new RpcRequestError({
        url,
        body: {},
        error: { code: -32005, message: `daily request count exceeded for ${bare}` },
      }),
      new RpcRequestError({
        url,
        body: {},
        error: { code: -32000, message: `invalid key ${bare.split('/').slice(1).join('/')}` },
      }),
    ]
  }
  for (const s of SHAPES)
    it(`${s.label}: label, status / class kept; the key, subdomain, path and port gone`, () => {
      expect(hostLabel(s.url)).toBe(s.label)
      for (const e of errorsFor(s.url)) {
        const outs = [
          describeRpcError(e, { role: 'cross-check' }),
          rpcFailure(e, { role: 'primary' }).message,
          scrub(e.message),
          scrub(String(e)),
          scrub(e.shortMessage),
          scrub((e as { details?: string }).details),
        ]
        expect(outs[0]).toContain(`from ${s.label} (cross-check)`)
        for (const o of outs) {
          for (const k of s.secret) expect(o).not.toContain(k)
          expect(o).not.toMatch(/https?:\/\//)
        }
      }
      expect(describeRpcError(errorsFor(s.url)[0], { role: 'cross-check' })).toMatch(
        new RegExp(`^HTTP 429 from ${s.label.replace('.', '\\.')} \\(cross-check\\)`),
      )
      expect(describeRpcError(errorsFor(s.url)[2])).toMatch(
        /^HTTP request failed \(no response, ECONNRESET\)/,
      )
      expect(describeRpcError(errorsFor(s.url)[3])).toMatch(/^timeout from/)
      expect(describeRpcError(errorsFor(s.url)[4])).toMatch(/^rate limited \(RPC -32005\) from/)
    })
  it('an unregistered key-like token is redacted too; addresses, hashes and selectors stay', () => {
    const addr = '0x' + 'ab'.repeat(20)
    const hash = '0x' + '12'.repeat(32)
    const out = scrub(
      `invalid project id 7e57c0de7e57c0de7e57c0de7e57c0de for ${addr} tx ${hash} sel 0x1234abcd`,
    )
    expect(out).not.toContain('7e57c0de7e57c0de7e57c0de7e57c0de')
    expect(out).toContain(addr)
    expect(out).toContain(hash.slice(0, 40))
    expect(out).toContain('0x1234abcd')
  })
  it('a key cut at the 160th character cannot survive as a prefix', () => {
    const out = scrub(`${'x '.repeat(70)}invalid key ${KEYS.infura}`)
    expect(out).not.toMatch(/0f1e2d3c/)
  })
  it('IP hosts, localhost and ports', () => {
    expect(hostLabel('http://10.0.0.7:8545/abc')).toBe('an IP host')
    expect(hostLabel('http://[::1]:8545')).toBe('an IP host')
    expect(hostLabel('http://localhost:8545')).toBe('localhost')
    expect(hostLabel('https://node.example.co.uk:9000/k')).toBe('example.co.uk')
    expect(hostLabel('not a url')).toBeNull()
  })
  // Review of lane T (PLAUSIBLE #2): the secret pass mangled the host before the host pass saw it
  it('a QuickNode id under 6 characters, named as a bare host, does not survive', () => {
    const token = '0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3'
    registerRpcSecrets([`https://abc12.ethereum-mainnet.quiknode.pro/${token}/`])
    const e = new HttpRequestError({
      url: `https://abc12.ethereum-mainnet.quiknode.pro/${token}/`,
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND abc12.ethereum-mainnet.quiknode.pro'), {
        code: 'ENOTFOUND',
      }),
    })
    for (const o of [
      scrub('getaddrinfo ENOTFOUND abc12.ethereum-mainnet.quiknode.pro'),
      scrub('getaddrinfo ENOTFOUND abc12.ethereum-mainnet.quiknode.pro:443'),
      scrub('no route to abc12.other-net.quiknode.pro'),
      describeRpcError(e, { role: 'cross-check' }),
      rpcFailure(e).message,
    ]) {
      expect(o).not.toContain('abc12')
      expect(o).not.toContain('other-net')
      expect(o).not.toContain(token)
      expect(o).not.toContain('443')
    }
    expect(scrub('getaddrinfo ENOTFOUND abc12.ethereum-mainnet.quiknode.pro')).toContain(
      'quiknode.pro',
    )
  })
  it('an IP host with a port (configured or not, v4 or v6) does not survive', () => {
    registerRpcSecrets(['http://10.1.2.3:8545/'])
    for (const m of [
      'connect ECONNREFUSED 10.1.2.3:8545',
      'connect ECONNREFUSED 10.1.2.3',
      'connect ECONNREFUSED 192.168.7.9:8545/rpc',
      'connect ECONNREFUSED [fe80::1]:8545',
    ]) {
      const o = scrub(m)
      expect(o).not.toMatch(/10\.1\.2\.3|192\.168|fe80|8545/)
      expect(o).toContain('an IP host')
    }
    // a version number or a decimal is not an IP host
    expect(scrub('viem@2.54.0 at 1.5 gwei')).toBe('viem@2.54.0 at 1.5 gwei')
  })
  it('the word "mainnet" in a message is not a key (mainnet.infura.io is registered above)', () => {
    expect(scrub('execution reverted on mainnet (ethereum)')).toBe(
      'execution reverted on mainnet (ethereum)',
    )
  })
})

// =====================================================================================================
// Review of lane T (PLAUSIBLE #1): viem's OWN retry (retryCount 1 on a non-paced host, a fallback
// ring's rounds) slept the full Retry-After header before `retryRpc` saw the error — no cap.
describe('notingFetch: a Retry-After above the per-wait cap reaches viem clamped', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('Retry-After 3600 → the cap (20 s); the status and the original value are still noted', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response('slow down', { status: 429, headers: { 'Retry-After': '3600' } }),
    )
    const prev = process.env.ORACLE_REGISTRY_RPC_BACKOFF_CAP_MS
    process.env.ORACLE_REGISTRY_RPC_BACKOFF_CAP_MS = '20000'
    try {
      const r = await notingFetch('https://x.example.org/', {})
      expect(r.status).toBe(429)
      expect(r.headers.get('retry-after')).toBe('20')
      expect(await r.text()).toBe('slow down')
      // under the cap: unchanged
      vi.stubGlobal(
        'fetch',
        async () => new Response('', { status: 429, headers: { 'Retry-After': '7' } }),
      )
      expect((await notingFetch('https://x.example.org/', {})).headers.get('retry-after')).toBe('7')
    } finally {
      if (prev === undefined) delete process.env.ORACLE_REGISTRY_RPC_BACKOFF_CAP_MS
      else process.env.ORACLE_REGISTRY_RPC_BACKOFF_CAP_MS = prev
    }
  })
})

// =====================================================================================================
// Review of lane T (PLAUSIBLE #3): the CCIP registry's rows go on every card; its deploy-block gap
// did not (the gap filter wanted the emitter in the subject's scope)
describe('ccipDeployGapOnCard: an out-of-scope emitter whose rows for this subject go on its card', () => {
  const TAR = '0xb22764f98dd05c789929716d677382df22c05cb6'
  const TOKEN = '0x' + '7'.repeat(40)
  const OTHER = '0x' + '8'.repeat(40)
  const gap = deployBlockGap(TAR, 'HTTP 429 from infura.io (cross-check)', 26_000_000)
  const rows = [
    { event: 'PoolSet', emitter: TAR, args: { token: TOKEN.toUpperCase().replace('0X', '0x') } },
  ]
  it('a deploy-block gap of that emitter is on the card of a subject whose token it names', () => {
    expect(ccipDeployGapOnCard(gap, rows, [TOKEN])).toBe(true)
    expect(
      ccipDeployGapOnCard(
        gap,
        [{ event: 'AdministratorTransferred', emitter: TAR, args: { token: TOKEN } }],
        [TOKEN],
      ),
    ).toBe(true)
  })
  it('(control) not for another subject, another emitter or another kind of gap', () => {
    expect(ccipDeployGapOnCard(gap, rows, [OTHER])).toBe(false)
    expect(ccipDeployGapOnCard({ ...gap, addresses: [OTHER] }, rows, [TOKEN])).toBe(false)
    expect(ccipDeployGapOnCard({ ...gap, scan: 'admin events' }, rows, [TOKEN])).toBe(false)
    expect(
      ccipDeployGapOnCard(
        gap,
        [{ event: 'OwnershipTransferred', emitter: TAR, args: {} }],
        [TOKEN],
      ),
    ).toBe(false)
  })
})

// =====================================================================================================
describe('lane T (5): a deploy block not confirmed after retries is a READ GAP the card lists', () => {
  const EMITTER = '0x' + '1'.repeat(40)
  const reason = 'HTTP 429 from infura.io (cross-check): "Too Many Requests"'
  it('deployBlockGap: a scan gap of the engine shape, the candidate block when the probe named one', () => {
    expect(deployBlockGap(EMITTER.toUpperCase().replace('0X', '0x'), reason, 26_000_000)).toEqual({
      scan: 'deploy-block confirmation',
      from: 0,
      to: 26_000_000,
      addresses: [EMITTER],
      error: `deploy block of ${EMITTER} not confirmed after retries (${reason}); left unknown`,
    })
    expect(
      deployBlockGap(
        EMITTER,
        'first code at 18123456 not confirmed on a second endpoint',
        26_000_000,
      ),
    ).toMatchObject({ from: 18_123_456, to: 18_123_456 })
  })
  it('the engine lists it in readGaps (counted), with the host label and status', () => {
    const subject: ConfigSubject = {
      key: 'z',
      label: 'Z',
      oracleAssetKey: null,
      class: 'lrt',
      contracts: [
        {
          role: 'token',
          dimension: 'admin',
          chainId: 1,
          address: EMITTER,
          label: 'p',
          deployBlock: 1,
        },
      ],
      lzOApps: [],
      ccipPools: [],
      powers: [],
      params: [],
      timelocks: [],
      safes: [],
      govChannels: [],
    } as ConfigSubject
    const raw = {
      version: 1,
      subjectKey: 'z',
      head: { block: 26_000_000, ts: 2_000_000_000 },
      scan: { from: 1, to: 26_000_000 },
      lz: {
        events: [],
        headRoutes: [],
        headDefaults: {},
        remote: [],
        codeProbes: {},
        dvnSigner: [],
        dvnHead: {},
      },
      admin: {
        events: [],
        controllers: {},
        powers: [],
        timelockAdmins: [],
        implHistory: {},
        owners: {},
        delegates: {},
        minDelays: {},
      },
      params: { head: {}, transitions: [] },
      queues: { ops: [], safe: [], safeStatus: [] },
      ccip: { pools: [] },
      scanGaps: [deployBlockGap(EMITTER, reason, 26_000_000)],
      warnings: [],
    } as unknown as RawSubject
    const registry = {
      byChain: { 1: {} },
      dead: { 1: [] },
      libraries: { 1: { send: [], receive: [], blocked: [], read: [] } },
    } as unknown as DvnRegistry
    const st = buildSubject(subject, raw, {
      registry,
      eidName: () => 'x',
      roleName: (h: string) => h,
      endpoint: '0x1a44076050125825900e736c501f859c50fe728c',
    }).state
    const gaps = (st.readGaps ?? []).filter((g) => /deploy-block confirmation/.test(g))
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toContain(`deploy block of ${EMITTER} not confirmed after retries`)
    expect(gaps[0]).toContain('HTTP 429 from infura.io (cross-check)')
  })
})
