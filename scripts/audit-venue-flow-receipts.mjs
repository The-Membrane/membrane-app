// Read-only audit of the sealed venue-flow corpus. A legacy row outside the
// receipt chain never contributes to the reported covered interval.
import { neon } from '@neondatabase/serverless'
import {
  databaseStore,
  requiredStreamIdentities,
  streamsFor,
  validateReceiptChain,
  verifyReceiptEventSet,
} from './record-venue-flows.mjs'
import { loadConfig, readEnv } from './lib/venue-reads.mjs'

const { get } = readEnv()
const url = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
if (!url) throw new Error('venue_flow_database_url_unset')
const store = databaseStore(neon(url))

const result = []
for (const venue of loadConfig().filter((entry) => entry.enabled)) {
  const streams = streamsFor(venue)
  if (!streams) continue
  const receipts = await store.readReceipts(venue.name)
  if (!receipts.length) {
    result.push({ venue: venue.name, status: 'uncovered' })
    continue
  }
  validateReceiptChain(receipts, requiredStreamIdentities(streams))
  let events = 0
  for (const receipt of receipts) {
    const rows = await store.readFlowsInRange(
      venue.name,
      BigInt(receipt.from_block),
      BigInt(receipt.to_block),
    )
    verifyReceiptEventSet(receipt, rows)
    events += rows.length
  }
  result.push({
    venue: venue.name,
    status: 'sealed',
    ranges: receipts.length,
    events,
    fromBlock: Number(receipts[0].from_block),
    toBlock: Number(receipts.at(-1).to_block),
  })
}
console.log(JSON.stringify(result, null, 2))
