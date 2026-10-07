// Config-card collector + engine plumbing: the subjects file loader, log decoding (incl. the
// two-shape events), LZ metadata compaction, the Safe Tx Service failure mode, the engine on a
// minimal raw subject, and the CLI property that must hold even when it crashes (no RPC URL).

import { spawnSync } from 'child_process'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  parseAbi,
  parseAbiItem,
  toFunctionSelector,
} from 'viem'

import { getConfigSubjects, parseSubjects } from '@/lib/oracleRegistry/config/subjects'
import { buildSubject, type RawSubject } from '@/lib/oracleRegistry/config/engine'
import type { CompactMeta } from '@/lib/oracleRegistry/config/backtest'
import type { ConfigSubject } from '@/lib/oracleRegistry/config/types'
import type { DvnRegistry } from '@/lib/oracleRegistry/config/uln'
import { TOPIC, decodeLog, lzEventsOf } from '@/scripts/oracle-registry/config/lib/abi.mjs'
import { compactLzMetadata, registryOf } from '@/scripts/oracle-registry/config/lib/lz.mjs'
import { safeQueue } from '@/scripts/oracle-registry/config/lib/safe.mjs'
import {
  classify,
  hashOp,
  isTimelockCode,
  readOps,
  recoverSalt,
} from '@/scripts/oracle-registry/config/lib/admin.mjs'
import { bisectChanges, pickTx } from '@/scripts/oracle-registry/config/lib/params.mjs'
import { isRevertError, tryRead } from '@/scripts/oracle-registry/config/lib/rpc.mjs'

const OAPP = '0x85d456b2dff1fd8245387c0bfb64dfb700e98ef3'
const LZ = '0x589dedbd617e0cbcb916a9223f4d1300c294236b'

describe('subjects.json', () => {
  it('loads and validates the committed v1 subjects', () => {
    const f = getConfigSubjects()
    expect(f.subjects.map((s) => s.key)).toEqual([
      'rseth',
      'weeth',
      'usde',
      'susde',
      'wbtc',
      'cbbtc',
      'pt-srusde',
      'wsteth',
    ])
    const kelp = f.subjects.find((s) => s.key === 'rseth')!
    expect(kelp.govChannels).toEqual([]) // NO-GOV-CHANNEL
    expect(kelp.params.find((p) => p.key === 'depositLimit:stETH')!.zero).toBe('closed')
  })
  it('rejects a cap without a zero sentinel, an undeclared power contract and a bad path step', () => {
    const f = JSON.parse(JSON.stringify(getConfigSubjects()))
    const s = f.subjects[0]
    s.params[0].zero = undefined
    expect(() => parseSubjects(f)).toThrow(/must say what 0 means/)
    const g = JSON.parse(JSON.stringify(getConfigSubjects()))
    g.subjects[0].powers[0].contract = '0x' + '9'.repeat(40)
    expect(() => parseSubjects(g)).toThrow(/undeclared contract/)
    const h = JSON.parse(JSON.stringify(getConfigSubjects()))
    h.subjects[0].powers[0].path = ['selfdestruct']
    expect(() => parseSubjects(h)).toThrow(/power path/)
  })
})

describe('log decoding', () => {
  it('decodes both shapes of a two-shape event (Safe 1.3 non-indexed vs 1.4.1 indexed AddedOwner)', () => {
    const owner = '0x00000000000000000000000000000000000000aa'
    const indexed = parseAbiItem('event AddedOwner(address indexed owner)')
    const plain = parseAbiItem('event AddedOwner(address owner)')
    const a = decodeLog({
      topics: encodeEventTopics({ abi: [indexed], args: { owner } }),
      data: '0x',
    })
    const b = decodeLog({
      topics: encodeEventTopics({ abi: [plain] }),
      data: encodeAbiParameters([{ type: 'address' }], [owner]),
    })
    expect(a).toEqual({ event: 'AddedOwner', args: { owner } })
    expect(b).toEqual({ event: 'AddedOwner', args: { owner } })
  })
  it('maps UlnConfigSet to an LzEvent and drops other OApps (oapp is not indexed: filtered in data)', () => {
    const item = parseAbiItem(
      'event UlnConfigSet(address oapp, uint32 eid, (uint64 confirmations, uint8 requiredDVNCount, uint8 optionalDVNCount, uint8 optionalDVNThreshold, address[] requiredDVNs, address[] optionalDVNs) config)',
    )
    const data = encodeAbiParameters(item.inputs, [
      OAPP,
      30320,
      {
        confirmations: 42n,
        requiredDVNCount: 1,
        optionalDVNCount: 0,
        optionalDVNThreshold: 0,
        requiredDVNs: [LZ],
        optionalDVNs: [],
      },
    ])
    const d = decodeLog({ topics: [TOPIC.UlnConfigSet], data })!
    const row = {
      chainId: 1,
      block: 22179964,
      logIndex: 1488,
      tx: '0x2d',
      emitter: '0xc02ab410f0734efa3f14628780e6e695156024c2',
      ...d,
    }
    const evs = lzEventsOf(row, new Set([OAPP]))
    expect(evs[0]).toMatchObject({
      kind: 'uln',
      oapp: OAPP,
      eid: 30320,
      config: { requiredDVNs: [LZ], confirmations: '42' },
    })
    expect(lzEventsOf(row, new Set(['0x' + '1'.repeat(40)]))).toEqual([])
  })
})

describe('LZ metadata', () => {
  const raw = {
    ethereum: {
      environment: 'mainnet',
      chainDetails: { nativeChainId: 1, chainType: 'evm', name: 'Ethereum' },
      rpcs: [{ url: 'https://eth.example' }, { url: 'https://keyed.example/?apikey=SECRET' }],
      deployments: [
        {
          version: 2,
          stage: 'mainnet',
          eid: '30101',
          endpointV2: { address: '0xE1' },
          sendUln302: { address: '0xS1' },
          receiveUln302: { address: '0xR1' },
          blockedMessageLib: { address: '0xB1' },
          readLib1002: { address: '0xL1' },
          deadDVN: { address: '0xD1' },
        },
      ],
      dvns: {
        [LZ]: { version: 2, canonicalName: 'LayerZero Labs', id: 'layerzero-labs' },
        '0xold': { version: 1, canonicalName: 'TSS', id: 'tss' },
      },
    },
    solana: {
      environment: 'mainnet',
      chainDetails: { chainType: 'solana', name: 'Solana' },
      deployments: [{ version: 2, stage: 'mainnet', eid: '30168' }],
    },
  }
  it('takes the library allowlist and DVN registry from the deployment metadata, drops keyed RPC URLs', () => {
    const m = compactLzMetadata(raw, new Set([30101, 30168]), 'now') as unknown as CompactMeta & {
      chains: Record<string, { rpcs: string[] }>
    }
    expect(m.eids['30168'].chainId).toBeNull()
    expect(m.chains['30101'].libs).toEqual({
      send: ['0xs1'],
      receive: ['0xr1'],
      blocked: ['0xb1'],
      read: ['0xl1'],
    })
    expect(m.chains['30101'].rpcs).toEqual(['https://eth.example'])
    expect(Object.keys(m.chains['30101'].dvns)).toEqual([LZ])
    const reg = registryOf(m) as DvnRegistry
    expect(reg.dead[1]).toEqual(['0xd1'])
    expect(reg.byChain[1][LZ].id).toBe('layerzero-labs')
  })
})

describe('Safe Tx Service', () => {
  it('a 429 marks the Safe unavailable — never "nothing pending"', async () => {
    const r = await safeQueue(
      '0x3b0aaf6e6fcd4a7ceef8c92c32dfea9e64dc1862',
      737,
      async () => new Response('', { status: 429 }),
    )
    expect(r.status).toBe('unavailable')
    expect(r.rows).toEqual([])
  })
  it('parses queued proposals', async () => {
    const body = {
      results: [
        {
          nonce: 737,
          to: '0xE8Dc0Fab349EA169283C48Ccfd09d797E6DB7c94',
          value: '0',
          data: '0x8f2a0bb0',
          confirmations: [{}, {}],
          confirmationsRequired: 5,
          submissionDate: '2026-10-05T08:00:00Z',
          safeTxHash: '0xh',
        },
      ],
    }
    const r = await safeQueue(
      '0x3b0aaf6e6fcd4a7ceef8c92c32dfea9e64dc1862',
      737,
      async () => new Response(JSON.stringify(body), { status: 200 }),
    )
    expect(r.rows[0]).toMatchObject({
      nonce: 737,
      confirmations: 2,
      confirmationsRequired: 5,
      to: '0xe8dc0fab349ea169283c48ccfd09d797e6db7c94',
    })
  })
})

describe('engine on a minimal raw subject', () => {
  const SAFE = '0x' + 'a'.repeat(40)
  const TL = '0x' + 'c'.repeat(40)
  const RECV = '0xc02ab410f0734efa3f14628780e6e695156024c2'
  const subject: ConfigSubject = {
    key: 'x',
    label: 'X',
    oracleAssetKey: null,
    class: 'lrt',
    contracts: [
      {
        role: 'oft_adapter',
        dimension: 'bridge',
        chainId: 1,
        address: OAPP,
        label: 'adapter',
        deployBlock: 1,
      },
      {
        role: 'timelock',
        dimension: 'admin',
        chainId: 1,
        address: TL,
        label: 'tl',
        deployBlock: 1,
      },
    ],
    lzOApps: [OAPP],
    ccipPools: [],
    powers: [{ power: 'bridge_config', contract: OAPP, path: ['lz_delegate'], label: 'delegate' }],
    params: [],
    timelocks: [TL],
    safes: [SAFE],
    govChannels: [],
  }
  const uln1 = {
    confirmations: '42',
    requiredDVNCount: 1,
    optionalDVNCount: 0,
    optionalDVNThreshold: 0,
    requiredDVNs: [LZ],
    optionalDVNs: [],
  }
  const raw: RawSubject = {
    version: 1,
    subjectKey: 'x',
    head: { block: 1000, ts: 2000 },
    scan: { from: 1, to: 1000 },
    lz: {
      events: [],
      headDefaults: {},
      codeProbes: { [LZ]: { firstCode: 1 } },
      dvnSigner: [],
      dvnHead: {},
      headRoutes: [
        {
          oapp: OAPP,
          eid: 30110,
          direction: 'receive',
          lib: RECV,
          libIsDefault: false,
          merged: uln1,
          app: uln1,
          peer: '0x' + '0'.repeat(24) + '1'.repeat(40),
        },
      ],
      remote: [
        {
          oapp: OAPP,
          eid: 30110,
          chainKey: 'arbitrum',
          chainId: 42161,
          status: 'remote_unread',
          reason: 'no working public RPC',
        },
      ],
    },
    admin: {
      events: [],
      powers: [{ power: 'bridge_config', label: 'delegate', contract: OAPP, holders: [SAFE] }],
      controllers: {
        [`${SAFE}@head`]: { kind: 'safe', address: SAFE, threshold: 3, signers: 6 },
        [`${TL}@head`]: { kind: 'oz_timelock', address: TL, delaySec: 172800 },
      },
      timelockAdmins: [{ timelock: TL, role: 'TIMELOCK_ADMIN_ROLE', holders: [TL, SAFE] }],
      implHistory: {},
      owners: {},
      delegates: { [OAPP]: SAFE },
      minDelays: { [TL]: 172800 },
    },
    params: { head: {}, transitions: [] },
    queues: {
      ops: [],
      safe: [],
      safeStatus: [{ safe: SAFE, status: 'unavailable', note: 'HTTP 429' }],
    },
    ccip: { pools: [] },
    warnings: [],
  }
  const reg = {
    byChain: { 1: { [LZ]: { id: 'layerzero-labs', name: 'LayerZero Labs' } } },
    dead: { 1: [] },
    libraries: { 1: { send: [], receive: [RECV], blocked: [], read: [] } },
  }
  const out = buildSubject(subject, raw, {
    registry: reg,
    eidName: () => 'arbitrum',
    roleName: (h) => h,
    endpoint: '0x1a44076050125825900e736c501f859c50fe728c',
  })
  it('floor breach at head, REMOTE UNREAD, INSTANT delay with pending not observable, AD-7, NO-GOV-CHANNEL', () => {
    const route = out.state.items.find((i) => i.key.startsWith('bridge/lz/1/'))!
    expect(route.breaches.map((b) => b.ruleId)).toEqual(['BR-2'])
    expect(out.state.counts.floorBreaches).toBe(1)
    expect(out.state.items.some((i) => i.display.includes('REMOTE UNREAD'))).toBe(true)
    expect(out.state.powers[0].effectiveDelaySec).toBe(0)
    expect(out.state.powers[0].pendingObservable).toBe(false)
    expect(out.state.items.find((i) => i.key.startsWith('admin/power'))!.display).toMatch(
      /INSTANT · pending changes not observable/,
    )
    expect(
      out.state.items.find((i) => i.key.startsWith('admin/timelock_admin'))!.breaches[0].ruleId,
    ).toBe('AD-7')
    expect(out.state.announcement).toBe('no_gov_channel')
    expect(out.state.proposedSources.find((p) => p.kind === 'safe_tx_service')!.status).toBe(
      'unavailable',
    )
    expect(
      out.state.proposedSources.filter((p) => p.status === 'not_ingested').map((p) => p.kind),
    ).toEqual(['snapshot', 'discourse'])
  })
})

describe('AD-6 at head: Safe fields that change without an event are diffed run to run', () => {
  it('a guard replaced between runs is a red bracketed change', () => {
    const SAFE = '0x' + 'a'.repeat(40)
    const subject: ConfigSubject = {
      key: 'y',
      label: 'Y',
      oracleAssetKey: null,
      class: 'lrt',
      contracts: [],
      lzOApps: [],
      ccipPools: [],
      powers: [],
      params: [],
      timelocks: [],
      safes: [SAFE],
      govChannels: [],
    }
    const now = {
      kind: 'safe' as const,
      address: SAFE,
      threshold: 3,
      signers: 5,
      guard: '0x' + 'b'.repeat(40),
      modules: [],
    }
    const raw: RawSubject = {
      version: 1,
      subjectKey: 'y',
      head: { block: 2000, ts: 1 },
      scan: { from: 1, to: 2000 },
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
        controllers: { [`${SAFE}@head`]: now },
        powers: [],
        timelockAdmins: [],
        implHistory: {},
        owners: {},
        delegates: {},
        minDelays: {},
        previousSafes: {
          block: 1000,
          controllers: { [SAFE]: { ...now, guard: '0x' + 'c'.repeat(40) } },
        },
      },
      params: { head: {}, transitions: [] },
      queues: { ops: [], safe: [], safeStatus: [] },
      ccip: { pools: [] },
      warnings: [],
    }
    const reg = { byChain: {}, dead: {}, libraries: {} }
    const out = buildSubject(subject, raw, {
      registry: reg,
      eidName: String,
      roleName: (h) => h,
      endpoint: '0x',
    })
    const c = out.changes.find((x) => x.key.endsWith('/guard'))!
    expect(c.red).toBe(true)
    expect(c.ruleIds).toEqual(['AD-6'])
    expect([c.blockFrom, c.block]).toEqual([1000, 2000])
    expect(out.state.safeSnapshot![0].guard).toBe('0x' + 'b'.repeat(40))
  })
})

describe('collect-config CLI', () => {
  it('dies on an RPC error without printing the RPC URL or its key', () => {
    const FAKE_KEY = 'FAKEKEY_cafebabe'
    const r = spawnSync(
      process.execPath,
      [
        join(process.cwd(), 'scripts', 'oracle-registry', 'config', 'collect-config.mjs'),
        '--only=cbbtc',
      ],
      {
        env: { ...process.env, ORACLE_REGISTRY_RPC_URL: `http://127.0.0.1:9/eth/${FAKE_KEY}` },
        encoding: 'utf8',
        timeout: 90_000,
      },
    )
    const out = `${r.stdout}\n${r.stderr}`
    expect(r.status).toBe(1)
    expect(out).not.toContain(FAKE_KEY)
    expect(out).not.toContain('127.0.0.1:9')
    expect(r.stderr).toMatch(/collect-config failed/)
  }, 120_000)
})

// ---- review fixes 2026-10-06: the engine must never read a failed read or a bypass as calm ----------
describe('engine review fixes', () => {
  const RECV = '0xc02ab410f0734efa3f14628780e6e695156024c2'
  const NM = '0xa59ba433ac34d2927232918ef5b2eaafcf130ba5'
  const SAFE = '0x' + 'a'.repeat(40)
  const TL = '0x' + 'c'.repeat(40)
  const CTRL = '0x' + 'b'.repeat(40)
  const MS = '0x' + '7'.repeat(40)
  const REMOTE = '0x' + '4'.repeat(40)
  const PEER = '0x' + '0'.repeat(24) + REMOTE.slice(2)
  const uln = (req: string[]) => ({
    confirmations: '15',
    requiredDVNCount: req.length,
    optionalDVNCount: 0,
    optionalDVNThreshold: 0,
    requiredDVNs: req,
    optionalDVNs: [],
  })
  const reg: DvnRegistry = {
    byChain: {
      1: { [LZ]: { id: 'layerzero-labs', name: 'LZ' }, [NM]: { id: 'nethermind', name: 'NM' } },
      42161: { [LZ]: { id: 'layerzero-labs', name: 'LZ' }, [NM]: { id: 'nethermind', name: 'NM' } },
    },
    dead: { 1: [], 42161: [] },
    libraries: {
      1: { send: [], receive: [RECV], blocked: [], read: [] },
      42161: { send: [RECV], receive: [RECV], blocked: [], read: [] },
    },
  }
  const subject: ConfigSubject = {
    key: 'z',
    label: 'Z',
    oracleAssetKey: null,
    class: 'lrt',
    contracts: [
      {
        role: 'oft_adapter',
        dimension: 'bridge',
        chainId: 1,
        address: OAPP,
        label: 'a',
        deployBlock: 1,
      },
    ],
    lzOApps: [OAPP],
    ccipPools: [],
    powers: [],
    params: [],
    timelocks: [],
    safes: [],
    govChannels: [],
  }
  const rawOf = (o: {
    headRoutes?: RawSubject['lz']['headRoutes']
    remote?: RawSubject['lz']['remote']
    previousRemote?: RawSubject['lz']['previousRemote']
    admin?: Partial<RawSubject['admin']>
    oracle?: RawSubject['oracle']
    events?: RawSubject['lz']['events']
  }): RawSubject => ({
    version: 1,
    subjectKey: 'z',
    head: { block: 1000, ts: 2000 },
    scan: { from: 1, to: 1000 },
    lz: {
      events: o.events ?? [],
      headRoutes: o.headRoutes ?? [],
      headDefaults: {},
      remote: o.remote ?? [],
      codeProbes: { [LZ]: { firstCode: 1 }, [NM]: { firstCode: 1 } },
      dvnSigner: [],
      dvnHead: {},
      previousRemote: o.previousRemote,
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
      ...o.admin,
    },
    params: { head: {}, transitions: [] },
    queues: { ops: [], safe: [], safeStatus: [] },
    ccip: { pools: [] },
    oracle: o.oracle,
    warnings: [],
  })
  const build = (raw: RawSubject, s: ConfigSubject = subject) =>
    buildSubject(s, raw, {
      registry: reg,
      eidName: () => 'arbitrum',
      roleName: (h) => h,
      endpoint: '0x1a44076050125825900e736c501f859c50fe728c',
    })
  const head = (o: Partial<RawSubject['lz']['headRoutes'][number]> = {}) => ({
    oapp: OAPP,
    eid: 30110,
    direction: 'receive' as const,
    lib: RECV,
    libIsDefault: false,
    merged: uln([LZ, NM]),
    app: null,
    peer: PEER,
    ...o,
  })
  const remoteOk = (o: Partial<RawSubject['lz']['remote'][number]> = {}) => ({
    oapp: OAPP,
    eid: 30110,
    chainKey: 'arbitrum',
    chainId: 42161,
    status: 'ok' as const,
    peer: REMOTE,
    peerBack: '0x' + '0'.repeat(24) + OAPP.slice(2),
    directions: {
      receive: { lib: RECV, merged: uln([LZ, NM]) },
      send: { lib: RECV, merged: uln([LZ, NM]) },
    },
    dvnCode: { [LZ]: true, [NM]: true },
    ...o,
  })

  it('a local getConfig READ failure is UNREAD, not "blocked (no_dvn)" — only a library revert is', () => {
    const out = build(rawOf({ headRoutes: [head({ merged: null, mergedError: 'HTTP 503' })] }))
    const it0 = out.state.items.find((i) => i.key.endsWith('/30110/receive'))!
    expect(it0.display).toMatch(/UNREAD/)
    expect(it0.display).not.toMatch(/blocked/)
    expect(it0.warnings).toContain('UNREAD')
    const rev = build(rawOf({ headRoutes: [head({ merged: null, mergedReverted: true })] }))
    expect(rev.state.items.find((i) => i.key.endsWith('/30110/receive'))!.display).toMatch(
      /blocked \(no_dvn\)/,
    )
  })

  it('remote: a failed receive read, a failed peer read and a failed getConfig never look calm', () => {
    const failRecv = build(
      rawOf({
        headRoutes: [head()],
        remote: [
          remoteOk({ directions: { receive: null, send: { lib: RECV, merged: uln([LZ, NM]) } } }),
        ],
      }),
    )
    const recvItem = failRecv.state.items.find(
      (i) => i.key === `bridge/lz/42161/${REMOTE}/30101/receive`,
    )!
    expect(recvItem.warnings).toContain('REMOTE UNREAD')
    // peer read failed + remote receive at 1-of-1: still a floor breach (liveness assumed)
    const noPeer = build(
      rawOf({
        headRoutes: [head()],
        remote: [
          remoteOk({
            peerBack: null,
            directions: {
              receive: { lib: RECV, merged: uln([LZ]) },
              send: { lib: RECV, merged: uln([LZ, NM]) },
            },
          }),
        ],
      }),
    )
    const r = noPeer.state.items.find((i) => i.key === `bridge/lz/42161/${REMOTE}/30101/receive`)!
    expect(r.breaches.map((b) => b.ruleId)).toContain('BR-2')
    expect(r.warnings?.join()).toMatch(/not read/)
    const nullMerged = build(
      rawOf({
        headRoutes: [head()],
        remote: [
          remoteOk({
            directions: {
              receive: { lib: RECV, merged: null, mergedError: 'timeout' },
              send: { lib: RECV, merged: uln([LZ, NM]) },
            },
          }),
        ],
      }),
    )
    const nm = nullMerged.state.items.find(
      (i) => i.key === `bridge/lz/42161/${REMOTE}/30101/receive`,
    )!
    expect(nm.warnings).toContain('REMOTE UNREAD')
    expect(nm.display).not.toMatch(/blocked/)
  })

  it('remote history: a remote downgrade between two runs is a red bracketed change', () => {
    const first = build(rawOf({ headRoutes: [head()], remote: [remoteOk()] }))
    const snap = first.state.remoteSnapshot!
    expect(Object.keys(snap)).toContain(`bridge/lz/42161/${REMOTE}/30101/receive`)
    const second = build(
      rawOf({
        headRoutes: [head()],
        remote: [
          remoteOk({
            directions: {
              receive: { lib: RECV, merged: uln([LZ]) },
              send: { lib: RECV, merged: uln([LZ, NM]) },
            },
          }),
        ],
        previousRemote: { block: 900, routes: JSON.parse(JSON.stringify(snap)) },
      }),
    )
    const c = second.changes.find((x) => x.key === `bridge/lz/42161/${REMOTE}/30101/receive`)!
    expect(c.red).toBe(true)
    expect(c.ruleIds).toEqual(expect.arrayContaining(['BR-1', 'BR-2']))
    expect(c.tags).toContain('bracketed')
    expect([c.blockFrom, c.block]).toEqual([900, 1000])
  })

  it('AD-1 without an event: a Safe threshold lowered between runs (delegatecall) is red', () => {
    const now = { kind: 'safe' as const, address: SAFE, threshold: 1, signers: 7, modules: [] }
    // the Safe must be THIS subject's (review 3: a Safe outside its graph never shows here)
    const out = build(
      rawOf({
        admin: {
          controllers: { [`${SAFE}@head`]: now },
          previousSafes: { block: 900, controllers: { [SAFE]: { ...now, threshold: 4 } } },
        },
      }),
      { ...subject, safes: [SAFE] },
    )
    const c = out.changes.find((x) => x.key === `admin/multisig/${SAFE}`)!
    expect(c.red).toBe(true)
    expect(c.ruleIds).toContain('AD-1')
  })

  it('pending changes not observable through an ownership chain (contract → 6-of-10 multisig)', () => {
    const out = build(
      rawOf({
        admin: {
          powers: [{ power: 'mint', label: 'mint', contract: CTRL, holders: [CTRL] }],
          controllers: {
            [`${CTRL}@head`]: {
              kind: 'contract',
              address: CTRL,
              ownedBy: { kind: 'legacy_multisig', address: MS, threshold: 6, signers: 10 },
            },
          },
        },
      }),
    )
    expect(out.state.powers[0].effectiveDelaySec).toBe(0)
    expect(out.state.powers[0].pendingObservable).toBe(false)
  })

  it('a timelock bypass: whitelisted functions on the contract or an unrestricted bypasser are INSTANT', () => {
    const wl = {
      kind: 'oz_timelock' as const,
      address: TL,
      delaySec: 86400,
      bypass: {
        fn: 'executeWhitelisted',
        scope: 'whitelist' as const,
        targets: { [OAPP]: ['setPeer(uint32,bytes32)'] },
      },
    }
    const out = build(
      rawOf({
        admin: {
          powers: [
            { power: 'bridge_config', label: 'adapter owner', contract: OAPP, holders: [TL] },
            { power: 'upgrade', label: 'other', contract: CTRL, holders: [TL] },
          ],
          controllers: { [`${TL}@head`]: wl },
        },
      }),
    )
    expect(out.state.powers[0].effectiveDelaySec).toBe(0)
    expect(out.state.powers[0].pendingObservable).toBe(false)
    const item = out.state.items.find((i) => i.key === `admin/power/bridge_config/${OAPP}`)!
    expect(item.display).toMatch(/INSTANT \(timelock bypass\)/)
    expect(item.warnings?.join()).toMatch(/setPeer/)
    // a contract with no whitelisted function keeps the delay
    expect(out.state.powers[1].effectiveDelaySec).toBe(86400)
    const any = build(
      rawOf({
        admin: {
          powers: [{ power: 'bridge_config', label: 'pool owner', contract: CTRL, holders: [TL] }],
          controllers: {
            [`${TL}@head`]: {
              ...wl,
              delaySec: 10800,
              bypass: { fn: 'bypasserExecuteBatch', scope: 'any', holders: [MS] },
            },
          },
        },
      }),
    )
    expect(any.state.powers[0].effectiveDelaySec).toBe(0)
    expect(any.state.powers[0].pendingObservable).toBe(false)
  })

  it('OR-1 is wired: an oracle source moved to an EOA, and a CAPO growth bound raised, are red', () => {
    const SRC = '0x' + '9'.repeat(40)
    const ORA = '0x' + '8'.repeat(40)
    const out = build(
      rawOf({
        admin: { controllers: { [`${SRC}@500`]: { kind: 'eoa', address: SRC } } },
        oracle: {
          events: [
            {
              block: 500,
              tx: '0x1',
              logIndex: 0,
              emitter: ORA,
              event: 'AssetSourceUpdated',
              args: { asset: CTRL, source: SRC },
              entryIds: ['e1'],
            },
            {
              block: 600,
              tx: '0x2',
              logIndex: 0,
              emitter: ORA,
              event: 'CapParametersUpdated',
              args: { maxYearlyRatioGrowthPercent: 875 },
              entryIds: ['e2'],
            },
            {
              block: 700,
              tx: '0x3',
              logIndex: 0,
              emitter: ORA,
              event: 'CapParametersUpdated',
              args: { maxYearlyRatioGrowthPercent: 1117 },
              entryIds: ['e2'],
            },
          ],
        },
      }),
    )
    const src = out.changes.find((c) => c.tx === '0x1')!
    expect(src.red).toBe(true)
    expect(src.ruleIds).toContain('OR-1')
    expect(out.changes.find((c) => c.tx === '0x2')!.red).toBe(false)
    const capo = out.changes.find((c) => c.tx === '0x3')!
    expect(capo.red).toBe(true)
    expect(capo.ruleIds).toContain('OR-1')
  })

  it('STILL IN EFFECT: a BR-1 downgrade followed by a neutral same-count DVN swap is still in effect', () => {
    const NM2 = '0x' + '6'.repeat(40)
    const reg2: DvnRegistry = {
      ...reg,
      byChain: {
        ...reg.byChain,
        1: { ...reg.byChain[1], [NM2]: { id: 'google-cloud', name: 'G' } },
      },
    }
    const GG = '0x' + '5'.repeat(40)
    const reg3: DvnRegistry = {
      ...reg2,
      byChain: {
        ...reg2.byChain,
        1: { ...reg2.byChain[1], [GG]: { id: 'horizen-labs', name: 'H' } },
      },
    }
    const ev = (block: number, req: string[]): RawSubject['lz']['events'][number] => ({
      chainId: 1,
      block,
      tx: `0x${block}`,
      logIndex: 0,
      kind: 'uln',
      lib: RECV,
      oapp: OAPP,
      eid: 30110,
      config: uln(req),
    })
    const raw = rawOf({
      events: [
        {
          chainId: 1,
          block: 1,
          tx: '0x01',
          logIndex: 0,
          kind: 'default_recv_lib',
          eid: 30110,
          lib: RECV,
        },
        {
          chainId: 1,
          block: 2,
          tx: '0x02',
          logIndex: 0,
          kind: 'peer',
          oapp: OAPP,
          eid: 30110,
          peer: PEER,
        },
        ev(3, [LZ, NM, NM2]),
        ev(10, [LZ, NM]), // BR-1 3 → 2
        ev(20, [LZ, GG]), // same count, other operator: neutral
      ],
      headRoutes: [head({ merged: uln([LZ, GG]) })],
    })
    raw.lz.codeProbes = {
      [LZ]: { firstCode: 1 },
      [NM]: { firstCode: 1 },
      [NM2]: { firstCode: 1 },
      [GG]: { firstCode: 1 },
    }
    const out = buildSubject(subject, raw, {
      registry: reg3,
      eidName: () => 'arbitrum',
      roleName: (h) => h,
      endpoint: '0x1a44076050125825900e736c501f859c50fe728c',
    })
    const down = out.changes.find((c) => c.tx === '0x10' && c.route?.direction === 'receive')!
    expect(down.ruleIds).toContain('BR-1')
    expect(down.stillInEffect).toBe(true)
  })
})

// ---- collector review fixes 2026-10-06 (pure helpers and fake clients: no network) -----------------
describe('collector: classification from code, not from self-reported views (review fix)', () => {
  const sel = (sig: string) => toFunctionSelector(`function ${sig}`).slice(2)
  const codeWith = (sigs: string[]) =>
    '0x6080' + sigs.map((x) => '63' + sel(x) + '14').join('') + '00'
  const TL_SIGS = [
    'getMinDelay()',
    'getTimestamp(bytes32)',
    'schedule(address,uint256,bytes,bytes32,bytes32,uint256)',
    'execute(address,uint256,bytes,bytes32,bytes32)',
    'hashOperation(address,uint256,bytes,bytes32,bytes32)',
  ]
  // a fake JSON-RPC client: views answered by name, raw storage by slot, everything else reverts
  const fake = (o: {
    code: string
    views?: Record<string, unknown>
    storage?: Record<string, string>
    reads?: Record<string, unknown>
  }) => ({
    getCode: async () => o.code,
    getBlockNumber: async () => 1000n,
    multicall: async ({ contracts }: { contracts: { functionName: string }[] }) =>
      contracts.map((c) =>
        o.views && c.functionName in o.views
          ? { status: 'success', result: o.views[c.functionName] }
          : { status: 'failure' },
      ),
    getStorageAt: async ({ slot }: { slot: string }) =>
      o.storage?.[BigInt(slot).toString()] ?? '0x' + '0'.repeat(64),
    readContract: async ({ functionName }: { functionName: string }) => {
      if (o.reads && functionName in o.reads) return o.reads[functionName]
      throw Object.assign(new Error('execution reverted'), {
        name: 'ContractFunctionRevertedError',
      })
    },
    request: async () => [],
  })
  const A = '0x' + '1'.repeat(40)
  it('a contract that only answers getMinDelay() = 365d is NOT a timelock', async () => {
    const c = await classify(fake({ code: '0x6080604052', views: { getMinDelay: 31_536_000n } }), A)
    expect(c.kind).toBe('contract')
    const real = await classify(
      fake({ code: codeWith(TL_SIGS), views: { getMinDelay: 86400n } }),
      A,
    )
    expect(real.kind).toBe('oz_timelock')
  })
  it('a 10-of-11 "Safe" with no canonical singleton in slot 0 is NOT a Safe', async () => {
    const owners = Array.from({ length: 11 }, (_, i) => '0x' + String(i + 1).padStart(40, '0'))
    const fakeSafe = await classify(
      fake({ code: '0x6080', views: { getThreshold: 10n, getOwners: owners } }),
      A,
    )
    expect(fakeSafe.kind).toBe('contract')
    // the views stay as information (history can replay the threshold); the rank is a contract's
    expect((fakeSafe as { threshold?: number }).threshold).toBe(10)
    const real = await classify(
      fake({
        code: '0x6080',
        views: { getThreshold: 4n, getOwners: owners.slice(0, 7), VERSION: '1.3.0' },
        storage: { '0': '0x' + '0'.repeat(24) + 'd9db270c1b5e3bd161e8c8503c55ceabee709552' },
        reads: { getModulesPaginated: [[], '0x0000000000000000000000000000000000000001'] },
      }),
      A,
    )
    expect(real.kind).toBe('safe')
    expect((real as { threshold?: number }).threshold).toBe(4)
  })
  it('a timelock with bypasserExecuteBatch and a bypasser holder: unrestricted bypass', async () => {
    const c = await classify(
      fake({
        code: codeWith([
          'getMinDelay()',
          'getTimestamp(bytes32)',
          'scheduleBatch((address,uint256,bytes)[],bytes32,bytes32,uint256)',
          'executeBatch((address,uint256,bytes)[],bytes32,bytes32)',
          'bypasserExecuteBatch((address,uint256,bytes)[])',
        ]),
        views: { getMinDelay: 10800n },
        reads: {
          BYPASSER_ROLE: '0x' + 'ab'.repeat(32),
          getRoleMemberCount: 1n,
          getRoleMember: '0x' + '7'.repeat(40),
        },
      }),
      A,
    )
    expect(c.kind).toBe('oz_timelock')
    expect((c as { bypass?: unknown }).bypass).toEqual({
      fn: 'bypasserExecuteBatch',
      scope: 'any',
      holders: ['0x' + '7'.repeat(40)],
    })
    expect(isTimelockCode(codeWith(TL_SIGS))).toBe(true)
    expect(isTimelockCode('0x6080')).toBe(false)
  })
})

describe('collector: timelock op state fails closed; salts recovered from the schedule tx (review fix)', () => {
  const TL = '0x' + 'c'.repeat(40)
  const TGT = '0x' + 'd'.repeat(40)
  const SAFE = '0x' + 'a'.repeat(40)
  const ZERO32 = ('0x' + '0'.repeat(64)) as `0x${string}`
  const SALT = ('0x' + '5a'.repeat(32)) as `0x${string}`
  const calls = [
    { target: TGT, value: '0', data: '0x3659cfe6' + '0'.repeat(24) + 'e'.repeat(40) },
    { target: TGT, value: '0', data: '0x8456cb59' },
  ]
  const op = () => {
    const o: Record<string, unknown> = {
      timelock: TL,
      calls: calls.map((c) => ({ ...c })),
      predecessor: ZERO32,
      delaySec: 864000,
      scheduledBlock: 10,
      scheduledTx: '0x' + '1'.repeat(64),
      salt: null,
    }
    o.id = hashOp(o, SALT, true)
    return o
  }
  // the schedule call wrapped in a Safe execTransaction (pre-4.9 OZ: no CallSalt event)
  const scheduleData = encodeFunctionData({
    abi: parseAbi([
      'function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)',
    ]),
    functionName: 'scheduleBatch',
    args: [
      calls.map((c) => c.target as `0x${string}`),
      [0n, 0n],
      calls.map((c) => c.data as `0x${string}`),
      ZERO32,
      SALT,
      864000n,
    ],
  })
  const wrapped = encodeFunctionData({
    abi: parseAbi([
      'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures)',
    ]),
    functionName: 'execTransaction',
    args: [
      TL as `0x${string}`,
      0n,
      scheduleData,
      0,
      0n,
      0n,
      0n,
      ('0x' + '0'.repeat(40)) as `0x${string}`,
      ('0x' + '0'.repeat(40)) as `0x${string}`,
      '0x',
    ],
  })
  const client = (o: { ts?: () => unknown; call?: () => unknown }) => ({
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'getTimestamp') return (o.ts ?? (() => 500n))()
      throw Object.assign(new Error('execution reverted'), {
        name: 'ContractFunctionRevertedError',
      })
    },
    getTransaction: async () => ({ input: wrapped }),
    call: async () => (o.call ?? (() => ({ data: '0x' })))(),
  })
  it('recovers the salt from Safe-wrapped scheduleBatch calldata and arms the op', async () => {
    expect(recoverSalt(wrapped, op())).toEqual({ salt: SALT, batch: true })
    const [o] = await readOps(client({}), [op()], { now: 1000, executorsOf: async () => [SAFE] })
    expect(o.simulation).toBe('ok')
  })
  it('an RPC error during execute is "error" (not a revert); a failed getTimestamp is null, not 0', async () => {
    const [e] = await readOps(
      client({
        call: () => {
          throw Object.assign(new Error('fetch failed'), { name: 'HttpRequestError' })
        },
      }),
      [op()],
      { now: 1000, executorsOf: async () => [SAFE] },
    )
    expect(e.simulation).toBe('error')
    const [r] = await readOps(
      client({
        call: () => {
          throw Object.assign(new Error('reverted'), { name: 'ContractFunctionRevertedError' })
        },
      }),
      [op()],
      { now: 1000, executorsOf: async () => [SAFE] },
    )
    expect(r.simulation).toBe('revert')
    const [u] = await readOps(
      client({
        ts: () => {
          throw Object.assign(new Error('timeout'), { name: 'TimeoutError' })
        },
      }),
      [op()],
      { now: 1000, executorsOf: async () => [SAFE] },
    )
    expect(u.timestamp).toBeNull()
  }, 20_000)
})

describe('collector: getter polling keeps every change and its own transaction (review fix)', () => {
  const A1 = '0x' + '1302'.padEnd(40, '0')
  const A2 = '0x' + '8fde'.padEnd(40, '0')
  const A3 = '0x' + '2b5b'.padEnd(40, '0')
  it('A → B → C between two grid points is two changes, each with the value read at its block', async () => {
    const at = (b: number) => (b < 464 ? A1 : b < 1065 ? A2 : A3)
    const steps = await bisectChanges(async (b: number) => at(b), {
      lo: 0,
      before: A1,
      hi: 5000,
      last: A3,
    })
    expect(
      steps.map((s: { block: number; before: string; after: string }) => [
        s.block,
        s.before,
        s.after,
      ]),
    ).toEqual([
      [464, A1, A2],
      [1065, A2, A3],
    ])
  })
  it('the transaction is the one whose logs name the new value, not the first log of the block', () => {
    const logs = [
      {
        transactionHash: '0xpauser',
        topics: ['0xt', '0x' + '0'.repeat(24) + 'fd0a'.padEnd(40, '0')],
        data: '0x',
      },
      {
        transactionHash: '0xminter',
        topics: ['0xt', '0x' + '0'.repeat(24) + A2.slice(2)],
        data: '0x',
      },
    ]
    expect(pickTx(logs, A2)).toBe('0xminter')
    expect(pickTx(logs, '0x' + '9'.repeat(40))).toBeNull()
    expect(pickTx([logs[1]], undefined)).toBe('0xminter')
  })
})

describe('collector: a revert is not a failed read (review fix)', () => {
  it('tryRead marks a contract revert, and only a revert, as reverted', async () => {
    const abi = parseAbi(['function f() view returns (uint256)'])
    const rev = await tryRead(
      {
        readContract: async () => {
          throw Object.assign(new Error('x'), {
            name: 'ContractFunctionExecutionError',
            cause: Object.assign(new Error('AtLeastOneDVN'), {
              name: 'ContractFunctionRevertedError',
            }),
          })
        },
      },
      '0x' + '1'.repeat(40),
      abi,
      'f',
    )
    expect(rev).toMatchObject({ ok: false, reverted: true })
    const net = await tryRead(
      {
        readContract: async () => {
          throw Object.assign(new Error('x'), {
            name: 'ContractFunctionExecutionError',
            cause: Object.assign(new Error('503'), { name: 'HttpRequestError' }),
          })
        },
      },
      '0x' + '1'.repeat(40),
      abi,
      'f',
    )
    expect(net).toMatchObject({ ok: false, reverted: false })
    expect(isRevertError({ name: 'TimeoutError' })).toBe(false)
  }, 20_000)
})

describe('STILL IN EFFECT refinement: a red grant ends when the role is revoked', () => {
  it('a red role grant to an EOA, later revoked, is not still in effect', () => {
    const TOK = '0x' + '3'.repeat(40)
    const BOT = '0x' + '9'.repeat(40)
    const subject: ConfigSubject = {
      key: 'r',
      label: 'R',
      oracleAssetKey: null,
      class: 'lrt',
      contracts: [
        { role: 'token', dimension: 'admin', chainId: 1, address: TOK, label: 't', deployBlock: 1 },
      ],
      lzOApps: [],
      ccipPools: [],
      powers: [],
      params: [],
      timelocks: [],
      safes: [],
      govChannels: [],
    }
    const ev = (event: string, block: number) => ({
      chainId: 1,
      block,
      logIndex: 0,
      tx: `0x${block}`,
      emitter: TOK,
      event,
      args: { role: '0x' + '0'.repeat(64), roleName: 'DEFAULT_ADMIN_ROLE', account: BOT },
    })
    const raw: RawSubject = {
      version: 1,
      subjectKey: 'r',
      head: { block: 1000, ts: 1 },
      scan: { from: 1, to: 1000 },
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
        events: [ev('RoleGranted', 100), ev('RoleRevoked', 200)],
        controllers: { [`${BOT}@100`]: { kind: 'eoa', address: BOT } },
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
      warnings: [],
    }
    const out = buildSubject(subject, raw, {
      registry: { byChain: {}, dead: {}, libraries: {} },
      eidName: String,
      roleName: (h) => h,
      endpoint: '0x',
    })
    const grant = out.changes.find((c) => c.tx === '0x100')!
    expect(grant.red).toBe(true)
    expect(grant.stillInEffect).toBeFalsy()
  })
})
