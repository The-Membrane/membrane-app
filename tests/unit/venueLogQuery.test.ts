import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('@/db', () => ({ db: { execute } }))

import { fetchVenueLogEntries } from '@/pages/api/_lib/venueLogQuery'

const at = '2026-09-28T10:00:00.000Z'
const hash = `v2:${'a'.repeat(64)}`

describe('public venue log terms provenance', () => {
  beforeEach(() => {
    execute.mockReset()
  })

  it('scrubs persisted legacy URLs and unknown fields while retaining safe attribution', async () => {
    execute
      .mockResolvedValueOnce({
        rows: [
          {
            venue: 'sUSDe',
            kind: 'terms_page_changed',
            at,
            since: null,
            prev: { content_hash: hash, content_len: 6200, note: 'secret=legacy' },
            next: {
              content_hash: hash,
              content_len: 6300,
              source_url: 'https://official.example/terms',
              final_url: 'https://official.example/redirected?session=private#section',
              raw_url: 'https://official.example/terms?token=private',
              note: 'https://official.example/terms?token=private',
            },
            note: 'https://official.example/terms?token=private',
          },
          {
            venue: 'Aave',
            kind: 'cooldown_duration_changed',
            at,
            since: null,
            prev: { cooldownDuration: 604800 },
            next: { cooldownDuration: 86400 },
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const entries = await fetchVenueLogEntries()
    expect(entries.find((entry) => entry.kind === 'terms_page_changed')).toMatchObject({
      kind: 'terms_page_changed',
      prev: { content_hash: hash, content_len: 6200 },
      next: {
        content_hash: hash,
        content_len: 6300,
        source_url: 'https://official.example/terms',
      },
    })
    expect(JSON.stringify(entries)).not.toMatch(/password|token=|session=|secret=|raw_url|note/)
    expect(entries.find((entry) => entry.kind === 'cooldown_duration_changed')).toMatchObject({
      kind: 'cooldown_duration_changed',
      prev: { cooldownDuration: 604800 },
      next: { cooldownDuration: 86400 },
    })
  })

  it('withholds private hosts and malformed URLs from old terms rows', async () => {
    execute
      .mockResolvedValueOnce({
        rows: [
          {
            venue: 'sUSDe',
            kind: 'terms_page_changed',
            at,
            since: null,
            prev: null,
            next: {
              source_url: 'http://localhost:3000/terms?token=private',
              final_url: 'https://127.0.0.1/terms?token=private',
              content_hash: 'https://official.example/?secret=bad',
            },
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    expect((await fetchVenueLogEntries())[0].next).toEqual({})
  })

  it('scrubs copied terms evidence in old notices and mixed gate alarms', async () => {
    const termsEvent = {
      kind: 'terms_page_changed',
      at,
      prev: { content_hash: hash, content_len: 6200 },
      next: {
        content_hash: hash,
        content_len: 6300,
        source_url: 'https://user:password@official.example/terms?token=private#exit',
      },
      note: 'https://official.example/terms?token=private',
    }
    execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            venue: 'sUSDe',
            kind: 'terms_page_notice',
            severity: 'notice',
            at,
            cleared: false,
            evidence: {
              count: 1,
              latest: termsEvent,
              events: [termsEvent],
              sourceUrl: 'https://user:password@official.example/terms?token=private#exit',
              note: 'https://official.example/terms?token=private',
            },
          },
          {
            venue: 'sUSDe',
            kind: 'gate_change',
            severity: 'alarm',
            at,
            cleared: false,
            evidence: {
              count: 2,
              latest: termsEvent,
              events: [
                termsEvent,
                {
                  kind: 'cooldown_duration_changed',
                  prev: { cooldownDuration: 86400 },
                  next: { cooldownDuration: 604800 },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })

    const entries = await fetchVenueLogEntries()
    expect(JSON.stringify(entries)).not.toMatch(/password|token=|note/)
    const notice = entries.find((entry) => entry.kind === 'terms_page_notice')
    expect(notice?.evidence).toMatchObject({ latest: { next: {} } })
    expect(notice?.evidence).not.toHaveProperty('sourceUrl')
    const mixed = entries.find((entry) => entry.kind === 'gate_change')
    expect(mixed?.evidence).toMatchObject({
      count: 2,
      events: [
        { kind: 'terms_page_changed' },
        {
          kind: 'cooldown_duration_changed',
          prev: { cooldownDuration: 86400 },
          next: { cooldownDuration: 604800 },
        },
      ],
    })
    expect(mixed?.next).toEqual(mixed?.evidence)
  })
})
