/**
 * Decoded events → feed actions + reallocation legs. Pure: every chain fact it cannot
 * see in the events themselves (a cap before the window, a vault's timelock, the queue
 * before its first in-window change) arrives through ClassifyContext.
 *
 * Contract rules this relies on (MetaMorpho v1.1 src/MetaMorphoV1_1.sol; v1.0 and Euler
 * Earn are the same here):
 *   - submitCap below the current cap calls _setCap at once (SetCap, no SubmitCap); a
 *     raise only records pendingCap and emits SubmitCap; acceptCap later emits SetCap.
 *   - _setCap(cap > 0) on a disabled market pushes it to the withdraw queue AND emits
 *     SetWithdrawQueue (MetaMorphoV1_1.sol:766-791), so the queue is fully visible in
 *     events once a starting queue is known.
 *   - a market leaves the withdraw queue only with cap 0, no pending cap, and either
 *     zero supply or an elapsed SubmitMarketRemoval (updateWithdrawQueue).
 * Vault V2 (src/VaultV2.sol): every curator call is timelocked through
 * submit(data) → Submit(selector, data, executableAt) → the call itself emits
 * Accept(selector, data) and its own event; cap DECREASES are immediate. A relative cap of
 * WAD means "no relative cap"; 0 means nothing may be allocated.
 * Aave v3: supply/borrow caps are whole tokens and 0 means NO cap (not zero).
 */

import { V2_SELECTORS, decodeParams, type EmitterKind } from './abi'
import { argBig, argBool, argList, argStr, byChainOrder, type DecodedEvent } from './decode'
import type { ActionKind, FeedAction, Protocol, Reallocation, Scope } from './types'
import { PROTOCOL_OF } from './types'
import { decodeV2IdData, v2IdOf, type V2IdData } from './v2ids'

export interface ClassifyContext {
  /** Collateral token(s) behind a target; [] when unknown or idle. */
  collateralOf(protocol: Protocol, scope: Scope, target: string): string[]
  /** Cap in force just before `block` (archive read), as a decimal string. */
  prevCap?(vault: string, target: string, block: number): string | undefined
  /** Timelock (seconds) in force at `block` for a V1 / Euler Earn vault. */
  timelockAt?(vault: string, block: number): number | undefined
  /** Queue just before the vault's first in-range queue event (archive read). */
  baselineWithdrawQueue?: Record<string, string[]>
  baselineSupplyQueue?: Record<string, string[]>
  /** Head-time contract reads for still-open submits, keyed `${vault}:${kind}:${target ?? ''}`. */
  chainValidAt?: Record<string, number>
  /** V2 cap id → decoded idData, for ids seen only in Allocate/Deallocate. */
  v2Ids?: Record<string, V2IdData>
  /** Public allocator singletons; a reallocation they trigger is tagged 'public-allocator'. */
  publicAllocators?: { mm?: string; ee?: string }
  /** V2: was `sender` an allocator of `vault`? Deposit-path allocations are not curator moves. */
  isV2Allocator?(vault: string, sender: string): boolean
}

export interface ClassifyResult {
  actions: FeedAction[]
  reallocations: Reallocation[]
  stats: {
    events: number
    supplyQueueReorders: number
    withdrawQueueReorders: number
    /** Queue events whose prior state was unknown (no baseline): diff skipped. */
    queueBaselineMissing: number
    v2DepositPathAllocations: number
    duplicatesSkipped: number
    /** Submits with no resolution event whose head read shows nothing pending. */
    openButClearedOnChain: number
    /** Submits accepted in their own transaction (zero timelock), folded into the executed row. */
    sameTxSubmitsFolded: number
  }
}

const SUBMIT_KINDS: ReadonlySet<ActionKind> = new Set([
  'cap_submit',
  'removal_submit',
  'timelock_submit',
  'guardian_submit',
  'v2_submit',
])
export const isSubmitKind = (k: ActionKind): boolean => SUBMIT_KINDS.has(k)

const WAD = 10n ** 18n

/** `0x<selector><args>` → the timelocked call's name and decoded args (cap calls only). */
export function decodeV2Call(data: string): {
  selector: string
  fn: string
  idData?: string
  value?: bigint
  address?: string
  flag?: boolean
} {
  const selector = data.slice(0, 10).toLowerCase()
  const fn = V2_SELECTORS[selector] ?? `unknown(${selector})`
  const body = '0x' + data.slice(10)
  try {
    if (fn.endsWith('(bytes,uint256)')) {
      const [idData, value] = decodeParams(['bytes', 'uint256'], body) as [string, bigint]
      return { selector, fn, idData, value }
    }
    if (fn.endsWith('(address)'))
      return { selector, fn, address: decodeParams(['address'], body)[0] as string }
    if (fn.endsWith('(address,bool)')) {
      const [address, flag] = decodeParams(['address', 'bool'], body) as [string, boolean]
      return { selector, fn, address, flag }
    }
    if (fn.endsWith('(uint256)'))
      return { selector, fn, value: decodeParams(['uint256'], body)[0] as bigint }
    if (fn.endsWith('(bytes4,uint256)')) {
      const [sel, value] = decodeParams(['bytes4', 'uint256'], body) as [string, bigint]
      return { selector, fn, address: sel, value }
    }
  } catch {
    /* malformed calldata — fall through with the name only */
  }
  return { selector, fn }
}

const fnName = (sig: string): string => sig.split('(')[0]

export function classifyEvents(events: DecodedEvent[], ctx: ClassifyContext): ClassifyResult {
  const sorted = [...events].sort(byChainOrder)
  const actions: FeedAction[] = []
  const reallocations: Reallocation[] = []
  const stats: ClassifyResult['stats'] = {
    events: sorted.length,
    supplyQueueReorders: 0,
    withdrawQueueReorders: 0,
    queueBaselineMissing: 0,
    v2DepositPathAllocations: 0,
    duplicatesSkipped: 0,
    openButClearedOnChain: 0,
    sameTxSubmitsFolded: 0,
  }
  const seen = new Set<string>()
  /** Open submit-type actions, keyed by what resolves them. */
  const open = new Map<string, FeedAction>()
  const withdrawQ = new Map<string, string[]>()
  const supplyQ = new Map<string, string[]>()
  /** Last cap seen in range, per `${vault}:${capType}:${target}` (V2 + Aave). */
  const lastCap = new Map<string, bigint>()
  const lastAaveCollateral = new Map<string, string>()

  const scopeV1 = (k: EmitterKind): Scope => (k === 'ee' ? 'strategy' : 'market')

  const push = (
    e: DecodedEvent,
    a: Omit<FeedAction, 'id' | 'protocol' | 'vault' | 'block' | 'ts' | 'tx' | 'collateral'> & {
      collateral?: string[]
    },
  ): FeedAction => {
    const protocol = PROTOCOL_OF[e.kind] as Protocol
    const action: FeedAction = {
      id: `${e.tx}:${e.logIndex}`,
      protocol,
      vault: e.emitter,
      block: e.block,
      ts: e.ts,
      tx: e.tx,
      collateral: a.collateral ?? (a.target ? ctx.collateralOf(protocol, a.scope, a.target) : []),
      ...a,
    }
    actions.push(action)
    return action
  }
  const resolve = (
    key: string,
    e: DecodedEvent,
    how: 'accepted' | 'revoked',
  ): FeedAction | undefined => {
    const a = open.get(key)
    if (!a) return undefined
    a.resolution = { how, block: e.block, ts: e.ts, tx: e.tx }
    open.delete(key)
    return a
  }
  /** Submits whose head-time contract read can replace the derived window. */
  const chainKeyed: { action: FeedAction; chainKey: string }[] = []
  const openSubmit = (
    key: string,
    a: FeedAction,
    e: DecodedEvent,
    derivedDelay: number | undefined,
    chainKey: string,
  ) => {
    if (a.validAt === undefined && derivedDelay !== undefined) {
      a.validAt = e.ts + derivedDelay
      a.validAtSource = 'derived'
    }
    open.set(key, a)
    chainKeyed.push({ action: a, chainKey })
  }

  for (const e of sorted) {
    const uid = `${e.tx}:${e.logIndex}`
    if (seen.has(uid)) {
      stats.duplicatesSkipped++
      continue
    }
    seen.add(uid)
    const v = e.emitter

    if (e.kind === 'mm' || e.kind === 'ee') {
      const scope = scopeV1(e.kind)
      switch (e.name) {
        case 'SubmitCap': {
          const target = argStr(e, 'id')
          const a = push(e, {
            kind: 'cap_submit',
            scope,
            target,
            to: argBig(e, 'cap').toString(),
            from: ctx.prevCap?.(v, target, e.block),
            actor: argStr(e, 'caller'),
          })
          openSubmit(
            `${v}|cap|${target}`,
            a,
            e,
            ctx.timelockAt?.(v, e.block),
            `${v}:cap_submit:${target}`,
          )
          break
        }
        case 'SetCap': {
          const target = argStr(e, 'id')
          const cap = argBig(e, 'cap')
          const submitted = resolve(`${v}|cap|${target}`, e, 'accepted')
          const prev = submitted?.from ?? ctx.prevCap?.(v, target, e.block)
          let kind: ActionKind
          let note: string | undefined
          if (cap === 0n) kind = 'cap_zero'
          else if (submitted) kind = 'cap_raise'
          else if (prev !== undefined) kind = cap > BigInt(prev) ? 'cap_raise' : 'cap_cut'
          else {
            // No SubmitCap in range and no prior read: by the contract this is a decrease
            // or the acceptance of a raise submitted before the range.
            kind = 'cap_cut'
            note = 'direction inferred: previous cap not read'
          }
          push(e, {
            kind,
            scope,
            target,
            from: prev,
            to: cap.toString(),
            actor: argStr(e, 'caller'),
            note,
          })
          break
        }
        case 'RevokePendingCap': {
          const target = argStr(e, 'id')
          const was = resolve(`${v}|cap|${target}`, e, 'revoked')
          push(e, { kind: 'cap_revoke', scope, target, to: was?.to, actor: argStr(e, 'caller') })
          break
        }
        case 'SubmitMarketRemoval': {
          const target = argStr(e, 'id')
          const a = push(e, { kind: 'removal_submit', scope, target, actor: argStr(e, 'caller') })
          openSubmit(
            `${v}|removal|${target}`,
            a,
            e,
            ctx.timelockAt?.(v, e.block),
            `${v}:removal_submit:${target}`,
          )
          break
        }
        case 'RevokePendingMarketRemoval': {
          const target = argStr(e, 'id')
          resolve(`${v}|removal|${target}`, e, 'revoked')
          push(e, { kind: 'removal_revoke', scope, target, actor: argStr(e, 'caller') })
          break
        }
        case 'SetWithdrawQueue':
        case 'SetSupplyQueue': {
          const isW = e.name === 'SetWithdrawQueue'
          const next = argList(e, isW ? 'newWithdrawQueue' : 'newSupplyQueue').map((x) =>
            x.toLowerCase(),
          )
          const state = isW ? withdrawQ : supplyQ
          const prev =
            state.get(v) ?? (isW ? ctx.baselineWithdrawQueue : ctx.baselineSupplyQueue)?.[v]
          state.set(v, next)
          if (!prev) {
            stats.queueBaselineMissing++
            break
          }
          const removed = prev.filter((x) => !next.includes(x))
          const added = next.filter((x) => !prev.includes(x))
          if (removed.length === 0 && added.length === 0) {
            if (prev.join() !== next.join())
              isW ? stats.withdrawQueueReorders++ : stats.supplyQueueReorders++
            break
          }
          const actor = argStr(e, 'caller')
          for (const target of removed) {
            if (isW) {
              const forced = resolve(`${v}|removal|${target}`, e, 'accepted')
              push(e, { kind: 'market_removed', scope, target, actor, forced: Boolean(forced) })
            } else push(e, { kind: 'supply_queue_remove', scope, target, actor })
          }
          for (const target of added)
            push(e, { kind: isW ? 'market_added' : 'supply_queue_add', scope, target, actor })
          break
        }
        case 'ReallocateWithdraw':
        case 'ReallocateSupply': {
          const out = e.name === 'ReallocateWithdraw'
          const actor = argStr(e, 'caller')
          const pa = ctx.publicAllocators?.[e.kind as 'mm' | 'ee']
          reallocations.push({
            protocol: PROTOCOL_OF[e.kind] as Protocol,
            vault: v,
            target: argStr(e, 'id'),
            dir: out ? 'out' : 'in',
            assets: argBig(e, out ? 'withdrawnAssets' : 'suppliedAssets'),
            source: pa && actor === pa.toLowerCase() ? 'public-allocator' : 'allocator',
            actor,
            block: e.block,
            ts: e.ts,
            tx: e.tx,
            logIndex: e.logIndex,
          })
          break
        }
        case 'SubmitTimelock': {
          const cur = ctx.timelockAt?.(v, e.block)
          const a = push(e, {
            kind: 'timelock_submit',
            scope: 'vault',
            from: cur?.toString(),
            to: argBig(e, 'newTimelock').toString(),
          })
          openSubmit(`${v}|timelock`, a, e, cur, `${v}:timelock_submit:`)
          break
        }
        case 'SetTimelock': {
          resolve(`${v}|timelock`, e, 'accepted')
          push(e, {
            kind: 'timelock_set',
            scope: 'vault',
            from: ctx.timelockAt?.(v, e.block - 1)?.toString(),
            to: argBig(e, 'newTimelock').toString(),
            actor: argStr(e, 'caller'),
          })
          break
        }
        case 'RevokePendingTimelock':
          resolve(`${v}|timelock`, e, 'revoked')
          push(e, { kind: 'timelock_revoke', scope: 'vault', actor: argStr(e, 'caller') })
          break
        case 'SetCurator':
          push(e, { kind: 'curator_set', scope: 'vault', to: argStr(e, 'newCurator') })
          break
        case 'SetIsAllocator':
          push(e, {
            kind: 'allocator_set',
            scope: 'vault',
            target: argStr(e, 'allocator'),
            to: String(argBool(e, 'isAllocator')),
            collateral: [],
          })
          break
        case 'SubmitGuardian': {
          const a = push(e, {
            kind: 'guardian_submit',
            scope: 'vault',
            to: argStr(e, 'newGuardian'),
          })
          openSubmit(`${v}|guardian`, a, e, ctx.timelockAt?.(v, e.block), `${v}:guardian_submit:`)
          break
        }
        case 'SetGuardian':
          resolve(`${v}|guardian`, e, 'accepted')
          push(e, {
            kind: 'guardian_set',
            scope: 'vault',
            to: argStr(e, 'guardian'),
            actor: argStr(e, 'caller'),
          })
          break
        case 'RevokePendingGuardian':
          resolve(`${v}|guardian`, e, 'revoked')
          push(e, { kind: 'guardian_revoke', scope: 'vault', actor: argStr(e, 'caller') })
          break
        case 'OwnershipTransferred':
          push(e, {
            kind: 'owner_set',
            scope: 'vault',
            from: argStr(e, 'previousOwner'),
            to: argStr(e, 'newOwner'),
          })
          break
      }
      continue
    }

    if (e.kind === 'v2') {
      const capAction = (idData: string, capType: 'absolute' | 'relative') => {
        const d = decodeV2IdData(idData)
        const target = v2IdOf(idData)
        const scope: Scope =
          d.type === 'collateral' ? 'collateral' : d.type === 'market' ? 'market' : 'adapter'
        const collateral =
          d.type === 'collateral'
            ? [d.collateral]
            : d.type === 'market'
              ? [d.marketParams.collateralToken]
              : []
        return { target, scope, collateral, capType, d }
      }
      switch (e.name) {
        case 'Submit': {
          const data = argStr(e, 'data')
          const call = decodeV2Call(data)
          const validAt = Number(argBig(e, 'executableAt'))
          let a: FeedAction
          if (
            call.idData !== undefined &&
            call.fn.startsWith('increase') &&
            call.fn.includes('Cap')
          ) {
            const c = capAction(
              call.idData,
              call.fn.startsWith('increaseAbsolute') ? 'absolute' : 'relative',
            )
            const prev = lastCap.get(`${v}:${c.capType}:${c.target}`)
            a = push(e, {
              kind: 'cap_submit',
              scope: c.scope,
              target: c.target,
              collateral: c.collateral,
              capType: c.capType,
              from: prev?.toString(),
              to: call.value?.toString(),
              validAt,
              validAtSource: 'event',
              note: fnName(call.fn),
            })
          } else if (call.fn.startsWith('decreaseTimelock')) {
            a = push(e, {
              kind: 'timelock_submit',
              scope: 'vault',
              to: call.value?.toString(),
              validAt,
              validAtSource: 'event',
              note: `decreaseTimelock(${V2_SELECTORS[call.address ?? ''] ? fnName(V2_SELECTORS[call.address ?? '']) : call.address})`,
            })
          } else {
            const detail =
              call.address !== undefined
                ? `${call.address}${call.flag !== undefined ? `, ${call.flag}` : ''}`
                : call.value !== undefined
                  ? call.value.toString()
                  : ''
            a = push(e, {
              kind: 'v2_submit',
              scope: 'vault',
              target: call.address,
              collateral: [],
              validAt,
              validAtSource: 'event',
              note: `${fnName(call.fn)}(${detail})`,
            })
          }
          open.set(`${v}|v2|${data.toLowerCase()}`, a)
          break
        }
        case 'Accept':
          resolve(`${v}|v2|${argStr(e, 'data').toLowerCase()}`, e, 'accepted')
          break
        case 'Revoke': {
          const data = argStr(e, 'data')
          const was = resolve(`${v}|v2|${data.toLowerCase()}`, e, 'revoked')
          const call = decodeV2Call(data)
          if (call.idData !== undefined && call.fn.includes('Cap')) {
            const c = capAction(call.idData, call.fn.includes('Absolute') ? 'absolute' : 'relative')
            push(e, {
              kind: 'cap_revoke',
              scope: c.scope,
              target: c.target,
              collateral: c.collateral,
              capType: c.capType,
              to: was?.to ?? call.value?.toString(),
              actor: argStr(e, 'sender'),
              note: fnName(call.fn),
            })
          } else
            push(e, {
              kind: 'v2_revoke',
              scope: 'vault',
              collateral: [],
              actor: argStr(e, 'sender'),
              note: fnName(call.fn),
            })
          break
        }
        case 'IncreaseAbsoluteCap':
        case 'IncreaseRelativeCap':
        case 'DecreaseAbsoluteCap':
        case 'DecreaseRelativeCap': {
          const capType = e.name.includes('Absolute') ? 'absolute' : 'relative'
          const c = capAction(argStr(e, 'idData'), capType)
          const value = argBig(e, capType === 'absolute' ? 'newAbsoluteCap' : 'newRelativeCap')
          const key = `${v}:${capType}:${c.target}`
          const prev = lastCap.get(key)
          lastCap.set(key, value)
          const up = e.name.startsWith('Increase')
          const kind: ActionKind = up ? 'cap_raise' : value === 0n ? 'cap_zero' : 'cap_cut'
          const note =
            capType === 'relative' && value === WAD
              ? 'relative cap = 100% (no relative cap)'
              : undefined
          push(e, {
            kind,
            scope: c.scope,
            target: c.target,
            collateral: c.collateral,
            capType,
            from: prev?.toString(),
            to: value.toString(),
            actor: up ? undefined : argStr(e, 'sender'),
            note,
          })
          break
        }
        case 'Allocate':
        case 'Deallocate': {
          const sender = argStr(e, 'sender')
          if (!ctx.isV2Allocator?.(v, sender)) {
            stats.v2DepositPathAllocations++
            break
          }
          const ids = argList(e, 'ids').map((x) => x.toLowerCase())
          const market = ids
            .map((id) => ctx.v2Ids?.[id])
            .find((d): d is Extract<V2IdData, { type: 'market' }> => d?.type === 'market')
          reallocations.push({
            protocol: 'morpho-v2',
            vault: v,
            target: market ? market.market : argStr(e, 'adapter'),
            dir: e.name === 'Allocate' ? 'in' : 'out',
            assets: argBig(e, 'assets'),
            source: 'allocator',
            actor: sender,
            block: e.block,
            ts: e.ts,
            tx: e.tx,
            logIndex: e.logIndex,
          })
          break
        }
        case 'AddAdapter':
          push(e, {
            kind: 'adapter_add',
            scope: 'adapter',
            target: argStr(e, 'account'),
            collateral: [],
          })
          break
        case 'RemoveAdapter':
          push(e, {
            kind: 'adapter_remove',
            scope: 'adapter',
            target: argStr(e, 'account'),
            collateral: [],
          })
          break
        case 'SetOwner':
          push(e, { kind: 'owner_set', scope: 'vault', to: argStr(e, 'newOwner') })
          break
        case 'SetCurator':
          push(e, { kind: 'curator_set', scope: 'vault', to: argStr(e, 'newCurator') })
          break
        case 'SetIsAllocator':
          push(e, {
            kind: 'allocator_set',
            scope: 'vault',
            target: argStr(e, 'allocator'),
            to: String(argBool(e, 'isAllocator')),
            collateral: [],
          })
          break
        case 'SetIsSentinel':
          push(e, {
            kind: 'sentinel_set',
            scope: 'vault',
            target: argStr(e, 'account'),
            to: String(argBool(e, 'newIsSentinel')),
            collateral: [],
          })
          break
        case 'IncreaseTimelock':
        case 'DecreaseTimelock': {
          const sel = argStr(e, 'selector')
          push(e, {
            kind: 'timelock_set',
            scope: 'vault',
            to: argBig(e, 'newDuration').toString(),
            note: `${e.name === 'IncreaseTimelock' ? 'increase' : 'decrease'} timelock of ${V2_SELECTORS[sel] ? fnName(V2_SELECTORS[sel]) : sel}`,
          })
          break
        }
        case 'Abdicate': {
          const sel = argStr(e, 'selector')
          push(e, {
            kind: 'timelock_set',
            scope: 'vault',
            to: 'abdicated',
            note: `abdicated ${V2_SELECTORS[sel] ? fnName(V2_SELECTORS[sel]) : sel} (can never be called again)`,
          })
          break
        }
      }
      continue
    }

    if (e.kind === 'aave') {
      const asset = argStr(e, 'asset')
      const base = { scope: 'reserve' as Scope, target: asset, collateral: [asset] }
      switch (e.name) {
        case 'SupplyCapChanged':
        case 'BorrowCapChanged': {
          const supply = e.name === 'SupplyCapChanged'
          const from = argBig(e, supply ? 'oldSupplyCap' : 'oldBorrowCap')
          const to = argBig(e, supply ? 'newSupplyCap' : 'newBorrowCap')
          if (from === to) break
          // 0 = no cap, so it ranks above every finite cap.
          const rank = (x: bigint) => (x === 0n ? 2n ** 255n : x)
          const kind: ActionKind = rank(to) > rank(from) ? 'cap_raise' : 'cap_cut'
          const note =
            to === 0n
              ? 'cap removed (0 = no cap)'
              : from === 0n
                ? 'cap set where there was none'
                : undefined
          push(e, {
            ...base,
            kind,
            capType: supply ? 'supply' : 'borrow',
            from: from.toString(),
            to: to.toString(),
            note: note ? `${note}; whole tokens` : 'whole tokens',
          })
          break
        }
        case 'ReserveFrozen':
          push(e, { ...base, kind: argBool(e, 'frozen') ? 'freeze' : 'unfreeze' })
          break
        case 'ReservePaused':
          push(e, { ...base, kind: argBool(e, 'paused') ? 'pause' : 'unpause' })
          break
        case 'ReserveBorrowing':
          push(e, { ...base, kind: argBool(e, 'enabled') ? 'borrow_on' : 'borrow_off' })
          break
        case 'CollateralConfigurationChanged': {
          const ltv = argBig(e, 'ltv')
          const lt = argBig(e, 'liquidationThreshold')
          const bonus = argBig(e, 'liquidationBonus')
          const sig = `${ltv}:${lt}:${bonus}`
          const key = `${v}:${asset}`
          const prev = lastAaveCollateral.get(key)
          lastAaveCollateral.set(key, sig)
          if (prev === sig) {
            stats.duplicatesSkipped++
            break
          }
          const prevLtv = prev ? prev.split(':')[0] : undefined
          push(e, {
            ...base,
            kind: ltv === 0n && prevLtv !== '0' ? 'ltv_zero' : 'collateral_params',
            from: prevLtv,
            to: ltv.toString(),
            note: `LTV ${Number(ltv) / 100}% · liquidation threshold ${Number(lt) / 100}%`,
          })
          break
        }
      }
    }
  }

  // A submit accepted in its own transaction (a zero timelock) never had a window: its
  // executed event already says what changed, so the submit row is folded away.
  const folded = actions.filter(
    (a) => isSubmitKind(a.kind) && a.resolution?.how === 'accepted' && a.resolution.tx === a.tx,
  )
  stats.sameTxSubmitsFolded = folded.length
  if (folded.length) {
    const drop = new Set(folded.map((a) => a.id))
    actions.splice(0, actions.length, ...actions.filter((a) => !drop.has(a.id)))
  }

  // A head-time contract read describes the submit still open at the head: it replaces
  // the derived window, or — when the contract shows nothing pending — says the outcome
  // event is missing from the collected logs (counted, never guessed).
  for (const { action, chainKey } of chainKeyed) {
    if (action.resolution) continue
    const chain = ctx.chainValidAt?.[chainKey]
    if (chain === undefined) continue
    if (chain > 0) {
      action.validAt = chain
      action.validAtSource = 'chain'
      action.headPending = true
    } else {
      action.headPending = false
      stats.openButClearedOnChain++
    }
  }
  return { actions, reallocations, stats }
}
