// Factory floor: canvas conveyor belts + machine nodes + three drop slots + intent
// chips. Proto sections: NODES/BELTS (:724-737), layout/path/at (:745-759), buildFloor/
// paintSlots (:762-811), draw/emit/beltLive (:947-988).

import React, { useEffect, useRef } from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { resolveColor } from '@/helpers/resolveToken'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { BELT_COLOR, CLASS_COLOR, CLASS_NM, BTC_PX } from './fixtures'
import { TINTS, tabular } from './styles'
import { byId, pct, usd } from './utils'
import { Calc, Intent } from './types'

// Belt hairline = bone at 0.16 (live) / 0.07 (idle). Canvas can't read var()/color-mix(),
// so resolve the token and compose rgba in JS. Called inside the rAF draw loop, so it
// self-heals on a theme flip (resolveColor's cache clears on membrane-theme-change).
const beltStroke = (live: boolean): string => {
  const c = resolveColor(SEMANTIC_COLORS.textPrimary)
  const a = live ? 0.16 : 0.07
  if (c.startsWith('rgb')) {
    const [r, g, b] = c.match(/[\d.]+/g) || []
    return `rgba(${r},${g},${b},${a})`
  }
  const h = c.replace('#', '')
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`
}

const NODES: Record<string, { x: number; y: number }> = {
  btc: { x: 0.1, y: 0.5 },
  cdp: { x: 0.3, y: 0.5 },
  s0: { x: 0.585, y: 0.18 },
  s1: { x: 0.585, y: 0.5 },
  s2: { x: 0.585, y: 0.82 },
  router: { x: 0.87, y: 0.5 },
}
type BeltColor = keyof typeof BELT_COLOR
const BELTS: { a: string; b: string; c: BeltColor; curve?: number }[] = [
  { a: 'btc', b: 'cdp', c: 'teal' },
  { a: 'cdp', b: 's0', c: 'teal' },
  { a: 'cdp', b: 's1', c: 'teal' },
  { a: 'cdp', b: 's2', c: 'teal' },
  { a: 's0', b: 'router', c: 'phos' },
  { a: 's1', b: 'router', c: 'phos' },
  { a: 's2', b: 'router', c: 'phos' },
  { a: 'router', b: 'cdp', c: 'phos', curve: -0.3 }, // the loop that closes
]

interface Particle {
  i: number
  t: number
  c: string
  sp: number
}

export interface FactoryFloorProps {
  slots: (string | null)[]
  intent: Intent
  calc: Calc
  btc: number
  onRemoveSlot: (i: number) => void
  onIntent: (i: Intent) => void
}

const INTENTS: { k: Intent; label: string }[] = [
  { k: 'repay', label: 'Repay debt' },
  { k: 'compound', label: 'Compound' },
  { k: 'distribute', label: 'Pay me' },
]

export const FactoryFloor: React.FC<FactoryFloorProps> = ({ slots, intent, calc, btc, onRemoveSlot, onIntent }) => {
  const floorRef = useRef<HTMLDivElement>(null)
  const cvRef = useRef<HTMLCanvasElement>(null)
  // The draw loop reads live state through this ref so the rAF closure never goes stale.
  const stateRef = useRef({ slots, intent, calc })
  stateRef.current = { slots, intent, calc }

  useEffect(() => {
    const floor = floorRef.current
    const cv = cvRef.current
    if (!floor || !cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    let W = 0
    let H = 0
    let parts: Particle[] = []
    const acc: Record<number, number> = {}
    let raf = 0
    let last = 0

    const layout = () => {
      const r = floor.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) return
      W = r.width
      H = r.height
      const d = Math.min(2, window.devicePixelRatio || 1)
      cv.width = Math.round(W * d)
      cv.height = Math.round(H * d)
      ctx.setTransform(d, 0, 0, d, 0, 0)
    }
    const P = (k: string) => ({ x: NODES[k].x * W, y: NODES[k].y * H })
    const path = (b: (typeof BELTS)[number]) => {
      const a = P(b.a)
      const z = P(b.b)
      let mx = (a.x + z.x) / 2
      let my = (a.y + z.y) / 2
      if (b.curve) {
        const dx = z.x - a.x
        const dy = z.y - a.y
        mx += -dy * b.curve
        my += dx * b.curve
      }
      return { a, b: z, c: { x: mx, y: my } }
    }
    const at = (p: ReturnType<typeof path>, t: number) => {
      const u = 1 - t
      return {
        x: u * u * p.a.x + 2 * u * t * p.c.x + t * t * p.b.x,
        y: u * u * p.a.y + 2 * u * t * p.c.y + t * t * p.b.y,
      }
    }
    const beltLive = (b: (typeof BELTS)[number], c: Calc, sl: (string | null)[], it: Intent) => {
      if (c.debt <= 0) return false
      if (b.a === 'btc') return true
      const si: Record<string, number> = { s0: 0, s1: 1, s2: 2 }
      if (b.a === 'cdp' && si[b.b] !== undefined) return !!sl[si[b.b]]
      if (si[b.a] !== undefined && b.b === 'router') return !!sl[si[b.a]]
      if (b.a === 'router') return it === 'repay' && c.p.length > 0 // only Repay closes the loop
      return false
    }
    const emit = (i: number, color: string, rate: number, dt: number) => {
      if (rate <= 0) return
      acc[i] = (acc[i] || 0) + rate * dt
      while (acc[i] >= 1) {
        acc[i] -= 1
        parts.push({ i, t: Math.random() * 0.08, c: color, sp: 0.34 + Math.random() * 0.2 })
      }
    }
    const draw = (dt: number) => {
      if (!W || !H || !cv.width) return
      ctx.clearRect(0, 0, W, H)
      const { slots: sl, intent: it, calc: c } = stateRef.current
      BELTS.forEach((b, i) => {
        const live = beltLive(b, c, sl, it)
        const p = path(b)
        ctx.beginPath()
        ctx.moveTo(p.a.x, p.a.y)
        ctx.quadraticCurveTo(p.c.x, p.c.y, p.b.x, p.b.y)
        ctx.strokeStyle = beltStroke(live)
        ctx.lineWidth = 1
        ctx.setLineDash([3, 5])
        ctx.stroke()
        ctx.setLineDash([])
        if (live) emit(i, BELT_COLOR[b.c], 2.4, dt)
      })
      const keep: Particle[] = []
      for (let k = 0; k < parts.length; k++) {
        const q = parts[k]
        q.t += q.sp * dt
        if (q.t >= 1) continue
        keep.push(q)
        const pt = at(path(BELTS[q.i]), q.t)
        ctx.beginPath()
        ctx.arc(pt.x, pt.y, 2.5, 0, Math.PI * 2)
        ctx.fillStyle = resolveColor(q.c)
        ctx.globalAlpha = 0.9
        ctx.fill()
        ctx.globalAlpha = 1
      }
      parts = keep.length > 420 ? keep.slice(keep.length - 420) : keep
    }
    const frame = (ts: number) => {
      if (!last) last = ts
      const dt = Math.min(0.05, (ts - last) / 1000)
      last = ts
      try {
        draw(dt)
      } catch {
        /* never take the page down from the belt painter */
      }
      raf = requestAnimationFrame(frame)
    }
    layout()
    draw(0)
    raf = requestAnimationFrame(frame)
    const onResize = () => layout()
    window.addEventListener('resize', onResize, { passive: true })
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  const node = (k: string) => ({ left: NODES[k].x * 100 + '%', top: NODES[k].y * 100 + '%' })

  return (
    <Box
      ref={floorRef}
      position="relative"
      bg={TINTS.sunk}
      minH="430px"
      overflow="hidden"
      backgroundImage={`radial-gradient(${TINTS.boneDots} 1px, transparent 1px)`}
      backgroundSize="22px 22px"
    >
      <Box as="canvas" ref={cvRef} position="absolute" inset={0} w="100%" h="100%" />

      {/* source + cdp machines */}
      <Box position="absolute" {...node('btc')} transform="translate(-50%,-50%)" bg={SEMANTIC_COLORS.bgSecondary} border="1px solid" borderColor={SEMANTIC_COLORS.borderStrong} px={SPACING.sm} py={SPACING.sm} minW="132px" display="grid" gap="2px" zIndex={3}>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" letterSpacing="0.16em" textTransform="uppercase" color={SEMANTIC_COLORS.textTertiary}>
          Source
        </Text>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11.5px" color={SEMANTIC_COLORS.textPrimary} {...tabular}>
          {btc.toFixed(2)} BTC
        </Text>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11.5px" color={SEMANTIC_COLORS.textSecondary} {...tabular}>
          {usd(btc * BTC_PX)}
        </Text>
      </Box>
      <Box position="absolute" {...node('cdp')} transform="translate(-50%,-50%)" bg={SEMANTIC_COLORS.bgSecondary} border="1px solid" borderColor={calc.debt > 0 ? TINTS.phosBorder : SEMANTIC_COLORS.borderStrong} px={SPACING.sm} py={SPACING.sm} minW="132px" display="grid" gap="2px" zIndex={3}>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" letterSpacing="0.16em" textTransform="uppercase" color={SEMANTIC_COLORS.textTertiary}>
          Cdp
        </Text>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11.5px" color={SEMANTIC_COLORS.textPrimary}>
          Your position
        </Text>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11.5px" color={SEMANTIC_COLORS.textSecondary} {...tabular}>
          {usd(calc.debt)} CDT out
        </Text>
      </Box>

      {/* three drop slots */}
      {[0, 1, 2].map((i) => {
        const id = slots[i]
        const t = byId(id)
        const key = 's' + i
        if (!t) {
          return (
            <Box
              key={key}
              data-builder-slot={i}
              position="absolute"
              {...node(key)}
              transform="translate(-50%,-50%)"
              w="150px"
              minH="66px"
              border="1px dashed"
              borderColor={SEMANTIC_COLORS.borderStrong}
              display="grid"
              placeItems="center"
              zIndex={3}
              color={SEMANTIC_COLORS.textTertiary}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="10px"
              letterSpacing="0.18em"
              textTransform="uppercase"
              p={SPACING.sm}
              textAlign="center"
              transition={TRANSITIONS.colors}
              sx={{ '&[data-over="true"]': { borderColor: SEMANTIC_COLORS.success, backgroundColor: TINTS.phosFaint } }}
            >
              Empty slot
            </Box>
          )
        }
        return (
          <Box
            key={key}
            data-builder-slot={i}
            position="absolute"
            {...node(key)}
            transform="translate(-50%,-50%)"
            w="150px"
            minH="66px"
            border="1px solid"
            borderColor={SEMANTIC_COLORS.borderStrong}
            bg={SEMANTIC_COLORS.bgSecondary}
            boxShadow={`inset 4px 0 0 ${CLASS_COLOR[t.cls]}`}
            display="grid"
            gap="2px"
            px={SPACING.sm}
            py={SPACING.sm}
            zIndex={3}
            textAlign="left"
            sx={{ '&[data-over="true"]': { borderColor: SEMANTIC_COLORS.success } }}
          >
            <Box
              as="button"
              type="button"
              aria-label={'Remove ' + t.nm}
              position="absolute"
              top="3px"
              right="5px"
              fontSize="13px"
              color={SEMANTIC_COLORS.textTertiary}
              bg="none"
              border={0}
              lineHeight={1}
              px="4px"
              py="2px"
              cursor="pointer"
              transition={TRANSITIONS.colors}
              _hover={{ color: SEMANTIC_COLORS.danger }}
              _focusVisible={FOCUS_STYLES.ring}
              onClick={(e: React.MouseEvent) => {
                e.stopPropagation()
                onRemoveSlot(i)
              }}
            >
              ×
            </Box>
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11.5px" color={SEMANTIC_COLORS.textPrimary}>
              {t.nm}
            </Text>
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="8px" letterSpacing="0.16em" textTransform="uppercase" color={CLASS_COLOR[t.cls]}>
              {CLASS_NM[t.cls]}
            </Text>
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.textSecondary} {...tabular}>
              {(t.apr * 100).toFixed(1)}% · recall {pct(t.liq)}
            </Text>
          </Box>
        )
      })}

      {/* yield router: intent chips */}
      <Box position="absolute" {...node('router')} transform="translate(-50%,-50%)" zIndex={3} display="grid" gap={SPACING.xs}>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" letterSpacing="0.18em" textTransform="uppercase" color={SEMANTIC_COLORS.textTertiary} textAlign="center">
          Yield goes to
        </Text>
        {INTENTS.map(({ k, label }) => {
          const on = intent === k
          return (
            <Box
              key={k}
              as="button"
              type="button"
              aria-pressed={on}
              onClick={() => onIntent(k)}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="9.5px"
              letterSpacing="0.1em"
              textTransform="uppercase"
              bg={on ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.bgSecondary}
              border="1px solid"
              borderColor={on ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.borderStrong}
              color={on ? SEMANTIC_COLORS.bgPrimary : SEMANTIC_COLORS.textSecondary}
              px={SPACING.sm}
              py="6px"
              cursor="pointer"
              borderRadius={0}
              transition={TRANSITIONS.colors}
              _hover={on ? undefined : { borderColor: SEMANTIC_COLORS.success, color: SEMANTIC_COLORS.success }}
              _focusVisible={FOCUS_STYLES.ring}
            >
              {label}
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}

export default FactoryFloor
