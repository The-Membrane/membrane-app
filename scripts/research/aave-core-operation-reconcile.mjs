// Offline, research-only arithmetic over a caller-supplied pinned Aave log set.
// Complete-range declarations are checked for internal gaps, not verified
// against Ethereum. A separate pinned collector/receipt is required for that.
import { MARKETS, POOL } from './aave-core-forward-panel.mjs'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HASH = /^0x[0-9a-fA-F]{64}$/
const KINDS = new Set(['Supply', 'Withdraw', 'Borrow', 'Repay'])
const INFLOW = new Set(['Supply', 'Repay'])

function insist(ok, message) {
  if (!ok) throw new Error(message)
}

function address(value, label) {
  insist(typeof value === 'string' && ADDRESS.test(value), `${label}: invalid address`)
  return value.toLowerCase()
}

function hash(value, label) {
  insist(typeof value === 'string' && HASH.test(value), `${label}: invalid hash`)
  return value.toLowerCase()
}

function integer(value, label, minimum = 0) {
  insist(Number.isSafeInteger(value) && value >= minimum, `${label}: invalid integer`)
  return value
}

function raw(value, label) {
  insist(
    typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value),
    `${label}: expected unsigned decimal raw-unit string`,
  )
  return BigInt(value)
}

function endpoint(input, label) {
  insist(input && typeof input === 'object', `${label}: missing endpoint`)
  return {
    blockNumber: integer(input.blockNumber, `${label}.blockNumber`),
    blockHash: hash(input.blockHash, `${label}.blockHash`),
    cashRaw: raw(input.cashRaw, `${label}.cashRaw`),
  }
}

function ranges(entries, name, a, b) {
  insist(
    Array.isArray(entries) && entries.length > 0,
    `${name}: explicit complete-range assertion required`,
  )
  let next = a + 1
  const normalized = entries.map((entry, index) => {
    const label = `${name}[${index}]`
    insist(
      entry && typeof entry === 'object' && entry.complete === true,
      `${label}: complete must be true`,
    )
    const fromBlock = integer(entry.fromBlock, `${label}.fromBlock`)
    const toBlock = integer(entry.toBlock, `${label}.toBlock`)
    insist(
      fromBlock === next && toBlock >= fromBlock && toBlock <= b,
      `${label}: coverage gap, overlap, or out-of-window range`,
    )
    insist(
      typeof entry.source === 'string' && entry.source.trim().length > 0,
      `${label}: source required`,
    )
    insist(
      typeof entry.receiptSha256 === 'string' && /^[0-9a-fA-F]{64}$/.test(entry.receiptSha256),
      `${label}: source receipt SHA-256 required`,
    )
    next = toBlock + 1
    return {
      fromBlock,
      toBlock,
      source: entry.source,
      receiptSha256: entry.receiptSha256.toLowerCase(),
    }
  })
  insist(next === b + 1, `${name}: incomplete declared coverage`)
  return normalized
}

function coordinates(entry, label, a, b, knownBlockHashes, knownTransactions, knownTxPositions) {
  insist(entry && typeof entry === 'object', `${label}: invalid log`)
  const blockNumber = integer(entry.blockNumber, `${label}.blockNumber`)
  insist(blockNumber > a && blockNumber <= b, `${label}: log outside (A,B]`)
  const blockHash = hash(entry.blockHash, `${label}.blockHash`)
  const transactionHash = hash(entry.transactionHash, `${label}.transactionHash`)
  const transactionIndex = integer(entry.transactionIndex, `${label}.transactionIndex`)
  const logIndex = integer(entry.logIndex, `${label}.logIndex`)
  const priorBlockHash = knownBlockHashes.get(blockNumber)
  insist(!priorBlockHash || priorBlockHash === blockHash, `${label}: conflicting block hash`)
  knownBlockHashes.set(blockNumber, blockHash)
  const priorTx = knownTransactions.get(transactionHash)
  insist(
    !priorTx ||
      (priorTx.blockNumber === blockNumber && priorTx.transactionIndex === transactionIndex),
    `${label}: inconsistent transaction coordinates`,
  )
  knownTransactions.set(transactionHash, { blockNumber, transactionIndex })
  const position = `${blockNumber}:${transactionIndex}`
  const priorHashAtPosition = knownTxPositions.get(position)
  insist(
    !priorHashAtPosition || priorHashAtPosition === transactionHash,
    `${label}: conflicting transaction hash at block/index`,
  )
  knownTxPositions.set(position, transactionHash)
  return { blockNumber, blockHash, transactionHash, transactionIndex, logIndex }
}

function compareLog(a, b) {
  return (
    a.blockNumber - b.blockNumber ||
    a.transactionIndex - b.transactionIndex ||
    a.logIndex - b.logIndex
  )
}

function signed(value) {
  return value.toString()
}

/**
 * Reconcile one reserve's underlying balanceOf(aToken) across (A,B].
 * All amounts and returned calculations are decimal raw-unit strings.
 * Throws on malformed identity, missing declared coverage, duplicate log
 * coordinates, impossible endpoint/log ancestry, or incomplete range claims.
 */
export function reconcileAaveCoreCash(input) {
  insist(input && typeof input === 'object', 'input required')
  const chainId = integer(input.chainId, 'chainId', 1)
  const pool = address(input.pool, 'pool')
  const underlying = address(input.underlying, 'underlying')
  const aToken = address(input.aToken, 'aToken')
  const market = MARKETS.find(
    (row) => row.base.toLowerCase() === underlying && row.aToken.toLowerCase() === aToken,
  )
  insist(
    chainId === 1 && pool === POOL.toLowerCase() && market,
    'Not a configured Ethereum Aave Core USDC/USDT reserve',
  )
  insist(new Set([pool, underlying, aToken]).size === 3, 'pool, underlying and aToken must differ')
  const from = endpoint(input.from, 'from')
  const to = endpoint(input.to, 'to')
  insist(to.blockNumber > from.blockNumber, 'expected nonempty (A,B] block window')
  insist(input.coverage && typeof input.coverage === 'object', 'coverage required')
  const coverage = {
    poolOperations: ranges(
      input.coverage.poolOperations,
      'coverage.poolOperations',
      from.blockNumber,
      to.blockNumber,
    ),
    underlyingTransfers: ranges(
      input.coverage.underlyingTransfers,
      'coverage.underlyingTransfers',
      from.blockNumber,
      to.blockNumber,
    ),
  }
  insist(
    Array.isArray(input.operations) && Array.isArray(input.transfers),
    'operations and transfers arrays required; use [] for certified zero-log ranges',
  )

  const knownBlockHashes = new Map([
    [from.blockNumber, from.blockHash],
    [to.blockNumber, to.blockHash],
  ])
  const knownTransactions = new Map()
  const knownTxPositions = new Map()
  const seenLogs = new Set()
  const events = []
  for (const [type, entries] of [
    ['operation', input.operations],
    ['transfer', input.transfers],
  ]) {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]
      const label = `${type}s[${index}]`
      const coord = coordinates(
        entry,
        label,
        from.blockNumber,
        to.blockNumber,
        knownBlockHashes,
        knownTransactions,
        knownTxPositions,
      )
      const logKey = `${coord.blockNumber}:${coord.logIndex}`
      insist(!seenLogs.has(logKey), `${label}: duplicate log coordinates`)
      seenLogs.add(logKey)
      if (type === 'operation') {
        insist(
          address(entry.emitter, `${label}.emitter`) === pool,
          `${label}: Pool emitter mismatch`,
        )
        insist(
          address(entry.reserve, `${label}.reserve`) === underlying,
          `${label}: reserve mismatch`,
        )
        insist(KINDS.has(entry.kind), `${label}: unsupported operation kind`)
        events.push({
          ...coord,
          type,
          kind: entry.kind,
          amountRaw: raw(entry.amountRaw, `${label}.amountRaw`),
        })
      } else {
        insist(
          address(entry.token, `${label}.token`) === underlying,
          `${label}: underlying token mismatch`,
        )
        const sender = address(entry.from, `${label}.from`)
        const recipient = address(entry.to, `${label}.to`)
        insist(
          sender === aToken || recipient === aToken,
          `${label}: Transfer does not touch aToken`,
        )
        events.push({
          ...coord,
          type,
          sender,
          recipient,
          amountRaw: raw(entry.amountRaw, `${label}.amountRaw`),
        })
      }
    }
  }
  events.sort(compareLog)

  const txs = new Map()
  for (const event of events) {
    const key = event.transactionHash
    let tx = txs.get(key)
    if (!tx) {
      tx = {
        blockNumber: event.blockNumber,
        blockHash: event.blockHash,
        transactionHash: key,
        transactionIndex: event.transactionIndex,
        firstLogIndex: event.logIndex,
        operationKinds: [],
        operationLogIndices: [],
        transferLogIndices: [],
        operations: [],
        transfers: [],
        operationIn: 0n,
        operationOut: 0n,
        transferIn: 0n,
        transferOut: 0n,
        selfTransfer: 0n,
      }
      txs.set(key, tx)
    }
    tx.firstLogIndex = Math.min(tx.firstLogIndex, event.logIndex)
    if (event.type === 'operation') {
      tx.operationKinds.push(event.kind)
      tx.operationLogIndices.push(event.logIndex)
      tx.operations.push({
        logIndex: event.logIndex,
        kind: event.kind,
        amountRaw: signed(event.amountRaw),
      })
      if (INFLOW.has(event.kind)) tx.operationIn += event.amountRaw
      else tx.operationOut += event.amountRaw
    } else {
      tx.transferLogIndices.push(event.logIndex)
      tx.transfers.push({
        logIndex: event.logIndex,
        from: event.sender,
        to: event.recipient,
        amountRaw: signed(event.amountRaw),
      })
      if (event.sender === aToken && event.recipient === aToken) tx.selfTransfer += event.amountRaw
      else if (event.recipient === aToken) tx.transferIn += event.amountRaw
      else tx.transferOut += event.amountRaw
    }
  }

  const transactionRows = [...txs.values()]
    .sort(
      (a, b) =>
        a.blockNumber - b.blockNumber ||
        a.transactionIndex - b.transactionIndex ||
        a.firstLogIndex - b.firstLogIndex,
    )
    .map((tx) => {
      const operationNet = tx.operationIn - tx.operationOut
      const transferNet = tx.transferIn - tx.transferOut
      const operationPresent = tx.operationLogIndices.length > 0
      const transferPresent = tx.transferLogIndices.length > 0
      const grossMatched = tx.operationIn === tx.transferIn && tx.operationOut === tx.transferOut
      const mixed =
        new Set(tx.operationKinds).size > 1 ||
        (tx.transferIn > 0n && tx.transferOut > 0n) ||
        tx.selfTransfer > 0n
      return {
        blockNumber: tx.blockNumber,
        blockHash: tx.blockHash,
        transactionHash: tx.transactionHash,
        transactionIndex: tx.transactionIndex,
        firstLogIndex: tx.firstLogIndex,
        operationKinds: tx.operationKinds,
        operationLogIndices: tx.operationLogIndices,
        transferLogIndices: tx.transferLogIndices,
        operations: tx.operations,
        transfers: tx.transfers,
        status: !operationPresent
          ? 'transfer-only'
          : !transferPresent
            ? 'operation-only'
            : grossMatched
              ? mixed
                ? 'gross-matched-mixed'
                : 'gross-matched'
              : 'gross-mismatch',
        operationInRaw: signed(tx.operationIn),
        operationOutRaw: signed(tx.operationOut),
        operationNetRaw: signed(operationNet),
        transferInRaw: signed(tx.transferIn),
        transferOutRaw: signed(tx.transferOut),
        transferNetRaw: signed(transferNet),
        selfTransferRaw: signed(tx.selfTransfer),
        operationMinusTransferNetRaw: signed(operationNet - transferNet),
        operationMinusTransferInRaw: signed(tx.operationIn - tx.transferIn),
        operationMinusTransferOutRaw: signed(tx.operationOut - tx.transferOut),
      }
    })

  const sum = (key) => transactionRows.reduce((total, row) => total + BigInt(row[key]), 0n)
  const operationNet = sum('operationNetRaw')
  const transferNet = sum('transferNetRaw')
  const endpointDelta = to.cashRaw - from.cashRaw
  const count = (status) => transactionRows.filter((row) => row.status === status).length
  return {
    study: 'aave-core-operation-cash-reconciliation-v1',
    chainId,
    identity: { market: market.name, pool, underlying, aToken },
    window: {
      fromExclusive: {
        blockNumber: from.blockNumber,
        blockHash: from.blockHash,
        cashRaw: signed(from.cashRaw),
      },
      toInclusive: {
        blockNumber: to.blockNumber,
        blockHash: to.blockHash,
        cashRaw: signed(to.cashRaw),
      },
    },
    coverage: { status: 'caller-asserted-not-chain-verified', ...coverage },
    emptyRange: events.length === 0,
    counts: {
      operations: input.operations.length,
      transfers: input.transfers.length,
      transactions: transactionRows.length,
      grossMismatch: count('gross-mismatch'),
      operationOnly: count('operation-only'),
      transferOnly: count('transfer-only'),
      grossMatchedMixed: count('gross-matched-mixed'),
    },
    totals: {
      operationInRaw: signed(sum('operationInRaw')),
      operationOutRaw: signed(sum('operationOutRaw')),
      operationNetRaw: signed(operationNet),
      transferInRaw: signed(sum('transferInRaw')),
      transferOutRaw: signed(sum('transferOutRaw')),
      transferNetRaw: signed(transferNet),
      endpointDeltaRaw: signed(endpointDelta),
      endpointMinusTransfersRaw: signed(endpointDelta - transferNet),
      endpointMinusOperationsRaw: signed(endpointDelta - operationNet),
    },
    endpointReconciled: endpointDelta === transferNet,
    operationGrossReconciled: transactionRows.every(
      (row) => row.status === 'gross-matched' || row.status === 'gross-matched-mixed',
    ),
    transactions: transactionRows,
    caveat:
      'Arithmetic only. Caller coverage assertions and supplied logs are not chain-verified; matching amounts do not prove economic intent or executable exit capacity.',
  }
}
