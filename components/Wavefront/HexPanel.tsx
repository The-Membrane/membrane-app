import React, { memo, useEffect, useLayoutEffect, useRef } from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

import type { PanelGeometry } from './geometry'
import { LABEL_LINE_PX } from './geometry'

/** Where the page stops stacking the panels (Wavefront.tsx uses the same query). */
export const TWO_UP = '@media screen and (min-width: 600px)'
import { drawMarks, type MarkPalette } from './marks'

// Canvas painting must land in the same commit as the numbers around it.
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

interface HexPanelProps {
  width: number
  height: number
  codes: Uint8Array
  geometry: PanelGeometry
  palette: MarkPalette
  /** The panel's whole content as a sentence (the canvas is not readable by AT). */
  ariaLabel: string
  emptyText?: string
  /**
   * Cluster labels: 'always' (the Real panel), or 'stacked' — only while the panels stack
   * (< 600 px), where the Real panel's labels are out of view (the Membrane panel).
   */
  labels?: 'always' | 'stacked'
  /** Stale live data: hatch the panel over (DESIGN_RULES §4). */
  stale?: boolean
}

/**
 * One panel: a single <canvas> with every mark (≈3,200), cluster labels as text on top. The
 * canvas repaints only when its codes, geometry, size or palette change.
 */
export const HexPanel: React.FC<HexPanelProps> = memo(function HexPanel({
  width,
  height,
  codes,
  geometry,
  palette,
  ariaLabel,
  emptyText,
  labels = 'always',
  stale = false,
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useIsoLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || width <= 0 || height <= 0) return
    const dpr = Math.min(3, window.devicePixelRatio || 1)
    const w = Math.round(width * dpr)
    const h = Math.round(height * dpr)
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawMarks({ ctx, codes, xs: geometry.xs, ys: geometry.ys, rho: geometry.rho, palette, dpr })
  }, [codes, geometry, palette, width, height])

  return (
    <Box role="img" aria-label={ariaLabel} position="relative" w="100%" h="100%" overflow="hidden">
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
      />
      {/* Plain elements with inline position: a styled component per changing left/top
          would mint a new CSS class every frame. */}
      <Box
        aria-hidden="true"
        sx={labels === 'stacked' ? { [TWO_UP]: { display: 'none' } } : undefined}
      >
        {geometry.labels.map((l) => (
          <div
            key={l.key}
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: l.x,
              top: l.y,
              width: l.w,
              textAlign: 'center',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              fontFamily: TYPOGRAPHY.fontMono,
              fontSize: TYPOGRAPHY.label,
              lineHeight: `${LABEL_LINE_PX}px`,
              color: SEMANTIC_COLORS.textSecondary,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {l.text}
          </div>
        ))}
      </Box>
      {stale ? (
        <Box
          aria-hidden="true"
          position="absolute"
          inset={0}
          pointerEvents="none"
          sx={{
            backgroundImage: `repeating-linear-gradient(45deg, ${SEMANTIC_COLORS.bgPrimary} 0 3px, transparent 3px 7px)`,
            opacity: 0.85,
          }}
        />
      ) : null}
      {emptyText ? (
        <Text
          position="absolute"
          inset={0}
          display="flex"
          alignItems="center"
          justifyContent="center"
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textTertiary}
        >
          {emptyText}
        </Text>
      ) : null}
    </Box>
  )
})
