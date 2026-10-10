import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  TERMS_BOUNDARY_AT,
  VENUE_ALARM_TERMS_MIGRATION_SQL,
  applyVenueAlarmTermsMigration,
} from './migrate-venue-alarm-terms.mjs'

const script = fileURLToPath(new URL('./migrate-venue-alarm-terms.mjs', import.meta.url))
const broadDdl = readFileSync(
  fileURLToPath(new URL('./apply-venue-recorder-ddl.mjs', import.meta.url)),
  'utf8',
)
const plan = VENUE_ALARM_TERMS_MIGRATION_SQL

test('fixed migration boundary precedes both known terms events', () => {
  assert.equal(TERMS_BOUNDARY_AT, '2026-10-04T22:59:27Z')
  assert.ok(Date.parse(TERMS_BOUNDARY_AT) < Date.parse('2026-10-04T23:02:59Z'))
  assert.match(plan, /VALUES \(true, boundary, 'legacy_aggregate_unmapped_pre_boundary'\)/)
  assert.doesNotMatch(plan, /VALUES \(true, now\(\)/i)
})

test('one atomic alarm-only statement contains the focused DDL in safe order', async () => {
  const seen = []
  await applyVenueAlarmTermsMigration({
    async query(statement) {
      seen.push(statement)
    },
  })
  assert.deepEqual(seen, [plan])
  assert.match(plan, /^DO \$alarm_migration\$/)
  assert.match(plan, /LOCK TABLE public\.venue_alarms IN ACCESS EXCLUSIVE MODE/)
  assert.match(plan, /venue alarm schema is neither expected legacy nor complete migration/)
  assert.match(plan, /boundary or status conflicts with prior rollout/)
  assert.match(plan, /column definition mismatch/)
  assert.match(plan, /replacement index definition mismatch/)

  const required = [
    'ALTER TABLE public.venue_alarms ADD COLUMN IF NOT EXISTS source_event_id uuid',
    'ALTER TABLE public.venue_alarms ADD COLUMN IF NOT EXISTS delivery_claim_token uuid',
    'ALTER TABLE public.venue_alarms ADD COLUMN IF NOT EXISTS delivery_claim_until timestamptz',
    'CREATE TABLE IF NOT EXISTS public.venue_alarm_terms_migration',
    'CREATE UNIQUE INDEX IF NOT EXISTS venue_alarms_condition_open_unique_idx',
    'CREATE UNIQUE INDEX IF NOT EXISTS venue_alarms_source_event_unique_idx',
    'DROP INDEX IF EXISTS public.venue_alarms_open_unique_idx',
  ]
  for (const fragment of required) {
    assert.ok(plan.includes(fragment), `missing ${fragment}`)
    assert.ok(
      broadDdl.includes(fragment.replaceAll('public.', '')),
      `not in broad DDL: ${fragment}`,
    )
  }
  assert.ok(
    plan.indexOf('INSERT INTO public.venue_alarm_terms_migration') <
      plan.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS venue_alarms_condition_open_unique_idx'),
  )
  assert.ok(
    plan.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS venue_alarms_source_event_unique_idx') <
      plan.indexOf('DROP INDEX IF EXISTS public.venue_alarms_open_unique_idx'),
  )
  assert.match(plan, /WHERE cleared_at IS NULL AND kind <> 'terms_page_notice'/)
  assert.match(plan, /WHERE source_event_id IS NOT NULL/)
  assert.doesNotMatch(plan, /\b(?:venue_snapshots|venue_flows|venue_predictions|venue_terms)\b/)
  assert.doesNotMatch(plan, /\b(?:DELETE|TRUNCATE|UPDATE)\s+public\./i)
})

test('database errors propagate rather than silently continuing', async () => {
  await assert.rejects(
    applyVenueAlarmTermsMigration({
      async query() {
        throw new Error('expected_failure')
      },
    }),
    /expected_failure/,
  )
})

test('CLI defaults to dry plan and requires both explicit apply arguments', () => {
  const env = { ...process.env }
  delete env.DATABASE_URL
  delete env.DATABASE_URL_UNPOOLED
  const dry = spawnSync(process.execPath, [script], { env, encoding: 'utf8' })
  assert.equal(dry.status, 0)
  assert.match(dry.stdout, /No SQL executed/)
  assert.match(dry.stdout, /2026-10-04T22:59:27Z/)
  const incomplete = spawnSync(process.execPath, [script, '--apply'], { env, encoding: 'utf8' })
  assert.equal(incomplete.status, 2)
  assert.match(incomplete.stderr, /--checker-stopped/)
})
