// One-time, additive schema for the latest sealed protocol headline poll per
// source. The native recorder mirrors every attempt after sealing it locally.
import { neon } from '@neondatabase/serverless'

import { readEnv } from './lib/venue-reads.mjs'

const { get } = readEnv()
const dbUrl = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
if (!dbUrl) throw new Error('DATABASE_URL is required')

const sql = neon(dbUrl)
await sql`
  CREATE TABLE IF NOT EXISTS venue_news_poll_receipts (
    source_id text PRIMARY KEY CHECK (length(source_id) BETWEEN 1 AND 128),
    sequence bigint NOT NULL CHECK (sequence > 0),
    receipt_text text NOT NULL CHECK (octet_length(receipt_text) <= 65536)
  )`
console.log('venue_news_poll_receipts ready')
