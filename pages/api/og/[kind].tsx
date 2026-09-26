import { ImageResponse } from 'next/og'
import type { NextRequest } from 'next/server'

import { CORPUS_SCALE_LINE, OCT10_SCALE_LINE } from '@/lib/position-sim/oct10Totals'
import {
  clampUsd,
  fmtUsdShort,
  normalizeAddress,
  parseOgKind,
  parseVenueParam,
  radarCardSummary,
  shortAddr,
  venueCardSummary,
} from '@/lib/share/permalink'

// Social cards, 1200x630 (MOAT_TRACKER step 5). One edge route, three kinds:
//   radar   ?address=  — fetches GET /api/radar/<address> on the SAME ORIGIN over
//                        HTTP. The edge bundle imports no DB/viem code; the radar
//                        API does the chain reads. No numbers ride in the query
//                        string, so a card cannot be forged into saying anything.
//   venue   ?venue=    — fetches GET /api/venues/<venue>/summary on the same origin.
//   finding            — static: the multi-year corpus scale line from
//                        lib/position-sim/oct10Totals.ts (Oct-10 line while partial).
// A failed or malformed fetch renders the plain branded card: title only, never a number.

export const config = { runtime: 'edge' }

const BONE = '#ece6d8'
const INK = '#09090a'
const PHOSPHOR = '#9bdc4f'
const MUTED = '#8a857a'
const HAIR = '#3a3833'
const VERDICT: Record<string, string> = { clear: PHOSPHOR, caution: '#e0b54a', exposed: '#e0604a' }

type Stat = { label: string; value: string; color?: string }
type CardProps = { eyebrow: string; title: string; stats?: Stat[]; line?: string }

function Card({ eyebrow, title, stats = [], line }: CardProps) {
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', background: INK, padding: 28 }}>
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          border: `1px solid ${HAIR}`,
          padding: '40px 48px',
          color: BONE,
          fontFamily: 'monospace',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', fontSize: 44, fontWeight: 700, color: PHOSPHOR }}>4%.</div>
          <div style={{ display: 'flex', fontSize: 18, letterSpacing: 3, textTransform: 'uppercase', color: MUTED }}>
            {eyebrow}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', fontSize: line ? 40 : 60, lineHeight: 1.2, maxWidth: 1000 }}>{title}</div>
          {line && <div style={{ display: 'flex', fontSize: 64, lineHeight: 1.15, marginTop: 20, color: PHOSPHOR }}>{line}</div>}
          {stats.length > 0 && (
            <div style={{ display: 'flex', marginTop: 36, borderTop: `1px solid ${HAIR}` }}>
              {stats.map((s) => (
                <div key={s.label} style={{ display: 'flex', flexDirection: 'column', paddingTop: 20, marginRight: 64 }}>
                  <div style={{ display: 'flex', fontSize: 16, letterSpacing: 2, textTransform: 'uppercase', color: MUTED }}>
                    {s.label}
                  </div>
                  <div style={{ display: 'flex', fontSize: 52, marginTop: 8, color: s.color ?? BONE }}>{s.value}</div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', fontSize: 16, color: MUTED }}>Data compiled by Membrane</div>
      </div>
    </div>
  )
}

async function getJson(url: URL): Promise<unknown | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } })
    return r.ok ? await r.json() : null
  } catch {
    return null
  }
}

async function radarCard(origin: string, raw: string | null): Promise<CardProps> {
  const address = normalizeAddress(raw)
  const plain: CardProps = { eyebrow: 'carry radar', title: 'Carry Radar' }
  if (!address) return plain
  const s = radarCardSummary(await getJson(new URL(`/api/radar/${address}`, origin)))
  if (!s) return { ...plain, title: `Carry Radar · ${shortAddr(address)}` }
  const stats: Stat[] = [
    { label: 'total', value: fmtUsdShort(s.totalUsd) },
    { label: 'venues held', value: String(s.heldCount) },
  ]
  if (s.worst) stats.push({ label: 'weakest verdict', value: s.worst, color: VERDICT[s.worst] })
  return { eyebrow: 'carry radar', title: shortAddr(s.address), stats }
}

async function venueCard(origin: string, raw: string | null): Promise<CardProps> {
  const venue = parseVenueParam(raw)
  const plain: CardProps = { eyebrow: 'venue · exit capacity', title: venue ?? 'Venue exit capacity' }
  if (!venue) return plain
  const s = venueCardSummary(await getJson(new URL(`/api/venues/${encodeURIComponent(venue)}/summary`, origin)))
  if (!s) return plain
  const stats: Stat[] = []
  if (s.tvlUsd != null) stats.push({ label: 'TVL', value: fmtUsdShort(s.tvlUsd) })
  if (s.worst1dUsd != null) stats.push({ label: 'worst 1-day outflow · 90 d', value: fmtUsdShort(s.worst1dUsd) })
  if (s.worst7dUsd != null) stats.push({ label: 'worst 7-day outflow · 90 d', value: fmtUsdShort(s.worst7dUsd) })
  if (s.openFlags != null) stats.push({ label: 'open flags', value: String(s.openFlags), color: s.openFlags > 0 ? VERDICT.caution : undefined })
  const eyebrow = s.observedAt ? `venue · observed ${s.observedAt}` : plain.eyebrow
  return { eyebrow, title: s.label, stats }
}

function findingCard(): CardProps {
  if (!CORPUS_SCALE_LINE.partial && clampUsd(CORPUS_SCALE_LINE.keptUsd) != null && CORPUS_SCALE_LINE.years > 0) {
    return {
      eyebrow: 'finding · aave v3 liquidations',
      title: `Collateral a 4% window would have kept ${CORPUS_SCALE_LINE.window}`,
      line: CORPUS_SCALE_LINE.figure,
    }
  }
  return { eyebrow: 'finding · 10 oct 2025', title: `Less debt closed ${OCT10_SCALE_LINE.window}`, line: OCT10_SCALE_LINE.figure }
}

export default async function handler(req: NextRequest) {
  const url = new URL(req.url)
  // Pages-router edge routes carry the dynamic segment in the query; fall back to the path.
  const kind = parseOgKind(url.searchParams.get('kind') ?? url.pathname.split('/').pop())
  let props: CardProps
  if (kind === 'radar') props = await radarCard(url.origin, url.searchParams.get('address'))
  else if (kind === 'venue') props = await venueCard(url.origin, url.searchParams.get('venue'))
  else if (kind === 'finding') props = findingCard()
  else props = { eyebrow: 'membrane', title: 'Membrane' }

  return new ImageResponse(<Card {...props} />, {
    width: 1200,
    height: 630,
    headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600' },
  })
}
