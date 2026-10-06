import React, { useId, useMemo, useState } from 'react'
import { Box, HStack, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

import {
  COLOUR_META,
  fmtBps,
  fmtShortUtc,
  fmtUsd,
  indexAt,
  sparkGeometry,
  stripCells,
} from './viewModel'

// 30-day history for one card: the feed's USD price (bone line) over the asset's market
// consensus (dashed), and under it the verdict strip — gold cells fill the upper half, red
// the lower half, green a thin centre band, stale the full height hatched. Pointer over the
// chart reads one bucket out; nothing animates.

const W = 240
const H = 40
const STRIP_H = 8

export type SparklineProps = {
  usd: readonly (number | null)[]
  consensus: readonly (number | null)[]
  colours: string
  ts: readonly number[]
  /** Accessible summary of the whole series. */
  label: string
}

export const Sparkline: React.FC<SparklineProps> = ({ usd, consensus, colours, ts, label }) => {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const hatchId = `hatch-${uid}`
  const geo = useMemo(() => sparkGeometry(usd, consensus, W, H), [usd, consensus])
  const cells = useMemo(() => stripCells(colours, W, STRIP_H), [colours])
  const [hover, setHover] = useState<number | null>(null)

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    setHover(indexAt(e.clientX - rect.left, rect.width, usd.length))
  }

  const hv = hover != null ? usd[hover] : null
  const hc = hover != null ? consensus[hover] : null
  const hx = hover != null && usd.length > 1 ? (hover / (usd.length - 1)) * W : null

  return (
    <Box>
      <Box
        position="relative"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        cursor="crosshair"
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height={H}
          preserveAspectRatio="none"
          role="img"
          aria-label={label}
          style={{ display: 'block' }}
        >
          <line
            x1={0}
            x2={W}
            y1={H - 0.5}
            y2={H - 0.5}
            style={{ stroke: SEMANTIC_COLORS.borderSubtle }}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
          {geo.consensusPath && (
            <path
              d={geo.consensusPath}
              fill="none"
              style={{ stroke: SEMANTIC_COLORS.textTertiary }}
              strokeWidth={1}
              strokeDasharray="3 2"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {geo.entryPath && (
            <path
              d={geo.entryPath}
              fill="none"
              style={{ stroke: SEMANTIC_COLORS.textPrimary }}
              strokeOpacity={0.85}
              strokeWidth={1.25}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {hx != null && (
            <line
              x1={hx}
              x2={hx}
              y1={0}
              y2={H}
              style={{ stroke: SEMANTIC_COLORS.borderStrong }}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        <svg
          viewBox={`0 0 ${W} ${STRIP_H}`}
          width="100%"
          height={STRIP_H}
          preserveAspectRatio="none"
          aria-hidden="true"
          style={{ display: 'block', marginTop: 3 }}
        >
          <defs>
            <pattern id={hatchId} width="3" height="3" patternUnits="userSpaceOnUse">
              <path
                d="M0 3 L3 0"
                style={{ stroke: SEMANTIC_COLORS.textTertiary }}
                strokeWidth={0.8}
              />
            </pattern>
          </defs>
          <line
            x1={0}
            x2={W}
            y1={STRIP_H / 2}
            y2={STRIP_H / 2}
            style={{ stroke: SEMANTIC_COLORS.borderSubtle }}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
          {cells.map((c, i) => (
            <rect
              key={i}
              x={c.x}
              y={c.y}
              width={c.w + 0.05}
              height={c.h}
              style={{
                fill: c.colour === 'stale' ? `url(#${hatchId})` : COLOUR_META[c.colour].token,
              }}
            />
          ))}
        </svg>
      </Box>
      <HStack
        justify="space-between"
        mt="2px"
        minH="16px"
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="10px"
        color={SEMANTIC_COLORS.textTertiary}
        aria-hidden="true"
      >
        {hover != null ? (
          <>
            <Text as="span">{ts[hover] ? fmtShortUtc(ts[hover]) : '—'}</Text>
            <Text as="span" color={SEMANTIC_COLORS.textSecondary}>
              {fmtUsd(hv)}
              {hv != null && hc != null ? ` · ${fmtBps((hv / hc - 1) * 1e4)}` : ''}
            </Text>
          </>
        ) : (
          <>
            <Text as="span">{ts.length ? fmtShortUtc(ts[0]).slice(0, 6) : ''}</Text>
            <Text as="span">{ts.length ? fmtShortUtc(ts[ts.length - 1]).slice(0, 6) : ''}</Text>
          </>
        )}
      </HStack>
    </Box>
  )
}

export default Sparkline
