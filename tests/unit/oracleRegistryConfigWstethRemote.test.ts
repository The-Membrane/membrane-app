// wstETH (Lido) audit, 2026-10-07 (second pass): what the card still could not see.
//   - the REMOTE side of the Wormhole NTT route (the BNB Chain manager): read at head with that
//     chain's public client (readNttRemote): threshold + transceivers (BR-2 floor / BR-7 there),
//     its peer back to Ethereum, owner / pauser classified on that chain (AD-3 when EOA-controlled),
//     and the wstETH supply there (severity rank, owner ruling #9); an unread side is a read gap
//   - the redemption path: the WithdrawalQueue's pause switch and upgrade path are declared
// No network: fake clients answer by (address, function).

import { describe, expect, it } from 'vitest'
import { keccak256, toHex } from 'viem'

import {
  buildSubject,
  nttRemoteGaps,
  nttRemoteLines,
  type NttHead,
  type NttRemoteHead,
  type RawSubject,
} from '@/lib/oracleRegistry/config/engine'
import { hasFloorRoutes, headline } from '@/components/OracleRegistry/configViewModel'
import type { ConfigCounts } from '@/lib/oracleRegistry/config/apiTypes'
import { isPrivilegedRole, PAUSE_ROLES } from '@/lib/oracleRegistry/config/rules'
import { getConfigSubjects } from '@/lib/oracleRegistry/config/subjects'
import type { ConfigSubject, Controller } from '@/lib/oracleRegistry/config/types'
import type { DvnRegistry } from '@/lib/oracleRegistry/config/uln'
import { roleName } from '@/scripts/oracle-registry/config/lib/abi.mjs'
import {
  WORMHOLE_ETHEREUM,
  WORMHOLE_EVM_CHAINS,
  nttRemoteTargets,
  readNttRemote,
} from '@/scripts/oracle-registry/config/lib/admin.mjs'
import { tokenVote } from './oracleRegistryVoteFixtures'

type Hx = `0x${string}`
const A = (n: string) => ('0x' + n.repeat(40).slice(0, 40)) as Hx
const AGENT = A('3')
const EXEC = A('5')
const EPT = A('6')
const NTT = A('b')
const WH = A('c')
const AX = A('d')
const TOKEN = A('f')
const BSC_NTT = '0x' + '61'.repeat(20)
const BSC_WH = '0x' + '62'.repeat(20)
const BSC_TOKEN = '0x' + '63'.repeat(20)
const BSC_OWNER = '0x' + '64'.repeat(20)
const BSC_PAUSER = '0x' + '65'.repeat(20)
const ZERO = '0x' + '0'.repeat(40)
const word = (a: string) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase()
const revert = () =>
  Object.assign(new Error('execution reverted'), { name: 'ContractFunctionRevertedError' })

/** A fake client: code per address, view answers per `${address}|${fn}` (a function = per args). */
function fake(o: { code?: Record<string, string>; reads?: Record<string, unknown> }) {
  const lc = (x: string) => x.toLowerCase()
  return {
    getCode: async ({ address }: { address: string }) => o.code?.[lc(address)] ?? '0x',
    getBlockNumber: async () => 1000n,
    multicall: async ({
      contracts,
    }: {
      contracts: { address: string; functionName: string; args?: unknown[] }[]
    }) =>
      contracts.map((c) => {
        const v = o.reads?.[`${lc(c.address)}|${c.functionName}`]
        if (v === undefined) return { status: 'failure' }
        return { status: 'success', result: typeof v === 'function' ? v(c.args ?? []) : v }
      }),
    getStorageAt: async () => '0x' + '0'.repeat(64),
    readContract: async ({
      address,
      functionName,
      args,
    }: {
      address: string
      functionName: string
      args?: unknown[]
    }) => {
      const v = o.reads?.[`${lc(address)}|${functionName}`]
      if (v === undefined) throw revert()
      return typeof v === 'function' ? v(args ?? []) : v
    },
    request: async () => [],
  }
}

/** The BNB Chain side as read on 2026-10-07: 2-of-2 Wormhole + Axelar, burning, 1,179.27 wstETH. */
const bscReads = (o: Record<string, unknown> = {}) => ({
  [`${BSC_NTT}|getThreshold`]: 2,
  [`${BSC_NTT}|getTransceivers`]: [BSC_WH, AX],
  [`${BSC_WH}|getTransceiverType`]: 'wormhole',
  [`${AX}|getTransceiverType`]: 'axelar',
  [`${BSC_WH}|getWormholePeer`]: (args: unknown[]) =>
    Number(args[0]) === 2 ? word(WH) : '0x' + '0'.repeat(64),
  [`${BSC_NTT}|getPeer`]: (args: unknown[]) =>
    Number(args[0]) === 2
      ? { peerAddress: word(NTT), tokenDecimals: 18 }
      : { peerAddress: '0x' + '0'.repeat(64), tokenDecimals: 0 },
  [`${BSC_NTT}|token`]: BSC_TOKEN,
  [`${BSC_NTT}|getMode`]: 1,
  [`${BSC_NTT}|owner`]: BSC_OWNER,
  [`${BSC_NTT}|pauser`]: BSC_PAUSER,
  [`${BSC_NTT}|isPaused`]: false,
  [`${BSC_TOKEN}|totalSupply`]: 1_179_271_546_140_000_000_000n,
  [`${BSC_TOKEN}|decimals`]: 18,
  ...o,
})

// =====================================================================================================
describe('collector: the remote side of a Wormhole NTT route', () => {
  it('maps Wormhole chain ids to EVM chains; only live peers are targets; an unmapped chain is null, never guessed', () => {
    expect(WORMHOLE_ETHEREUM).toBe(2)
    expect(WORMHOLE_EVM_CHAINS[4]).toBe(56)
    expect(WORMHOLE_EVM_CHAINS[2]).toBe(1)
    const t = nttRemoteTargets({
      peers: {
        4: { peer: word(BSC_NTT), decimals: 18 },
        5: { peer: '0x' + '0'.repeat(64), decimals: 18 },
        999: { peer: word(BSC_NTT), decimals: 18 },
        6: null,
      },
    })
    expect(t).toEqual([
      { wormholeChainId: 4, chainId: 56, peer: word(BSC_NTT) },
      { wormholeChainId: 999, chainId: null, peer: word(BSC_NTT) },
    ])
    expect(nttRemoteTargets(null)).toEqual([])
  })

  it('readNttRemote: threshold, transceivers, the peer back to Ethereum, owner / pauser classified there, bridged supply', async () => {
    const c = fake({ code: { [BSC_OWNER]: '0x6080600052' }, reads: bscReads() })
    const r = await readNttRemote(c, {
      wormholeChainId: 4,
      chainId: 56,
      chainKey: 'bsc',
      peer: word(BSC_NTT),
    })
    expect(r).toMatchObject({
      status: 'ok',
      chainKey: 'bsc',
      manager: BSC_NTT,
      mode: 'burning',
      threshold: 2,
      peerBack: { peer: word(NTT), decimals: 18 },
      owner: { kind: 'contract', address: BSC_OWNER },
      pauser: { kind: 'eoa', address: BSC_PAUSER },
      paused: false,
      supply: { raw: '1179271546140000000000', decimals: 18 },
    })
    const side = r as NttRemoteHead
    expect(side.transceivers!.map((t) => t.type)).toEqual(['wormhole', 'axelar'])
    // the remote Wormhole transceiver's peer for Ethereum is read too
    expect(side.transceivers![0].peers).toEqual({ 2: word(WH) })
  })

  it('readNttRemote: a locking remote has no bridged supply (said why); a dead RPC / a non-EVM peer is remote_unread', async () => {
    const lock = (await readNttRemote(fake({ reads: bscReads({ [`${BSC_NTT}|getMode`]: 0 }) }), {
      wormholeChainId: 4,
      chainId: 56,
      chainKey: 'bsc',
      peer: word(BSC_NTT),
    })) as NttRemoteHead
    expect(lock.supply).toBeNull()
    expect(lock.supplyNote).toMatch(/LOCKS/)
    const dead = await readNttRemote(fake({}), {
      wormholeChainId: 4,
      chainId: 56,
      chainKey: 'bsc',
      peer: word(BSC_NTT),
    })
    expect(dead).toMatchObject({
      status: 'remote_unread',
      reason: expect.stringMatching(/every remote read failed/),
    })
    const solana = await readNttRemote(fake({ reads: bscReads() }), {
      wormholeChainId: 1,
      chainId: null,
      chainKey: null,
      peer: '0x' + 'ab'.repeat(32),
    })
    expect(solana).toMatchObject({
      status: 'remote_unread',
      reason: expect.stringMatching(/right-aligned EVM/),
    })
  }, 20_000)
})

// =====================================================================================================
const remoteOk = (o: Partial<NttRemoteHead> = {}): NttRemoteHead => ({
  wormholeChainId: 4,
  chainId: 56,
  chainKey: 'bsc',
  status: 'ok',
  manager: BSC_NTT,
  token: BSC_TOKEN,
  mode: 'burning',
  threshold: 2,
  transceivers: [
    { address: BSC_WH, type: 'wormhole', peers: { 2: word(WH) } },
    { address: AX, type: 'axelar', peers: {} },
  ],
  peerBack: { peer: word(NTT), decimals: 18 },
  owner: { kind: 'contract', address: BSC_OWNER as Hx },
  pauser: { kind: 'safe', address: BSC_PAUSER as Hx, threshold: 3, signers: 5 },
  paused: false,
  supply: { raw: '1179271546140000000000', decimals: 18 },
  ...o,
})
const nttHead = (remote: NttRemoteHead[] | undefined, o: Partial<NttHead> = {}): NttHead => ({
  manager: NTT,
  token: TOKEN,
  mode: 'locking',
  threshold: 2,
  transceivers: [
    { address: WH, type: 'wormhole', peers: {} },
    { address: AX, type: 'axelar', peers: {} },
  ],
  peers: { 4: { peer: word(BSC_NTT), decimals: 18 } },
  owner: AGENT,
  pauser: ZERO,
  paused: false,
  locked: { raw: '1179300000000000000000', decimals: 18 },
  remote,
  ...o,
})

describe('engine: the remote side of an NTT route', () => {
  it('a 2-of-2 remote side is clean: shown, its supply feeds the value at risk, its contract owner is flagged as classified there only', () => {
    const r = nttRemoteLines(
      nttHead([remoteOk({ supply: { raw: '2000000000000000000000', decimals: 18 } })]),
    )
    expect(r.breaches).toEqual([])
    expect(r.unread).toEqual([])
    expect(r.supply).toEqual({ raw: '2000000000000000000000', decimals: 18 })
    expect(r.parts[0]).toMatch(
      /^bsc side 0x6161…6161 \(burning\): threshold 2 of 2 \(wormhole \+ axelar\) · 2,000 bridged · owner contract 0x6464…6464 · pauser Safe 3-of-5 0x6565…6565$/,
    )
    expect(r.warnings.join(' ')).toMatch(/classified on bsc only/)
    expect(nttRemoteGaps(nttHead([remoteOk()]))).toEqual([])
  })

  it('a 1-of-2 remote side is a BR-2 floor breach there; an unknown / duplicate network is BR-7; an EOA-controlled owner is AD-3', () => {
    expect(
      nttRemoteLines(nttHead([remoteOk({ threshold: 1 })])).breaches.map((b) => b.ruleId),
    ).toEqual(['BR-2'])
    const dup = remoteOk({
      transceivers: [
        { address: BSC_WH, type: 'wormhole', peers: {} },
        { address: AX, type: 'wormhole', peers: {} },
      ],
    })
    expect(nttRemoteLines(nttHead([dup])).breaches.map((b) => b.ruleId)).toEqual(['BR-2', 'BR-7'])
    const unknown = remoteOk({
      transceivers: [
        { address: BSC_WH, type: 'wormhole', peers: {} },
        { address: AX, type: null, peers: {} },
      ],
    })
    expect(nttRemoteLines(nttHead([unknown])).breaches.map((b) => b.ruleId)).toEqual([
      'BR-2',
      'BR-7',
    ])
    const eoa = nttRemoteLines(
      nttHead([remoteOk({ owner: { kind: 'eoa', address: BSC_OWNER as Hx } })]),
    )
    expect(eoa.breaches.map((b) => [b.ruleId, b.message])).toEqual([
      ['AD-3', 'NTT owner on bsc is EOA 0x6464…6464'],
    ])
    const oneOfN = nttRemoteLines(
      nttHead([
        remoteOk({ owner: { kind: 'safe', address: BSC_OWNER as Hx, threshold: 1, signers: 4 } }),
      ]),
    )
    expect(oneOfN.breaches.map((b) => b.ruleId)).toEqual(['AD-3'])
    // a remote side whose own peer for Ethereum is zero is not a live route there: no floor
    const closed = remoteOk({
      threshold: 1,
      peerBack: { peer: '0x' + '0'.repeat(64), decimals: 18 },
    })
    expect(nttRemoteLines(nttHead([closed])).breaches).toEqual([])
    // …but an UNREAD peer for Ethereum is assumed live (fail closed): the floor is judged
    const unreadBack = nttRemoteLines(nttHead([remoteOk({ threshold: 1, peerBack: null })]))
    expect(unreadBack.breaches.map((b) => b.ruleId)).toEqual(['BR-2'])
    expect(unreadBack.warnings.join(' ')).toMatch(/peer for Ethereum was not read/)
  })

  it('an unread remote side is a warning, a read gap and a lower-bound value; no remote read at all is a read gap too', () => {
    const un: NttRemoteHead = {
      wormholeChainId: 4,
      chainId: 56,
      chainKey: 'bsc',
      status: 'remote_unread',
      reason: 'no working public RPC',
    }
    const r = nttRemoteLines(nttHead([un]))
    expect(r.breaches).toEqual([])
    expect(r.warnings.join(' ')).toMatch(/bsc side not read \(no working public RPC\)/)
    expect(r.unread).toEqual(['bsc bridged supply not read'])
    expect(r.parts).toEqual(['bsc side NOT READ'])
    expect(nttRemoteGaps(nttHead([un]))).toEqual([
      'NTT manager 0xbbbb…bbbb: bsc side not read (no working public RPC)',
    ])
    expect(nttRemoteGaps(nttHead(undefined))).toEqual([
      'NTT manager 0xbbbb…bbbb: remote side not read',
    ])
    expect(nttRemoteGaps(nttHead([remoteOk({ threshold: null })]))).toEqual([
      'NTT manager 0xbbbb…bbbb: bsc threshold / transceivers not read',
    ])
    expect(nttRemoteGaps(nttHead([remoteOk({ owner: null })]))).toEqual([
      'NTT manager 0xbbbb…bbbb: bsc owner not read',
    ])
    // no live peer on Ethereum: no route, nothing to read
    expect(nttRemoteGaps(nttHead(undefined, { peers: {} }))).toEqual([])
    expect(nttRemoteLines(nttHead(undefined, { peers: {} })).unread).toEqual([])
    // fail closed: a live peer with no remote entry (an empty list) is an unread side, and an
    // entry for a chain Ethereum no longer peers with does not stand in for it
    expect(nttRemoteGaps(nttHead([]))).toEqual([
      'NTT manager 0xbbbb…bbbb: Wormhole chain 4 side not read (no remote read recorded for this peer)',
    ])
    expect(nttRemoteGaps(nttHead([remoteOk({ wormholeChainId: 5 })]))).toHaveLength(1)
  })

  it('a remote peer for Ethereum that is not this manager is a warning; an unmapped chain is named by its Wormhole id', () => {
    const other = nttRemoteLines(
      nttHead([remoteOk({ peerBack: { peer: word(A('9')), decimals: 18 } })]),
    )
    expect(other.warnings.join(' ')).toMatch(/peer for Ethereum is 0x0{24}9{40}, not this manager/)
    const un = nttRemoteLines(
      nttHead(
        [
          {
            wormholeChainId: 999,
            chainId: null,
            chainKey: null,
            status: 'remote_unread',
            reason: 'Wormhole chain 999 is not mapped to an EVM chain',
          },
        ],
        { peers: { 999: { peer: word(BSC_NTT), decimals: 18 } } },
      ),
    )
    expect(un.parts).toEqual(['Wormhole chain 999 side NOT READ'])
  })

  // the whole item through buildSubject
  const subject = (): ConfigSubject => ({
    key: 'wsteth',
    label: 'wstETH',
    oracleAssetKey: null,
    class: 'lrt',
    contracts: [
      {
        role: 'other',
        dimension: 'bridge',
        chainId: 1,
        address: NTT,
        label: 'ntt',
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
    nttManagers: [NTT],
  })
  const registry: DvnRegistry = {
    byChain: { 1: {} },
    dead: { 1: [] },
    libraries: { 1: { send: [], receive: [], blocked: [], read: [] } },
  }
  const agent: Controller = {
    kind: 'contract',
    address: AGENT,
    version: 'Aragon Agent',
    ownedBy: {
      kind: 'contract',
      address: EXEC,
      ownedBy: {
        kind: 'aragon_dg',
        address: EPT,
        delaySec: 691200,
        schedulers: [tokenVote(A('4'))],
      },
    },
  }
  const raw = (ntt: NttHead): RawSubject => ({
    version: 1,
    subjectKey: 'wsteth',
    head: { block: 1000, ts: 2000 },
    scan: { from: 1, to: 1000 },
    lz: {
      events: [],
      headRoutes: [],
      headDefaults: {},
      remote: [],
      codeProbes: {},
      dvnSigner: [],
      dvnHead: {},
      value: {
        priceUsd: 4000,
        priceBasis: 'wstETH registry consensus',
        locked: {},
        remoteSupply: {},
      },
    },
    admin: {
      events: [],
      controllers: { [`${AGENT}@head`]: agent },
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
    ntt: [ntt],
    warnings: [],
  })
  const build = (n: NttHead) =>
    buildSubject(subject(), raw(n), { registry, eidName: () => 'x', roleName, endpoint: ZERO })

  it('the NTT line shows both sides; one route breached on both sides counts as ONE floor breach; the larger side ranks it', () => {
    const ok = build(
      nttHead([remoteOk({ supply: { raw: '3000000000000000000000', decimals: 18 } })]),
    )
    const item = ok.state.items.find((i) => i.key === `bridge/ntt/${NTT}`)!
    expect(item.breaches).toEqual([])
    expect(item.display).toMatch(
      /· bsc side 0x6161…6161 \(burning\): threshold 2 of 2 \(wormhole \+ axelar\) · 3,000 bridged/,
    )
    expect(item.valueAtRisk).toMatchObject({ usd: 12_000_000, basis: 'remote_supply', unread: [] })
    expect(ok.state.readGaps ?? []).toEqual([])
    const both = build(nttHead([remoteOk({ threshold: 1 })], { threshold: 1 }))
    const b = both.state.items.find((i) => i.key === `bridge/ntt/${NTT}`)!
    expect(b.breaches.map((x) => x.ruleId)).toEqual(['BR-2', 'BR-2'])
    expect(both.state.counts.floorBreaches).toBe(1)
    // the remote side unread: a read gap, the value a lower bound (locked on Ethereum)
    const un = build(
      nttHead([
        {
          wormholeChainId: 4,
          chainId: 56,
          chainKey: 'bsc',
          status: 'remote_unread',
          reason: 'no working public RPC',
        },
      ]),
    )
    expect(un.state.readGaps).toEqual([
      'NTT manager 0xbbbb…bbbb: bsc side not read (no working public RPC)',
    ])
    expect(un.state.items.find((i) => i.key === `bridge/ntt/${NTT}`)!.valueAtRisk).toMatchObject({
      basis: 'locked',
      unread: ['bsc bridged supply not read'],
    })
  })
})

// =====================================================================================================
describe('subjects.json: the wstETH redemption path and the NTT note', () => {
  const s = getConfigSubjects().subjects.find((x) => x.key === 'wsteth')!
  const WQ = '0x889edc2edab5f40e902b864ad4d7ade8e412f9b1'
  it('declares the WithdrawalQueue: its upgrade path and its pause switch', () => {
    expect(s.contracts.find((c) => c.address === WQ)).toMatchObject({
      dimension: 'mint_redeem',
      deployBlock: 17172547,
    })
    expect(s.powers.find((p) => p.contract === WQ)).toMatchObject({
      power: 'upgrade',
      path: ['eip1967_admin'],
    })
    expect(s.params.find((p) => p.key === 'withdrawalsPaused')).toMatchObject({
      contract: WQ,
      sig: 'function isPaused() view returns (bool)',
      rule: 'info',
    })
  })
  it('the notes say the NTT route is read on both sides and what is still not read there', () => {
    const n = s.notes!.join(' ')
    expect(n).toMatch(/read on BOTH sides at head/)
    expect(n).toMatch(/event history is not scanned/)
  })
  it('the WithdrawalQueue, Aragon Voting and Linea config roles are named (display only, judged privileged)', () => {
    for (const r of [
      'FINALIZE_ROLE',
      'ORACLE_ROLE',
      'MANAGE_TOKEN_URI_ROLE',
      'UNSAFELY_MODIFY_VOTE_TIME_ROLE',
      'SECURITY_COUNCIL_ROLE',
      'SET_MESSAGE_SERVICE_ROLE',
      'SET_REMOTE_TOKENBRIDGE_ROLE',
      'SET_RESERVED_TOKEN_ROLE',
      'REMOVE_RESERVED_TOKEN_ROLE',
      'SET_CUSTOM_CONTRACT_ROLE',
    ]) {
      expect(roleName(keccak256(toHex(r)))).toBe(r)
      expect(isPrivilegedRole(r)).toBe(true)
    }
  })
  it("Lido V3's namespaced PausableUntilWithRoles switches keep their names and rules; the VaultHub's own roles are privileged", () => {
    expect(roleName(keccak256(toHex('PausableUntilWithRoles.PauseRole')))).toBe('PAUSE_ROLE')
    expect(roleName(keccak256(toHex('PausableUntilWithRoles.ResumeRole')))).toBe('RESUME_ROLE')
    expect(PAUSE_ROLES.has('PAUSE_ROLE')).toBe(true)
    expect(isPrivilegedRole('RESUME_ROLE')).toBe(false)
    for (const [ns, name] of [
      ['vaults.VaultHub.BadDebtMasterRole', 'BAD_DEBT_MASTER_ROLE'],
      ['vaults.VaultHub.ValidatorExitRole', 'VALIDATOR_EXIT_ROLE'],
      ['vaults.VaultHub.RedemptionMasterRole', 'REDEMPTION_MASTER_ROLE'],
      ['vaults.VaultHub.VaultMasterRole', 'VAULT_MASTER_ROLE'],
    ]) {
      expect(roleName(keccak256(toHex(ns)))).toBe(name)
      expect(isPrivilegedRole(name)).toBe(true)
    }
  })
})

// =====================================================================================================
describe('headline: an NTT route is a floor route', () => {
  it('a card with only a Wormhole NTT line reads "0 floor breaches", not "floor n/a"; CCIP / canonical lines alone stay n/a', () => {
    const ntt = { oapps: [], ccip: [{ key: `bridge/ntt/${NTT}` }, { key: 'bridge/canonical/0x1' }] }
    const ccipOnly = {
      oapps: [],
      ccip: [{ key: 'bridge/ccip/0x1' }, { key: 'bridge/canonical/0x1' }],
    }
    expect(hasFloorRoutes(ntt)).toBe(true)
    expect(hasFloorRoutes(ccipOnly)).toBe(false)
    expect(hasFloorRoutes({ oapps: [{ routes: [1] }], ccip: [] })).toBe(true)
    expect(hasFloorRoutes({ oapps: [{ routes: [] }], ccip: [] })).toBe(false)
    const c: ConfigCounts = {
      floorBreaches: 0,
      ruleBreaches: 1,
      redInEffect: 0,
      redOpen: 0,
      openRed: 0,
      redTotal: 0,
      pending: 0,
      armed: 0,
      stale: 0,
      proposed: 0,
      historical: 0,
      unread: 0,
      readGaps: 0,
    }
    expect(headline('wstETH', c, true, true, hasFloorRoutes(ntt))).toMatch(
      /^wstETH: 0 floor breaches/,
    )
    expect(headline('cbBTC', c, true, true, hasFloorRoutes(ccipOnly))).toMatch(
      /no LayerZero or NTT route \(floor n\/a\)/,
    )
  })
})
