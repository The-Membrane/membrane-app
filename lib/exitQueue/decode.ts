import { decodeEventLog, type AbiEvent, type Hex } from 'viem'

import type { LedgerEvent, RawLog } from './types'
import { ABI, topic, type VenueDef } from './venues'

/**
 * Raw log → ledger event, one decoder per venue kind. Pure: no RPC, no clock.
 * A log that matches no known topic returns null; a log that matches a topic but
 * does not decode throws, and the recorder counts it in `undecodedLogs`.
 */

const lc = (s: string) => s.toLowerCase()
const logId = (log: RawLog) => `${lc(log.transactionHash)}:${log.logIndex}`

function decodeWith(events: readonly AbiEvent[], log: RawLog) {
  const t0 = log.topics[0]
  const event = events.find((e) => topic(e) === t0)
  if (!event) return null
  const { args } = decodeEventLog({
    abi: [event],
    data: log.data as Hex,
    topics: log.topics as [Hex, ...Hex[]],
    strict: true,
  })
  return { name: event.name, args: args as unknown as Record<string, unknown> }
}

const at = (log: RawLog) => ({
  block: log.blockNumber,
  ts: log.blockTimestamp,
  logIndex: log.logIndex,
})

export interface LogFilter {
  address: `0x${string}`
  /** Positional topic filter: an array is OR, null is a wildcard. */
  topics: (string[] | string | null)[]
}

/** getLogs filters for a venue: one per (address, topic set). */
export function venueLogFilters(def: VenueDef): LogFilter[] {
  const t = (events: Record<string, AbiEvent>) => Object.values(events).map(topic)
  switch (def.kind) {
    case 'lido':
      return [{ address: def.contracts.queue, topics: [t(ABI.lido)] }]
    case 'etherfi':
      return [{ address: def.contracts.queue, topics: [t(ABI.etherfi)] }]
    case 'kelp':
      return [{ address: def.contracts.queue, topics: [t(ABI.kelp)] }]
    case 'ethena': {
      const silo = `0x${def.contracts.silo.slice(2).toLowerCase().padStart(64, '0')}`
      return [
        // Withdraw(sender, receiver, owner): topic 2 is the receiver = the silo.
        { address: def.contracts.vault, topics: [[topic(ABI.ethena.withdraw)], null, silo] },
        { address: def.contracts.vault, topics: [[topic(ABI.ethena.cooldown)]] },
        { address: def.contracts.usde, topics: [[topic(ABI.ethena.transfer)], silo] },
      ]
    }
    case 'maple':
      return [{ address: def.contracts.queue, topics: [t(ABI.maple)] }]
    case 'erc7540':
      return [{ address: def.contracts.vault, topics: [t(ABI.erc7540)] }]
    case 'beacon':
      return []
  }
}

export function decodeVenueLog(def: VenueDef, log: RawLog): LedgerEvent | null {
  switch (def.kind) {
    case 'lido': {
      const d = decodeWith(Object.values(ABI.lido), log)
      if (!d) return null
      const a = d.args
      if (d.name === 'WithdrawalRequested')
        return {
          kind: 'request',
          id: String(a.requestId),
          owner: lc(String(a.owner)),
          amount: a.amountOfStETH as bigint,
          ...at(log),
        }
      if (d.name === 'WithdrawalsFinalized')
        return {
          kind: 'finalize_range',
          fromId: a.from as bigint,
          toId: a.to as bigint,
          ...at(log),
        }
      if (d.name === 'WithdrawalClaimed')
        return { kind: 'claim', id: String(a.requestId), logId: logId(log), ...at(log) }
      const tx = lc(log.transactionHash)
      if (d.name === 'BunkerModeEnabled')
        return { kind: 'param', param: 'bunkerMode', to: true, txHash: tx, ...at(log) }
      if (d.name === 'BunkerModeDisabled')
        return { kind: 'param', param: 'bunkerMode', to: false, txHash: tx, ...at(log) }
      if (d.name === 'Paused')
        return { kind: 'param', param: 'paused', to: true, txHash: tx, ...at(log) }
      if (d.name === 'Resumed')
        return { kind: 'param', param: 'paused', to: false, txHash: tx, ...at(log) }
      return null
    }
    case 'etherfi': {
      const d = decodeWith(Object.values(ABI.etherfi), log)
      if (!d) return null
      const a = d.args
      const tx = lc(log.transactionHash)
      if (d.name === 'WithdrawRequestCreated')
        return {
          kind: 'request',
          id: String(a.requestId),
          owner: lc(String(a.owner)),
          amount: a.amountOfEEth as bigint,
          ...at(log),
        }
      if (d.name === 'WithdrawRequestClaimed')
        return { kind: 'claim', id: String(a.requestId), logId: logId(log), ...at(log) }
      if (d.name === 'WithdrawRequestInvalidated')
        return { kind: 'remove', id: String(a.requestId), txHash: tx, ...at(log) }
      if (d.name === 'Paused')
        return { kind: 'param', param: 'paused', to: true, txHash: tx, ...at(log) }
      if (d.name === 'Unpaused')
        return { kind: 'param', param: 'paused', to: false, txHash: tx, ...at(log) }
      return null
    }
    case 'kelp': {
      const d = decodeWith(Object.values(ABI.kelp), log)
      if (!d) return null
      const a = d.args
      const tx = lc(log.transactionHash)
      if (d.name === 'AssetWithdrawalQueued') {
        const asset = lc(String(a.asset))
        return {
          kind: 'request',
          id: `${asset}:${String(a.userNonce)}`,
          owner: lc(String(a.withdrawer)),
          asset,
          amount: a.rsETHUnstaked as bigint,
          ...at(log),
        }
      }
      // Also emitted by instantWithdrawal, which never queued. completeWithdrawal always
      // pays the user's oldest request, so the ledger accepts it only when the burned
      // rsETH equals that request's amount.
      if (d.name === 'AssetWithdrawalFinalized')
        return {
          kind: 'claim_fifo',
          owner: lc(String(a.withdrawer)),
          asset: lc(String(a.asset)),
          amount: a.amountBurned as bigint,
          logId: logId(log),
          ...at(log),
        }
      if (d.name === 'AssetUnlocked')
        return { kind: 'unlock_hint', asset: lc(String(a.asset)), ...at(log) }
      if (d.name === 'WithdrawalDelayBlocksUpdated')
        return {
          kind: 'param',
          param: 'withdrawalDelayBlocks',
          to: Number(a.withdrawalDelayBlocks),
          txHash: tx,
          ...at(log),
        }
      if (d.name === 'InstantWithdrawalFeeUpdated')
        return {
          kind: 'param',
          param: 'instantWithdrawalFeeBps',
          to: Number(a.feeBasisPoints),
          txHash: tx,
          ...at(log),
        }
      if (d.name === 'MinAmountToWithdrawUpdated')
        return {
          kind: 'param',
          param: `minAmountToWithdraw:${lc(String(a.asset))}`,
          to: String(a.minRsEthAmountToWithdraw),
          txHash: tx,
          ...at(log),
        }
      if (d.name === 'Paused')
        return { kind: 'param', param: 'paused', to: true, txHash: tx, ...at(log) }
      if (d.name === 'Unpaused')
        return { kind: 'param', param: 'paused', to: false, txHash: tx, ...at(log) }
      return null
    }
    case 'ethena': {
      const address = lc(log.address)
      if (address === lc(def.contracts.usde)) {
        const d = decodeWith([ABI.ethena.transfer], log)
        if (!d || lc(String(d.args.from)) !== lc(def.contracts.silo)) return null
        return {
          kind: 'claim_amount',
          receiver: lc(String(d.args.to)),
          amount: d.args.value as bigint,
          logId: logId(log),
          ...at(log),
        }
      }
      const d = decodeWith([ABI.ethena.withdraw, ABI.ethena.cooldown], log)
      if (!d) return null
      if (d.name === 'CooldownDurationUpdated')
        return {
          kind: 'param',
          param: 'cooldownDuration',
          from: Number(d.args.previousDuration),
          to: Number(d.args.newDuration),
          txHash: lc(log.transactionHash),
          ...at(log),
        }
      // cooldownAssets/cooldownShares withdraw into the silo; any other receiver is an
      // instant ERC-4626 exit (only possible while cooldownDuration is 0), not a queue entry.
      if (lc(String(d.args.receiver)) !== lc(def.contracts.silo)) return null
      return {
        kind: 'request',
        id: logId(log),
        owner: lc(String(d.args.owner)),
        amount: d.args.assets as bigint,
        ...at(log),
      }
    }
    case 'maple': {
      const d = decodeWith(Object.values(ABI.maple), log)
      if (!d) return null
      const a = d.args
      const tx = lc(log.transactionHash)
      if (d.name === 'RequestCreated')
        return {
          kind: 'request',
          id: String(a.requestId),
          owner: lc(String(a.owner)),
          amount: a.shares as bigint,
          ...at(log),
        }
      if (d.name === 'RequestProcessed')
        return { kind: 'process', id: String(a.requestId), txHash: tx, ...at(log) }
      if (d.name === 'RequestRemoved')
        return { kind: 'remove', id: String(a.requestId), txHash: tx, ...at(log) }
      if (d.name === 'ManualSharesIncreased')
        return { kind: 'manual', id: String(a.requestId), ...at(log) }
      return null
    }
    case 'erc7540': {
      const d = decodeWith(Object.values(ABI.erc7540), log)
      if (!d) return null
      const a = d.args
      const vault = lc(def.contracts.vault)
      if (d.name === 'RedeemRequest')
        return {
          kind: 'request',
          id: logId(log),
          owner: lc(String(a.controller)),
          asset: vault,
          amount: a.shares as bigint,
          ...at(log),
        }
      if (d.name === 'Withdraw')
        return {
          kind: 'claim_fifo',
          owner: lc(String(a.owner)),
          asset: vault,
          logId: logId(log),
          ...at(log),
        }
      return null
    }
    case 'beacon':
      return null
  }
}
