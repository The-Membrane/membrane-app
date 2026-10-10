import { beforeEach, describe, expect, it, vi } from 'vitest'

import { db } from '@/db'
import handler from '@/pages/api/venues/alarms'

vi.mock('@/db', () => ({ db: { execute: vi.fn() } }))
vi.mock('@/pages/api/_lib/uncovered', () => ({ uncoveredByVenue: vi.fn(async () => ({})) }))

const row = (kind: string, clearedAt: string | null = null) => ({
  venue: 'sUSDe',
  kind,
  severity: 'alarm',
  evidence: {},
  firedAt: '2026-09-20T00:00:00Z',
  clearedAt,
})

describe('public venue alarms feed', () => {
  beforeEach(() => vi.mocked(db.execute).mockReset())

  it('suppresses legacy flow rows from both active and cleared lists', async () => {
    vi.mocked(db.execute)
      .mockResolvedValueOnce({ rows: [row('headroom_thin'), row('utilization')] } as never)
      .mockResolvedValueOnce({
        rows: [
          row('net_outflow_streak', '2026-09-21T00:00:00Z'),
          row('gate_change', '2026-09-21T00:00:00Z'),
        ],
      } as never)
    const res = {
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn((body: unknown) => body),
    }
    await handler({ method: 'GET' } as never, res as never)
    expect(res.status).toHaveBeenCalledWith(200)
    const body = res.json.mock.calls[0][0] as {
      open: Array<{ kind: string }>
      cleared: Array<{ kind: string }>
    }
    expect(body.open.map((a) => a.kind)).toEqual(['utilization'])
    expect(body.cleared.map((a) => a.kind)).toEqual(['gate_change'])
  })

  it('keeps terms-page notices distinct from measured alarms in the public feed', async () => {
    vi.mocked(db.execute)
      .mockResolvedValueOnce({
        rows: [
          {
            ...row('terms_page_notice'),
            severity: 'notice',
            evidence: { sourceUrl: 'https://official.example/terms' },
          },
        ],
      } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
    const res = {
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn((body: unknown) => body),
    }
    await handler({ method: 'GET' } as never, res as never)
    const body = res.json.mock.calls[0][0] as {
      open: Array<{ kind: string; severity: string; evidence: Record<string, unknown> }>
    }
    expect(body.open[0]).toMatchObject({
      kind: 'terms_page_notice',
      severity: 'notice',
      evidence: { sourceUrl: 'https://official.example/terms' },
    })
  })

  it('withholds legacy terms URLs and notes from the independent public alarm feed', async () => {
    const terms = {
      kind: 'terms_page_changed',
      at: '2026-09-20T00:00:00Z',
      prev: { content_len: 100 },
      next: { content_len: 120, source_url: 'https://u:p@official.example/terms?token=x' },
      note: 'https://official.example/terms?token=x',
    }
    vi.mocked(db.execute)
      .mockResolvedValueOnce({
        rows: [
          {
            ...row('terms_page_notice'),
            evidence: {
              count: 1,
              latest: terms,
              events: [terms],
              sourceUrl: 'https://official.example/terms?token=x',
              note: 'https://official.example/terms?token=x',
            },
          },
          {
            ...row('gate_change'),
            evidence: {
              count: 2,
              latest: terms,
              events: [
                terms,
                { kind: 'cooldown_duration_changed', next: { cooldownDuration: 604800 } },
              ],
            },
          },
        ],
      } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
    const res = {
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn((body: unknown) => body),
    }

    await handler({ method: 'GET' } as never, res as never)
    const body = res.json.mock.calls[0][0] as {
      open: Array<{ kind: string; evidence: Record<string, unknown> }>
    }
    expect(JSON.stringify(body)).not.toMatch(/token=|u:p@|note|source_url/)
    expect(
      body.open.find((alarm) => alarm.kind === 'terms_page_notice')?.evidence,
    ).not.toHaveProperty('sourceUrl')
    expect(body.open.find((alarm) => alarm.kind === 'gate_change')?.evidence).toMatchObject({
      events: [
        { kind: 'terms_page_changed' },
        { kind: 'cooldown_duration_changed', next: { cooldownDuration: 604800 } },
      ],
    })
  })
})
