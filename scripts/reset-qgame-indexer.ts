/**
 * reset-qgame-indexer.ts — dev-DB hygiene after a q-racing anvil redeploy.
 *
 * The chain was torn down and redeployed with new contract addresses, so every row the
 * indexer previously wrote (and the cursor block it wrote them up to) refers to a chain
 * state that no longer exists. Resets indexer_cursor's 'qgame' row to block 0 and clears
 * onchain_results / daily_firsts entirely so the next indexNewEvents() run starts clean
 * against the fresh deployment.
 *
 * Run:  pnpm tsx scripts/reset-qgame-indexer.ts
 */
import { sql } from 'drizzle-orm'
import { db } from '../db'

async function main() {
  const before = await db.execute<{ board: string; n: string }>(sql`
    select board, count(*) as n from onchain_results group by board order by board
  `)
  const firstsBefore = await db.execute<{ n: string }>(sql`select count(*) as n from daily_firsts`)
  console.log('before:')
  for (const r of before.rows) console.log(`  onchain_results[${r.board}] = ${r.n}`)
  console.log(`  daily_firsts = ${firstsBefore.rows[0]?.n ?? 0}`)

  await db.execute(sql`delete from onchain_results`)
  await db.execute(sql`delete from daily_firsts`)
  await db.execute(sql`
    insert into indexer_cursor (key, block, last_run)
    values ('qgame', 0, null)
    on conflict (key) do update set block = 0, last_run = null
  `)

  const after = await db.execute<{ board: string; n: string }>(sql`
    select board, count(*) as n from onchain_results group by board order by board
  `)
  const firstsAfter = await db.execute<{ n: string }>(sql`select count(*) as n from daily_firsts`)
  const cursor = await db.execute<{ block: string }>(sql`select block from indexer_cursor where key = 'qgame'`)
  console.log('after:')
  console.log(`  onchain_results rows = ${after.rows.length === 0 ? 0 : after.rows.map((r) => r.n).join('+')}`)
  console.log(`  daily_firsts = ${firstsAfter.rows[0]?.n ?? 0}`)
  console.log(`  indexer_cursor[qgame].block = ${cursor.rows[0]?.block ?? '(missing)'}`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
