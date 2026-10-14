/**
 * /api/wavefront/stream without a database: 503 with a plain message, before any query (no
 * network). Plus the row → record mapping and the missing-table detection the route uses.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import handler from '@/pages/api/wavefront/stream'
import { isMissingTable, rowToRecord } from '@/pages/api/_lib/wavefrontEvents'
import { aavePid } from '@/lib/wavefront/pid'

import { mockRes } from './fixtures/mockApiRes'

describe('GET /api/wavefront/stream without DATABASE_URL', () => {
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env.DATABASE_URL
    delete process.env.DATABASE_URL
  })
  afterEach(() => {
    if (saved !== undefined) process.env.DATABASE_URL = saved
  })

  it('answers 503 with a plain message', async () => {
    const res = mockRes()
    await handler({ method: 'GET', query: { after: '0' } } as any, res)
    expect(res.statusCode).toBe(503)
    expect(res.headers['content-type']).toMatch(/^text\/plain/)
    expect(res.body).toBe('Live wavefront unavailable: DATABASE_URL is not set.')
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('answers 405 to anything but GET', async () => {
    const res = mockRes()
    await handler({ method: 'POST', query: {} } as any, res)
    expect(res.statusCode).toBe(405)
    expect(res.headers.allow).toBe('GET')
  })
})

describe('wavefront_events rows', () => {
  it('a row becomes its record: seq and kind from the columns, pid and ts filled in', () => {
    // schema v2 pid: the Aave pool is part of the id; the route never parses it
    const pid = aavePid('base', '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', '0xAbC')
    const r = rowToRecord({
      seq: '42',
      ts: '2025-10-10T21:30:00Z',
      kind: 'real',
      pid,
      body: { repaidUsd: 10, seizedUsd: 11, block: 1, tx: '0x1', logIndex: 0 },
    })
    expect(r).toMatchObject({
      kind: 'real',
      seq: 42,
      pid,
      ts: Date.parse('2025-10-10T21:30:00Z') / 1000,
      repaidUsd: 10,
    })
    // a ts in the body wins; a JSON-string body is parsed
    const t = rowToRecord({
      seq: 7,
      ts: null,
      kind: 'tick',
      pid: null,
      body: JSON.stringify({ ts: 1760131800, minute: 1289 }),
    })
    expect(t).toMatchObject({ kind: 'tick', seq: 7, ts: 1760131800 })
  })

  it('rejects rows that are not records', () => {
    expect(rowToRecord({ seq: 1, ts: null, kind: 'header', pid: null, body: {} })).toBeNull()
    expect(rowToRecord({ seq: 0, ts: null, kind: 'tick', pid: null, body: { ts: 1 } })).toBeNull()
    expect(rowToRecord({ seq: 2, ts: null, kind: 'open', pid: null, body: { ts: 1 } })).toBeNull()
    expect(rowToRecord({ seq: 3, ts: null, kind: 'mem', pid: 'x', body: {} })).toBeNull()
  })

  it('recognises a missing table however the driver wraps it', () => {
    expect(isMissingTable({ code: '42P01' })).toBe(true)
    expect(isMissingTable(new Error('x', { cause: { code: '42P01' } }))).toBe(true)
    expect(isMissingTable(new Error('relation "wavefront_events" does not exist'))).toBe(true)
    expect(isMissingTable(new Error('connection refused'))).toBe(false)
  })
})
