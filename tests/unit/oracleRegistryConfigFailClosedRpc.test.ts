// Config cards — fail-closed audit (2026-10-10), part 1: the reads below the engine. Log scans
// (scanLogs / crossCheckedLogs / getLogs answers), eth_call / getCode answers, the oracle
// collector's governance scan, the metadata / verification / holder caches and the state files.
//
// FAIL-CLOSED INVARIANT (owner standing ruling): every chain read whose failure could change a
// verdict must, on failure, (a) produce a listed read gap, (b) never make a change read calmer,
// (c) never drop a head breach / in-effect red / red queue or history row a previous run had, and
// (d) never be cached as a success. Every test below failed on the code before its fix unless it
// is marked (control). The finding ids are those of the audit (docs/research/CONFIG-CARDS-DESIGN.md
// "Fail-closed audit").

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createPublicClient, custom, keccak256, pad, parseAbi, toHex } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadConfigInputs } from '@/lib/oracleRegistry/config/server'
import type { ConfigSubject, SubjectState } from '@/lib/oracleRegistry/config/types'
import { buildConfigCard } from '@/lib/oracleRegistry/config/view'
import { TOPIC, decodeLog } from '@/scripts/oracle-registry/config/lib/abi.mjs'
import * as files from '@/scripts/oracle-registry/config/lib/files.mjs'
import { holderSnapshots } from '@/scripts/oracle-registry/config/lib/holders.mjs'
import { fetchLzMetadata } from '@/scripts/oracle-registry/config/lib/lz.mjs'
import {
  codeAt,
  crossCheckedLogs,
  ethereumClients,
  isRevertError,
  scanLogs,
  tryRead,
} from '@/scripts/oracle-registry/config/lib/rpc.mjs'
import * as verify from '@/scripts/oracle-registry/config/lib/verify.mjs'
import * as confirmLogs from '@/scripts/oracle-registry/lib/confirmLogs.mjs'

// ---- fixtures -------------------------------------------------------------------------------------
type Hx = `0x${string}`
const A = (n: string) => ('0x' + n.repeat(40).slice(0, 40)) as Hx
const X = A('1')
const PREV = A('2')
const NEXT = A('e')
const hx = (n: number) => '0x' + n.toString(16)
type Q = { address?: unknown; fromBlock: string; toBlock: string }
/** A raw log of OwnershipTransferred(prev, next) (both indexed) at `block`. */
const ownerLog = (block: number, i = 0) => ({
  address: X,
  topics: [TOPIC.OwnershipTransferred, pad(PREV, { size: 32 }), pad(NEXT, { size: 32 })],
  data: '0x',
  blockNumber: hx(block),
  logIndex: hx(i),
  transactionHash: '0x' + String(block).padStart(64, '0'),
})
/** An endpoint answering `fn(from, to)` (an Error is thrown); every request recorded. */
const ep = (fn: (from: number, to: number) => unknown) => {
  const asked: [number, number][] = []
  return {
    asked,
    request: async ({ params }: { params: Q[] }) => {
      const f = Number(params[0].fromBlock)
      const t = Number(params[0].toBlock)
      asked.push([f, t])
      const r = fn(f, t)
      if (r instanceof Error) throw r
      return r
    },
  }
}
const inRange = (logs: ReturnType<typeof ownerLog>[]) => (f: number, t: number) =>
  logs.filter((l) => Number(l.blockNumber) >= f && Number(l.blockNumber) <= t)
const tmp = () => mkdtempSync(join(tmpdir(), 'fc-rpc-'))
const scan = scanLogs as unknown as (o: Record<string, unknown>) => Promise<{ block: number }[]>

// =====================================================================================================
describe('EV-03 / EV-04: crossCheckedLogs — a non-array answer is a failure, every empty piece confirmed', () => {
  it('EV-04 (2) / EV-03: a primary that answers null is a FAILED read, not an empty one (it was "confirmed" by one empty)', async () => {
    const primary = ep(() => null)
    const secondary = ep(() => [])
    await expect(
      crossCheckedLogs(primary, secondary, {
        address: X,
        topics0: ['0x01'],
        fromBlock: 1,
        toBlock: 100,
      }),
    ).rejects.toThrow()
  }, 20_000)
  it('EV-04 (1): a false-empty primary next to a partial secondary — every empty piece is asked on the primary again', async () => {
    const truth = [ownerLog(500), ownerLog(15_000)]
    // the primary's whole-range answer is false-empty; asked for the piece it answers right
    const primary = ep((f, t) => (f === 0 && t === 19_999 ? [] : inRange(truth)(f, t)))
    // the secondary's second piece is false-empty
    const secondary = ep((f, t) => (f >= 10_000 ? [] : inRange(truth)(f, t)))
    const r = await crossCheckedLogs(primary, secondary, {
      address: X,
      topics0: ['0x01'],
      fromBlock: 0,
      toBlock: 19_999,
    })
    expect(
      r.logs
        .map((l: { blockNumber: string }) => Number(l.blockNumber))
        .sort((x: number, y: number) => x - y),
    ).toEqual([500, 15_000])
  }, 20_000)
  it('(control) both endpoints empty on every piece: confirmed empty, no extra request', async () => {
    const primary = ep(() => [])
    const secondary = ep(() => [])
    const r = await crossCheckedLogs(primary, secondary, {
      address: X,
      topics0: ['0x01'],
      fromBlock: 0,
      toBlock: 19_999,
    })
    expect(r.logs).toEqual([])
    expect(primary.asked).toHaveLength(1)
    expect(secondary.asked).toHaveLength(2)
  })
})

describe('EV-04: the two log endpoints are distinct hosts', () => {
  const saved = process.env.ORACLE_REGISTRY_RPC_URL
  afterEach(() => {
    if (saved === undefined) delete process.env.ORACLE_REGISTRY_RPC_URL
    else process.env.ORACLE_REGISTRY_RPC_URL = saved
  })
  it('one log host (or two URLs on one host) is refused at startup: an endpoint never cross-checks itself', () => {
    process.env.ORACLE_REGISTRY_RPC_URL = 'https://rpc.ankr.com/eth/aaaa'
    expect(() => ethereumClients()).toThrow(/distinct/)
    process.env.ORACLE_REGISTRY_RPC_URL =
      'https://rpc.ankr.com/eth/aaaa,https://rpc.ankr.com/eth/bbbb'
    expect(() => ethereumClients()).toThrow(/distinct/)
  })
  it('(control) Ankr + Infura: two independent endpoints', () => {
    process.env.ORACLE_REGISTRY_RPC_URL =
      'https://rpc.ankr.com/eth/aaaa,https://mainnet.infura.io/v3/bbbb'
    const c = ethereumClients()
    expect(c.logsPrimary).toBeTruthy()
    expect(c.logsSecondary).toBeTruthy()
  })
})

// =====================================================================================================
describe('EV-01 / ST-03 / KG-7: scanLogs cross-checks every empty chunk and caches only confirmed ones', () => {
  const base = (dir: string, o: Record<string, unknown>) => ({
    chainId: 1,
    addresses: [X],
    topics0: [TOPIC.OwnershipTransferred],
    from: 1,
    to: 1000,
    head: 100_000,
    span: 1000,
    cacheDir: dir,
    ...o,
  })
  it('a false-empty chunk on the first endpoint is corrected by the second (it was cached as "no event")', async () => {
    const dir = tmp()
    try {
      const primary = ep(() => [])
      const secondary = ep(inRange([ownerLog(700)]))
      const rows = await scan(base(dir, { client: primary, primary, secondary, gaps: [] }))
      expect(rows.map((r) => r.block)).toEqual([700])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
  it('an empty chunk nothing confirms is a scan GAP, is not cached, and is read again next run', async () => {
    const dir = tmp()
    try {
      const primary = ep(() => [])
      const gaps: unknown[] = []
      const rows = await scan(
        base(dir, { client: primary, primary, secondary: ep(() => new Error('timeout')), gaps }),
      )
      expect(rows).toEqual([])
      expect(gaps).toHaveLength(1)
      // the next run asks again (nothing was cached) and finds the event
      const again = await scan(
        base(dir, {
          client: primary,
          primary,
          secondary: ep(inRange([ownerLog(700)])),
          gaps: [],
        }),
      )
      expect(again.map((r) => r.block)).toEqual([700])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
  it('with no gap list the unconfirmed chunk THROWS (the run stops; it never reads as "no event")', async () => {
    const dir = tmp()
    try {
      const primary = ep(() => [])
      await expect(
        scan(base(dir, { client: primary, primary, secondary: ep(() => new Error('timeout')) })),
      ).rejects.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
  it('a cache line written before the cross-check (no confirmed mark) is read again', async () => {
    const dir = tmp()
    try {
      const primary = ep(inRange([ownerLog(700)]))
      const secondary = ep(inRange([ownerLog(700)]))
      // first run: discover the cache file name, then replace its content with an old-style line
      await scan(base(dir, { client: primary, primary, secondary, gaps: [] }))
      const f = readdir(dir)
      writeFileSync(f, JSON.stringify({ from: 1, to: 1000, rows: [] }) + '\n')
      const rows = await scan(base(dir, { client: primary, primary, secondary, gaps: [] }))
      expect(rows.map((r) => r.block)).toEqual([700])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
  it('a chunk ending within 64 blocks of head is never cached (a lagging log node)', async () => {
    const dir = tmp()
    try {
      const primary = ep(inRange([ownerLog(700)]))
      await scan(base(dir, { client: primary, primary, secondary: primary, gaps: [], head: 1010 }))
      const f = readdir(dir, true)
      expect(f ? readFileSync(f, 'utf8').trim() : '').toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
function readdir(dir: string, maybe = false): string {
  const f = readdirSync(dir).find((n) => n.startsWith('scan-'))
  if (!f && maybe) return ''
  return join(dir, f!)
}

// =====================================================================================================
describe('EV-02: a log of a requested event that does not decode is never dropped silently', () => {
  it('OwnershipTransferred with ONE indexed arg (newOwner in data) decodes (it was null)', () => {
    const d = decodeLog({
      topics: [TOPIC.OwnershipTransferred, pad(PREV, { size: 32 })],
      data: pad(NEXT, { size: 32 }),
    })
    expect(d).toMatchObject({
      event: 'OwnershipTransferred',
      args: { previousOwner: PREV, newOwner: NEXT },
    })
  })
  it('AdminChanged with BOTH args indexed decodes (only the non-indexed shape was declared)', () => {
    const d = decodeLog({
      topics: [TOPIC.AdminChanged, pad(PREV, { size: 32 }), pad(NEXT, { size: 32 })],
      data: '0x',
    })
    expect(d).toMatchObject({
      event: 'AdminChanged',
      args: { previousAdmin: PREV, newAdmin: NEXT },
    })
  })
  it('a requested log that cannot be decoded at all is a scan gap, and its chunk is not cached', async () => {
    const dir = tmp()
    try {
      const bad = { ...ownerLog(700), topics: [TOPIC.OwnershipTransferred], data: '0x1234' }
      const primary = ep(() => [bad])
      const gaps: { error?: string }[] = []
      await scan({
        chainId: 1,
        addresses: [X],
        topics0: [TOPIC.OwnershipTransferred],
        from: 1,
        to: 1000,
        head: 100_000,
        span: 1000,
        cacheDir: dir,
        client: primary,
        primary,
        secondary: primary,
        gaps,
      })
      expect(gaps).toHaveLength(1)
      expect(String(gaps[0].error)).toMatch(/not decodable/)
      const f = readdir(dir, true)
      expect(f ? readFileSync(f, 'utf8').trim() : '').toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// =====================================================================================================
describe('RPC-REVERT: a node failure is never read as a revert (it closed routes and skipped reads)', () => {
  const clientFailing = (err: Record<string, unknown>) =>
    createPublicClient({
      transport: custom({
        async request({ method }: { method: string }) {
          if (method === 'eth_call') throw err
          if (method === 'eth_chainId') return '0x1'
          throw new Error('unexpected ' + method)
        },
      }),
    })
  const abi = parseAbi(['function peers(uint32) view returns (bytes32)'])
  it('-32603 "Internal error" with no revert data: a failed read, not a revert (it was reverted: true)', async () => {
    const r = await tryRead(
      clientFailing({ code: -32603, message: 'Internal error' }),
      X,
      abi,
      'peers',
      [1],
    )
    expect(r).toMatchObject({ ok: false, reverted: false })
  }, 20_000)
  it('"gas required exceeds allowance" is a node limit, not a revert (a simulation read it as stale)', () => {
    const e = {
      name: 'CallExecutionError',
      cause: {
        name: 'ExecutionRevertedError',
        details: 'gas required exceeds allowance (10000000)',
        code: -32000,
      },
    }
    expect(isRevertError(e)).toBe(false)
  })
  it('(control) a code-3 revert with revert data is a revert, and tryRead hands back its selector', async () => {
    const r = await tryRead(
      clientFailing({ code: 3, message: 'execution reverted', data: '0x2c66f1d6' }),
      X,
      abi,
      'peers',
      [1],
    )
    expect(r).toMatchObject({ ok: false, reverted: true, revertSelector: '0x2c66f1d6' })
  }, 20_000)
})

describe('CL-01: getCode answering null is a failed read (it was "no code": an EOA)', () => {
  it('codeAt throws on a null answer; "0x" stays "no code"', async () => {
    await expect(codeAt({ getCode: async () => null }, X)).rejects.toThrow()
    expect(await codeAt({ getCode: async () => undefined }, X)).toBeNull()
  }, 20_000)
})

// =====================================================================================================
describe('LZ-13: LayerZero metadata is validated before it is cached or used', () => {
  it('a 200 answer that is not the metadata (an error JSON) is refused and not cached', async () => {
    const dir = tmp()
    try {
      const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ error: 'x' }) })
      await expect(fetchLzMetadata(dir, fetchImpl as never)).rejects.toThrow()
      expect(existsSync(join(dir, 'lz-metadata-raw.json'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})

// =====================================================================================================
describe('ST-01: the previous run is read as a SET (state, changes, queues) or the run stops', () => {
  it('a state file that parses to null STOPS the run (it was a first run)', () => {
    const dir = tmp()
    try {
      const p = join(dir, 's.json')
      writeFileSync(p, 'null')
      expect(() => files.readPreviousState(p)).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  const setDir = (o: { state?: unknown; changes?: unknown; queues?: unknown }) => {
    const dir = tmp()
    for (const d of ['state', 'changes', 'queues']) mkdirSync(join(dir, d))
    for (const [d, v] of Object.entries(o))
      if (v !== undefined) writeFileSync(join(dir, d, 'z.json'), JSON.stringify(v))
    return dir
  }
  const st = (block: number) => ({ version: 1, subject: 'z', asOf: { block, ts: 1 }, items: [] })
  const ch = (block: number) => ({ version: 1, subject: 'z', asOf: { block, ts: 1 }, changes: [] })
  it('a torn set (state written by a newer run than its changes file) STOPS the run', () => {
    const dir = setDir({ state: st(200), changes: ch(100), queues: ch(200) })
    try {
      expect(() => files.readPreviousSet(dir, 'z')).toThrow(/block/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('a missing state next to an existing changes file STOPS the run (not a first run)', () => {
    const dir = setDir({ changes: ch(100), queues: ch(100) })
    try {
      expect(() => files.readPreviousSet(dir, 'z')).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('(control) a whole set reads; no file at all is a first run', () => {
    const ok = setDir({ state: st(100), changes: ch(100), queues: ch(100) })
    const none = setDir({})
    try {
      expect(files.readPreviousSet(ok, 'z').state.asOf.block).toBe(100)
      expect(files.readPreviousSet(none, 'z')).toEqual({ state: null, changes: null, queues: null })
    } finally {
      rmSync(ok, { recursive: true, force: true })
      rmSync(none, { recursive: true, force: true })
    }
  })
  it('the collector writes changes and queues first and the state LAST (the state is the commit mark)', () => {
    const order: string[] = []
    files.writeSubjectFiles(
      '/nowhere',
      'z',
      { state: st(1), changes: [], queue: [] },
      (p: string) => order.push(p.split('/').at(-2)!),
    )
    expect(order).toEqual(['changes', 'queues', 'state'])
  })
})

describe('MISSED-2 (state files): --rebuild never overwrites a newer run with an older raw', () => {
  it('a raw older than the current state is refused', () => {
    expect(() =>
      files.assertRebuildFresh({ head: { block: 100 } }, { asOf: { block: 200 } }),
    ).toThrow()
    expect(() =>
      files.assertRebuildFresh({ head: { block: 300 } }, { asOf: { block: 200 } }),
    ).not.toThrow()
  })
})

// =====================================================================================================
describe('ST-06: the card never serves "0 red in effect" over a change file it could not read', () => {
  const subject: ConfigSubject = {
    key: 'z',
    label: 'Z',
    oracleAssetKey: null,
    class: 'lrt',
    contracts: [],
    lzOApps: [],
    ccipPools: [],
    powers: [],
    params: [],
    timelocks: [],
    safes: [],
    govChannels: [],
  }
  const state = {
    version: 1,
    subject: 'z',
    label: 'Z',
    oracleAssetKey: null,
    chainId: 1,
    asOf: { block: 30_000_000, ts: 1 },
    scan: { from: 1, to: 30_000_000 },
    govChannels: [],
    announcement: 'no_gov_channel',
    proposedSources: [],
    powers: [],
    items: [],
    counts: { red: 1, pending: 0, proposed: 0, historical: 1, floorBreaches: 0 },
    warnings: [],
  } as unknown as SubjectState
  const redRow = {
    id: '1:0xab:0',
    subject: 'z',
    dimension: 'admin',
    key: 'admin/owner/x',
    title: 'owner moved',
    state: 'historical',
    stage: 'executed',
    severity: 'downgrade',
    floorBreach: false,
    red: true,
    stillInEffect: true,
    ruleIds: ['AD-3'],
    tags: [],
    unannounced: null,
    announcement: 'no_gov_channel',
    chainId: 1,
    block: 29_000_000,
  }
  const write = (changesText: string) => {
    const dir = tmp()
    for (const d of ['state', 'changes', 'queues']) mkdirSync(join(dir, d))
    writeFileSync(join(dir, 'state', 'z.json'), JSON.stringify(state))
    writeFileSync(join(dir, 'changes', 'z.json'), changesText)
    writeFileSync(
      join(dir, 'queues', 'z.json'),
      JSON.stringify({ version: 1, subject: 'z', asOf: state.asOf, changes: [] }),
    )
    return dir
  }
  const card = (dir: string) => buildConfigCard(loadConfigInputs(subject, dir))
  it('a truncated change file: a read gap, and the red the state recorded stays counted', () => {
    const full = JSON.stringify({ version: 1, subject: 'z', asOf: state.asOf, changes: [redRow] })
    const dir = write(full.slice(0, full.length - 40))
    try {
      const c = card(dir)!
      expect((c.readGaps ?? []).length).toBeGreaterThanOrEqual(1)
      expect(c.counts.openRed).toBeGreaterThanOrEqual(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('(control) the whole change file: no read gap, the red counted from it', () => {
    const dir = write(
      JSON.stringify({ version: 1, subject: 'z', asOf: state.asOf, changes: [redRow] }),
    )
    try {
      const c = card(dir)!
      expect(c.readGaps).toEqual([])
      expect(c.counts.redInEffect).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// =====================================================================================================
describe('PO-11 / PO-13: source verification — a malformed answer is "not read", never "not verified"; only definite answers are kept', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('a 200 that is not JSON (an HTML error page) is not read (it was "not verified", cached for good)', async () => {
    vi.stubGlobal('fetch', async () => ({
      status: 200,
      json: async () => {
        throw new Error('Unexpected token <')
      },
    }))
    expect(await verify.sourceVerified(X)).toBeNull()
  })
  it('a cached "not verified" is checked again (a later verification is picked up)', async () => {
    const dir = tmp()
    try {
      const f = join(dir, 'verification.json')
      writeFileSync(f, JSON.stringify({ [X]: false }))
      vi.stubGlobal('fetch', async (url: string) => ({
        status: 200,
        json: async () =>
          String(url).includes('sourcify') ? { match: 'exact_match' } : { is_verified: true },
      }))
      const out = (await verify.verifySources([X], f)) as Record<string, boolean | null>
      expect(out[X]).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('PO-13: an implementation slot answer that is not a 32-byte word is not read (it was "not a proxy")', () => {
    expect(verify.implFromSlotWord(null)).toBeNull()
    expect(verify.implFromSlotWord('0x')).toBeNull()
    expect(verify.implFromSlotWord('0x' + '0'.repeat(64))).toBeUndefined()
    expect(verify.implFromSlotWord(pad(NEXT, { size: 32 }))).toBe(NEXT)
  })
})

// =====================================================================================================
describe('TV-15 / TV-16 / ST-09: the holder-snapshot cache', () => {
  const snapshots = holderSnapshots as unknown as (
    o: Record<string, unknown>,
  ) => Promise<Map<number, unknown>>
  const TOKEN = A('7')
  const TRANSFER = keccak256(toHex('Transfer(address,address,uint256)'))
  const holders = Array.from(
    { length: 12 },
    (_, i) => ('0x' + String(i + 1).padStart(40, '0')) as Hx,
  )
  const mint = (to: Hx, v: bigint, i: number) => ({
    address: TOKEN,
    topics: [TRANSFER, pad('0x0', { size: 32 }), pad(to, { size: 32 })],
    data: pad(toHex(v), { size: 32 }),
    blockNumber: hx(5),
    logIndex: hx(i),
    transactionHash: '0x' + '5'.repeat(64),
  })
  const logs = holders.map((h, i) => mint(h, BigInt(1000 - i), i))
  const supply = logs.reduce((s, _, i) => s + BigInt(1000 - i), 0n)
  const logClients = { primary: ep(() => logs), secondary: ep(() => logs) }
  const chain = (wrong?: Hx) => ({
    readContract: async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
      if (functionName === 'totalSupply') return supply
      const i = holders.indexOf(String(args![0]).toLowerCase() as Hx)
      return args![0] === wrong ? 1n : BigInt(1000 - i)
    },
  })
  it('TV-15: a truncated cache file is warned about and rebuilt (it stopped every later run)', async () => {
    const dir = tmp()
    try {
      const f = join(dir, 'h.json')
      writeFileSync(f, '{"broken')
      const out = await snapshots({
        logClients,
        state: chain(),
        token: TOKEN,
        from: 1,
        blocks: [10],
        cacheFile: f,
      })
      expect(out.get(10)).toMatchObject({ supply: String(supply) })
      expect(() => JSON.parse(readFileSync(f, 'utf8'))).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
  it('TV-16: every cached holder is verified on chain (a mismatch at rank 11 was cached)', async () => {
    const out = await snapshots({
      logClients,
      state: chain(holders[10]),
      token: TOKEN,
      from: 1,
      blocks: [10],
    })
    expect(out.get(10)).toHaveProperty('error')
  }, 20_000)
})

// =====================================================================================================
describe('MISSED collect.mjs:811 / EV MISSED-2: the oracle collector confirms every empty governance chunk', () => {
  const get = (r: unknown) => async () => {
    if (r instanceof Error) throw r
    return r
  }
  it('an empty first answer is asked again; a second endpoint that fails leaves it UNCONFIRMED (throws)', async () => {
    const f = confirmLogs.confirmedLogs as unknown as (
      p: () => Promise<unknown>,
      s: (() => Promise<unknown>) | null,
    ) => Promise<unknown[]>
    expect(await f(get([]), get([{ x: 1 }]))).toEqual([{ x: 1 }])
    expect(await f(get([]), get([]))).toEqual([])
    await expect(f(get([]), get(new Error('timeout')))).rejects.toThrow()
    await expect(f(get([]), null)).rejects.toThrow()
    await expect(f(get(null), get([]))).rejects.toThrow()
    expect(await f(get([{ y: 2 }]), null)).toEqual([{ y: 2 }])
  })
})
