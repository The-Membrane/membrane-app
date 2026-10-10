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

import { existsSync, mkdirSync, readFileSync } from 'fs'
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
  callAddressArgs,
  classify,
  confirmedFirstCode,
  dgCommitteeAddresses,
  enrichTokenVotes,
  hasReadFailure,
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
  coHolderReads,
  roleHoldersFromEvents,
  setAragonExecCandidates,
  setLogClients,
  setRoleCandidates,
  storageWord,
  subjectExtraEmitters,
  timelockAdminHolders,
  timelockExecutors,
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
  headRouteEids,
  readRemoteRoute,
  readRoute,
  registryOf,
  remoteReadList,
  replayDvnSigners,
  skippedRemoteSides,
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
import {
  assertRebuildFresh,
  readOracleChanges,
  readPreviousSet,
  writeJsonAtomic,
  writeSubjectFiles,
} from './lib/files.mjs'
import { safeQueues } from './lib/safe.mjs'
import { implFromSlotWord, verifySources, verifySourcesThroughProxies } from './lib/verify.mjs'
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
// review round 12 (rules #8): every write is atomic (temp file + rename) — a full disk mid-write
// truncated state/<subject>.json, and the next run silently lost every carry
const writeJson = (p, o) => writeJsonAtomic(p, o)

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
  // fail-closed audit (ST-01): changes and queues first, the state LAST (the commit mark of the set)
  writeSubjectFiles(DIR, s.key, out, writeJson)
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
  for (const s of subjects) {
    const rawSubject = JSON.parse(readFileSync(join(CACHE, `raw-${s.key}.json`), 'utf8'))
    // fail-closed audit (state files MISSED-2): never overwrite a newer run with an older raw
    assertRebuildFresh(rawSubject, readPreviousSet(DIR, s.key).state, flag('force-stale'))
    summary.push(await emit(s, rawSubject, metadata, engine))
  }
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
// Fail-closed audit (EV-01 / KG-7): every event scan reads through two independent log endpoints
// (an empty chunk is confirmed on both); a chunk that cannot be confirmed is a SCAN GAP — listed
// on the card of every subject it can hide events from, and the engine carries what it could hide.
const scanGaps = []
const scanOpts = {
  client: logs,
  primary: logsPrimary,
  secondary: logsSecondary,
  head,
  gaps: scanGaps,
}
const lzEvents = allOApps.length
  ? await scanLzConfig({
      ...scanOpts,
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
    ...scanOpts,
    scan: 'admin event scan',
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
    ...scanOpts,
    scan: 'Aragon ACL scan (before the window)',
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
// appId → the declared Aragon app proxies with it (a Kernel SetApp(base, appId) upgrades them).
// Fail-closed audit (TV-10): a kernel() / appId() read that FAILED (not a revert: not an Aragon
// app) is never "not an app" — the address is recorded unread (a read gap; a SetApp for an
// unmapped appId stays on the Kernel as an upgrade of an unknown app). An AppProxy's kernel and
// appId are immutable: successful reads are cached and reused when a later read fails.
const aragonApps = {}
const aragonAppsUnread = []
const APP_CACHE = join(CACHE, 'aragon-apps-v1.json')
let appCache = {}
try {
  appCache = existsSync(APP_CACHE) ? JSON.parse(readFileSync(APP_CACHE, 'utf8')) : {}
} catch {
  appCache = {} // read again
}
for (const a of adminAddrs) {
  if (appCache[a]) {
    if (appCache[a].appId) (aragonApps[appCache[a].appId] ??= []).push(a)
    continue
  }
  const k = await tryRead(client, a, fnAbi(FN.kernel), 'kernel')
  if (!k.ok && !k.reverted) {
    aragonAppsUnread.push(a)
    continue
  }
  if (!k.ok || /^0x0*$/i.test(k.value)) {
    appCache[a] = { appId: null }
    continue
  }
  const id = await tryRead(client, a, fnAbi(FN.appId), 'appId')
  if (id.ok) {
    appCache[a] = { appId: lc(id.value) }
    ;(aragonApps[lc(id.value)] ??= []).push(a)
  } else if (!id.reverted) aragonAppsUnread.push(a)
  else appCache[a] = { appId: null }
}
writeJson(APP_CACHE, appCache)
if (aragonAppsUnread.length)
  ctx.warnings.push(`Aragon app ids not read: ${aragonAppsUnread.join(', ')}`)
// a parameterless event (EmergencyModeActivated()) carries no args, also in older cache chunks
for (const r of adminRows) r.args ??= {}
adminRows = aragonRows(adminRows, aragonApps, { incomplete: aragonAppsUnread.length > 0 }).sort(
  (a, b) => a.block - b.block || a.logIndex - b.logIndex,
)
// an Aragon Agent is classified through its executor (RUN_SCRIPT / EXECUTE holders from the ACL).
// Fail-closed audit (MS-3): the previous run's executors of every Agent are candidates too (each
// confirmed by hasPermission at the block; a failed read keeps it) — a lost SetPermission chunk
// dropped one, and the Agent ranked as the remaining stronger one with no gap
{
  const cands = aragonExecCandidatesFromRows(adminRows)
  const walk = (c, seen = new Set()) => {
    if (!c || typeof c !== 'object' || seen.has(c)) return
    seen.add(c)
    if ((c.version ?? '').startsWith('Aragon Agent'))
      for (const e of c.executors ?? []) {
        const set = cands.get(lc(c.address)) ?? new Set()
        set.add(lc(e.address))
        cands.set(lc(c.address), set)
      }
    for (const x of [c.ownedBy, ...(c.executors ?? []), ...(c.schedulers ?? [])]) walk(x, seen)
  }
  for (const s of subjects)
    for (const pw of readPreviousSet(DIR, s.key).state?.powers ?? [])
      for (const h of pw.holders ?? []) walk(h)
  setAragonExecCandidates(cands)
}
log(`  ${adminRows.length} admin rows`)

// ---- 3. Head: powers → controllers discovered at head (their own events are scanned too) -------------
// Fail-closed audit (PH-03): the previous run's holders of a `role:` power are candidates too
// (confirmed by hasRole at head; a failed read keeps them) — a lost RoleGranted chunk dropped one
const prevRoleCands = (map) => {
  for (const s of subjects) {
    const prev = readPreviousSet(DIR, s.key).state
    for (const sp of s.powers) {
      const last = sp.path.at(-1) ?? ''
      if (sp.path.length !== 1 || !last.startsWith('role:')) continue
      const pw = (prev?.powers ?? []).find(
        (x) => x.label === sp.label && lc(x.contract) === lc(sp.contract),
      )
      const k = `${lc(sp.contract)}|${lc(roleHash(last.slice(5)))}`
      const set = map.get(k) ?? new Set()
      for (const h of pw?.holders ?? []) set.add(lc(h.address))
      if (set.size) map.set(k, set)
    }
  }
  return map
}
let roleMap = prevRoleCands(roleHoldersFromEvents(adminRows))
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
        // fail-closed audit (PH-02): the previous run's holders of a power not resolved stay in
        // scope (their events scanned and filed, their queues read) — `via` keeps them in the
        // subject's power graph for this run; the read gap is the power's error
        const prevPw = (readPreviousSet(DIR, s.key).state?.powers ?? []).find(
          (x) => x.label === p.label && lc(x.contract) === lc(p.contract),
        )
        const prevHolders = (prevPw?.holders ?? []).map((h) => lc(h.address))
        out.push({
          power: p.power,
          label: p.label,
          contract: p.contract,
          holders: [],
          ...(prevHolders.length ? { via: prevHolders } : {}),
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
// fail-closed audit (EV-09): every discovered holder is scanned — a getCode filter dropped one a
// lagging node answered "no code" for (an EOA has no logs; the address groups bound the filter)
const extraCode = [...extra]
if (extraCode.length) {
  log(`admin scan (discovered controllers): ${extraCode.length}`)
  const more = (
    await scanLogs({
      ...scanOpts,
      scan: 'admin event scan (discovered controllers)',
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
  roleMap = prevRoleCands(roleHoldersFromEvents(adminRows))
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
      ...scanOpts,
      scan: 'DVN signer scan',
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
// Fail-closed audit (LZ-01..LZ-05 / LZ-02 / LZ-03 / MS-1 / MISSED-HEAD-UNPINNED, 2026-10-10):
//   - every head read is PINNED to `head` (a lagging endpoint errors instead of answering old state);
//   - the eids read per OApp are its events' eids, every eid its previous run had an item for, and
//     every mainnet eid whose peers() a sweep reads non-zero — a route whose events were lost was
//     never read, and its floor breach dropped with no gap;
//   - a side is CLOSED only when read so (a zero peer; the Endpoint's "no default library" error):
//     `closedRoutes`. Any failed or unexpected read — a peers() revert included — is UNREAD;
//   - an owner() / delegates() read that failed is recorded (a queued change against it is judged
//     fail closed, and the card lists it).
const closedRoutes = []
const ownersUnread = []
const delegatesUnread = []
const lzSweepGaps = []
const mainnetEids = Object.keys(metadata.eids ?? {})
  .map(Number)
  .filter((e) => e >= 30_000 && e < 40_000 && e !== 30101)
const prevLzItems = (oapp) =>
  subjects
    .filter((s) => s.lzOApps.map(lc).includes(oapp))
    .flatMap((s) => readPreviousSet(DIR, s.key).state?.items ?? [])
for (const oapp of allOApps) {
  // the peers sweep (one multicall per 100 eids): a non-zero peer names a live route
  const swept = []
  for (let i = 0; i < mainnetEids.length; i += 100) {
    const part = mainnetEids.slice(i, i + 100)
    try {
      const res = await retry(() =>
        client.multicall({
          contracts: part.map((eid) => ({
            address: oapp,
            abi: fnAbi(FN.peers),
            functionName: 'peers',
            args: [eid],
          })),
          allowFailure: true,
          blockNumber: BigInt(head),
        }),
      )
      res.forEach((r, j) => {
        if (r.status === 'success' && !/^0x0*$/.test(lc(r.result))) swept.push(part[j])
      })
    } catch (e) {
      lzSweepGaps.push({
        scan: 'LayerZero peers sweep',
        from: head,
        to: head,
        addresses: [oapp],
        error: scrub(e?.shortMessage || e?.message),
      })
    }
  }
  const eids = headRouteEids(oapp, lzEvents, prevLzItems(oapp), swept)
  const rows = []
  const del = await tryRead(client, ETH.endpoint, fnAbi(FN.delegates), 'delegates', [oapp], head)
  if (del.ok) delegates[oapp] = lc(del.value)
  else delegatesUnread.push(oapp)
  const own = await tryRead(client, oapp, fnAbi(FN.owner), 'owner', [], head)
  if (own.ok) owners[oapp] = lc(own.value)
  else if (!own.reverted) ownersUnread.push(oapp)
  await pool(eids, 4, async (eid) => {
    const p = await tryRead(client, oapp, fnAbi(FN.peers), 'peers', [eid], head)
    // A failed READ is UNREAD (both directions), never a zero peer that drops the route; LZ-04:
    // a revert of the public peers() getter is no proof the route is closed — UNREAD too.
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
    if (!p.ok) {
      for (const direction of ['send', 'receive'])
        rows.push(unreadRow(direction, `peers() read failed: ${p.error}`))
      return
    }
    const peer = lc(p.value)
    if (/^0x0*$/.test(peer)) {
      closedRoutes.push({ oapp, eid, why: 'zero_peer' })
      return
    }
    for (const direction of ['send', 'receive']) {
      const r = await readRoute(client, {
        endpoint: ETH.endpoint,
        oapp,
        eid,
        direction,
        block: head,
      })
      if (!r.ok) {
        // LZ-05: closed only on the Endpoint's own "no default library" error
        if (r.closed) closedRoutes.push({ oapp, eid, direction, why: 'no_library' })
        else rows.push(unreadRow(direction, `library read failed: ${r.error}`))
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
        ...(r.appUnread ? { appUnread: true } : {}),
        grace: r.grace,
        peer,
      })
      const k = `${r.lib}|${eid}`
      if (!headDefaults[k]) {
        const d = await tryRead(
          client,
          r.lib,
          fnAbi(FN.getAppUlnConfig),
          'getAppUlnConfig',
          ['0x0000000000000000000000000000000000000000', eid],
          head,
        )
        if (d.ok) headDefaults[k] = ulnFromTuple(d.value)
      }
    }
  })
  headRoutes.set(oapp, rows)
  log(`  head ${oapp.slice(0, 10)}…: ${rows.length / 2} live-peer routes`)
}

// owner() of every other subject contract too (review fix: a queued transferOwnership on a
// ProxyAdmin, EthenaMinting or a token was judged against "owner not read"). Fail-closed audit
// (MS-1): and of every power-path hop (a ProxyAdmin `via`); a read that FAILED is recorded.
for (const a of [
  ...new Set([
    ...subjects.flatMap((s) => [...s.contracts.map((c) => lc(c.address)), ...s.timelocks]),
    ...subjects.flatMap((s) => (powerReads.get(s.key) ?? []).flatMap((p) => p.via ?? [])),
  ]),
])
  if (!owners[a]) {
    const own = await tryRead(client, a, fnAbi(FN.owner), 'owner', [], head)
    if (own.ok && !/^0x0*$/.test(lc(own.value))) owners[a] = lc(own.value)
    else if (!own.ok && !own.reverted) ownersUnread.push(a)
  }

// DVN code at first use (BR-4 / "known as of block").
const firstUse = new Map()
for (const e of lzEvents)
  for (const a of [...(e.config?.requiredDVNs ?? []), ...(e.config?.optionalDVNs ?? [])])
    firstUse.set(lc(a), Math.min(firstUse.get(lc(a)) ?? Infinity, e.block))
for (const rows of headRoutes.values())
  for (const r of rows)
    for (const a of [
      ...(r.merged?.requiredDVNs ?? []),
      ...(r.merged?.optionalDVNs ?? []),
      // the old library in its grace period still verifies: its DVNs are probed too
      ...(r.grace?.config?.requiredDVNs ?? []),
      ...(r.grace?.config?.optionalDVNs ?? []),
    ])
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
} else {
  // fail-closed audit (RC-M7): --no-remote skips the reads, never the sides — each one is a
  // REMOTE UNREAD placeholder (a first run said "no red flags" over sides never judged)
  for (const x of skippedRemoteSides(remoteReadList(headRoutes, lzEvents, allOApps), metadata))
    remote.set(`${x.oapp}|${x.eid}`, x)
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
const lastOwnerSeen = new Map()
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
  // fail-closed audit (ERA-1): a from-zero OwnershipTransferred / AdminChanged after an earlier
  // owner is judged against that owner AT block − 1 (the replay's `lastOwner`): classify it there
  // (it fell back to its head classification: another era)
  if (r.event === 'OwnershipTransferred' || r.event === 'AdminChanged') {
    const what = r.event === 'AdminChanged' ? 'admin' : 'owner'
    const k = `${what}|${r.emitter}`
    const prevAddr = lc(a.previousOwner ?? a.previousAdmin)
    if (/^0x0*$/.test(prevAddr) && lastOwnerSeen.get(k) && !/^0x0*$/.test(lastOwnerSeen.get(k)))
      wantAt.add(`${lastOwnerSeen.get(k)}@${r.block - 1}`)
    lastOwnerSeen.set(k, lc(a.newOwner ?? a.newAdmin))
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
    // fail-closed audit (PH-12): a read that FAILED is "not read", never "none before"
    if (!x.ok && !x.reverted) r.prevUnread = true
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
    if (!x.ok && !x.reverted) r.prevUnread = true
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
    if (!x.ok && !x.reverted) r.prevUnread = true
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
    if (!x.ok && !x.reverted) r.prevUnread = true
  }
}
for (const e of lzEvents.filter((x) => x.kind === 'delegate')) {
  wantAt.add(`${lc(e.delegate)}@${e.block}`)
}
// OR-1: an oracle source is judged on what it was at the block it was set.
// fail-closed audit (PO-07 / MISSED-1): missing = a read gap on every oracle subject; unreadable =
// the run STOPS (it was `{ events: [] }`: every oracle red row vanished with no gap)
const oracleChanges = readOracleChanges(join(ROOT, 'data', 'oracle-registry', 'changes.json'))
for (const e of oracleChanges.events ?? [])
  if (/SourceUpdated|SourceSet$/.test(e.event) && (e.args?.source ?? e.args?.newSource))
    wantAt.add(`${lc(e.args.source ?? e.args.newSource)}@${e.block}`)
// AD-5: the upgrade power's holders at the block BEFORE each upgrade / admin change, so a
// timelock is only expected in transactions after it actually held that power.
const upgradeHoldersAt = {}
const upgradeHoldersUnread = []
const upgradeSpecs = new Map()
for (const s of subjects)
  for (const p of s.powers) if (p.power === 'upgrade') upgradeSpecs.set(p.contract, p.path)
for (const r of adminRows) {
  if (
    !['Upgraded', 'AdminChanged', 'BeaconUpgraded'].includes(r.event) ||
    !upgradeSpecs.has(r.emitter)
  )
    continue
  // review round 12: resolvePath now throws on a failed read (fail closed) — the upgrade is then
  // judged against the declared timelock (AD-5 `upgradeHoldersUnread`), never skipped
  let hs
  try {
    hs = await resolvePath(client, {
      endpoint: ETH.endpoint,
      contract: r.emitter,
      path: upgradeSpecs.get(r.emitter),
      roleMap,
      block: r.block - 1,
    })
  } catch (e) {
    upgradeHoldersUnread.push(`${r.emitter}@${r.block}`)
    ctx.warnings.push(`upgrade holders of ${r.emitter}@${r.block - 1}: ${scrub(e?.message)}`)
    continue
  }
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
// v6 (fail-closed audit, 2026-10-10): every failed read inside a classification now leaves a
// marker (a rejected multicall chunk, an unread owner / Aragon implementation / Agent permission /
// bypasser / proposer member, a scheduler cycle, a confirmed deployment bound) — entries cached
// under v5 carry no such marker, so a timelock tree is never carried over (it is read again);
// any other v5 entry is kept.
const AT_CACHE = join(CACHE, 'controllers-at-v6.json')
const AT_CACHE_V5 = join(CACHE, 'controllers-at-v5.json')
const hasTimelock = (c, seen = new Set()) =>
  !!c &&
  typeof c === 'object' &&
  !seen.has(c) &&
  (seen.add(c),
  ['oz_timelock', 'ds_pause', 'aragon_dg'].includes(c.kind) ||
    (c.version ?? '').startsWith('Aragon') ||
    c.kind === 'aragon_voting' ||
    [c.ownedBy, ...(c.executors ?? []), ...(c.schedulers ?? [])].some((x) => hasTimelock(x, seen)))
const atCache = existsSync(AT_CACHE)
  ? JSON.parse(readFileSync(AT_CACHE, 'utf8'))
  : existsSync(AT_CACHE_V5)
    ? Object.fromEntries(
        Object.entries(JSON.parse(readFileSync(AT_CACHE_V5, 'utf8'))).filter(
          ([k, c]) => Number(k.split('@')[1]) >= MULTICALL3_BLOCK && !hasTimelock(c),
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
const coHolderReuse = {}
const rankedRole = (r) => {
  const name = String(r.args.roleName ?? roleName(r.args.role))
  return rulesTs.isPrivilegedRole(name) || !!adminRoleNames.get(r.emitter)?.has(name)
}
{
  // review round 12 (on-chain #5): a co-holder already read as an EOA is recorded at the later
  // grant block too (`reuse`), never left "not read" there
  const co = coHolderReads(adminRows, atCache, rankedRole)
  for (const k of co.want) wantAt.add(k)
  for (const [k, c] of Object.entries(co.reuse)) coHolderReuse[k] = c
  log(`role holders at their grant blocks: ${wantAt.size} at event blocks in all`)
}
// ---- deploy blocks of every admin-event emitter (initialization = its deploy block) ---------------------
// Fail-closed audit (FCB-2 / ST-05): a bisected deploy block is CONFIRMED on the two independent
// archive log endpoints before it is cached (v2 holds confirmed blocks only; v1 entries are read
// again); an unconfirmed one is left unknown (the engine fails closed on an unknown deploy block).
const DEPLOY_CACHE = join(CACHE, 'deploy-blocks-v2.json')
const deployBlocks = existsSync(DEPLOY_CACHE) ? JSON.parse(readFileSync(DEPLOY_CACHE, 'utf8')) : {}
{
  const missing = [...new Set(adminRows.map((r) => r.emitter))].filter(
    (a) => deployBlocks[a] === undefined,
  )
  const probes = await firstCodeBlocks(client, missing, () => 0, head, {
    confirm: [logsPrimary, logsSecondary],
  })
  let unconfirmed = 0
  for (const [a, p] of Object.entries(probes)) {
    if (p.firstCode) deployBlocks[a] = p.firstCode
    else if (p.unconfirmed) unconfirmed++
  }
  writeJson(DEPLOY_CACHE, deployBlocks)
  log(
    `deploy blocks: ${missing.length} bisected, ${Object.keys(deployBlocks).length} known${unconfirmed ? `, ${unconfirmed} NOT confirmed (unknown)` : ''}`,
  )
}

await pool([...wantAt], 6, async (k) => {
  // round 12: a cached classification in which a read failed is read again (never sticky)
  if (atCache[k] && !hasReadFailure(atCache[k])) return void (controllers[k] = atCache[k])
  const [a, b] = k.split('@')
  try {
    const c = await classify(client, a, Number(b))
    // fail-closed audit (ST-04 a / TL MISSED): "no code" at a block at or after the address's
    // confirmed deploy block is a FALSE read (an endpoint that could not serve the block) — not
    // classified (fail closed), never cached as an EOA
    if (
      (c.kind === 'eoa' || c.kind === 'eoa_7702') &&
      deployBlocks[a] !== undefined &&
      deployBlocks[a] <= Number(b)
    )
      throw new Error(
        `no code at ${b}, but code from block ${deployBlocks[a]}: the read was not served`,
      )
    controllers[k] = c
    if (hasReadFailure(c)) delete atCache[k]
    else atCache[k] = c
  } catch (e) {
    classifyFailed.add(k)
    ctx.warnings.push(`classify ${a}@${b}: ${scrub(e?.message)}`)
  }
})
for (const [k, c] of Object.entries(coHolderReuse)) controllers[k] ??= c
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
// fail-closed audit (QU-04 / MS-2): only CONFIRMED executors (open execution READ, or EXECUTOR_ROLE
// confirmed by hasRole at head) are simulated from — an unconfirmed set is "not simulated" (armed,
// fail closed); it fell back to 0x…dEaD, whose revert made an armed op read "stale"
const execOf = (timelock) =>
  timelockExecutors(client, timelock, [
    ...(roleMap.get(`${timelock}|${roleHash('EXECUTOR_ROLE')}`) ?? []),
  ])
// The previous run's queue rows of every subject (fail-closed audit QU-05 / M-1 / PH-02): a queue
// they came from is read again this run, or reported unavailable — never silently dropped.
const prevQueueRows = subjects.flatMap((s) => readPreviousSet(DIR, s.key).queues?.changes ?? [])
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
  // classify call arguments that the queue judges at head (grantees, new owners, providers);
  // rules #7 (fail-closed review): a call index never seen (a hole) is skipped, not a crash
  for (const o of ops) for (const a of callAddressArgs(o.calls)) want.add(a)
}
// QU-05: a previous OZ op this run did not re-derive from events (a lost CallScheduled) — its
// getTimestamp at head: 0 (cancelled) / 1 (executed) resolve it; pending or a failed read keep it
const ozResolved = []
{
  const derived = new Set(
    [...opsByTimelock.entries()].flatMap(([t, ops]) => ops.map((o) => `${lc(t)}|${lc(o.id)}`)),
  )
  const missing = [
    ...new Set(
      prevQueueRows
        .filter((c) => c.queue?.kind === 'oz_timelock' && c.queue.opId)
        .map((c) => `${lc(c.queue.address)}|${lc(c.queue.opId)}`)
        .filter((k) => !derived.has(k)),
    ),
  ]
  for (const k of missing) {
    const [t, id] = k.split('|')
    const ts = await tryRead(client, t, fnAbi(FN.getTimestamp), 'getTimestamp', [id], head)
    if (ts.ok && (Number(ts.value) === 0 || Number(ts.value) === 1)) ozResolved.push(k)
    else
      ctx.warnings.push(
        `timelock ${t}: op ${id.slice(0, 10)}… not re-derived from events (${ts.ok ? `still scheduled, ETA ${ts.value}` : 'state not read'}): its last row is carried`,
      )
  }
}
let safeStatus = []
let safeRows = []
// M-1: the Safes the previous run had queue rows for are polled again (or reported unavailable)
const prevQueueSafes = [
  ...new Set(prevQueueRows.filter((c) => c.queue?.kind === 'safe').map((c) => lc(c.queue.address))),
]
if (flag('no-safe'))
  safeStatus = prevQueueSafes.map((a) => ({
    safe: a,
    status: 'unavailable',
    note: 'Safe Tx Service not read (--no-safe)',
  }))
else {
  const safes = new Set([...subjects.flatMap((s) => s.safes), ...prevQueueSafes])
  for (const s of subjects)
    for (const p of powerReads.get(s.key))
      for (const h of p.holders) if (controllers[`${h}@head`]?.kind === 'safe') safes.add(h)
  for (const t of subjects.flatMap((s) => s.timelocks))
    for (const h of roleMap.get(`${t}|${roleHash('PROPOSER_ROLE')}`) ?? [])
      if (controllers[`${h}@head`]?.kind === 'safe') safes.add(h)
  // SQ-05: a nonce that was not read is null — that Safe is unavailable (never read from 0)
  const res = await safeQueues([...safes], async (s) => {
    const n = await tryRead(client, s, fnAbi(FN.nonce), 'nonce', [], head)
    return n.ok ? Number(n.value) : null
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
// fail-closed audit (DG M2): every node of a holder's deferral chain AND an Aragon Agent's
// executors (an Agent with several executors has no single `ownedBy`; the engine's own search
// follows executors — the collector stopped at the Agent)
const leavesOf = (c, out = [], seen = new Set()) => {
  if (!c || seen.has(c)) return out
  seen.add(c)
  if (c.kind === 'contract' && (c.ownedBy || c.executors?.length)) {
    leavesOf(c.ownedBy, out, seen)
    for (const e of c.executors ?? []) leavesOf(e, out, seen)
  } else out.push(c)
  return out
}
const multisigs = new Set()
for (const s of subjects)
  for (const p of powerReads.get(s.key))
    for (const h of p.holders)
      for (const l of leavesOf(controllers[`${h}@head`]))
        if (l?.kind === 'legacy_multisig') multisigs.add(lc(l.address))
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
        ...scanOpts,
        scan: 'MultiSigWallet submission scan',
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
    for (const h of p.holders)
      for (const l of leavesOf(controllers[`${h}@head`]))
        if (l?.kind === 'aragon_dg') dgTimelocks.add(lc(l.address))
const dgReads = new Map()
for (const t of dgTimelocks) {
  const r = await readDgProposals(client, t, { now: headTs })
  dgReads.set(t, r)
  log(
    `  Dual Governance ${t.slice(0, 10)}…: ${r.status === 'ok' ? `${r.count} proposals, ${r.ops.length} not executed / cancelled` : `proposals NOT read (${scrub(r.note)})`}`,
  )
  for (const o of r.ops) for (const a of callAddressArgs(o.calls)) want.add(a)
}
// Wormhole NTT managers and canonical rollup bridges (head reads)
const nttReads = {}
// Fail-closed audit (NB-02): the Wormhole chain ids swept for live peers — every id up to 70 (EVM
// or not: Solana 1, Sui 21, Aptos 22, Berachain 39…; getPeer is a cheap view), not only the EVM
// chains this module maps
const WORMHOLE_SWEEP = Array.from({ length: 70 }, (_, i) => i + 1).filter((c) => c !== 2)
for (const m of [...new Set(subjects.flatMap((s) => s.nttManagers ?? []))]) {
  const chains = [
    ...new Set([
      ...adminRows
        .filter((r) => r.emitter === m && r.event === 'PeerUpdated')
        .map((r) => Number(r.args.chainId_)),
      // every chain the previous run had a peer for is named (read again, never dropped)
      ...subjects
        .filter((s) => (s.nttManagers ?? []).includes(m))
        .flatMap((s) =>
          (readPreviousSet(DIR, s.key).state?.items ?? [])
            .filter((i) => i.key === `bridge/ntt/${m}`)
            .flatMap((i) => Object.keys(i.value?.peers ?? {}).map(Number)),
        ),
    ]),
  ]
  // review round 8: more chains are read too — a false-empty PeerUpdated scan must not leave the
  // manager with no live route (and the floor switched off)
  nttReads[m] = await readNtt(client, m, chains, WORMHOLE_SWEEP)
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
// fail-closed audit (CL-08): a head classification that FAILED is recorded — a queued change
// naming the address is judged fail closed, and the card lists it (it read as "unknown": calm)
const headClassifyFailed = []
await pool(
  [...want].filter((a) => !controllers[`${a}@head`]),
  4,
  async (a) => {
    try {
      controllers[`${a}@head`] = await classify(client, a)
    } catch (e) {
      headClassifyFailed.push(a)
      ctx.warnings.push(`classify ${a}@head: ${scrub(e?.message)}`)
    }
  },
)

// ---- 10. mint / redeem getters ------------------------------------------------------------------------
let params = { transitions: [], head: {} }
// fail-closed audit (PO-03): --no-params reads nothing — every declared getter is UNREAD (a read
// gap), never an empty read
if (flag('no-params'))
  params.unread = scopedParamSpecs(subjects)
    .filter((sp) => !sp.eventsOnly && sp.sig)
    .map((sp) => ({ key: sp.key, block: head, reason: 'not read (--no-params)' }))
else {
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
// fail-closed audit (QU-08): the current implementation of every proxy a QUEUED upgrade targets
// is read too (it was read only for proxies with Upgraded rows), as a 32-byte word (a malformed
// answer throws: the run stops rather than read an unknown implementation)
{
  const upg = ['upgradeTo(address)', 'upgradeToAndCall(address,bytes)'].map((x) =>
    toFunctionSelector(`function ${x}`).slice(2),
  )
  for (const o of [...opsByTimelock.values()].flat())
    for (const c of o.calls)
      if (c && upg.some((x) => String(c.data).slice(2, 10).toLowerCase() === x))
        implHistory[lc(c.target)] ??= { impls: [], current: null }
}
for (const [proxy, h] of Object.entries(implHistory)) {
  const w = await retry(() =>
    storageWord(
      client,
      proxy,
      '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
      head,
    ),
  )
  h.current = /^0x0{64}$/i.test(w) ? null : '0x' + w.slice(-40).toLowerCase()
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
    ...[...opsByTimelock.values()]
      .flat()
      .flatMap((o) => o.calls.filter(Boolean).map((c) => c.data)),
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
  // fail-closed audit (PO-13): only a 32-byte word answers; anything else is NOT READ (null) —
  // a null / short answer read as "not a proxy", and a verified proxy over an unverified
  // implementation passed AD-9
  const implOf = async (a) => {
    try {
      return implFromSlotWord(
        await retry(() => client.getStorageAt({ address: a, slot: SLOT.eip1967Impl })),
      )
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
  // fail-closed audit (UQ17-FC): the shared CONFIRMED first-code bisection (a false "no code"
  // moved the start of the Transfer stream later and lost early transfers)
  const firstCode = (a) =>
    confirmedFirstCode(client, a, { hi: head, confirm: [logsPrimary, logsSecondary] })
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
    // the past-block classifications now carry their holders: cached with them — except one in
    // which a holder's classification failed (fail-closed audit TV-14: read again next run)
    for (const [k, c] of Object.entries(atCache)) if (hasReadFailure(c)) delete atCache[k]
    writeJson(AT_CACHE, atCache)
  }
}
const oracleFor = (s) => {
  if (!s.oracleAssetKey) return undefined
  const slug = s.oracleAssetKey.toLowerCase()
  return {
    window: oracleChanges.window,
    ...(oracleChanges.unread ? { unread: oracleChanges.unread } : {}),
    events: (oracleChanges.events ?? []).filter((e) =>
      (e.entryIds ?? []).some((id) => id.split('.')[0] === slug),
    ),
  }
}
// The previous run's state of a subject (Safe fields and remote routes are diffed run to run).
// Review round 12 (rules #8): a missing file is a first run; one that cannot be parsed STOPS the
// run (it was read as null: every carry and run-to-run diff silently lost).
// Fail-closed audit (ST-01): the previous run is read as a SET (state, changes, queues of one run),
// or the run stops (a torn or partial set is never read as a first run).
const prevSets = new Map()
const prevSet = (key) => {
  if (!prevSets.has(key)) prevSets.set(key, readPreviousSet(DIR, key))
  return prevSets.get(key)
}
const prevState = (key) => prevSet(key).state
// Review round 12 (rules #6 / #7) and the fail-closed audit (ST-02): ALL the previous run's history
// rows (the engine carries a red one this run did not re-derive, and the run-only rows by their
// own rules) and its pending queue rows (carried unless their queue is read again this run).
const prevRows = (dir, key) => {
  const f = dir === 'changes' ? prevSet(key).changes : prevSet(key).queues
  if (!f?.changes) return undefined
  return { block: f.asOf?.block ?? 0, changes: f.changes }
}
// fail-closed audit (PH-13): the AD-7 holders of each declared timelock, read on the timelock
const tlAdminReads = new Map()
for (const t of [...new Set(subjects.flatMap((s) => s.timelocks))]) {
  const cands = [
    ...(roleMap.get(`${t}|${roleHash('TIMELOCK_ADMIN_ROLE')}`) ?? []),
    ...(roleMap.get(`${t}|${roleHash('DEFAULT_ADMIN_ROLE')}`) ?? []),
  ]
  tlAdminReads.set(
    t,
    await timelockAdminHolders(
      client,
      t,
      ['TIMELOCK_ADMIN_ROLE', 'DEFAULT_ADMIN_ROLE'],
      cands,
    ).catch(() => ({ holders: [...new Set(cands)], unread: true })),
  )
}
const summary = []
// this subject's Dual Governance timelocks (leaves of its power holders)
const dgOf = (s) => [
  ...new Set(
    (powerReads.get(s.key) ?? [])
      .flatMap((p) => p.holders)
      .flatMap((h) => leavesOf(controllers[`${h}@head`]))
      .filter((l) => l?.kind === 'aragon_dg')
      .map((l) => lc(l.address)),
  ),
]
for (const s of subjects) {
  const tl = s.timelocks.map((t) => {
    const r = tlAdminReads.get(t) ?? { holders: [], unread: true }
    return {
      timelock: t,
      role: 'TIMELOCK_ADMIN_ROLE / DEFAULT_ADMIN_ROLE',
      holders: r.holders,
      ...(r.unread ? { unread: true } : {}),
    }
  })
  const subjectAddrs = new Set([...s.contracts.map((c) => c.address), ...s.timelocks])
  // power holders AND the proposer / executor / canceller / admin holders of its timelocks:
  // their own events (Safe threshold / owner changes) belong on this card (review round 6)
  const extraForSubject = subjectExtraEmitters(s, powerReads.get(s.key), roleMap)
  // fail-closed audit (EV-01 / KG-7): the scan gaps that can hide this subject's events — a scan of
  // one of its emitters, an LZ / DVN scan when it has OApps, its ACL's scan, the peers sweep
  const scope = new Set([...subjectAddrs, ...extraForSubject, ...s.lzOApps].map(lc))
  const myScanGaps = [...scanGaps, ...lzSweepGaps].filter(
    (g) =>
      (/LayerZero|DVN/.test(g.scan) && s.lzOApps.length) ||
      (g.addresses ?? []).some((a) => scope.has(lc(a))) ||
      (s.aragonAcl && (g.addresses ?? []).map(lc).includes(lc(s.aragonAcl))),
  )
  // the previous run's queues that this run did not read at all are reported unavailable
  const prevQ = prevRows('queues', s.key)?.changes ?? []
  const rawSubject = {
    version: 1,
    subjectKey: s.key,
    head: { block: head, ts: headTs },
    scan: { from: Math.min(ETH.endpointDeployBlock, adminFrom), to: head },
    ...(myScanGaps.length ? { scanGaps: myScanGaps } : {}),
    lz: {
      events: lzEvents.filter((e) => !e.oapp || s.lzOApps.includes(lc(e.oapp))),
      headRoutes: s.lzOApps.flatMap((o) => headRoutes.get(o) ?? []),
      closedRoutes: closedRoutes.filter((r) => s.lzOApps.map(lc).includes(lc(r.oapp))),
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
      scope: [...scope],
      ...(headClassifyFailed.length ? { headClassifyFailed } : {}),
      ...(ownersUnread.length ? { ownersUnread } : {}),
      ...(delegatesUnread.length
        ? { delegatesUnread: delegatesUnread.filter((o) => s.lzOApps.map(lc).includes(lc(o))) }
        : {}),
      ...(aragonAppsUnread.some((a) => subjectAddrs.has(a))
        ? { aragonAppsUnread: aragonAppsUnread.filter((a) => subjectAddrs.has(a)) }
        : {}),
      powers: powerReads.get(s.key),
      timelockAdmins: tl,
      implHistory,
      owners,
      delegates,
      minDelays,
      upgradeHoldersAt: Object.fromEntries(
        Object.entries(upgradeHoldersAt).filter(([k]) => subjectAddrs.has(k.split('@')[0])),
      ),
      ...(upgradeHoldersUnread.some((k) => subjectAddrs.has(k.split('@')[0]))
        ? {
            upgradeHoldersUnread: upgradeHoldersUnread.filter((k) =>
              subjectAddrs.has(k.split('@')[0]),
            ),
          }
        : {}),
      previousSafes: (() => {
        const prev = prevState(s.key)
        if (!prev?.safeSnapshot) return undefined
        return {
          block: prev.asOf.block,
          controllers: Object.fromEntries(prev.safeSnapshot.map((c) => [c.address, c])),
          // review round 12: a Safe carried through a run that could not classify it keeps the
          // block it was last READ at
          ...(prev.safeReadAt ? { readAt: prev.safeReadAt } : {}),
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
      ...(ozResolved.length
        ? { ozResolved: ozResolved.filter((k) => s.timelocks.map(lc).includes(k.split('|')[0])) }
        : {}),
      ...(() => {
        // a Dual Governance timelock the previous run read proposals for, no longer reached
        // this run (fail-closed audit DG M2): unavailable, so its rows are carried
        const dgs = [
          ...new Set([
            ...dgOf(s),
            ...prevQ.filter((c) => c.queue?.kind === 'dg_timelock').map((c) => lc(c.queue.address)),
          ]),
        ]
        return dgs.length
          ? {
              dgStatus: dgs.map((t) => ({
                timelock: t,
                status: dgReads.get(t)?.status ?? 'unavailable',
                ...(dgReads.get(t)?.note
                  ? { note: scrub(dgReads.get(t).note) }
                  : dgReads.get(t)
                    ? {}
                    : { note: 'not reached this run (its holder path was not read)' }),
              })),
            }
          : {}
      })(),
      safe: safeRows.filter(
        (r) =>
          s.safes.includes(r.safe) ||
          extraForSubject.has(r.safe) ||
          prevQ.some((c) => c.queue?.kind === 'safe' && lc(c.queue.address) === r.safe) ||
          s.timelocks.some((t) =>
            (roleMap.get(`${t}|${roleHash('PROPOSER_ROLE')}`) ?? new Set()).has(r.safe),
          ),
      ),
      safeStatus: safeStatus.filter(
        (x) =>
          s.safes.includes(x.safe) ||
          extraForSubject.has(x.safe) ||
          prevQ.some((c) => c.queue?.kind === 'safe' && lc(c.queue.address) === x.safe) ||
          s.timelocks.some((t) =>
            (roleMap.get(`${t}|${roleHash('PROPOSER_ROLE')}`) ?? new Set()).has(x.safe),
          ),
      ),
      ...(() => {
        // this subject's legacy multisigs (leaves of its power holders)
        const mine = [...multisigReads.values()].filter((r) =>
          (powerReads.get(s.key) ?? []).some((p) =>
            p.holders.some((h) =>
              leavesOf(controllers[`${h}@head`]).some((l) => lc(l?.address) === r.multisig),
            ),
          ),
        )
        // a multisig the previous run read submissions for, not reached this run: unavailable
        const lost = [
          ...new Set(
            prevQ
              .filter((c) => c.queue?.kind === 'legacy_multisig')
              .map((c) => lc(c.queue.address))
              .filter((m) => !mine.some((r) => r.multisig === m)),
          ),
        ]
        return mine.length || lost.length
          ? {
              multisig: mine.flatMap((r) => r.rows),
              multisigStatus: [
                ...mine.map((r) => ({
                  multisig: r.multisig,
                  status: r.status,
                  ...(r.note ? { note: r.note } : {}),
                })),
                ...lost.map((m) => ({
                  multisig: m,
                  status: 'unavailable',
                  note: 'not reached this run (its holder path was not read)',
                })),
              ],
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
    // UQ-30: the previous run's head breaches — one this run cannot re-confirm because a read it
    // depends on failed is carried (counted, red, "breach unconfirmed: read gap")
    ...(prevState(s.key)?.items
      ? { previousHead: { block: prevState(s.key).asOf.block, items: prevState(s.key).items } }
      : {}),
    // review round 12 / fail-closed audit (ST-02): the previous run's history rows and queue rows
    ...(() => {
      const ch = prevRows('changes', s.key)
      const q = prevRows('queues', s.key)
      return {
        ...(ch?.changes.length ? { previousChanges: ch } : {}),
        ...(q?.changes.length ? { previousQueue: q } : {}),
      }
    })(),
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
