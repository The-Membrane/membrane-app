// LayerZero V2 readers for the config-card collector: deployment/DVN metadata, event scans on
// Ethereum, head reads per route, remote-chain reads per route, DVN code probes.
//
// Metadata: https://metadata.layerzero-api.com/v1/metadata (public, ~4.5 MB) — per chain the
// eid, native chain id, endpoint, message libraries, dead DVN, public RPC list and DVN
// registry (canonicalName, id, deprecated). Cached raw for a day under the gitignored cache
// and compacted into data/oracle-registry/config/lz-metadata.json (only the chains used).

import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { decodeAbiParameters, keccak256, toHex } from 'viem'
import { FN, TOPIC, fnAbi, lzEventsOf } from './abi.mjs'
import { writeJsonAtomic } from './files.mjs'
import { codeAt, pool, publicClient, retry, scanLogs, scrub, tryRead } from './rpc.mjs'

export const META_URL = 'https://metadata.layerzero-api.com/v1/metadata'
const DAY = 86_400_000

/**
 * Fail-closed audit (LZ-13, 2026-10-10): the raw metadata is VALIDATED before it is cached or
 * used — Ethereum (eid 30101) with this module's endpoint and its ULN302 libraries, and a DVN
 * registry. Any 200 answer was cached for a day: an error JSON or a renamed field silently dropped
 * chains, and a queued setConfig whose library direction was then unknown was skipped (no row).
 */
export function assertLzMetadata(raw) {
  const eth = Object.values(raw ?? {}).find((c) => Number(v2Of(c ?? {})?.eid) === 30101)
  const d = eth ? v2Of(eth) : null
  const libs = Object.entries(d ?? {})
    .map(([k, v]) => [k, addrOf(v)])
    .filter(([, a]) => a)
  const has = (re, a) => libs.some(([k, x]) => re.test(k) && x === a)
  if (
    !d ||
    addrOf(d.endpointV2) !== ETH.endpoint ||
    !has(/^send.*uln/i, ETH.sendUln302) ||
    !has(/^receive.*uln/i, ETH.receiveUln302) ||
    !Object.keys(eth.dvns ?? {}).length
  )
    throw new Error(
      'LZ metadata malformed: Ethereum endpoint / ULN302 libraries / DVN registry missing',
    )
  return raw
}

export async function fetchLzMetadata(cacheDir, fetchImpl = fetch) {
  const file = join(cacheDir, 'lz-metadata-raw.json')
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < DAY)
    try {
      return assertLzMetadata(JSON.parse(readFileSync(file, 'utf8')))
    } catch {
      /* a malformed cached copy is fetched again */
    }
  const res = await retry(() => fetchImpl(META_URL, { headers: { accept: 'application/json' } }))
  if (!res.ok) throw new Error(`LZ metadata HTTP ${res.status}`)
  const json = assertLzMetadata(await res.json())
  writeJsonAtomic(file, json)
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
  primary,
  secondary,
  chainId,
  endpoint,
  libs,
  oapps,
  from,
  to,
  head,
  cacheDir,
  span = 500_000,
  gaps,
  log = () => {},
}) {
  const set = new Set(oapps.map((a) => a.toLowerCase()))
  const key = [...set].sort().join(',')
  // fail-closed audit (EV-06): every chunk cross-checked (scanLogs); an unconfirmed one is a gap
  const common = { client, primary, secondary, head, gaps }
  const libRows = await scanLogs({
    ...common,
    scan: 'LayerZero ULN config scan',
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
    ...common,
    scan: 'LayerZero Endpoint scan',
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
    ...common,
    scan: 'LayerZero PeerSet scan',
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
  // Fail-closed audit (RC-07 / RC-M8, 2026-10-10): EVERY (oapp, eid) with a live peer in ANY head
  // row (send, receive or an unread row) — a send-only row (its receive library reverted) was
  // skipped, and the remote receive side (packets that mint remotely) was never judged. A row
  // whose peer was not read uses the last non-zero PeerSet peer.
  const live = (p) => typeof p === 'string' && /^0x[0-9a-f]+$/i.test(p) && !/^0x0*$/.test(p)
  for (const [oapp, rows] of headRoutes)
    for (const r of rows) {
      const k = `${String(oapp).toLowerCase()}|${r.eid}`
      if (seen.has(k)) continue
      const peer = live(r.peer) ? String(r.peer).toLowerCase() : last.get(k)
      if (!peer) continue
      byEid.set(r.eid, [...(byEid.get(r.eid) ?? []), { oapp, peer }])
      seen.add(k)
    }
  for (const [k, peer] of last) {
    if (seen.has(k) || !/^0x0*$/.test(now.get(k) ?? '0x')) continue
    const [oapp, eid] = k.split('|')
    byEid.set(Number(eid), [...(byEid.get(Number(eid)) ?? []), { oapp, peer, ethPeerZeroed: true }])
  }
  return byEid
}

/**
 * Fail-closed audit (LZ-01 / EV-06): the eids whose Ethereum route of `oapp` is read at head — the
 * eids its events named, every eid its previous run had an item for (a route seen before is read
 * again, or listed unread, never dropped), and the extra eids a peers() sweep found live.
 */
export function headRouteEids(oapp, lzEvents, prevItems = [], swept = []) {
  const o = String(oapp).toLowerCase()
  const out = new Set(
    lzEvents
      .filter((e) => String(e.oapp ?? '').toLowerCase() === o && e.eid !== undefined)
      .map((e) => Number(e.eid)),
  )
  for (const i of prevItems) {
    const m = String(i.key ?? '').match(/^bridge\/lz\/1\/(0x[0-9a-f]{40})\/(\d+)\//)
    if (m && m[1] === o) out.add(Number(m[2]))
  }
  for (const e of swept) out.add(Number(e))
  return [...out]
}

/**
 * Fail-closed audit (RC-M7): with the remote reads skipped (--no-remote) every remote side the
 * collector would have read is a REMOTE UNREAD placeholder, never absent — a first run said "no
 * red flags" over sides that were never judged.
 */
export function skippedRemoteSides(byEid, metadata, reason = 'remote reads skipped (--no-remote)') {
  const out = []
  for (const [eid, list] of byEid)
    for (const x of list)
      out.push({
        oapp: x.oapp,
        eid,
        chainKey: metadata?.eids?.[eid]?.chainKey ?? String(eid),
        chainId: metadata?.chains?.[eid]?.chainId ?? null,
        status: 'remote_unread',
        reason,
      })
  return out
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
/**
 * Fail-closed audit (LZ-05 / LZ-07, 2026-10-10): the custom errors whose revert IS a fact about
 * the route — the Endpoint has no default library for the eid (no library: the side is closed),
 * the ULN has no DVN at all (AtLeastOneDVN: it verifies nothing), the BlockedMessageLib (it
 * implements nothing). Any other revert, or a failure, is NOT READ: it was taken as "closed" /
 * "no DVN", and a misclassified -32603 dropped the route's floor breach.
 */
const errSel = (sig) => keccak256(toHex(sig)).slice(0, 10)
export const LZ_NO_LIBRARY_ERRORS = new Set(
  ['LZ_DefaultSendLibUnavailable()', 'LZ_DefaultReceiveLibUnavailable()'].map(errSel),
)
export const LZ_NO_DVN_ERRORS = new Set(
  ['LZ_ULN_AtLeastOneDVN()', 'LZ_NotImplemented()', 'NotImplemented()'].map(errSel),
)

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
  if (!libR.ok)
    return {
      ok: false,
      error: libR.error,
      reverted: !!libR.reverted,
      // closed only on the Endpoint's own "no default library" error
      closed: !!libR.reverted && LZ_NO_LIBRARY_ERRORS.has(libR.revertSelector ?? ''),
    }
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
    // LZ-09: a timeout read that FAILED is a grace not read (both getters are public mappings: a
    // revert is never a meaningful answer) — it read as "no grace"
    if (!t.ok) grace = { unread: true, error: t.error }
    else if (!/^0x0{40}$/i.test(t.value[0])) {
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
    // the library reverted with its "no DVN at all" error (AtLeastOneDVN / a blocked library) vs
    // anything else (UNREAD) — LZ-07: a misread revert made the route "blocked (no_dvn)"
    mergedReverted: cfgR.ok
      ? undefined
      : !!cfgR.reverted && LZ_NO_DVN_ERRORS.has(cfgR.revertSelector ?? ''),
    app: appR.ok ? ulnFromTuple(appR.value) : null,
    // LZ-08: the app override NOT read is unknown — never "no override" (a default merge)
    ...(appR.ok ? {} : { appUnread: true }),
    grace,
  }
}

/**
 * Code-presence probes: first block with code for each address (null = never, up to `head`).
 * Fail-closed audit (FCB-2 / ST-05 / MISSED-4, 2026-10-10): with `confirm` clients (the two
 * independent archive log endpoints) a bisected boundary is CONFIRMED there — code at it and none
 * one block before on each. One false "no code" mid-bisection moved the deploy block LATER, and it
 * was cached for good: a first owner set long after deployment then counted as initialization
 * (neutral, not AD-3). An unconfirmed boundary is left out ({ unconfirmed }), never cached; the
 * engine fails closed on an unknown deploy block.
 */
export async function firstCodeBlocks(client, addresses, minBlockOf, head, { confirm = [] } = {}) {
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
    for (const c of confirm)
      try {
        if (!(await codeAt(c, a, hi)) || (await codeAt(c, a, hi - 1))) {
          out[a] = { unconfirmed: `first code at ${hi} not confirmed on a second endpoint` }
          return
        }
      } catch (e) {
        out[a] = { unconfirmed: scrub(e?.message ?? e) }
        return
      }
    out[a] = { firstCode: hi, ...(confirm.length ? { confirmed: true } : {}) }
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
export async function clientForChain(chain, opts = {}) {
  const urls = await workingRpcUrls(chain, opts)
  // One client over every endpoint that answered: a call that fails on one moves to the next.
  return urls.length ? publicClient(chain.chainId, urls) : null
}

/**
 * Two INDEPENDENT clients (distinct hosts) for a log scan on another chain (fail-closed audit
 * EV-01: an empty chunk is confirmed on the second); null when fewer than two hosts answer.
 */
export async function clientPairForChain(chain, opts = {}) {
  const urls = await workingRpcUrls(chain, opts)
  const host = (u) => {
    try {
      return new URL(u).host
    } catch {
      return u
    }
  }
  const pair = []
  for (const u of urls) if (!pair.some((x) => host(x) === host(u))) pair.push(u)
  return pair.length >= 2
    ? {
        primary: publicClient(chain.chainId, [pair[0]]),
        secondary: publicClient(chain.chainId, [pair[1]]),
      }
    : null
}

async function workingRpcUrls(chain, { archiveBlock } = {}) {
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
  return ok.filter(Boolean)
}

/** Remote side of one route: the peer OApp's config for messages to/from Ethereum (eid 30101). */
export async function readRemoteRoute(client, chain, peerAddress, localEid = 30101) {
  // The remote block just BEFORE the reads (public RPCs: reads stay at latest, a pinned block
  // can be missing on a lagging node): a receive grace period's expiry is a remote block
  // number, judged against it — a grace counted active a few blocks too long fails closed.
  // null = the block could not be read (every unexpired-looking grace counts).
  // Fail-closed audit (RC-M4): the remote clock is the EVM's own block.number (Multicall3
  // getBlockNumber), never eth_blockNumber — on an Arbitrum-stack chain that is the L2 block while
  // the Endpoint checks a grace expiry against block.number (the L1 block): every live grace
  // there read as expired. Not read: null (every unexpired-looking grace counts — fail closed).
  let block = null
  const b = await tryRead(
    client,
    '0xcA11bde05977b3631167028862bE2a173976CA11',
    fnAbi('function getBlockNumber() view returns (uint256)'),
    'getBlockNumber',
  )
  if (b.ok) block = Number(b.value)
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
    for (const a of [
      ...(d.merged?.requiredDVNs ?? []),
      ...(d.merged?.optionalDVNs ?? []),
      // RC-M3: the old library in its grace period still verifies: its DVNs are probed too
      ...(d.grace?.config?.requiredDVNs ?? []),
      ...(d.grace?.config?.optionalDVNs ?? []),
    ])
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
      // fail-closed audit (LZ-15): the state before carried from the previous transaction because
      // the archive read FAILED — exact only if no event was lost; the row says so (a read gap)
      let prevCarried = false
      if (r.block !== lastBlock) {
        const s = await readState(dvn, r.block - 1)
        if (s && s.quorum !== null && s.signers !== null) prev = s
        // no code one block earlier: these events are the DVN's own setup (deploy block)
        else if (s?.noCode) initBlock = r.block
        else {
          prev = carried
          prevCarried = !!carried
        }
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
        ...(prevCarried ? { prevCarried: true } : {}),
      })
      carried = next
    }
  }
  return out
}
