import { getAddress, parseAbiItem } from 'viem'
import { aTokenExternalFlowRaw, flowDirection, modifiedDietz } from './strat-returns.mjs'

const transfer = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
)
const aTokenMint = parseAbiItem(
  'event Mint(address indexed caller,address indexed onBehalfOf,uint256 value,uint256 balanceIncrease,uint256 index)',
)
const aTokenBurn = parseAbiItem(
  'event Burn(address indexed from,address indexed target,uint256 value,uint256 balanceIncrease,uint256 index)',
)
const balanceAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
]
const convertAbi = [
  {
    type: 'function',
    name: 'convertToAssets',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
]
const MAX_BLOCKS_PER_PASS = 1900n // comfortably inside free RPC log-range ceilings

async function valueShares(client, venue, shares, blockNumber) {
  const units =
    venue.kind === 'atoken-liquidity'
      ? shares
      : await client.readContract({
          address: getAddress(venue.address),
          abi: convertAbi,
          functionName: 'convertToAssets',
          args: [shares],
          blockNumber,
        })
  const value = Number(units) / 10 ** (venue.decimals ?? 18)
  if (!Number.isFinite(value)) throw new Error('non-finite historical venue valuation')
  return value // explicit $1/stable proxy; no market-price or borrow-cost adjustment
}

async function readNav(client, venue, address, blockNumber) {
  const shares = await client.readContract({
    address: getAddress(venue.address),
    abi: balanceAbi,
    functionName: 'balanceOf',
    args: [address],
    blockNumber,
  })
  return valueShares(client, venue, shares, blockNumber)
}

async function blockAt(client, blockNumber, cache) {
  const key = String(blockNumber)
  if (!cache.has(key)) cache.set(key, await client.getBlock({ blockNumber }))
  return cache.get(key)
}

export async function recordStratVenueReturn({ sql, client, venue, address, watchEpoch, head }) {
  const epoch = new Date(watchEpoch).toISOString()
  const atokenUnverified =
    venue.kind === 'atoken-liquidity' && process.env.ENABLE_ATOKEN_RETURN_PRICING !== '1'
  const token = getAddress(venue.address)
  const blocks = new Map()
  const existing = await sql`
    SELECT start_block, last_complete_block, start_at, start_nav_usd
    FROM strat_return_cursors
    WHERE address = ${address} AND venue = ${venue.name} AND watch_epoch = ${epoch}::timestamptz
    LIMIT 1`

  if (existing.length === 0) {
    // Reuse the first sibling's block so a transient venue failure cannot
    // create permanently mismatched watch-wide return windows.
    const siblings = await sql`
      SELECT start_block FROM strat_return_cursors
      WHERE address = ${address} AND watch_epoch = ${epoch}::timestamptz
      ORDER BY start_block ASC LIMIT 1`
    const anchorBlock = siblings.length ? BigInt(siblings[0].start_block) : head.number
    const anchorHead =
      anchorBlock === head.number ? head : await client.getBlock({ blockNumber: anchorBlock })
    const at = new Date(Number(anchorHead.timestamp) * 1000).toISOString()
    let nav = null
    try {
      nav = await readNav(client, venue, address, anchorBlock)
    } catch {
      /* unpriced anchor stays null */
    }
    await sql`
      INSERT INTO strat_return_cursors
        (address, venue, watch_epoch, start_block, last_complete_block, start_at, start_nav_usd)
      VALUES (${address}, ${venue.name}, ${epoch}::timestamptz, ${anchorBlock.toString()}, ${anchorBlock.toString()}, ${at}::timestamptz, ${nav})
      ON CONFLICT (address, venue, watch_epoch) DO NOTHING`
    await sql`
      INSERT INTO strat_return_snapshots
        (address, venue, watch_epoch, block, observed_at, nav_usd, status)
      VALUES (${address}, ${venue.name}, ${epoch}::timestamptz, ${anchorBlock.toString()}, ${at}::timestamptz, ${nav}, ${nav == null ? 'unpriced_anchor' : 'anchor'})
      ON CONFLICT (address, venue, watch_epoch, block) DO NOTHING`
    return { status: nav == null ? 'unpriced_anchor' : 'anchor', block: anchorBlock }
  }

  const cursor = existing[0]
  const lastBlock = BigInt(cursor.last_complete_block)
  if (cursor.start_nav_usd == null && lastBlock === BigInt(cursor.start_block)) {
    // Retry the SAME block; moving the anchor would mismatch sibling venues.
    const at = new Date(cursor.start_at).toISOString()
    const nav = await readNav(client, venue, address, lastBlock)
    await sql`
      UPDATE strat_return_cursors
      SET start_nav_usd = ${nav}, last_error = NULL
      WHERE address = ${address} AND venue = ${venue.name} AND watch_epoch = ${epoch}::timestamptz
        AND start_nav_usd IS NULL AND last_complete_block = ${lastBlock.toString()}`
    await sql`
      INSERT INTO strat_return_snapshots
        (address, venue, watch_epoch, block, observed_at, nav_usd, status)
      VALUES (${address}, ${venue.name}, ${epoch}::timestamptz, ${lastBlock.toString()}, ${at}::timestamptz, ${nav}, 'anchor')
      ON CONFLICT (address, venue, watch_epoch, block) DO NOTHING`
    return { status: 'anchor', block: lastBlock }
  }
  if (lastBlock >= head.number) return { status: 'current', block: lastBlock }
  const toBlock =
    lastBlock + MAX_BLOCKS_PER_PASS < head.number ? lastBlock + MAX_BLOCKS_PER_PASS : head.number
  const fromBlock = lastBlock + 1n

  // Query both indexed sides, then deduplicate one on-chain Transfer log. A
  // transfer to self has zero external flow. Mint/burn are each one Transfer;
  // Deposit/Withdraw logs are deliberately not counted a second time.
  const [sent, received, mints, burns] = await Promise.all([
    client.getLogs({
      address: token,
      event: transfer,
      args: { from: address },
      fromBlock,
      toBlock,
    }),
    client.getLogs({ address: token, event: transfer, args: { to: address }, fromBlock, toBlock }),
    venue.kind === 'atoken-liquidity' && !atokenUnverified
      ? client.getLogs({
          address: token,
          event: aTokenMint,
          args: { onBehalfOf: address },
          fromBlock,
          toBlock,
        })
      : [],
    venue.kind === 'atoken-liquidity' && !atokenUnverified
      ? client.getLogs({
          address: token,
          event: aTokenBurn,
          args: { from: address },
          fromBlock,
          toBlock,
        })
      : [],
  ])
  const aTokenActions = new Map()
  for (const log of mints)
    aTokenActions.set(`${log.transactionHash}:${log.logIndex - 1}`, { kind: 'mint', ...log.args })
  for (const log of burns)
    aTokenActions.set(`${log.transactionHash}:${log.logIndex - 1}`, { kind: 'burn', ...log.args })
  const unique = new Map()
  for (const log of [...sent, ...received])
    unique.set(`${log.transactionHash}:${log.logIndex}`, log)
  const ordered = [...unique.values()].sort(
    (a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex,
  )

  for (const log of ordered) {
    const direction = flowDirection(address, log.args.from, log.args.to)
    if (direction === 0) continue
    const block = await blockAt(client, log.blockNumber, blocks)
    const at = new Date(Number(block.timestamp) * 1000).toISOString()
    let usd = null
    if (!atokenUnverified) {
      if (
        venue.kind === 'atoken-liquidity' &&
        (log.args.from === '0x0000000000000000000000000000000000000000' ||
          log.args.to === '0x0000000000000000000000000000000000000000')
      ) {
        const corrected = aTokenExternalFlowRaw(
          log.args.value,
          aTokenActions.get(`${log.transactionHash}:${log.logIndex}`),
        )
        if (corrected === null) throw new Error('aToken mint/burn interest split unavailable')
        usd = Number(corrected) / 10 ** (venue.decimals ?? 18)
      } else {
        usd = direction * (await valueShares(client, venue, log.args.value, log.blockNumber))
      }
      if (!Number.isFinite(usd)) throw new Error('non-finite flow')
    }
    // Unverified aToken flows are deliberately stored as unsupported facts.
    // Any OTHER missing valuation aborts this range before cursor advance;
    // replay can price it later without rewriting an append-only ledger row.
    if (usd == null && !atokenUnverified)
      throw new Error(`unpriced flow ${venue.name} ${log.transactionHash}:${log.logIndex}`)
    await sql`
      INSERT INTO strat_return_flows
        (address, venue, watch_epoch, tx_hash, log_index, block, occurred_at,
         from_address, to_address, shares_raw, flow_usd, pricing_status)
      VALUES (${address}, ${venue.name}, ${epoch}::timestamptz,
        ${log.transactionHash}, ${log.logIndex}, ${log.blockNumber.toString()}, ${at}::timestamptz,
        ${log.args.from}, ${log.args.to}, ${log.args.value.toString()}, ${usd},
        ${usd == null ? 'unsupported_atoken' : 'stable_usd_proxy'})
      ON CONFLICT (address, venue, watch_epoch, tx_hash, log_index) DO NOTHING`
  }

  const endBlock = await blockAt(client, toBlock, blocks)
  const endAt = new Date(Number(endBlock.timestamp) * 1000).toISOString()
  const endNav = await readNav(client, venue, address, toBlock)
  const ledger = await sql`
    SELECT occurred_at, flow_usd FROM strat_return_flows
    WHERE address = ${address} AND venue = ${venue.name} AND watch_epoch = ${epoch}::timestamptz
      AND block <= ${toBlock.toString()}
    ORDER BY block, log_index`
  const unpricedCount = ledger.filter((row) => row.flow_usd == null).length
  const flows = ledger.map((row) => ({
    at: row.occurred_at,
    usd: row.flow_usd == null ? NaN : Number(row.flow_usd),
  }))
  const emptyAToken =
    atokenUnverified && Number(cursor.start_nav_usd) === 0 && endNav === 0 && ledger.length === 0
  const result =
    atokenUnverified && !emptyAToken
      ? { pnlUsd: null, returnPct: null, capitalBaseUsd: null, status: 'unsupported_atoken' }
      : endNav == null || cursor.start_nav_usd == null
        ? { pnlUsd: null, returnPct: null, capitalBaseUsd: null, status: 'unpriced_nav' }
        : modifiedDietz({
            startNavUsd: Number(cursor.start_nav_usd),
            endNavUsd: endNav,
            startAt: cursor.start_at,
            endAt,
            flows,
          })

  // All log queries and event writes succeeded before the cursor advances.
  // A failed pass retries the same range; the unique event key makes that safe.
  await sql`
    INSERT INTO strat_return_snapshots
      (address, venue, watch_epoch, block, observed_at, nav_usd, pnl_usd, return_pct, capital_base_usd,
       flow_count, unpriced_count, status)
    VALUES (${address}, ${venue.name}, ${epoch}::timestamptz, ${toBlock.toString()}, ${endAt}::timestamptz,
      ${endNav}, ${result.pnlUsd}, ${result.returnPct}, ${result.capitalBaseUsd}, ${ledger.length}, ${unpricedCount}, ${result.status})
    ON CONFLICT (address, venue, watch_epoch, block) DO NOTHING`
  await sql`
    UPDATE strat_return_cursors SET last_complete_block = ${toBlock.toString()}, last_error = NULL
    WHERE address = ${address} AND venue = ${venue.name} AND watch_epoch = ${epoch}::timestamptz
      AND last_complete_block = ${lastBlock.toString()}`
  return { status: result.status, block: toBlock, flowCount: ledger.length }
}
