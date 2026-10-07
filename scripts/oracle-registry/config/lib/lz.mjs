// LayerZero V2 readers for the config-card collector: deployment/DVN metadata, event scans on
// Ethereum, head reads per route, remote-chain reads per route, DVN code probes.
//
// Metadata: https://metadata.layerzero-api.com/v1/metadata (public, ~4.5 MB) — per chain the
// eid, native chain id, endpoint, message libraries, dead DVN, public RPC list and DVN
// registry (canonicalName, id, deprecated). Cached raw for a day under the gitignored cache
// and compacted into data/oracle-registry/config/lz-metadata.json (only the chains used).

import { existsSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { decodeAbiParameters } from 'viem'
import { FN, TOPIC, fnAbi, lzEventsOf } from './abi.mjs'
import { codeAt, pool, publicClient, retry, scanLogs, scrub, tryRead } from './rpc.mjs'

export const META_URL = 'https://metadata.layerzero-api.com/v1/metadata'
const DAY = 86_400_000

export async function fetchLzMetadata(cacheDir, fetchImpl = fetch) {
  const file = join(cacheDir, 'lz-metadata-raw.json')
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < DAY)
    return JSON.parse(readFileSync(file, 'utf8'))
  const res = await retry(() => fetchImpl(META_URL, { headers: { accept: 'application/json' } }))
  if (!res.ok) throw new Error(`LZ metadata HTTP ${res.status}`)
  const json = await res.json()
  writeFileSync(file, JSON.stringify(json))
  return json
}

const v2Of = (chain) =>
  (chain.deployments ?? []).find((d) => d.version === 2 && d.stage === 'mainnet')
const addrOf = (x) => (x?.address ? String(x.address).toLowerCase() : null)

/**
 * Compact the raw metadata: eid → chain map for every mainnet V2 chain, and full detail
 * (libraries, dead DVN, RPCs, DVN registry) for `detailEids` only.
 */
export function compactLzMetadata(raw, detailEids, fetchedAt) {
  const eids = {}
  const chains = {}
  for (const [key, chain] of Object.entries(raw)) {
    const d = v2Of(chain)
    if (!d || chain.environment === 'testnet') continue
    const eid = Number(d.eid)
    const nativeChainId = chain.chainDetails?.nativeChainId ?? null
    eids[eid] = {
      chainKey: key,
      chainId: chain.chainDetails?.chainType === 'evm' ? nativeChainId : null,
      name: chain.chainDetails?.name ?? key,
    }
    if (!detailEids.has(eid)) continue
    const libs = { send: [], receive: [], blocked: [], read: [] }
    for (const [k, v] of Object.entries(d)) {
      const a = addrOf(v)
      if (!a) continue
      if (/^send.*uln/i.test(k)) libs.send.push(a)
      else if (/^receive.*uln/i.test(k)) libs.receive.push(a)
      else if (/blockedmessagelib/i.test(k)) libs.blocked.push(a)
      else if (/^readlib/i.test(k)) libs.read.push(a)
    }
    const dvns = {}
    for (const [a, row] of Object.entries(chain.dvns ?? {})) {
      if (row.version !== 2) continue
      dvns[a.toLowerCase()] = {
        id: row.id,
        name: row.canonicalName,
        ...(row.deprecated ? { deprecated: true } : {}),
      }
    }
    chains[eid] = {
      chainKey: key,
      chainId: eids[eid].chainId,
      evm: chain.chainDetails?.chainType === 'evm',
      endpoint: addrOf(d.endpointV2),
      libs,
      dead: [addrOf(d.deadDVN)].filter(Boolean),
      // Public endpoints only (no key in the URL): the metadata lists community RPCs.
      rpcs: (chain.rpcs ?? [])
        .map((r) => r.url)
        .filter(publicRpc)
        .slice(0, 6),
      dvns,
    }
  }
  return { version: 1, source: META_URL, fetchedAt, eids, chains }
}

/**
 * Keep only plainly public endpoints: https, no query key, no ${'$'}{…} template, no provider that
 * needs a key, and no long token in the path (some community entries embed one).
 */
export function publicRpc(u) {
  try {
    const url = new URL(u)
    if (url.protocol !== 'https:' || url.search || /\$\{/.test(u)) return false
    if (
      /(alchemy\.com|infura\.io|quiknode\.pro|quicknode|ankr\.com\/[^/]+\/[a-f0-9]{20,})/i.test(u)
    )
      return false
    return !url.pathname.split('/').some((seg) => /^[A-Za-z0-9_-]{24,}$/.test(seg))
  } catch {
    return false
  }
}

/** DvnRegistry (lib/oracleRegistry/config/uln.ts) from compacted metadata, keyed by chain id. */
export function registryOf(meta) {
  const byChain = {}
  const dead = {}
  const libraries = {}
  for (const c of Object.values(meta.chains)) {
    if (!c.chainId) continue
    byChain[c.chainId] = c.dvns
    dead[c.chainId] = c.dead
    libraries[c.chainId] = c.libs
  }
  return { byChain, dead, libraries }
}

// ---- Ethereum scans ------------------------------------------------------------------------------

export const ETH = {
  endpoint: '0x1a44076050125825900e736c501f859c50fe728c',
  sendUln302: '0xbb2ea70c9e858123480642cf96acbcce1372dce1',
  receiveUln302: '0xc02ab410f0734efa3f14628780e6e695156024c2',
  endpointDeployBlock: 19093715,
}

/**
 * Every LayerZero config event that can move the routes of `oapps` on a chain, as LzEvent rows.
 * Three scans (topic-filtered): the ULN libraries, the Endpoint, the OApps themselves.
 */
export async function scanLzConfig({
  client,
  chainId,
  endpoint,
  libs,
  oapps,
  from,
  to,
  cacheDir,
  span = 500_000,
  log = () => {},
}) {
  const set = new Set(oapps.map((a) => a.toLowerCase()))
  const key = [...set].sort().join(',')
  const libRows = await scanLogs({
    client,
    chainId,
    addresses: libs,
    topics0: [TOPIC.UlnConfigSet, TOPIC.DefaultUlnConfigsSet],
    from,
    to,
    span,
    cacheDir,
    cacheKey: `uln:${key}`,
    keep: (r) => r.event === 'DefaultUlnConfigsSet' || set.has(String(r.args.oapp).toLowerCase()),
  })
  log(`  ULN libraries: ${libRows.length} rows`)
  const epTopics = [
    'DelegateSet',
    'SendLibrarySet',
    'ReceiveLibrarySet',
    'ReceiveLibraryTimeoutSet',
    'DefaultSendLibrarySet',
    'DefaultReceiveLibrarySet',
    'DefaultReceiveLibraryTimeoutSet',
  ].map((k) => TOPIC[k])
  const epRows = await scanLogs({
    client,
    chainId,
    addresses: [endpoint],
    topics0: epTopics,
    from,
    to,
    span,
    cacheDir,
    cacheKey: `ep:${key}`,
    keep: (r) => {
      const who = r.args.sender ?? r.args.receiver
      return who === undefined || set.has(String(who).toLowerCase())
    },
  })
  log(`  Endpoint: ${epRows.length} rows`)
  const oappRows = await scanLogs({
    client,
    chainId,
    addresses: [...set],
    topics0: [TOPIC.PeerSet],
    from,
    to,
    span,
    cacheDir,
  })
  log(`  OApps PeerSet: ${oappRows.length} rows`)
  const rows = [...libRows, ...epRows, ...oappRows]
  return rows.flatMap((r) => lzEventsOf(r, set))
}

/**
 * The remote sides to read, per eid: every Ethereum route with a live peer (its receive row),
 * plus — review round 6 — every (oapp, eid) whose Ethereum peer is ZERO now but was set before
 * (PeerSet history): the remote OApp at its last non-zero peer may still point back and accept
 * a forged packet, whatever Ethereum does. Those carry `ethPeerZeroed: true`.
 *   headRoutes  Map(oapp → head rows { oapp, eid, direction, peer })
 *   lzEvents    replay rows (kind 'peer' with { oapp, eid, peer, block, logIndex })
 */
export function remoteReadList(headRoutes, lzEvents, oapps) {
  const byEid = new Map()
  const seen = new Set()
  for (const [oapp, rows] of headRoutes)
    for (const r of rows)
      if (r.direction === 'receive') {
        byEid.set(r.eid, [...(byEid.get(r.eid) ?? []), { oapp, peer: r.peer }])
        seen.add(`${String(oapp).toLowerCase()}|${r.eid}`)
      }
  const tracked = new Set((oapps ?? []).map((o) => String(o).toLowerCase()))
  const last = new Map()
  const now = new Map()
  for (const e of [...lzEvents]
    .filter((e) => e.kind === 'peer' && tracked.has(String(e.oapp).toLowerCase()))
    .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)) {
    const k = `${String(e.oapp).toLowerCase()}|${e.eid}`
    const peer = String(e.peer).toLowerCase()
    now.set(k, peer)
    if (!/^0x0*$/.test(peer)) last.set(k, peer)
  }
  for (const [k, peer] of last) {
    if (seen.has(k) || !/^0x0*$/.test(now.get(k) ?? '0x')) continue
    const [oapp, eid] = k.split('|')
    byEid.set(Number(eid), [...(byEid.get(Number(eid)) ?? []), { oapp, peer, ethPeerZeroed: true }])
  }
  return byEid
}

/** Keep only default-config events for eids some tracked route uses (compact fixtures). */
export function pruneDefaults(events) {
  const eids = new Set(events.filter((e) => e.oapp).map((e) => e.eid))
  return events.filter((e) => e.oapp || eids.has(e.eid))
}

export const ulnFromTuple = (t) => ({
  confirmations: String(t.confirmations ?? t[0]),
  requiredDVNCount: Number(t.requiredDVNCount ?? t[1]),
  optionalDVNCount: Number(t.optionalDVNCount ?? t[2]),
  optionalDVNThreshold: Number(t.optionalDVNThreshold ?? t[3]),
  requiredDVNs: [...(t.requiredDVNs ?? t[4])].map((a) => a.toLowerCase()),
  optionalDVNs: [...(t.optionalDVNs ?? t[5])].map((a) => a.toLowerCase()),
})

const ULN_TYPE = [
  {
    type: 'tuple',
    components: [
      { name: 'confirmations', type: 'uint64' },
      { name: 'requiredDVNCount', type: 'uint8' },
      { name: 'optionalDVNCount', type: 'uint8' },
      { name: 'optionalDVNThreshold', type: 'uint8' },
      { name: 'requiredDVNs', type: 'address[]' },
      { name: 'optionalDVNs', type: 'address[]' },
    ],
  },
]
export const decodeUlnBytes = (bytes) => ulnFromTuple(decodeAbiParameters(ULN_TYPE, bytes)[0])

/**
 * Head (or archive) reads of one route direction, straight from the Endpoint and library —
 * the authoritative values the replay is cross-checked against.
 */
export async function readRoute(client, { endpoint, oapp, eid, direction, block, remoteEid }) {
  const ep = (sig) => fnAbi(sig)
  const libR =
    direction === 'send'
      ? await tryRead(client, endpoint, ep(FN.getSendLibrary), 'getSendLibrary', [oapp, eid], block)
      : await tryRead(
          client,
          endpoint,
          ep(FN.getReceiveLibrary),
          'getReceiveLibrary',
          [oapp, eid],
          block,
        )
  if (!libR.ok) return { ok: false, error: libR.error, reverted: !!libR.reverted }
  const lib = (direction === 'send' ? libR.value : libR.value[0]).toLowerCase()
  const isDefaultR =
    direction === 'send'
      ? await tryRead(
          client,
          endpoint,
          ep(FN.isDefaultSendLibrary),
          'isDefaultSendLibrary',
          [oapp, eid],
          block,
        )
      : { ok: true, value: libR.value[1] }
  const cfgR = await tryRead(
    client,
    endpoint,
    ep(FN.getConfig),
    'getConfig',
    [oapp, lib, eid, 2],
    block,
  )
  const appR = await tryRead(
    client,
    lib,
    ep(FN.getAppUlnConfig),
    'getAppUlnConfig',
    [oapp, eid],
    block,
  )
  let grace
  if (direction === 'receive') {
    const t = libR.value[1]
      ? await tryRead(
          client,
          endpoint,
          ep(FN.defaultReceiveLibraryTimeout),
          'defaultReceiveLibraryTimeout',
          [eid],
          block,
        )
      : await tryRead(
          client,
          endpoint,
          ep(FN.receiveLibraryTimeout),
          'receiveLibraryTimeout',
          [oapp, eid],
          block,
        )
    if (t.ok && !/^0x0{40}$/i.test(t.value[0])) {
      const gl = t.value[0].toLowerCase()
      const gc = await tryRead(
        client,
        endpoint,
        ep(FN.getConfig),
        'getConfig',
        [oapp, gl, eid, 2],
        block,
      )
      grace = {
        lib: gl,
        expiry: Number(t.value[1]),
        config: gc.ok ? decodeUlnBytes(gc.value) : null,
      }
    }
  }
  return {
    ok: true,
    oapp: oapp.toLowerCase(),
    eid,
    remoteEid,
    direction,
    lib,
    libIsDefault: isDefaultR.ok ? !!isDefaultR.value : null,
    // getConfig → library.getUlnConfig(oapp, eid): the MERGED config (reverts if no DVN at all).
    merged: cfgR.ok ? decodeUlnBytes(cfgR.value) : null,
    mergedError: cfgR.ok ? undefined : cfgR.error,
    // the library reverted (no DVN at all: AtLeastOneDVN) vs the read failed (UNREAD)
    mergedReverted: cfgR.ok ? undefined : !!cfgR.reverted,
    app: appR.ok ? ulnFromTuple(appR.value) : null,
    grace,
  }
}

/** Code-presence probes: first block with code for each address (null = never, up to `head`). */
export async function firstCodeBlocks(client, addresses, minBlockOf, head) {
  const out = {}
  await pool(addresses, 4, async (a) => {
    const lo0 = Math.max(0, minBlockOf(a))
    if (await codeAt(client, a, lo0)) {
      out[a] = { firstCode: null, codeAt: lo0 }
      return
    }
    if (!(await codeAt(client, a, head))) {
      out[a] = { firstCode: null, never: true, checkedTo: head }
      return
    }
    let lo = lo0
    let hi = head
    while (hi - lo > 1) {
      const m = Math.floor((lo + hi) / 2)
      if (await codeAt(client, a, m)) hi = m
      else lo = m
    }
    out[a] = { firstCode: hi }
  })
  return out
}

/** CodeOracle (uln.ts) from probe results: code at block b ⇔ first code ≤ b (no self-destructs). */
export function codeOracleOf(probes) {
  return (chainId, address, block) => {
    const p = probes[chainId]?.[String(address).toLowerCase()]
    if (!p) return null
    if (p.never) return block <= p.checkedTo ? false : null
    if (p.codeAt !== undefined) return block >= p.codeAt ? true : null
    return block >= p.firstCode
  }
}

/**
 * A working public client for a chain: the first RPC whose eth_chainId matches and, when
 * `archiveBlock` is given, that also serves archive eth_getLogs / eth_getCode at that block
 * (free tiers often refuse old blocks or ranges).
 */
export async function clientForChain(chain, { archiveBlock } = {}) {
  const hx = (n) => '0x' + Number(n).toString(16)
  const within = (p) =>
    Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10_000))])
  const ok = await Promise.all(
    (chain.rpcs ?? []).map(async (url) => {
      try {
        const c = publicClient(chain.chainId, [url])
        if (Number(await within(c.getChainId())) !== Number(chain.chainId)) return null
        if (archiveBlock !== undefined) {
          await within(
            c.request({
              method: 'eth_getLogs',
              params: [
                {
                  address: chain.endpoint,
                  topics: [[TOPIC.DelegateSet]],
                  fromBlock: hx(archiveBlock),
                  toBlock: hx(archiveBlock + 2000),
                },
              ],
            }),
          )
          await within(c.getCode({ address: chain.endpoint, blockNumber: BigInt(archiveBlock) }))
        }
        return url
      } catch (e) {
        void scrub(e)
        return null
      }
    }),
  )
  const urls = ok.filter(Boolean)
  // One client over every endpoint that answered: a call that fails on one moves to the next.
  return urls.length ? publicClient(chain.chainId, urls) : null
}

/** Remote side of one route: the peer OApp's config for messages to/from Ethereum (eid 30101). */
export async function readRemoteRoute(client, chain, peerAddress, localEid = 30101) {
  // The remote block just BEFORE the reads (public RPCs: reads stay at latest, a pinned block
  // can be missing on a lagging node): a receive grace period's expiry is a remote block
  // number, judged against it — a grace counted active a few blocks too long fails closed.
  // null = the block could not be read (every unexpired-looking grace counts).
  let block = null
  try {
    block = Number(await client.getBlockNumber())
  } catch {
    block = null
  }
  const out = {
    chainKey: chain.chainKey,
    chainId: chain.chainId,
    peer: peerAddress,
    block,
    directions: {},
  }
  for (const direction of ['send', 'receive']) {
    const r = await readRoute(client, {
      endpoint: chain.endpoint,
      oapp: peerAddress,
      eid: localEid,
      direction,
    })
    out.directions[direction] = r
  }
  const back = await tryRead(client, peerAddress, fnAbi(FN.peers), 'peers', [localEid])
  out.peerBack = back.ok ? String(back.value).toLowerCase() : null
  const dvns = new Set()
  for (const d of Object.values(out.directions))
    for (const a of [...(d.merged?.requiredDVNs ?? []), ...(d.merged?.optionalDVNs ?? [])])
      dvns.add(a)
  out.dvnCode = {}
  for (const a of dvns) {
    try {
      out.dvnCode[a] = !!(await codeAt(client, a))
    } catch {
      out.dvnCode[a] = null
    }
  }
  return out
}

/**
 * DV-1 / DV-2 rows replayed from the DVN multisig's own events (review fix: reading quorum /
 * signerSize at block − 1 and at the block missed a quorum lowered and restored inside one
 * transaction or block, and dropped the row when a read failed).
 *
 * Per DVN, transactions in block order: the state before the FIRST transaction of each block is
 * an exact archive read at block − 1 (`readState`), else the state the previous transaction
 * left; inside a transaction every UpdateQuorum(_quorum) / UpdateSigner(_signer, _active) is
 * applied in log order. `dip` is the weakest intermediate state the transaction passed through
 * (lowest quorum; at an unchanged quorum, most signers). `prev` null = the state before could not
 * be read — the engine never judges that row calm.
 */
export async function replayDvnSigners(rows, readState) {
  const byDvn = new Map()
  for (const r of [...rows].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex))
    byDvn.set(r.emitter, [...(byDvn.get(r.emitter) ?? []), r])
  const out = []
  for (const [dvn, evs] of byDvn) {
    const txs = []
    for (const e of evs) {
      const last = txs[txs.length - 1]
      if (last && last[0].tx === e.tx) last.push(e)
      else txs.push([e])
    }
    let carried = null
    let lastBlock = -1
    let initBlock = -1
    for (const tx of txs) {
      const r = tx[0]
      let prev = null
      if (r.block !== lastBlock) {
        const s = await readState(dvn, r.block - 1)
        if (s && s.quorum !== null && s.signers !== null) prev = s
        // no code one block earlier: these events are the DVN's own setup (deploy block)
        else if (s?.noCode) initBlock = r.block
        else prev = carried
      } else prev = carried
      lastBlock = r.block
      // with the state before unknown, the state after is unknown too (an event carries one field)
      const cur = prev ? { ...prev } : null
      let dip = cur ? { ...cur } : null
      let added = false
      let removed = false
      for (const e of tx) {
        if (e.event === 'UpdateQuorum') {
          if (cur) cur.quorum = Number(e.args._quorum)
        } else if (e.event === 'UpdateSigner') {
          if (e.args._active) added = true
          else removed = true
          if (cur) cur.signers += e.args._active ? 1 : -1
        }
        // the quorum dip is the flash that matters (fewer signatures verify a packet); a signer
        // added then removed in one rotation transaction is not one
        if (cur && dip && cur.quorum < dip.quorum) dip = { ...cur }
      }
      const next = cur
      out.push({
        chainId: 1,
        dvn,
        block: r.block,
        tx: r.tx,
        logIndex: r.logIndex,
        ts: r.ts,
        prev: prev ? { quorum: prev.quorum, signers: prev.signers } : null,
        next: next ? { quorum: next.quorum, signers: next.signers } : null,
        dip:
          dip && prev && dip.quorum < prev.quorum
            ? { quorum: dip.quorum, signers: dip.signers }
            : undefined,
        addedAndRemoved: added && removed,
        ...(r.block === initBlock ? { init: true } : {}),
      })
      carried = next
    }
  }
  return out
}
