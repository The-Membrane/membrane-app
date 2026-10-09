#!/usr/bin/env node
// Config-card collector (docs/research/CONFIG-CARDS-DESIGN.md): bridge, admin and mint/redeem
// configuration of every subject in data/oracle-registry/config/subjects.json, its history,
// its pending (timelock) and proposed (Safe Tx Service) changes, judged by the engine in
// lib/oracleRegistry/config/ (loaded through tsx, no build step).
//
//   node scripts/oracle-registry/config/collect-config.mjs [--only=rseth,usde] [--param-days=365]
//        [--no-remote] [--no-safe] [--no-params] [--keep-raw]   (cache raw observations)
//   node scripts/oracle-registry/config/collect-config.mjs --rebuild   (engine only, from --keep-raw)
//
// Writes (compact JSON):
//   data/oracle-registry/config/lz-metadata.json        LZ eids, libraries, DVN registry (used chains)
//   data/oracle-registry/config/state/<subject>.json    head state + persistent breaches + powers
//   data/oracle-registry/config/changes/<subject>.json  historical changes (newest first)
//   data/oracle-registry/config/queues/<subject>.json   pending (timelock) + proposed (Safe) changes
//   data/oracle-registry/config/cursors.json            what was scanned, when
// Cache (gitignored, resumable): data/oracle-registry/config/.cache/
//
// RPC: RECORDER_RPC_URL (keyed; never printed — every error is scrubbed). Remote chains: public
// RPCs from the LZ metadata. Scans are topic-filtered raw eth_getLogs (see lib/rpc.mjs).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { toFunctionSelector } from 'viem'
import { ROOT } from '../../lib/venue-reads.mjs'
import { guardProcessErrors } from '../lib/readers.mjs'
import {
  ADMIN_TOPICS,
  DVN_TOPICS,
  FN,
  SLOT,
  TOPIC,
  aragonRows,
  fnAbi,
  roleHash,
  roleName,
  roleSetRow,
} from './lib/abi.mjs'
import {
  aragonExecCandidatesFromRows,
  classify,
  dgCommitteeAddresses,
  enrichTokenVotes,
  MULTICALL3_BLOCK,
  opsFromEvents,
  readCanonicalBridge,
  readCcipPool,
  readDgProposals,
  readMultisigSubmissions,
  readNtt,
  readNttRemote,
  readOps,
  resolvePath,
  roleHoldersFromEvents,
  setAragonExecCandidates,
  setLogClients,
  setRoleCandidates,
  subjectExtraEmitters,
  TIMELOCK_SCOPE_ROLES,
  WORMHOLE_EVM_CHAINS,
  nttRemoteTargets,
  voteDefense,
} from './lib/admin.mjs'
import {
  ETH,
  clientForChain,
  compactLzMetadata,
  fetchLzMetadata,
  firstCodeBlocks,
  readRemoteRoute,
  readRoute,
  registryOf,
  remoteReadList,
  replayDvnSigners,
  scanLzConfig,
  ulnFromTuple,
} from './lib/lz.mjs'
import { holderSnapshots } from './lib/holders.mjs'
import { paramTransitions, paramsForSubject, scopedParamSpecs, txAtBlock } from './lib/params.mjs'
import {
  blockTimestamps,
  codeAt,
  ethereumClients,
  pool,
  retry,
  scanLogs,
  scrub,
  tryRead,
} from './lib/rpc.mjs'
import { safeQueues } from './lib/safe.mjs'
import { verifySources, verifySourcesThroughProxies } from './lib/verify.mjs'
import { loadTs } from './lib/ts.mjs'

guardProcessErrors('oracle-registry collect-config')

const args = process.argv.slice(2)
const flag = (k) => args.includes(`--${k}`)
const argVal = (k, d) => args.find((x) => x.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const ONLY = argVal('only', '').split(',').filter(Boolean)
const PARAM_DAYS = Number(argVal('param-days', '365'))
const log = (...a) => console.error(...a)
const lc = (a) => String(a ?? '').toLowerCase()
// Lido Dual Governance setters that name a new holder (the previous one is read at block − 1)
const DG_SETTERS = [
  'GovernanceSet',
  'AdminExecutorSet',
  'EmergencyGovernanceSet',
  'EmergencyActivationCommitteeSet',
  'EmergencyExecutionCommitteeSet',
  'ProposalsCancellerSet',
  'ResealCommitteeSet',
  'TiebreakerCommitteeSet',
  'ConfigProviderSet',
]
const firstAddr = (args) =>
  Object.values(args ?? {}).find((x) => /^0x[0-9a-f]{40}$/i.test(String(x))) ?? null

const DIR = join(ROOT, 'data', 'oracle-registry', 'config')
const CACHE = join(DIR, '.cache')
for (const d of ['state', 'changes', 'queues', '.cache'])
  mkdirSync(join(DIR, d), { recursive: true })
const writeJson = (p, o) => writeFileSync(p, JSON.stringify(o) + '\n')

const file = JSON.parse(readFileSync(join(DIR, 'subjects.json'), 'utf8'))
const subjects = file.subjects.filter((s) => !ONLY.length || ONLY.includes(s.key))
if (!subjects.length) throw new Error('no subject selected')

// --rebuild: re-run the engine on the raw observations cached by the last network run.
async function emit(s, rawSubject, metadata, engine) {
  const out = engine.buildSubject(s, rawSubject, {
    registry: registryOf(metadata),
    eidName: (e) => metadata.eids[e]?.chainKey ?? String(e),
    roleName,
    endpoint: ETH.endpoint,
  })
  writeJson(join(DIR, 'state', `${s.key}.json`), out.state)
  writeJson(join(DIR, 'changes', `${s.key}.json`), {
    version: 1,
    subject: s.key,
    asOf: out.state.asOf,
    changes: out.changes,
  })
  writeJson(join(DIR, 'queues', `${s.key}.json`), {
    version: 1,
    subject: s.key,
    asOf: out.state.asOf,
    changes: out.queue,
  })
  const all = [...out.changes, ...out.queue]
  return {
    subject: s.key,
    red: all.filter((c) => c.red).length,
    redStillInEffect: out.changes.filter((c) => c.red && c.stillInEffect).length,
    amberPending: out.queue.filter((c) => c.state === 'pending' && c.stage !== 'stale').length,
    stalePending: out.queue.filter((c) => c.stage === 'stale').length,
    armed: out.queue.filter((c) => c.stage === 'armed').length,
    blueProposed: out.queue.filter((c) => c.state === 'proposed').length,
    greyHistorical: out.changes.length,
    floorBreaches: out.state.counts.floorBreaches,
    stateBreaches: out.state.items.reduce((n, i) => n + i.breaches.length, 0),
  }
}
if (flag('rebuild')) {
  const engine = await loadTs('../../../../lib/oracleRegistry/config/engine.ts')
  const metadata = JSON.parse(readFileSync(join(DIR, 'lz-metadata.json'), 'utf8'))
  const summary = []
  for (const s of subjects)
    summary.push(
      await emit(
        s,
        JSON.parse(readFileSync(join(CACHE, `raw-${s.key}.json`), 'utf8')),
        metadata,
        engine,
      ),
    )
  console.log(JSON.stringify({ rebuild: true, summary }, null, 1))
  process.exit(0)
}

const { state: client, logs, logsPrimary, logsSecondary } = ethereumClients()
// UQ-23: timelock proposer logs are read on two independent keyed endpoints, every empty chunk
// cross-checked on the second
setLogClients(logsPrimary, logsSecondary)
const head = Number(await retry(() => client.getBlockNumber())) - 3
const headTs = Number((await retry(() => client.getBlock({ blockNumber: BigInt(head) }))).timestamp)
log(`head ${head} (${new Date(headTs * 1000).toISOString()}), ${subjects.length} subjects`)
const ctx = { warnings: [] }

// ---- 1. LayerZero history (Ethereum) ----------------------------------------------------------------
const allOApps = [...new Set(subjects.flatMap((s) => s.lzOApps))]
log(`LZ scan: ${allOApps.length} OApps from block ${ETH.endpointDeployBlock}`)
const lzEvents = allOApps.length
  ? await scanLzConfig({
      client: logs,
      chainId: 1,
      endpoint: ETH.endpoint,
      libs: [ETH.sendUln302, ETH.receiveUln302],
      oapps: allOApps,
      from: ETH.endpointDeployBlock,
      to: head,
      cacheDir: CACHE,
      log,
    })
  : []

// ---- 2. Admin / CCIP / mint history ------------------------------------------------------------------
const adminAddrs = [...new Set(subjects.flatMap((s) => s.contracts.map((c) => c.address)))]
const adminFrom = Math.max(
  file.scanFloor,
  Math.min(...subjects.flatMap((s) => s.contracts.map((c) => c.deployBlock))),
)
log(`admin scan: ${adminAddrs.length} contracts from block ${adminFrom}`)
// The CCIP TokenAdminRegistry is shared by every token: keep only this run's subject tokens.
const TAR = '0xb22764f98dd05c789929716d677382df22c05cb6'
const subjectTokens = new Set(
  subjects.flatMap((s) => s.contracts.filter((c) => c.role === 'token').map((c) => c.address)),
)
const keepAdmin = (r) => r.emitter !== TAR || subjectTokens.has(lc(r.args.token))
// Solady RoleSet (ether.fi RoleRegistry) is replayed as RoleGranted / RoleRevoked (review round 6)
let adminRows = (
  await scanLogs({
    client: logs,
    chainId: 1,
    addresses: adminAddrs,
    topics0: ADMIN_TOPICS,
    from: adminFrom,
    to: head,
    cacheDir: CACHE,
    span: 250_000,
    keep: keepAdmin,
    cacheKey: [...subjectTokens].sort().join(','),
  })
).map(roleSetRow)
// Aragon ACLs (Lido DAO): permission events from the ACL's DEPLOYMENT — the ACL cannot list who
// holds a permission, so the replay needs all of them; rows before the scan window are replayed
// for state only (fileFrom), never filed. Then the ACL / Kernel rows are rewritten onto the apps
// they act on (SetPermission → RoleGranted / RoleRevoked, SetApp → Upgraded; abi.mjs aragonRows).
for (const acl of [...new Set(subjects.map((s) => s.aragonAcl).filter(Boolean))]) {
  const dep = Math.min(
    ...subjects.flatMap((s) =>
      s.contracts.filter((c) => c.address === acl).map((c) => c.deployBlock),
    ),
  )
  if (dep >= adminFrom) continue
  const pre = await scanLogs({
    client: logs,
    chainId: 1,
    addresses: [acl],
    topics0: [TOPIC.SetPermission, TOPIC.ChangePermissionManager],
    from: dep,
    to: adminFrom - 1,
    cacheDir: CACHE,
    span: 1_000_000,
  })
  log(`  Aragon ACL ${acl.slice(0, 10)}…: ${pre.length} permission rows before the scan window`)
  adminRows = [...pre, ...adminRows]
}
// appId → the declared Aragon app proxies with it (a Kernel SetApp(base, appId) upgrades them)
const aragonApps = {}
for (const a of adminAddrs) {
  const k = await tryRead(client, a, fnAbi(FN.kernel), 'kernel')
  if (!k.ok || /^0x0*$/i.test(k.value)) continue
  const id = await tryRead(client, a, fnAbi(FN.appId), 'appId')
  if (id.ok) (aragonApps[lc(id.value)] ??= []).push(a)
}
// a parameterless event (EmergencyModeActivated()) carries no args, also in older cache chunks
for (const r of adminRows) r.args ??= {}
adminRows = aragonRows(adminRows, aragonApps).sort(
  (a, b) => a.block - b.block || a.logIndex - b.logIndex,
)
// an Aragon Agent is classified through its executor (RUN_SCRIPT / EXECUTE holders from the ACL)
setAragonExecCandidates(aragonExecCandidatesFromRows(adminRows))
log(`  ${adminRows.length} admin rows`)

// ---- 3. Head: powers → controllers discovered at head (their own events are scanned too) -------------
let roleMap = roleHoldersFromEvents(adminRows)
const powerReads = new Map()
const resolveAll = async () => {
  for (const s of subjects) {
    const out = []
    for (const p of s.powers) {
      try {
        const trail = new Set()
        const holders = await resolvePath(client, {
          endpoint: ETH.endpoint,
          contract: p.contract,
          path: p.path,
          roleMap,
          trail,
        })
        // the path's intermediate hops (a ProxyAdmin): scanned and in scope (review round 7)
        const via = [...trail].filter((a) => a !== lc(p.contract) && !holders.includes(a))
        out.push({
          power: p.power,
          label: p.label,
          contract: p.contract,
          holders,
          ...(via.length ? { via } : {}),
        })
      } catch (e) {
        out.push({
          power: p.power,
          label: p.label,
          contract: p.contract,
          holders: [],
          error: scrub(e?.message),
        })
      }
    }
    powerReads.set(s.key, out)
  }
}
await resolveAll()
// Timelock role holders (proposers / executors / admins) and power holders that are not yet
// scanned: scan their events too (Safe threshold / owner changes).
const extra = new Set()
for (const s of subjects)
  for (const h of subjectExtraEmitters(s, powerReads.get(s.key), roleMap))
    if (!adminAddrs.includes(h)) extra.add(h)
const extraCode = []
for (const a of extra) if (await retry(() => client.getCode({ address: a }))) extraCode.push(a)
if (extraCode.length) {
  log(`admin scan (discovered controllers): ${extraCode.length}`)
  const more = (
    await scanLogs({
      client: logs,
      chainId: 1,
      addresses: extraCode,
      topics0: ADMIN_TOPICS,
      from: adminFrom,
      to: head,
      cacheDir: CACHE,
      span: 250_000,
    })
  ).map(roleSetRow)
  for (const r of more) r.args ??= {}
  adminRows = [...adminRows, ...more].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
  roleMap = roleHoldersFromEvents(adminRows)
  await resolveAll()
}
// ruling #12: the timelock proposer candidates the admin scan saw (a cross-check for the
// per-timelock RoleGranted read in classify)
setRoleCandidates(adminRows)
for (const r of adminRows) {
  if (r.args?.role) r.args.roleName = roleName(r.args.role)
  // RoleAdminChanged: name both admin roles (AD-3 on who can grant the role)
  if (r.args?.previousAdminRole) r.args.previousAdminRoleName = roleName(r.args.previousAdminRole)
  if (r.args?.newAdminRole) r.args.newAdminRoleName = roleName(r.args.newAdminRole)
}

// ---- 4. DVN signer sets --------------------------------------------------------------------------------
const dvnSet = new Set()
for (const e of lzEvents)
  for (const a of [...(e.config?.requiredDVNs ?? []), ...(e.config?.optionalDVNs ?? [])])
    dvnSet.add(lc(a))
for (const a of [...dvnSet]) if (/^0x0{36}dead$/.test(a)) dvnSet.delete(a)
log(`DVN scan: ${dvnSet.size} DVNs`)
const dvnRows = dvnSet.size
  ? await scanLogs({
      client: logs,
      chainId: 1,
      addresses: [...dvnSet],
      topics0: DVN_TOPICS,
      from: ETH.endpointDeployBlock,
      to: head,
      cacheDir: CACHE,
    })
  : []

// ---- 5. timestamps -------------------------------------------------------------------------------------
const tsMap = await blockTimestamps(
  client,
  [...lzEvents, ...adminRows, ...dvnRows].map((e) => e.block),
  join(CACHE, 'ts-1.json'),
)
for (const e of [...lzEvents, ...adminRows, ...dvnRows]) e.ts = tsMap[e.block]

// ---- 6. LZ head reads + metadata ----------------------------------------------------------------------
const eidSet = new Set([30101, ...lzEvents.filter((e) => e.eid !== undefined).map((e) => e.eid)])
// An --only run keeps every chain the earlier runs detailed: the file is shared, and the other
// subjects' cards read their DVN registries from it (a wstETH-only run, which has no LayerZero
// route, rewrote it down to Ethereum alone).
if (ONLY.length)
  try {
    const prevMeta = JSON.parse(readFileSync(join(DIR, 'lz-metadata.json'), 'utf8'))
    for (const k of Object.keys(prevMeta.chains ?? {})) eidSet.add(Number(k))
  } catch {
    /* first run */
  }
const raw = await fetchLzMetadata(CACHE)
let metadata = compactLzMetadata(raw, eidSet, new Date().toISOString())
// the chains of every Wormhole NTT peer: their public RPCs read the remote manager (section 9b)
{
  const nttEvm = new Set(
    adminRows
      .filter(
        (r) =>
          r.event === 'PeerUpdated' &&
          subjects.some((s) => (s.nttManagers ?? []).includes(r.emitter)),
      )
      .map((r) => WORMHOLE_EVM_CHAINS[Number(r.args.chainId_)])
      .filter(Boolean),
  )
  const need = Object.entries(metadata.eids)
    .filter(([e, x]) => nttEvm.has(Number(x.chainId)) && !eidSet.has(Number(e)))
    .map(([e]) => Number(e))
  if (need.length) {
    need.forEach((e) => eidSet.add(e))
    metadata = compactLzMetadata(raw, eidSet, new Date().toISOString())
  }
}
writeJson(join(DIR, 'lz-metadata.json'), metadata)
const registry = registryOf(metadata)
const headRoutes = new Map()
const headDefaults = {}
const owners = {}
const delegates = {}
for (const oapp of allOApps) {
  const eids = [
    ...new Set(
      lzEvents.filter((e) => lc(e.oapp) === oapp && e.eid !== undefined).map((e) => e.eid),
    ),
  ]
  const rows = []
  const del = await tryRead(client, ETH.endpoint, fnAbi(FN.delegates), 'delegates', [oapp])
  if (del.ok) delegates[oapp] = lc(del.value)
  const own = await tryRead(client, oapp, fnAbi(FN.owner), 'owner')
  if (own.ok) owners[oapp] = lc(own.value)
  await pool(eids, 4, async (eid) => {
    const p = await tryRead(client, oapp, fnAbi(FN.peers), 'peers', [eid])
    // A failed READ is UNREAD (both directions), never a zero peer that drops the route; a
    // revert (no peers() / no library for the eid) is not a route.
    const unreadRow = (direction, error) => ({
      oapp,
      eid,
      direction,
      lib: '0x0000000000000000000000000000000000000000',
      libIsDefault: null,
      merged: null,
      mergedError: error,
      app: null,
      peer: p.ok ? lc(p.value) : '0x',
    })
    if (!p.ok && p.reverted) return
    if (!p.ok) {
      for (const direction of ['send', 'receive'])
        rows.push(unreadRow(direction, `peers() read failed: ${p.error}`))
      return
    }
    const peer = lc(p.value)
    if (/^0x0*$/.test(peer)) return
    for (const direction of ['send', 'receive']) {
      const r = await readRoute(client, { endpoint: ETH.endpoint, oapp, eid, direction })
      if (!r.ok) {
        if (!r.reverted) rows.push(unreadRow(direction, `library read failed: ${r.error}`))
        continue
      }
      rows.push({
        oapp,
        eid,
        direction,
        lib: r.lib,
        libIsDefault: r.libIsDefault,
        merged: r.merged,
        mergedError: r.mergedError,
        mergedReverted: r.mergedReverted,
        app: r.app,
        grace: r.grace,
        peer,
      })
      const k = `${r.lib}|${eid}`
      if (!headDefaults[k]) {
        const d = await tryRead(client, r.lib, fnAbi(FN.getAppUlnConfig), 'getAppUlnConfig', [
          '0x0000000000000000000000000000000000000000',
          eid,
        ])
        if (d.ok) headDefaults[k] = ulnFromTuple(d.value)
      }
    }
  })
  headRoutes.set(oapp, rows)
  log(`  head ${oapp.slice(0, 10)}…: ${rows.length / 2} live-peer routes`)
}

// owner() of every other subject contract too (review fix: a queued transferOwnership on a
// ProxyAdmin, EthenaMinting or a token was judged against "owner not read")
for (const a of [
  ...new Set(subjects.flatMap((s) => [...s.contracts.map((c) => lc(c.address)), ...s.timelocks])),
])
  if (!owners[a]) {
    const own = await tryRead(client, a, fnAbi(FN.owner), 'owner')
    if (own.ok && !/^0x0*$/.test(lc(own.value))) owners[a] = lc(own.value)
  }

// DVN code at first use (BR-4 / "known as of block").
const firstUse = new Map()
for (const e of lzEvents)
  for (const a of [...(e.config?.requiredDVNs ?? []), ...(e.config?.optionalDVNs ?? [])])
    firstUse.set(lc(a), Math.min(firstUse.get(lc(a)) ?? Infinity, e.block))
for (const rows of headRoutes.values())
  for (const r of rows)
    for (const a of [...(r.merged?.requiredDVNs ?? []), ...(r.merged?.optionalDVNs ?? [])])
      if (!firstUse.has(lc(a))) firstUse.set(lc(a), head)
const codeProbes = await firstCodeBlocks(client, [...firstUse.keys()], (a) => firstUse.get(a), head)

// DVN signer changes (DV-1 / DV-2) and head quorum.
const dvnAbi = { quorum: fnAbi(FN.quorum), signerSize: fnAbi(FN.signerSize) }
const dvnState = async (dvn, block) => {
  const q = await tryRead(client, dvn, dvnAbi.quorum, 'quorum', [], block)
  const s = await tryRead(client, dvn, dvnAbi.signerSize, 'signerSize', [], block)
  const out = { quorum: q.ok ? Number(q.value) : null, signers: s.ok ? Number(s.value) : null }
  // a failed read before the DVN existed is its deploy block (setup), not an unread state
  if (block !== undefined && (out.quorum === null || out.signers === null))
    out.noCode = !(await codeAt(client, dvn, block).catch(() => true))
  return out
}
const dvnSigner = await replayDvnSigners(dvnRows, dvnState)
const dvnHead = {}
for (const dvn of firstUse.keys())
  if (codeProbes[dvn] && !codeProbes[dvn].never) dvnHead[dvn] = await dvnState(dvn)

// ---- 7. remote side of every live route (eth_call only; REMOTE UNREAD on failure) --------------------
const remote = new Map()
const remoteSupply = {}
if (!flag('no-remote')) {
  // every live Ethereum route, and every route whose Ethereum peer was zeroed (its remote OApp,
  // at the last non-zero peer, may still accept a packet from Ethereum — review round 6)
  const byEid = remoteReadList(headRoutes, lzEvents, allOApps)
  await pool([...byEid.entries()], 4, async ([eid, list]) => {
    const chain = metadata.chains[eid]
    const unread = (reason) =>
      list.forEach((x) =>
        remote.set(`${x.oapp}|${eid}`, {
          oapp: x.oapp,
          eid,
          chainKey: metadata.eids[eid]?.chainKey ?? String(eid),
          chainId: chain?.chainId ?? null,
          status: 'remote_unread',
          reason,
        }),
      )
    if (!chain || !chain.evm || !chain.chainId) return unread('non-EVM chain or no metadata')
    const rc = await clientForChain(chain)
    if (!rc) return unread('no working public RPC')
    for (const x of list) {
      // EVM peers are right-aligned addresses; anything else cannot be read as a contract.
      if (!/^0x0{24}[0-9a-f]{40}$/.test(x.peer)) {
        remote.set(`${x.oapp}|${eid}`, {
          oapp: x.oapp,
          eid,
          chainKey: chain.chainKey,
          chainId: chain.chainId,
          status: 'remote_unread',
          reason: 'peer is not a right-aligned EVM address',
        })
        continue
      }
      const peerAddr = '0x' + x.peer.slice(-40)
      try {
        const rr = await readRemoteRoute(rc, chain, peerAddr)
        if (!Object.values(rr.directions).some((r) => r.ok)) {
          remote.set(`${x.oapp}|${eid}`, {
            oapp: x.oapp,
            eid,
            chainKey: chain.chainKey,
            chainId: chain.chainId,
            status: 'remote_unread',
            reason: 'every remote read failed (public RPCs)',
          })
          continue
        }
        // the remote side's bridged supply (severity rank of floor breaches, owner ruling #9)
        const sup = await tryRead(rc, peerAddr, fnAbi(FN.totalSupply), 'totalSupply')
        const dec = sup.ok ? await tryRead(rc, peerAddr, fnAbi(FN.decimals), 'decimals') : null
        remoteSupply[`${x.oapp}|${eid}`] =
          sup.ok && dec?.ok
            ? { amount: { raw: String(sup.value), decimals: Number(dec.value) } }
            : {
                amount: null,
                note: `remote supply not read on ${chain.chainKey} (${sup.ok ? dec?.error : sup.error})`,
              }
        remote.set(`${x.oapp}|${eid}`, {
          oapp: x.oapp,
          eid,
          chainKey: chain.chainKey,
          chainId: chain.chainId,
          status: 'ok',
          peer: peerAddr,
          peerBack: rr.peerBack,
          // the remote chain's block of the reads: a receive grace period's expiry is judged on it
          block: rr.block ?? undefined,
          directions: Object.fromEntries(
            Object.entries(rr.directions).map(([d, r]) => [
              d,
              r.ok
                ? {
                    lib: r.lib,
                    merged: r.merged,
                    mergedError: r.mergedError,
                    mergedReverted: r.mergedReverted,
                    // the old receive library in its grace period (review round 5: was dropped)
                    grace: r.grace,
                  }
                : null,
            ]),
          ),
          dvnCode: rr.dvnCode,
        })
      } catch (e) {
        remote.set(`${x.oapp}|${eid}`, {
          oapp: x.oapp,
          eid,
          chainKey: chain.chainKey,
          chainId: chain.chainId,
          status: 'remote_unread',
          reason: scrub(e?.shortMessage || e?.message),
        })
      }
    }
  })
  log(
    `remote reads: ${[...remote.values()].filter((r) => r.status === 'ok').length} ok, ${[...remote.values()].filter((r) => r.status !== 'ok').length} REMOTE UNREAD`,
  )
}

// ---- 7b. value at risk behind each route (severity rank of floor breaches, owner ruling #9) ----------
// Ethereum: an OFT adapter's locked balance (underlying.balanceOf(adapter)); a native OFT or any
// other OApp has no lockbox here (noted). Price: the oracle registry's consensus for the subject's
// catalog asset (latest snapshot) × an optional on-chain rate (rsETH/ETH from LRTOracle).
const locked = {}
for (const oapp of allOApps) {
  const t = await tryRead(client, oapp, fnAbi(FN.token), 'token')
  if (!t.ok) {
    locked[oapp] = {
      amount: null,
      note: t.reverted
        ? 'not an OFT adapter: no lockbox on Ethereum read'
        : `token() read failed (${t.error})`,
    }
    continue
  }
  const token = lc(t.value)
  if (token === oapp) {
    locked[oapp] = { amount: null, note: 'native OFT: nothing locked on Ethereum' }
    continue
  }
  const b = await tryRead(client, token, fnAbi(FN.balanceOf), 'balanceOf', [oapp])
  const d = await tryRead(client, token, fnAbi(FN.decimals), 'decimals')
  locked[oapp] =
    b.ok && d.ok
      ? { amount: { raw: String(b.value), decimals: Number(d.value) }, token }
      : { amount: null, note: `locked balance not read (${b.ok ? d.error : b.error})` }
}
const priceOf = new Map()
{
  let board = null
  let basisBlock = null
  try {
    const cls = await loadTs('../../../../lib/oracleRegistry/classify.ts')
    const cat = await loadTs('../../../../lib/oracleRegistry/catalog.ts')
    const snap = JSON.parse(
      readFileSync(join(ROOT, 'data', 'oracle-registry', 'snapshots', 'latest.json'), 'utf8'),
    )
    board = cls.evaluateSnapshot(cat.getOracleCatalog(), snap)
    basisBlock = snap.block
  } catch (e) {
    ctx.warnings.push(`registry consensus not loaded: ${scrub(e?.message)}`)
  }
  for (const s of subjects) {
    const v = s.valuation
    if (!v) continue
    const cons = board?.assets.find((a) => a.asset === v.asset)?.consensus
    const usd = cons?.status === 'ok' ? cons.price : null
    let rate
    let rateNote = ''
    if (v.rate) {
      const r = await tryRead(
        client,
        v.rate.contract,
        fnAbi(v.rate.sig),
        v.rate.sig.match(/function (\w+)/)[1],
      )
      rate = r.ok ? { raw: String(r.value), decimals: v.rate.decimals } : null
      rateNote = ` × ${v.rate.sig.match(/function (\w+)/)[1]}() on ${v.rate.contract.slice(0, 10)}…${r.ok ? '' : ' (NOT READ)'}`
    }
    const valueTs = await loadTs('../../../../lib/oracleRegistry/config/value.ts')
    priceOf.set(s.key, {
      priceUsd: valueTs.tokenPriceUsd(usd, rate),
      priceBasis: `${v.asset} registry consensus${basisBlock ? ` (snapshot block ${basisBlock})` : ''}${cons && cons.status !== 'ok' ? ` — ${cons.status}` : ''}${rateNote}`,
    })
  }
}

// ---- 8. controllers (head + at event blocks) ----------------------------------------------------------
const controllers = {}
const want = new Set()
const wantAt = new Set()
for (const s of subjects)
  for (const p of powerReads.get(s.key))
    for (const h of [...p.holders, ...(p.via ?? [])]) want.add(h)
for (const a of [...Object.values(owners), ...Object.values(delegates)]) want.add(a)
// every proposer / executor / canceller / admin of a declared timelock is classified at head:
// its Safe fields are diffed run to run (review round 7: the Ethena EXECUTOR Safe was scanned
// for events but missing from the snapshot)
for (const t of subjects.flatMap((s) => s.timelocks))
  for (const role of TIMELOCK_SCOPE_ROLES)
    for (const h of roleMap.get(`${t}|${roleHash(role)}`) ?? []) want.add(h)
// every declared Safe is classified at head (wstETH: the Dual Governance emergency committees are
// declared but sit on no power path — without this they never reached the card or the run-to-run
// Safe snapshot)
for (const s of subjects) for (const a of s.safes) want.add(lc(a))
// the previous CCIP token administrator is the one the last AdministratorTransferred set: classify
// it one block before the next transfer (the event names only the new one)
const prevCcipAdminOf = new Map()
{
  const last = {}
  const tokens = new Set(
    subjects.flatMap((s) => s.contracts.filter((c) => c.role === 'token').map((c) => c.address)),
  )
  for (const r of adminRows
    .filter((x) => x.event === 'AdministratorTransferred' && tokens.has(lc(x.args.token)))
    .sort((x, y) => x.block - y.block || x.logIndex - y.logIndex)) {
    prevCcipAdminOf.set(r, last[lc(r.args.token)] ?? null)
    last[lc(r.args.token)] = lc(r.args.newAdmin)
  }
}
for (const r of adminRows) {
  const a = r.args
  const prevCcipAdmin = prevCcipAdminOf.get(r) ?? null
  const pairs = {
    OwnershipTransferred: [a.previousOwner, a.newOwner],
    AdminChanged: [a.previousAdmin, a.newAdmin],
    RoleGranted: [null, a.account],
    RebalancerSet: [a.oldRebalancer, a.newRebalancer],
    // CCIP 1.6 siloed pools (review round 5): the rebalancers are judged at their blocks too
    SiloRebalancerSet: [a.oldRebalancer, a.newRebalancer],
    UnsiloedRebalancerSet: [a.oldRebalancer, a.newRebalancer],
    ChainSiloed: [null, a.rebalancer],
    MasterMinterChanged: [null, a.newMasterMinter],
    PauserChanged: [null, a.newAddress],
    BlacklisterChanged: [null, a.newBlacklister],
    AdministratorTransferred: [prevCcipAdmin, a.newAdmin],
    // Aragon / Lido Dual Governance / Wormhole NTT (the previous holder of the *Set events is read
    // one block earlier below)
    PermissionManagerChanged: [null, a.manager],
    ProposerRegistered: [null, a.proposer],
    PauserTransferred: [a.oldPauser, a.newPauser],
    ...Object.fromEntries(DG_SETTERS.map((e) => [e, [null, firstAddr(a)]])),
  }[r.event]
  if (pairs) {
    if (pairs[0] && !/^0x0*$/.test(pairs[0])) wantAt.add(`${lc(pairs[0])}@${r.block - 1}`)
    if (pairs[1]) wantAt.add(`${lc(pairs[1])}@${r.block}`)
  }
  if (
    [
      'AddedOwner',
      'RemovedOwner',
      'ChangedThreshold',
      'OwnerAddition',
      'OwnerRemoval',
      'RequirementChange',
    ].includes(r.event)
  ) {
    wantAt.add(`${r.emitter}@${r.block - 1}`)
    wantAt.add(`${r.emitter}@${r.block}`)
  }
}
// Enrichment: events that do not carry the previous holder (read the getter one block earlier).
const prevGetter = {
  MasterMinterChanged: 'masterMinter',
  PauserChanged: 'pauser',
  BlacklisterChanged: 'blacklister',
}
// Lido Dual Governance setters: the value before, read one block earlier on the emitter
const dgPrevSig = {
  GovernanceSet: 'function getGovernance() view returns (address)',
  AdminExecutorSet: 'function getAdminExecutor() view returns (address)',
  EmergencyGovernanceSet: 'function getEmergencyGovernance() view returns (address)',
  EmergencyActivationCommitteeSet:
    'function getEmergencyActivationCommittee() view returns (address)',
  EmergencyExecutionCommitteeSet:
    'function getEmergencyExecutionCommittee() view returns (address)',
  ProposalsCancellerSet: 'function getProposalsCanceller() view returns (address)',
  ResealCommitteeSet: 'function getResealCommittee() view returns (address)',
  ConfigProviderSet: 'function getConfigProvider() view returns (address)',
  TiebreakerCommitteeSet:
    'function getTiebreakerDetails() view returns ((bool isTie, address tiebreakerCommittee, uint256 tiebreakerActivationTimeout, address[] sealableWithdrawalBlockers))',
  AfterSubmitDelaySet: 'function getAfterSubmitDelay() view returns (uint32)',
  AfterScheduleDelaySet: 'function getAfterScheduleDelay() view returns (uint32)',
}
for (const r of adminRows) {
  if (dgPrevSig[r.event]) {
    const sig = dgPrevSig[r.event]
    const x = await tryRead(
      client,
      r.emitter,
      fnAbi(sig),
      sig.match(/function (\w+)/)[1],
      [],
      r.block - 1,
    )
    const v = x.ok ? (x.value?.tiebreakerCommittee ?? x.value) : null
    r.prev = v === null || v === undefined ? null : typeof v === 'string' ? lc(v) : String(v)
    if (r.prev && /^0x[0-9a-f]{40}$/.test(r.prev)) wantAt.add(`${r.prev}@${r.block - 1}`)
  }
  if (r.event === 'PermissionManagerChanged' && r.args.acl) {
    const x = await tryRead(
      client,
      r.args.acl,
      fnAbi(FN.getPermissionManager),
      'getPermissionManager',
      [r.emitter, r.args.role],
      r.block - 1,
    )
    r.prev = x.ok ? lc(x.value) : null
    if (r.prev && !/^0x0*$/.test(r.prev)) wantAt.add(`${r.prev}@${r.block - 1}`)
  }
  // Wormhole NTT: the verifier network of each transceiver (its code persists: read at head)
  if (r.event === 'TransceiverAdded' || r.event === 'TransceiverRemoved') {
    const t = await tryRead(
      client,
      r.args.transceiver,
      fnAbi('function getTransceiverType() view returns (string)'),
      'getTransceiverType',
    )
    r.args.transceiverType = t.ok ? String(t.value) : null
  }
}
for (const r of adminRows) {
  if (prevGetter[r.event]) {
    const x = await tryRead(
      client,
      r.emitter,
      fnAbi(`function ${prevGetter[r.event]}() view returns (address)`),
      prevGetter[r.event],
      [],
      r.block - 1,
    )
    r.prev = x.ok ? lc(x.value) : null
    if (r.prev) wantAt.add(`${r.prev}@${r.block - 1}`)
  }
  if (r.event === 'MinterConfigured') {
    const x = await tryRead(
      client,
      r.emitter,
      fnAbi('function minterAllowance(address) view returns (uint256)'),
      'minterAllowance',
      [r.args.minter],
      r.block - 1,
    )
    r.prev = x.ok ? String(x.value) : null
  }
}
for (const e of lzEvents.filter((x) => x.kind === 'delegate')) {
  wantAt.add(`${lc(e.delegate)}@${e.block}`)
}
// OR-1: an oracle source is judged on what it was at the block it was set.
const oracleChanges = (() => {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'data', 'oracle-registry', 'changes.json'), 'utf8'))
  } catch {
    return { events: [] }
  }
})()
for (const e of oracleChanges.events ?? [])
  if (/SourceUpdated|SourceSet$/.test(e.event) && (e.args?.source ?? e.args?.newSource))
    wantAt.add(`${lc(e.args.source ?? e.args.newSource)}@${e.block}`)
// AD-5: the upgrade power's holders at the block BEFORE each upgrade / admin change, so a
// timelock is only expected in transactions after it actually held that power.
const upgradeHoldersAt = {}
const upgradeSpecs = new Map()
for (const s of subjects)
  for (const p of s.powers) if (p.power === 'upgrade') upgradeSpecs.set(p.contract, p.path)
for (const r of adminRows) {
  if (
    !['Upgraded', 'AdminChanged', 'BeaconUpgraded'].includes(r.event) ||
    !upgradeSpecs.has(r.emitter)
  )
    continue
  const hs = await resolvePath(client, {
    endpoint: ETH.endpoint,
    contract: r.emitter,
    path: upgradeSpecs.get(r.emitter),
    roleMap,
    block: r.block - 1,
  })
  upgradeHoldersAt[`${r.emitter}@${r.block}`] = hs
  for (const h of hs) wantAt.add(`${h}@${r.block - 1}`)
}
// Safe initialization: a Safe event in the Safe's own creation tx (no code one block earlier).
for (const r of adminRows)
  if (
    ['ChangedFallbackHandler', 'ChangedGuard', 'ChangedModuleGuard', 'EnabledModule'].includes(
      r.event,
    )
  )
    wantAt.add(`${r.emitter}@${r.block - 1}`)
log(`controllers: ${want.size} at head, ${wantAt.size} at event blocks`)
await pool([...want], 4, async (a) => {
  controllers[`${a}@head`] = await classify(client, a)
})
// the Dual Governance committees and canceller the head controllers name (classified below with
// the other late additions to `want`)
for (const c of Object.values(controllers)) for (const a of dgCommitteeAddresses(c)) want.add(a)
// A classification at a past block never changes: cache it across runs. v2 = classification
// from the code (canonical Safe singleton, timelock dispatch table, bypass paths); v3 = a
// timelock carries its schedulers (owner ruling 2026-10-08, #12); v4 (review round 9) = owner
// hops counted from the last scheduler hop, ownership cycles not followed, a timelock's delay
// setters; v5 (review round 10) = before Multicall3 (block 14,353,601) the views are read one
// eth_call each (a Safe there was a plain contract), and an owner past the hop limit is
// recorded (`ownerNotFollowed`). A v4 entry at or after the Multicall3 block carries over (no v4
// entry in the cache reached the owner hop limit: measured 2026-10-09); older ones are read again.
const AT_CACHE = join(CACHE, 'controllers-at-v5.json')
const AT_CACHE_V4 = join(CACHE, 'controllers-at-v4.json')
const atCache = existsSync(AT_CACHE)
  ? JSON.parse(readFileSync(AT_CACHE, 'utf8'))
  : existsSync(AT_CACHE_V4)
    ? Object.fromEntries(
        Object.entries(JSON.parse(readFileSync(AT_CACHE_V4, 'utf8'))).filter(
          ([k]) => Number(k.split('@')[1]) >= MULTICALL3_BLOCK,
        ),
      )
    : {}
// Review round 10 (O-4): a classification at a past block that FAILED is recorded, so the engine
// never replaces it with the head classification (that mixes eras; fail closed)
const classifyFailed = new Set()
// Review round 8: the holders a role grant is ranked against are classified AT the grant block.
// The replay fell back to their head classification (or, with none, to "not ranked against") —
// and the head now covers every current holder with code (below), so the fallback would rank a
// past grant against today's holder. Only PRIVILEGED roles (and roles that administer others)
// are ranked; a holder that was a plain EOA when granted is skipped (it ranks as an EOA).
const rulesTs = await loadTs('../../../../lib/oracleRegistry/config/rules.ts')
// Review round 9: a committee member change is neutral only when the declared delayed path MADE
// it (adminReplay `committeePathVia`): the recipient of each such transaction is read (a
// transaction sent to the path runs nothing outside it), and the calldata of every CallExecuted
// that targets a committee is kept (it must name the member). A failed read is null (no proof).
const { COMMITTEE_EVENTS } = await loadTs('../../../../lib/oracleRegistry/config/adminReplay.ts')
const committeeEmitters = new Set(
  adminRows.filter((r) => COMMITTEE_EVENTS.has(r.event)).map((r) => lc(r.emitter)),
)
const committeeTxTo = {}
await pool(
  [...new Set(adminRows.filter((r) => COMMITTEE_EVENTS.has(r.event)).map((r) => r.tx))],
  4,
  async (h) => {
    try {
      const t = await retry(() => client.getTransaction({ hash: h }))
      committeeTxTo[h] = t?.to ? lc(t.to) : null
    } catch {
      committeeTxTo[h] = null
    }
  },
)
// UQ-19: a committee member change is judged by the rank of the path controller that made it
// against the committee's own controllers (the holders of the declared powers over it), both at
// block − 1: classify the path executors of each such transaction and the committee's power
// holders there (the engine falls back to head, which mixes eras: the 2023 Voting path against
// the 2026 Dual Governance Agent)
{
  const powerHoldersOn = new Map()
  for (const s of subjects)
    for (const p of powerReads.get(s.key) ?? [])
      powerHoldersOn.set(lc(p.contract), [
        ...(powerHoldersOn.get(lc(p.contract)) ?? []),
        ...p.holders,
      ])
  const byTx = new Map()
  for (const r of adminRows) byTx.set(r.tx, [...(byTx.get(r.tx) ?? []), r])
  for (const r of adminRows.filter((x) => COMMITTEE_EVENTS.has(x.event))) {
    for (const h of powerHoldersOn.get(lc(r.emitter)) ?? []) wantAt.add(`${lc(h)}@${r.block - 1}`)
    for (const x of byTx.get(r.tx) ?? [])
      if (['CallExecuted', 'ProposalExecuted', 'ExecuteVote'].includes(x.event))
        wantAt.add(`${lc(x.emitter)}@${r.block - 1}`)
  }
}
const adminRoleNames = new Map()
for (const r of adminRows)
  if (r.event === 'RoleAdminChanged')
    adminRoleNames.set(
      r.emitter,
      new Set([
        ...(adminRoleNames.get(r.emitter) ?? []),
        String(r.args.newAdminRoleName ?? roleName(r.args.newAdminRole)),
      ]),
    )
const rankedRole = (r) => {
  const name = String(r.args.roleName ?? roleName(r.args.role))
  return rulesTs.isPrivilegedRole(name) || !!adminRoleNames.get(r.emitter)?.has(name)
}
{
  const held = new Map()
  const grantedAt = new Map()
  for (const r of [...adminRows].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)) {
    if (r.event !== 'RoleGranted' && r.event !== 'RoleRevoked') continue
    const k = `${r.emitter}|${lc(r.args.role)}`
    const acct = lc(r.args.account)
    const set = held.get(k) ?? new Set()
    if (r.event === 'RoleGranted' && rankedRole(r)) {
      for (const h of set) {
        if (h === acct) continue
        const own = atCache[`${h}@${grantedAt.get(`${k}|${h}`)}`]
        if (own && (own.kind === 'eoa' || own.kind === 'eoa_7702')) continue
        wantAt.add(`${h}@${r.block}`)
      }
    }
    if (r.event === 'RoleGranted') {
      set.add(acct)
      if (!grantedAt.has(`${k}|${acct}`)) grantedAt.set(`${k}|${acct}`, r.block)
    } else {
      set.delete(acct)
      grantedAt.delete(`${k}|${acct}`)
    }
    held.set(k, set)
  }
  log(`role holders at their grant blocks: ${wantAt.size} at event blocks in all`)
}
await pool([...wantAt], 6, async (k) => {
  if (atCache[k]) return void (controllers[k] = atCache[k])
  const [a, b] = k.split('@')
  try {
    controllers[k] = atCache[k] = await classify(client, a, Number(b))
  } catch (e) {
    classifyFailed.add(k)
    ctx.warnings.push(`classify ${a}@${b}: ${scrub(e?.message)}`)
  }
})
writeJson(AT_CACHE, atCache)
// Previous delegates for DelegateSet (the replay knows them; classify one block before).
{
  const lastDel = {}
  for (const e of lzEvents.filter((x) => x.kind === 'delegate').sort((a, b) => a.block - b.block)) {
    const prev = lastDel[lc(e.oapp)]
    if (prev && !controllers[`${prev}@${e.block - 1}`])
      controllers[`${prev}@${e.block - 1}`] = await classify(client, prev, e.block - 1)
    lastDel[lc(e.oapp)] = lc(e.delegate)
  }
}

// ---- 9. timelock queues + Safe queues ----------------------------------------------------------------
// Who to simulate execute() from: anyone when EXECUTOR_ROLE is open, else every holder (up
// to 4) until one can run it — one revoked or wrong executor never makes an op look stale.
const execOf = async (timelock) => {
  const open = await tryRead(client, timelock, fnAbi(FN.hasRole), 'hasRole', [
    roleHash('EXECUTOR_ROLE'),
    '0x0000000000000000000000000000000000000000',
  ])
  if (open.ok && open.value) return ['0x000000000000000000000000000000000000dEaD']
  const hs = [...(roleMap.get(`${timelock}|${roleHash('EXECUTOR_ROLE')}`) ?? [])].slice(0, 4)
  return hs.length ? hs : ['0x000000000000000000000000000000000000dEaD']
}
const opsByTimelock = new Map()
for (const t of [...new Set(subjects.flatMap((s) => s.timelocks))]) {
  const ops = await readOps(client, opsFromEvents(adminRows, t), {
    now: headTs,
    executorsOf: execOf,
  })
  opsByTimelock.set(t, ops)
  const st = { pending: 0, ready: 0, armed: 0 }
  const sims = {}
  for (const o of ops) {
    if (o.timestamp === null) st.unread = (st.unread ?? 0) + 1
    else if (o.timestamp > headTs) st.pending++
    else if (o.timestamp > 1) {
      st.ready++
      if (o.simulation === 'ok') st.armed++
      sims[o.simulation] = (sims[o.simulation] ?? 0) + 1
    }
  }
  log(
    `  timelock ${t.slice(0, 10)}…: ${ops.length} ops, ${st.pending} pending, ${st.ready} ready (${st.armed} executable; simulations ${JSON.stringify(sims)})${st.unread ? `, ${st.unread} state UNREAD` : ''}`,
  )
  // classify call arguments that the queue judges at head (grantees, new owners, providers)
  for (const o of ops)
    for (const c of o.calls)
      for (const m of String(c.data).slice(10).match(/.{64}/g) ?? [])
        if (/^0{24}[0-9a-f]{40}$/.test(m)) want.add('0x' + m.slice(24))
}
let safeStatus = []
let safeRows = []
if (!flag('no-safe')) {
  const safes = new Set(subjects.flatMap((s) => s.safes))
  for (const s of subjects)
    for (const p of powerReads.get(s.key))
      for (const h of p.holders) if (controllers[`${h}@head`]?.kind === 'safe') safes.add(h)
  for (const t of subjects.flatMap((s) => s.timelocks))
    for (const h of roleMap.get(`${t}|${roleHash('PROPOSER_ROLE')}`) ?? [])
      if (controllers[`${h}@head`]?.kind === 'safe') safes.add(h)
  const res = await safeQueues([...safes], async (s) => {
    const n = await tryRead(client, s, fnAbi(FN.nonce), 'nonce')
    return n.ok ? Number(n.value) : 0
  })
  safeStatus = res.map((r) => ({ safe: lc(r.safe), status: r.status, note: r.note }))
  safeRows = res.flatMap((r) => r.rows)
  log(
    `Safe Tx Service: ${res.filter((r) => r.status === 'ok').length}/${res.length} ok, ${safeRows.length} queued proposals`,
  )
  for (const p of safeRows)
    for (const m of String(p.data ?? '')
      .slice(10)
      .match(/.{64}/g) ?? [])
      if (/^0{24}[0-9a-f]{40}$/.test(m)) want.add('0x' + m.slice(24))
}
// Legacy MultiSigWallets at the end of a power's deferral chain (WBTC Controller / Members):
// their submitted-but-unexecuted transactions are the pending changes (observable on-chain).
const leafOf = (c) => (c?.kind === 'contract' && c.ownedBy ? leafOf(c.ownedBy) : c)
const multisigs = new Set()
for (const s of subjects)
  for (const p of powerReads.get(s.key))
    for (const h of p.holders) {
      const l = leafOf(controllers[`${h}@head`])
      if (l?.kind === 'legacy_multisig') multisigs.add(lc(l.address))
    }
const multisigReads = new Map()
for (const ms of multisigs) {
  const r = await readMultisigSubmissions(client, ms)
  // When each pending transaction was submitted (review round 7: WBTC's pending rows showed
  // "—" for block and date, so a 2019 submission read like a fresh one): its Submission event,
  // scanned from the multisig's first block with code. Unfound ⇒ the row says so.
  if (r.status === 'ok' && r.rows.length) {
    try {
      const fc = await firstCodeBlocks(client, [ms], () => 0, head)
      const from = fc[ms]?.firstCode ?? 0
      const subs = await scanLogs({
        client: logs,
        chainId: 1,
        addresses: [ms],
        topics0: [TOPIC.Submission],
        from,
        to: head,
        cacheDir: CACHE,
        span: 1_000_000,
      })
      const at = new Map(subs.map((x) => [Number(x.args.transactionId), x]))
      const ts = await blockTimestamps(
        client,
        r.rows.map((row) => at.get(row.txId)?.block).filter((b) => b !== undefined),
        join(CACHE, 'ts-1.json'),
      )
      for (const row of r.rows) {
        const x = at.get(row.txId)
        if (!x) continue
        row.block = x.block
        row.tx = x.tx
        row.ts = ts[x.block]
      }
    } catch (e) {
      ctx.warnings.push(`multisig ${ms}: submission blocks not read (${scrub(e?.message)})`)
    }
  }
  multisigReads.set(ms, r)
  log(
    `  MultiSigWallet ${ms.slice(0, 10)}…: ${r.status === 'ok' ? `${r.rows.length} submitted, unexecuted` : `submissions NOT read (${r.note})`}`,
  )
  for (const row of r.rows)
    for (const m of String(row.data ?? '')
      .slice(10)
      .match(/.{64}/g) ?? [])
      if (/^0{24}[0-9a-f]{40}$/.test(m)) want.add('0x' + m.slice(24))
}
// Lido Dual Governance timelocks at the end of a power's deferral chain: their submitted and
// scheduled proposals are the pending changes (read on-chain, getProposal).
const dgTimelocks = new Set()
for (const s of subjects)
  for (const p of powerReads.get(s.key))
    for (const h of p.holders) {
      const l = leafOf(controllers[`${h}@head`])
      if (l?.kind === 'aragon_dg') dgTimelocks.add(lc(l.address))
    }
const dgReads = new Map()
for (const t of dgTimelocks) {
  const r = await readDgProposals(client, t, { now: headTs })
  dgReads.set(t, r)
  log(
    `  Dual Governance ${t.slice(0, 10)}…: ${r.status === 'ok' ? `${r.count} proposals, ${r.ops.length} not executed / cancelled` : `proposals NOT read (${scrub(r.note)})`}`,
  )
  for (const o of r.ops)
    for (const c of o.calls)
      for (const m of String(c.data).slice(10).match(/.{64}/g) ?? [])
        if (/^0{24}[0-9a-f]{40}$/.test(m)) want.add('0x' + m.slice(24))
}
// Wormhole NTT managers and canonical rollup bridges (head reads)
const nttReads = {}
for (const m of [...new Set(subjects.flatMap((s) => s.nttManagers ?? []))]) {
  const chains = [
    ...new Set(
      adminRows
        .filter((r) => r.emitter === m && r.event === 'PeerUpdated')
        .map((r) => Number(r.args.chainId_)),
    ),
  ]
  // review round 8: every EVM chain Wormhole maps is read too — a false-empty PeerUpdated scan
  // must not leave the manager with no live route (and the floor switched off)
  nttReads[m] = await readNtt(
    client,
    m,
    chains,
    Object.keys(WORMHOLE_EVM_CHAINS)
      .map(Number)
      .filter((c) => c !== 2),
  )
  for (const a of [nttReads[m].owner, nttReads[m].pauser]) if (a) want.add(a)
  log(
    `  NTT ${m.slice(0, 10)}…: threshold ${nttReads[m].threshold} of ${nttReads[m].transceivers?.length ?? '?'}`,
  )
  // the remote side of each live peer (threshold, transceivers, owner, bridged supply), read with
  // that chain's public RPCs; unread sides say why (the engine counts them as read gaps)
  if (!flag('no-remote')) {
    const remoteSides = []
    for (const t of nttRemoteTargets(nttReads[m])) {
      const chain = t.chainId
        ? Object.values(metadata.chains).find((c) => c.evm && Number(c.chainId) === t.chainId)
        : null
      const base = {
        wormholeChainId: t.wormholeChainId,
        chainId: t.chainId,
        chainKey: chain?.chainKey ?? null,
      }
      const unread = (reason) => remoteSides.push({ ...base, status: 'remote_unread', reason })
      if (!t.chainId) {
        unread(`Wormhole chain ${t.wormholeChainId} is not mapped to an EVM chain`)
        continue
      }
      if (!chain) {
        unread(`no public RPC list for chain ${t.chainId}`)
        continue
      }
      const rc = await clientForChain(chain)
      if (!rc) {
        unread('no working public RPC')
        continue
      }
      try {
        remoteSides.push(await readNttRemote(rc, { ...base, peer: t.peer }))
      } catch (e) {
        unread(scrub(e?.shortMessage || e?.message))
      }
    }
    nttReads[m].remote = remoteSides
    for (const r of remoteSides)
      log(
        `    remote ${r.chainKey ?? r.wormholeChainId}: ${r.status === 'ok' ? `threshold ${r.threshold} of ${r.transceivers?.length ?? '?'}` : `REMOTE UNREAD (${r.reason})`}`,
      )
  }
}
const canonicalReads = {}
for (const b of subjects.flatMap((s) => s.canonicalBridges ?? [])) {
  if (canonicalReads[b.address]) continue
  canonicalReads[b.address] = await readCanonicalBridge(client, b.address, b.token)
  if (canonicalReads[b.address].admin) want.add(canonicalReads[b.address].admin)
}
// Review round 8 (on-chain #1): every CURRENT role holder that had code when it was granted is
// classified at head too — the engine re-judges the grant on the account as it is now (an MCMS
// whose owner moved from a key to a timelock; a Safe whose threshold changed). A holder that was
// a plain EOA when granted has no controller to change.
{
  const grantBlock = new Map()
  for (const r of adminRows)
    if (r.event === 'RoleGranted' && rankedRole(r))
      grantBlock.set(`${r.emitter}|${lc(r.args.role)}|${lc(r.args.account)}`, r.block)
  for (const [k, set] of roleMap)
    for (const h of set) {
      const b = grantBlock.get(`${k}|${h}`)
      // not a privileged role (no grant recorded as ranked): the engine never re-judges it
      if (b === undefined) continue
      const c = controllers[`${h}@${b}`]
      if (c && (c.kind === 'eoa' || c.kind === 'eoa_7702')) continue
      want.add(h)
    }
}
await pool(
  [...want].filter((a) => !controllers[`${a}@head`]),
  4,
  async (a) => {
    try {
      controllers[`${a}@head`] = await classify(client, a)
    } catch {
      /* unclassified: the engine shows 'unknown' */
    }
  },
)

// ---- 10. mint / redeem getters ------------------------------------------------------------------------
let params = { transitions: [], head: {} }
if (!flag('no-params')) {
  // review round 9: keys scoped by subject — weETH and wstETH both declare oracleQuorum /
  // oracleMembers, and one pass keyed by `key` alone gave weETH wstETH's values
  const specs = scopedParamSpecs(subjects)
  params = await paramTransitions(client, specs, {
    from: head - Math.round(PARAM_DAYS * 7200),
    head,
    log,
  })
  for (const t of params.transitions) {
    t.ts = Number((await retry(() => client.getBlock({ blockNumber: BigInt(t.block) }))).timestamp)
    t.tx = (await txAtBlock(client, t.contract, t.block, t.after)) ?? undefined
    if (typeof t.after === 'string' && /^0x[0-9a-f]{40}$/.test(t.after))
      controllers[`${t.after}@${t.block}`] = await classify(client, t.after, t.block)
    // the old value as it stood just before (EOA → EOA is a rotation, not a new minter)
    if (typeof t.before === 'string' && /^0x[0-9a-f]{40}$/.test(t.before))
      controllers[`${t.before}@${t.blockFrom}`] = await classify(client, t.before, t.blockFrom)
  }
  for (const v of Object.values(params.head))
    if (typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v) && !controllers[`${v}@head`])
      controllers[`${v}@head`] = await classify(client, v)
  log(`params: ${params.transitions.length} transitions`)
}

// ---- 11. implementation history (AD-8 stale rollback) --------------------------------------------------
const implHistory = {}
for (const r of adminRows.filter((x) => x.event === 'Upgraded')) {
  const h = (implHistory[r.emitter] = implHistory[r.emitter] ?? { impls: [], current: null })
  h.impls.push({ impl: lc(r.args.implementation), block: r.block })
}
for (const [proxy, h] of Object.entries(implHistory)) {
  const w = await retry(() =>
    client.getStorageAt({
      address: proxy,
      slot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
    }),
  )
  h.current = w ? '0x' + w.slice(-40) : null
}
const minDelays = {}
for (const t of subjects.flatMap((s) => s.timelocks)) {
  const d = await tryRead(client, t, fnAbi(FN.getMinDelay), 'getMinDelay')
  if (d.ok) minDelays[t] = Number(d.value)
}

// ---- 12. CCIP pools ---------------------------------------------------------------------------------------
const ccipPools = {}
for (const p of [...new Set(subjects.flatMap((s) => s.ccipPools))]) {
  ccipPools[p] = await readCcipPool(client, p)
  for (const a of [
    ccipPools[p].owner,
    ccipPools[p].rebalancer,
    ...ccipPools[p].chains.map((c) => c.rebalancer),
  ])
    if (a && !controllers[`${a}@head`]) controllers[`${a}@head`] = await classify(client, a)
}

// ---- 12b. deploy blocks of every admin-event emitter (initialization = its deploy block) -------------------
const DEPLOY_CACHE = join(CACHE, 'deploy-blocks.json')
const deployBlocks = existsSync(DEPLOY_CACHE) ? JSON.parse(readFileSync(DEPLOY_CACHE, 'utf8')) : {}
{
  const missing = [...new Set(adminRows.map((r) => r.emitter))].filter(
    (a) => deployBlocks[a] === undefined,
  )
  const probes = await firstCodeBlocks(client, missing, () => 0, head)
  for (const [a, p] of Object.entries(probes)) if (p.firstCode) deployBlocks[a] = p.firstCode
  writeJson(DEPLOY_CACHE, deployBlocks)
  log(`deploy blocks: ${missing.length} bisected, ${Object.keys(deployBlocks).length} known`)
}

// ---- 12c. source verification of implementations / providers / oracle sources (AD-9) --------------------
const verifyTargets = new Set()
// Rate providers / price oracles / oracle sources may sit behind a PROXY: their verification is
// the proxy's AND its implementation's (review round 5 — a verified proxy in front of an
// unverified implementation passed). Implementations from Upgraded are verified as they are.
const proxyTargets = new Set()
for (const r of adminRows)
  if (r.event === 'Upgraded' || r.event === 'BeaconUpgraded')
    verifyTargets.add(lc(r.args.implementation ?? r.args.beacon))
  else if (r.event === 'GovernanceSet' || r.event === 'ConfigProviderSet')
    verifyTargets.add(lc(firstAddr(r.args)))
  else if (r.event === 'AppAddressSet') verifyTargets.add(lc(r.args.app))
for (const e of oracleChanges.events ?? []) {
  const a = e.args?.implementation ?? e.args?.source ?? e.args?.newSource
  if (a) verifyTargets.add(lc(a))
  const src = e.args?.source ?? e.args?.newSource
  if (src) proxyTargets.add(lc(src))
}
for (const s of subjects)
  for (const sp of s.params.filter(
    (x) => x.rule === 'rate_provider' || x.rule === 'price_oracle',
  )) {
    const mine = paramsForSubject(params, s.key)
    const v = mine.head[sp.key]
    if (typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v)) {
      verifyTargets.add(v)
      proxyTargets.add(v)
    }
    for (const t of mine.transitions.filter((x) => x.key === sp.key))
      if (typeof t.after === 'string' && /^0x[0-9a-f]{40}$/.test(t.after)) {
        verifyTargets.add(t.after)
        proxyTargets.add(t.after)
      }
  }
{
  // queued upgrades / provider swaps (inside timelock ops, Safe proposals, scheduleBatch or
  // MultiSend payloads): the address arguments right after each selector
  const sels = [
    'upgradeTo(address)',
    'upgradeToAndCall(address,bytes)',
    'upgrade(address,address)',
    'upgradeAndCall(address,address,bytes)',
    'setProvider(address)',
  ].map((x) => toFunctionSelector(`function ${x}`).slice(2))
  const datas = [
    ...[...opsByTimelock.values()].flat().flatMap((o) => o.calls.map((c) => c.data)),
    ...safeRows.map((p) => p.data),
  ]
  for (const raw of datas) {
    const h = String(raw ?? '')
      .toLowerCase()
      .replace(/^0x/, '')
    for (const sl of sels)
      for (let i = h.indexOf(sl); i >= 0; i = h.indexOf(sl, i + 1)) {
        if (i % 2) continue
        for (const m of h.slice(i + 8, i + 8 + 128).match(/.{64}/g) ?? [])
          // an ABI offset / length word (0x…40) is not an address
          if (/^0{24}[0-9a-f]{40}$/.test(m) && BigInt('0x' + m) > 0xffffn) {
            verifyTargets.add('0x' + m.slice(24))
            if (sl === sels[4]) proxyTargets.add('0x' + m.slice(24))
          }
      }
  }
}
const verification = await verifySources([...verifyTargets], join(CACHE, 'verification.json'), log)
{
  // the EIP-1967 implementation behind each provider-like target (undefined: not a proxy)
  const implOf = async (a) => {
    try {
      const w = await retry(() => client.getStorageAt({ address: a, slot: SLOT.eip1967Impl }))
      return w && !/^0x0*$/.test(w) ? '0x' + w.slice(-40).toLowerCase() : undefined
    } catch {
      return null
    }
  }
  const through = await verifySourcesThroughProxies(
    [...proxyTargets],
    implOf,
    join(CACHE, 'verification.json'),
    log,
  )
  Object.assign(verification, through)
}

// ---- 13. engine ---------------------------------------------------------------------------------------------
const engine = await loadTs('../../../../lib/oracleRegistry/config/engine.ts')
for (const e of oracleChanges.events ?? []) {
  const src = e.args?.source ?? e.args?.newSource
  if (/SourceUpdated|SourceSet$/.test(e.event) && src && !controllers[`${lc(src)}@${e.block}`])
    try {
      controllers[`${lc(src)}@${e.block}`] = await classify(client, lc(src), e.block)
    } catch {
      /* unclassified source: judged as unknown */
    }
}
// UQ-17 (owner ruling 2026-10-08): every Aragon Voting in a classified tree gets its HOLDER
// CONCENTRATION at that block — one streaming pass over the voting token's Transfer logs per run
// (top-50 per block cached; no raw logs, no balance map on disk), each snapshot verified on chain.
{
  const HOLDER_CACHE = join(CACHE, 'token-holders-v1.json')
  const firstCode = async (a) => {
    let lo = 0
    let hi = head
    while (hi - lo > 1) {
      const m = Math.floor((lo + hi) / 2)
      if (await codeAt(client, a, m)) hi = m
      else lo = m
    }
    return hi
  }
  // UQ-25 (owner ruling 2026-10-09): each vote's trailing-year opposition D at its block, cached
  // per (vote app, block) — a few hundred bytes each
  const DEFENSE_CACHE = join(CACHE, 'vote-defense-v1.json')
  const defenseCache = existsSync(DEFENSE_CACHE)
    ? JSON.parse(readFileSync(DEFENSE_CACHE, 'utf8'))
    : {}
  let defenseDirty = false
  const defenseFor = async (app, block) => {
    const key = `${app}@${block}`
    if (defenseCache[key]) return defenseCache[key]
    const ts = (await blockTimestamps(client, [block], join(CACHE, 'ts-1.json')))[block]
    const d = await voteDefense(client, app, block, ts)
    defenseCache[key] = d
    defenseDirty = true
    return d
  }
  const n = await enrichTokenVotes(client, controllers, {
    head,
    decide: rulesTs.tokenVoteDecision,
    needsHolders: rulesTs.tokenVoteNeedsHolders,
    defenseFor,
    log,
    snapshotsFor: async (token, blocks) =>
      holderSnapshots({
        logClients: { primary: logsPrimary, secondary: logsSecondary },
        state: client,
        token,
        from: await firstCode(token),
        blocks,
        cacheFile: HOLDER_CACHE,
        log,
      }),
  })
  if (defenseDirty) writeJson(DEFENSE_CACHE, defenseCache)
  if (n) {
    log(`token votes: ${n} vote classification(s) given their holder concentration`)
    // the past-block classifications now carry their holders: cached with them
    writeJson(AT_CACHE, atCache)
  }
}
const oracleFor = (s) => {
  if (!s.oracleAssetKey) return undefined
  const slug = s.oracleAssetKey.toLowerCase()
  return {
    window: oracleChanges.window,
    events: (oracleChanges.events ?? []).filter((e) =>
      (e.entryIds ?? []).some((id) => id.split('.')[0] === slug),
    ),
  }
}
// The previous run's state of a subject (Safe fields and remote routes are diffed run to run).
const prevStates = new Map()
const prevState = (key) => {
  if (!prevStates.has(key))
    try {
      prevStates.set(key, JSON.parse(readFileSync(join(DIR, 'state', `${key}.json`), 'utf8')))
    } catch {
      prevStates.set(key, null)
    }
  return prevStates.get(key)
}
const summary = []
// this subject's Dual Governance timelocks (leaves of its power holders)
const dgOf = (s) => [
  ...new Set(
    (powerReads.get(s.key) ?? [])
      .flatMap((p) => p.holders)
      .map((h) => leafOf(controllers[`${h}@head`]))
      .filter((l) => l?.kind === 'aragon_dg')
      .map((l) => lc(l.address)),
  ),
]
for (const s of subjects) {
  const tl = s.timelocks.map((t) => {
    const holders = [
      ...new Set([
        ...(roleMap.get(`${t}|${roleHash('TIMELOCK_ADMIN_ROLE')}`) ?? []),
        ...(roleMap.get(`${t}|${roleHash('DEFAULT_ADMIN_ROLE')}`) ?? []),
      ]),
    ]
    return { timelock: t, role: 'TIMELOCK_ADMIN_ROLE / DEFAULT_ADMIN_ROLE', holders }
  })
  const subjectAddrs = new Set([...s.contracts.map((c) => c.address), ...s.timelocks])
  // power holders AND the proposer / executor / canceller / admin holders of its timelocks:
  // their own events (Safe threshold / owner changes) belong on this card (review round 6)
  const extraForSubject = subjectExtraEmitters(s, powerReads.get(s.key), roleMap)
  const rawSubject = {
    version: 1,
    subjectKey: s.key,
    head: { block: head, ts: headTs },
    scan: { from: Math.min(ETH.endpointDeployBlock, adminFrom), to: head },
    lz: {
      events: lzEvents.filter((e) => !e.oapp || s.lzOApps.includes(lc(e.oapp))),
      headRoutes: s.lzOApps.flatMap((o) => headRoutes.get(o) ?? []),
      headDefaults,
      remote: s.lzOApps.flatMap((o) => [...remote.values()].filter((r) => r.oapp === o)),
      codeProbes,
      dvnSigner,
      dvnHead,
      value: priceOf.has(s.key)
        ? {
            ...priceOf.get(s.key),
            locked: Object.fromEntries(s.lzOApps.map((o) => [o, locked[o]]).filter(([, v]) => v)),
            remoteSupply: Object.fromEntries(
              Object.entries(remoteSupply).filter(([k]) => s.lzOApps.includes(k.split('|')[0])),
            ),
          }
        : undefined,
      previousRemote: prevState(s.key)?.remoteSnapshot
        ? {
            block: prevState(s.key).asOf.block,
            routes: prevState(s.key).remoteSnapshot,
            readAt: prevState(s.key).remoteReadAt,
            lastPeer: prevState(s.key).remoteLastPeer,
            lastVerifying: prevState(s.key).remoteLastVerifying,
          }
        : undefined,
    },
    admin: {
      // Queue rows (CallScheduled / CallSalt) matter only for this subject's own timelocks
      // (read separately as ops); CallExecuted only marks a tx (AD-5), so its payload is dropped.
      events: adminRows
        .filter(
          (r) =>
            (subjectAddrs.has(r.emitter) ||
              extraForSubject.has(r.emitter) ||
              r.event === 'PoolSet' ||
              r.event === 'AdministratorTransferred') &&
            !(
              ['CallScheduled', 'CallSalt', 'Cancelled'].includes(r.event) &&
              !s.timelocks.includes(r.emitter)
            ),
        )
        .map((r) =>
          r.event === 'CallExecuted'
            ? {
                ...r,
                args: {
                  id: r.args.id,
                  index: r.args.index,
                  target: r.args.target,
                  ...(committeeEmitters.has(lc(r.args.target)) ? { data: r.args.data } : {}),
                },
              }
            : r,
        ),
      txTo: Object.fromEntries(
        Object.entries(committeeTxTo).filter(([h]) =>
          adminRows.some(
            (r) =>
              r.tx === h &&
              COMMITTEE_EVENTS.has(r.event) &&
              (subjectAddrs.has(r.emitter) || extraForSubject.has(r.emitter)),
          ),
        ),
      ),
      controllers,
      ...(classifyFailed.size ? { classifyFailed: [...classifyFailed] } : {}),
      powers: powerReads.get(s.key),
      timelockAdmins: tl,
      implHistory,
      owners,
      delegates,
      minDelays,
      upgradeHoldersAt: Object.fromEntries(
        Object.entries(upgradeHoldersAt).filter(([k]) => subjectAddrs.has(k.split('@')[0])),
      ),
      previousSafes: (() => {
        const prev = prevState(s.key)
        if (!prev?.safeSnapshot) return undefined
        return {
          block: prev.asOf.block,
          controllers: Object.fromEntries(prev.safeSnapshot.map((c) => [c.address, c])),
        }
      })(),
      deployBlocks,
      verification,
      // an Aragon ACL scanned from deployment: rows before the window are state only
      ...(s.aragonAcl ? { fileFrom: adminFrom } : {}),
      ...(Object.keys(aragonApps).length ? { aragonApps } : {}),
    },
    params: paramsForSubject(params, s.key),
    queues: {
      ops: [
        ...s.timelocks.flatMap((t) => opsByTimelock.get(t) ?? []),
        ...dgOf(s).flatMap((t) => dgReads.get(t)?.ops ?? []),
      ],
      ...(dgOf(s).length
        ? {
            dgStatus: dgOf(s).map((t) => ({
              timelock: t,
              status: dgReads.get(t)?.status ?? 'unavailable',
              ...(dgReads.get(t)?.note ? { note: scrub(dgReads.get(t).note) } : {}),
            })),
          }
        : {}),
      safe: safeRows.filter(
        (r) =>
          s.safes.includes(r.safe) ||
          extraForSubject.has(r.safe) ||
          s.timelocks.some((t) =>
            (roleMap.get(`${t}|${roleHash('PROPOSER_ROLE')}`) ?? new Set()).has(r.safe),
          ),
      ),
      safeStatus: safeStatus.filter(
        (x) =>
          s.safes.includes(x.safe) ||
          extraForSubject.has(x.safe) ||
          s.timelocks.some((t) =>
            (roleMap.get(`${t}|${roleHash('PROPOSER_ROLE')}`) ?? new Set()).has(x.safe),
          ),
      ),
      ...(() => {
        // this subject's legacy multisigs (leaves of its power holders)
        const mine = [...multisigReads.values()].filter((r) =>
          (powerReads.get(s.key) ?? []).some((p) =>
            p.holders.some((h) => lc(leafOf(controllers[`${h}@head`])?.address) === r.multisig),
          ),
        )
        return mine.length
          ? {
              multisig: mine.flatMap((r) => r.rows),
              multisigStatus: mine.map((r) => ({
                multisig: r.multisig,
                status: r.status,
                ...(r.note ? { note: r.note } : {}),
              })),
            }
          : {}
      })(),
    },
    ccip: { pools: s.ccipPools.map((p) => ccipPools[p]).filter(Boolean) },
    ...(s.nttManagers?.length
      ? { ntt: s.nttManagers.map((m) => nttReads[m]).filter(Boolean) }
      : {}),
    ...(s.canonicalBridges?.length
      ? { canonical: s.canonicalBridges.map((b) => canonicalReads[b.address]).filter(Boolean) }
      : {}),
    oracle: oracleFor(s),
    warnings: ctx.warnings,
  }
  // Raw observations (for --rebuild): opt-in, they are the largest cache files.
  if (flag('keep-raw')) writeJson(join(CACHE, `raw-${s.key}.json`), rawSubject)
  summary.push(await emit(s, rawSubject, metadata, engine))
}
{
  // one run per subject set: an --only run keeps what the earlier runs recorded for the others
  let prev = {}
  try {
    prev = JSON.parse(readFileSync(join(DIR, 'cursors.json'), 'utf8'))
  } catch {
    /* first run */
  }
  const runAt = new Date().toISOString()
  const bySubject = { ...(prev.bySubject ?? {}) }
  for (const k of prev.bySubject ? [] : (prev.subjects ?? []))
    bySubject[k] = { runAt: prev.runAt, head: prev.head, adminFrom: prev.adminFrom }
  for (const s of subjects) bySubject[s.key] = { runAt, head, adminFrom }
  writeJson(join(DIR, 'cursors.json'), {
    version: 1,
    runAt,
    head,
    headTs,
    lzFrom: ETH.endpointDeployBlock,
    adminFrom,
    paramDays: PARAM_DAYS,
    subjects: subjects.map((s) => s.key),
    bySubject,
  })
}
console.log(JSON.stringify({ head, summary }, null, 1))
