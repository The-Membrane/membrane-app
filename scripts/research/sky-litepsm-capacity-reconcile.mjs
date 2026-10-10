// Offline raw-unit accounting for the configured Sky LitePSM USDC Pocket.
// Inputs, endpoint reads, log completeness and receipt digests are caller
// assertions. This does not prove Ethereum provenance or an executable exit.
import { readFileSync } from 'node:fs'

const PSM = '0xf6e72db5454dd049d0788e411b06cfaf16853042'
const POCKET = '0x37305b1cd40574e4c5ce33f8e8306be057fd7341'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HASH = /^0x[0-9a-fA-F]{64}$/
const SHA = /^[0-9a-fA-F]{64}$/
const RAW = /^(0|[1-9][0-9]*)$/
const STREAMS = ['buyGem', 'sellGem', 'fileUint', 'usdcTransfersOut', 'usdcTransfersIn']

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function address(value, label) {
  requireValue(typeof value === 'string' && ADDRESS.test(value), `${label}: invalid address`)
  return value.toLowerCase()
}

function hash(value, label) {
  requireValue(typeof value === 'string' && HASH.test(value), `${label}: invalid hash`)
  return value.toLowerCase()
}

function raw(value, label) {
  requireValue(typeof value === 'string' && RAW.test(value), `${label}: invalid raw-unit string`)
  return BigInt(value)
}

function uint(value, label) {
  requireValue(Number.isSafeInteger(value) && value >= 0, `${label}: invalid integer`)
  return value
}

function configuredRoute() {
  const config = JSON.parse(
    readFileSync(new URL('../../tools/venue-recorder.config.json', import.meta.url), 'utf8'),
  )
  const venues = config.venues.filter((venue) => venue.name === 'sUSDS' && venue.enabled === true)
  requireValue(venues.length === 1, 'Expected one enabled configured sUSDS venue')
  const markets = venues[0].depthMarkets.filter(
    (market) => market.enabled === true && market.kind === 'psm-buffer',
  )
  requireValue(markets.length === 1, 'Expected one enabled configured sUSDS PSM market')
  const market = markets[0]
  requireValue(
    address(market.address, 'configured PSM') === PSM &&
      address(market.buffer, 'configured Pocket') === POCKET &&
      address(market.bufferToken, 'configured USDC') === USDC &&
      address(market.exitFrom, 'configured exit token') ===
        address(venues[0].underlying, 'configured sUSDS underlying'),
    'Configured Sky LitePSM route changed',
  )
}

function endpoint(input, label) {
  requireValue(input && typeof input === 'object', `${label}: endpoint required`)
  const point = {
    blockNumber: uint(input.blockNumber, `${label}.blockNumber`),
    blockHash: hash(input.blockHash, `${label}.blockHash`),
    pocketUsdcRaw: raw(input.pocketUsdcRaw, `${label}.pocketUsdcRaw`),
    psmPocket: address(input.psmPocket, `${label}.psmPocket`),
    psmGem: address(input.psmGem, `${label}.psmGem`),
    psmCodeSha256: hash(`0x${input.psmCodeSha256}`, `${label}.psmCodeSha256`).slice(2),
    usdcCodeSha256: hash(`0x${input.usdcCodeSha256}`, `${label}.usdcCodeSha256`).slice(2),
  }
  requireValue(
    point.psmPocket === POCKET && point.psmGem === USDC,
    `${label}: PSM identity mismatch`,
  )
  return point
}

function completeRanges(entries, label, a, b) {
  requireValue(Array.isArray(entries) && entries.length > 0, `${label}: ranges required`)
  let next = a + 1
  const result = entries.map((entry, index) => {
    const name = `${label}[${index}]`
    requireValue(entry && entry.complete === true, `${name}: complete assertion required`)
    const fromBlock = uint(entry.fromBlock, `${name}.fromBlock`)
    const toBlock = uint(entry.toBlock, `${name}.toBlock`)
    requireValue(
      fromBlock === next && toBlock >= fromBlock && toBlock <= b,
      `${name}: gap, overlap or out-of-window range`,
    )
    requireValue(
      typeof entry.source === 'string' && entry.source.trim(),
      `${name}: source required`,
    )
    requireValue(
      typeof entry.receiptSha256 === 'string' && SHA.test(entry.receiptSha256),
      `${name}: caller receipt SHA-256 required`,
    )
    next = toBlock + 1
    return {
      fromBlock,
      toBlock,
      source: entry.source,
      receiptSha256: entry.receiptSha256.toLowerCase(),
      complete: true,
    }
  })
  requireValue(next === b + 1, `${label}: incomplete (A,B] coverage`)
  return result
}

function logCoordinate(log, label, from, to, knownBlocks, knownTxs, positions, seenLogs) {
  requireValue(log && typeof log === 'object', `${label}: log required`)
  const blockNumber = uint(log.blockNumber, `${label}.blockNumber`)
  requireValue(
    blockNumber > from.blockNumber && blockNumber <= to.blockNumber,
    `${label}: outside (A,B]`,
  )
  const blockHash = hash(log.blockHash, `${label}.blockHash`)
  const transactionHash = hash(log.transactionHash, `${label}.transactionHash`)
  const transactionIndex = uint(log.transactionIndex, `${label}.transactionIndex`)
  const logIndex = uint(log.logIndex, `${label}.logIndex`)
  const priorBlock = knownBlocks.get(blockNumber)
  requireValue(!priorBlock || priorBlock === blockHash, `${label}: conflicting block hash`)
  knownBlocks.set(blockNumber, blockHash)
  const txPosition = `${blockNumber}:${transactionIndex}`
  const priorTx = knownTxs.get(transactionHash)
  requireValue(!priorTx || priorTx === txPosition, `${label}: inconsistent transaction coordinates`)
  knownTxs.set(transactionHash, txPosition)
  const priorHash = positions.get(txPosition)
  requireValue(
    !priorHash || priorHash === transactionHash,
    `${label}: conflicting transaction hash`,
  )
  positions.set(txPosition, transactionHash)
  const logPosition = `${blockNumber}:${logIndex}`
  requireValue(!seenLogs.has(logPosition), `${label}: duplicate log coordinates`)
  seenLogs.add(logPosition)
  return { blockNumber, blockHash, transactionHash, transactionIndex, logIndex }
}

function ordered(a, b) {
  return (
    a.blockNumber - b.blockNumber ||
    a.transactionIndex - b.transactionIndex ||
    a.logIndex - b.logIndex
  )
}

/**
 * Reconcile caller-declared complete `(A,B]` PSM/Pocket logs to two pinned
 * USDC.balanceOf(Pocket) endpoint reads. All amounts are raw decimal strings.
 * Nonzero residuals and unmatched transactions are retained as findings.
 */
export function reconcileSkyLitePsmPocket(input) {
  configuredRoute()
  requireValue(input && typeof input === 'object', 'input required')
  requireValue(input.chainId === 1, 'Only configured Ethereum Sky LitePSM is supported')
  requireValue(
    address(input.psm, 'psm') === PSM &&
      address(input.pocket, 'pocket') === POCKET &&
      address(input.usdc, 'usdc') === USDC,
    'Not the configured Sky LitePSM/Pocket/USDC route',
  )
  const from = endpoint(input.from, 'from')
  const to = endpoint(input.to, 'to')
  requireValue(to.blockNumber > from.blockNumber, 'Expected nonempty (A,B]')
  requireValue(input.coverage && typeof input.coverage === 'object', 'coverage required')
  const coverage = Object.fromEntries(
    STREAMS.map((stream) => [
      stream,
      completeRanges(
        input.coverage[stream],
        `coverage.${stream}`,
        from.blockNumber,
        to.blockNumber,
      ),
    ]),
  )
  requireValue(input.logs && typeof input.logs === 'object', 'logs required')
  const knownBlocks = new Map([
    [from.blockNumber, from.blockHash],
    [to.blockNumber, to.blockHash],
  ])
  const knownTxs = new Map()
  const positions = new Map()
  const seenLogs = new Set()
  const selfOut = new Map()
  const events = []
  for (const stream of STREAMS) {
    const logs = input.logs[stream]
    requireValue(Array.isArray(logs), `logs.${stream}: array required; use [] for quiet ranges`)
    for (let index = 0; index < logs.length; index += 1) {
      const log = logs[index]
      const label = `logs.${stream}[${index}]`
      // The same Pocket->Pocket Transfer appears in both independently
      // filtered direction queries. Verify the second copy, then count once.
      if (stream === 'usdcTransfersIn' && address(log?.from, `${label}.from`) === POCKET) {
        requireValue(address(log.to, `${label}.to`) === POCKET, `${label}: not a self-transfer`)
        const key = `${uint(log.blockNumber, `${label}.blockNumber`)}:${uint(log.logIndex, `${label}.logIndex`)}`
        const prior = selfOut.get(key)
        requireValue(prior, `${label}: self-transfer has no matching out-stream copy`)
        requireValue(
          hash(log.blockHash, `${label}.blockHash`) === prior.blockHash &&
            hash(log.transactionHash, `${label}.transactionHash`) === prior.transactionHash &&
            uint(log.transactionIndex, `${label}.transactionIndex`) === prior.transactionIndex &&
            address(log.token, `${label}.token`) === USDC &&
            raw(log.amountRaw, `${label}.amountRaw`) === prior.amountRaw,
          `${label}: conflicting self-transfer copies`,
        )
        selfOut.delete(key)
        continue
      }
      const coord = logCoordinate(log, label, from, to, knownBlocks, knownTxs, positions, seenLogs)
      if (stream === 'buyGem' || stream === 'sellGem' || stream === 'fileUint') {
        requireValue(
          address(log.emitter, `${label}.emitter`) === PSM,
          `${label}: PSM emitter mismatch`,
        )
        if (stream === 'fileUint') {
          events.push({
            ...coord,
            stream,
            what: hash(log.what, `${label}.what`),
            dataRaw: raw(log.dataRaw, `${label}.dataRaw`),
          })
        } else {
          events.push({
            ...coord,
            stream,
            owner: address(log.owner, `${label}.owner`),
            valueRaw: raw(log.valueRaw, `${label}.valueRaw`),
            feeRaw: raw(log.feeRaw, `${label}.feeRaw`),
          })
        }
      } else {
        requireValue(address(log.token, `${label}.token`) === USDC, `${label}: USDC token mismatch`)
        const sender = address(log.from, `${label}.from`)
        const recipient = address(log.to, `${label}.to`)
        requireValue(
          stream === 'usdcTransfersOut' ? sender === POCKET : recipient === POCKET,
          `${label}: transfer direction/Pocket mismatch`,
        )
        if (sender === POCKET && recipient === POCKET)
          selfOut.set(`${coord.blockNumber}:${coord.logIndex}`, {
            ...coord,
            amountRaw: raw(log.amountRaw, `${label}.amountRaw`),
          })
        events.push({
          ...coord,
          stream,
          sender,
          recipient,
          amountRaw: raw(log.amountRaw, `${label}.amountRaw`),
        })
      }
    }
  }
  requireValue(selfOut.size === 0, 'Pocket self-transfer missing matching in-stream copy')
  events.sort(ordered)
  const txs = new Map()
  let totalNet = 0n
  for (const event of events) {
    let tx = txs.get(event.transactionHash)
    if (!tx) {
      tx = {
        blockNumber: event.blockNumber,
        blockHash: event.blockHash,
        transactionHash: event.transactionHash,
        transactionIndex: event.transactionIndex,
        events: [],
        buyGemRaw: 0n,
        sellGemRaw: 0n,
        pocketInRaw: 0n,
        pocketOutRaw: 0n,
        pocketSelfRaw: 0n,
      }
      txs.set(event.transactionHash, tx)
    }
    const publicEvent = { stream: event.stream, logIndex: event.logIndex }
    if (event.stream === 'buyGem' || event.stream === 'sellGem') {
      publicEvent.owner = event.owner
      publicEvent.valueRaw = event.valueRaw.toString()
      publicEvent.feeRaw = event.feeRaw.toString()
      if (event.stream === 'buyGem') tx.buyGemRaw += event.valueRaw
      else tx.sellGemRaw += event.valueRaw
    } else if (event.stream === 'fileUint') {
      publicEvent.what = event.what
      publicEvent.dataRaw = event.dataRaw.toString()
    } else {
      publicEvent.from = event.sender
      publicEvent.to = event.recipient
      publicEvent.amountRaw = event.amountRaw.toString()
      if (event.sender === POCKET && event.recipient === POCKET) tx.pocketSelfRaw += event.amountRaw
      else if (event.sender === POCKET) tx.pocketOutRaw += event.amountRaw
      else tx.pocketInRaw += event.amountRaw
    }
    tx.events.push(publicEvent)
  }
  const transactions = [...txs.values()].map((tx) => {
    const net = tx.pocketInRaw - tx.pocketOutRaw
    totalNet += net
    const mixed = tx.buyGemRaw > 0n && tx.sellGemRaw > 0n
    const buyOutRelation =
      tx.buyGemRaw === 0n
        ? 'no_buy_gem'
        : mixed || tx.pocketInRaw > 0n
          ? 'mixed_no_simple_equality'
          : tx.pocketOutRaw === tx.buyGemRaw
            ? 'equal_in_this_transaction'
            : 'mismatch_in_this_transaction'
    return {
      blockNumber: tx.blockNumber,
      blockHash: tx.blockHash,
      transactionHash: tx.transactionHash,
      transactionIndex: tx.transactionIndex,
      events: tx.events,
      buyGemRaw: tx.buyGemRaw.toString(),
      sellGemRaw: tx.sellGemRaw.toString(),
      pocketInRaw: tx.pocketInRaw.toString(),
      pocketOutRaw: tx.pocketOutRaw.toString(),
      pocketSelfRaw: tx.pocketSelfRaw.toString(),
      pocketNetRaw: net.toString(),
      pocketOutMinusBuyGemRaw: (tx.pocketOutRaw - tx.buyGemRaw).toString(),
      buyOutRelation,
    }
  })
  const observed = to.pocketUsdcRaw - from.pocketUsdcRaw
  const residual = observed - totalNet
  return {
    status: residual === 0n ? 'caller_logs_balance_reconciled' : 'endpoint_residual_nonzero',
    evidence: 'caller_attested_offline_not_chain_verified',
    executableExit: false,
    route: { chainId: 1, psm: PSM, pocket: POCKET, usdc: USDC },
    from: { ...from, pocketUsdcRaw: from.pocketUsdcRaw.toString() },
    to: { ...to, pocketUsdcRaw: to.pocketUsdcRaw.toString() },
    coverage,
    transactions,
    pocketNetTransfersRaw: totalNet.toString(),
    observedPocketChangeRaw: observed.toString(),
    endpointMinusTransfersRaw: residual.toString(),
  }
}
