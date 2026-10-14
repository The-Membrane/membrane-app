import React, { memo, useEffect, useLayoutEffect, useRef } from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

import type { PanelGeometry } from './geometry'
import { LABEL_LINE_PX } from './geometry'
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
    drawMarks({ ctx, codes, xs: geometry.xs, ys: geometry.ys, rho: geometry.rho, palette })
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
