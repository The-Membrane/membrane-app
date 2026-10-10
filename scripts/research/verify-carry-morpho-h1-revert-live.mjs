// Read-only independent replay of the rare native H1 Morpho covered revert.
// No holder, size, vault, RPC URL or raw provider error is printed.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { neon } from '@neondatabase/serverless'
import { encodeFunctionData, parseAbi } from 'viem'

import { makeClient, readEnv } from '../lib/venue-reads.mjs'

const ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function previewWithdraw(uint256) view returns (uint256)',
  'function withdraw(uint256,address,address) returns (uint256)',
])
const pin = (hash) => ({ blockHash: hash, requireCanonical: true })

function provenEvmRevert(error) {
  let cursor = error
  for (let i = 0; cursor && i < 6; i++, cursor = cursor.cause) {
    if (cursor.name === 'HttpRequestError' || cursor.name === 'TimeoutError') return false
    if (
      cursor.name === 'RpcRequestError' &&
      cursor.code === 3 &&
      typeof cursor.data === 'string' &&
      /^0x(?:[0-9a-f]{2})+$/i.test(cursor.data)
    )
      return true
  }
  return false
}

export async function verifyRecordedH1Revert(sql, client) {
  const rows = await sql`SELECT i.vault, i.holder, i.assets_raw::text AS assets_raw,
      o.source_block::text AS source_block, o.source_hash
    FROM carry_morpho_exit_outcomes o
      JOIN carry_morpho_exit_attempts i ON i.id = o.issue_id
    WHERE o.status = 'evm_revert'
    ORDER BY o.recorded_at DESC LIMIT 1`
  const row = rows?.[0]
  if (!row) return { status: 'no_recorded_revert' }
  try {
    if ((await client.getChainId()) !== 1) return { status: 'wrong_chain' }
    const block = await client.getBlock({ blockNumber: BigInt(row.source_block) })
    if (block.hash?.toLowerCase() !== row.source_hash)
      return { status: 'canonical_block_disagreement' }
    const q = BigInt(row.assets_raw)
    const [code, shares] = await Promise.all([
      client.getCode({ address: row.holder, ...pin(block.hash) }),
      client.readContract({
        address: row.vault,
        abi: ABI,
        functionName: 'balanceOf',
        args: [row.holder],
        ...pin(block.hash),
      }),
    ])
    if ((code && code !== '0x') || shares <= 0n) return { status: 'holder_position_disagreement' }
    const [claim, requiredShares] = await Promise.all([
      client.readContract({
        address: row.vault,
        abi: ABI,
        functionName: 'previewRedeem',
        args: [shares],
        ...pin(block.hash),
      }),
      client.readContract({
        address: row.vault,
        abi: ABI,
        functionName: 'previewWithdraw',
        args: [q],
        ...pin(block.hash),
      }),
    ])
    if (claim < q || requiredShares > shares) return { status: 'position_insufficient' }
    try {
      await client.call({
        account: row.holder,
        to: row.vault,
        data: encodeFunctionData({
          abi: ABI,
          functionName: 'withdraw',
          args: [q, row.holder, row.holder],
        }),
        gas: 20_000_000n,
        ...pin(block.hash),
      })
      return { status: 'recorded_revert_disagreed_success' }
    } catch (error) {
      return { status: provenEvmRevert(error) ? 'confirmed_covered_revert' : 'rpc_unavailable' }
    }
  } catch {
    return { status: 'rpc_unavailable' }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).join(' ') !== '--run-live') throw Error('usage: --run-live')
  const { get } = readEnv()
  const db =
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_URL ||
    get('DATABASE_URL_UNPOOLED') ||
    get('DATABASE_URL')
  if (!db) throw Error('database_url_required')
  verifyRecordedH1Revert(neon(db), makeClient('https://eth.drpc.org'))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(() => {
      process.stderr.write('morpho_h1_revert_verification_failed\n')
      process.exitCode = 1
    })
}
