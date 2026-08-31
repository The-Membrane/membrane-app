import React, { useEffect, useRef, useState } from 'react'
import { Box, Button, Flex, HStack, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { ORACLE, ORACLE_PROV } from './fixtures'
import { OraclePtMode } from './types'
import { RichText } from './RichText'

/**
 * Shared oracle-info modal (canonical copy ported from the `_oracle-cards.html`
 * block at the tail of public/proto/carry.html). Any element that calls
 * `onOpenOracle(sym)` opens this; written in deployed voice per the owner ruling.
 */
export interface OracleCardProps {
  sym: string | null
  onClose: () => void
}

const MODE_COLOR: Record<OraclePtMode, string> = {
  calm: SEMANTIC_COLORS.success,
  spike: SEMANTIC_COLORS.warning,
  depeg: SEMANTIC_COLORS.danger,
}

const MODE_LABEL: Record<OraclePtMode, string> = {
  calm: 'calm',
  spike: 'rate spike',
  depeg: 'underlying depeg',
}

const MODE_CAPTION: Record<OraclePtMode, string> = {
  calm: 'calm: converges to $1 at maturity',
  spike: 'rate spike at day 60: price gaps down, pull-to-par reels it back',
  depeg: 'underlying cut 3% at day 90: proportional, ends at $0.97',
}

// Bone tints for the grid/reference strokes (derived from #ece6d8) + the
// knock-out chip background (near-black). Canvas colours mirror the tokens.
const BONE_35 = 'rgba(236,230,216,0.35)'
const BONE_55 = 'rgba(236,230,216,0.55)'
const KNOCKOUT = SEMANTIC_COLORS.bgPrimary
const DIM = SEMANTIC_COLORS.textSecondary
const FAINT = SEMANTIC_COLORS.textTertiary

/** Ported ptChart(): the fixed discount curve + a scenario path, labels last. */
function drawPtChart(cv: HTMLCanvasElement, mode: OraclePtMode) {
  const W = cv.clientWidth || 580
  const H = cv.clientHeight || 200
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  cv.width = W * dpr
  cv.height = H * dpr
  const x = cv.getContext('2d')
  if (!x) return
  x.setTransform(dpr, 0, 0, dpr, 0, 0)
  x.clearRect(0, 0, W, H)

  const P = 26
  const T = 180
  const r0 = 0.06
  const X = (d: number) => P + ((W - 2 * P) * d) / T
  const Y = (p: number) => H - P - ((H - 2 * P) * (p - 0.9)) / 0.11
  const curve = (d: number, r: number) => Math.pow(1 + r, -(T - d) / 365)

  x.font = '9px ui-monospace,monospace'

  // $1.00 par reference line.
  x.strokeStyle = BONE_35
  x.setLineDash([3, 4])
  x.beginPath()
  x.moveTo(P, Y(1))
  x.lineTo(W - P, Y(1))
  x.stroke()
  x.setLineDash([])

  // Fixed 6%/yr discount curve (the oracle's ceiling).
  x.strokeStyle = BONE_55
  x.setLineDash([4, 4])
  x.beginPath()
  for (let d = 0; d <= T; d++) {
    const p = curve(d, r0)
    d === 0 ? x.moveTo(X(d), Y(p)) : x.lineTo(X(d), Y(p))
  }
  x.stroke()
  x.setLineDash([])

  // Scenario path.
  const col = MODE_COLOR[mode]
  x.strokeStyle = col
  x.lineWidth = 2
  x.beginPath()
  for (let d2 = 0; d2 <= T; d2++) {
    let p2: number
    if (mode === 'calm') {
      p2 = Math.min(curve(d2, r0), curve(d2, r0 + 0.004 * (1 - d2 / T) * 4))
    } else if (mode === 'spike') {
      const r =
        d2 < 60
          ? r0
          : d2 < 120
          ? 0.14 - (0.14 - r0) * ((d2 - 60) / 60) * 0.3
          : r0 + (0.14 * 0.7 - r0) * Math.max(0, 1 - (d2 - 120) / 60)
      p2 = Math.min(curve(d2, r0), curve(d2, Math.max(r0, r)))
    } else {
      const base = Math.min(curve(d2, r0), curve(d2, r0 + 0.003))
      p2 = d2 < 90 ? base : base * 0.97
    }
    d2 === 0 ? x.moveTo(X(d2), Y(Math.max(0.9, p2))) : x.lineTo(X(d2), Y(Math.max(0.9, p2)))
  }
  x.stroke()
  x.lineWidth = 1

  // Labels last, each on its own knocked-out chip so a line can't swallow it.
  const label = (t: string, px: number, py: number, color: string, align: CanvasTextAlign = 'left') => {
    x.textAlign = align
    const w = x.measureText(t).width
    const lx = align === 'right' ? px - w : px
    x.fillStyle = KNOCKOUT
    x.fillRect(lx - 3, py - 8, w + 6, 11)
    x.fillStyle = color
    x.fillText(t, px, py)
  }
  label('$1.00 par', P + 2, Y(1) - 5, DIM)
  label('fixed discount curve (6%/yr) — the oracle’s ceiling', P + 2, Y(curve(0, r0)) + 13, DIM)
  label(MODE_CAPTION[mode], W - P - 2, P + 10, col, 'right')
  label('listing', P, H - 8, FAINT)
  label('maturity (180d)', W - P, H - 8, FAINT, 'right')
}

const PtChart: React.FC<{ mode: OraclePtMode }> = ({ mode }) => {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (ref.current) drawPtChart(ref.current, mode)
  }, [mode])
  return (
    <Box position="relative" h="200px" bg={SEMANTIC_COLORS.bgPrimary} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} mt={SPACING.md} mb={SPACING.sm}>
      <Box as="canvas" ref={ref as never} position="absolute" inset={0} w="100%" h="100%" />
    </Box>
  )
}

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="10px"
    letterSpacing="0.24em"
    textTransform="uppercase"
    color={SEMANTIC_COLORS.textSecondary}
    mt={SPACING.md}
    mb={SPACING.xs}
  >
    {children}
  </Text>
)

export const OracleCard: React.FC<OracleCardProps> = ({ sym, onClose }) => {
  const [mode, setMode] = useState<OraclePtMode>('calm')

  useEffect(() => {
    if (sym) setMode('calm')
  }, [sym])

  if (!sym) return null
  const o = ORACLE[sym]
  if (!o) return null

  const tagColor = o.tag[0] === 'plan' ? SEMANTIC_COLORS.info : SEMANTIC_COLORS.warning

  return (
    <Flex
      position="fixed"
      inset={0}
      zIndex={80}
      align="center"
      justify="center"
      overflow="auto"
      bg="rgba(7,7,8,0.82)"
      p={SPACING.base}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <Box
        bg={SEMANTIC_COLORS.bgSecondary}
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderStrong}
        borderRadius={0}
        p={SPACING.lg}
        w="min(640px, 94vw)"
        maxH="92vh"
        overflow="auto"
      >
        <HStack justify="space-between" align="baseline" spacing={SPACING.md} flexWrap="wrap" mb={SPACING.xs}>
          <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h3} color={SEMANTIC_COLORS.textPrimary}>
            Oracle info — {sym}
          </Text>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="9px"
            letterSpacing="0.18em"
            textTransform="uppercase"
            color={tagColor}
            border="1px solid"
            borderColor={tagColor}
            px={SPACING.sm}
            py={SPACING.xs}
            whiteSpace="nowrap"
          >
            {o.tag[1]}
          </Text>
        </HStack>

        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textPrimary}
          lineHeight={1.7}
          my={SPACING.sm}
        >
          <RichText html={o.sum} />
        </Text>

        {o.pt && (
          <>
            <PtChart mode={mode} />
            <HStack spacing={SPACING.sm} my={SPACING.sm}>
              {(['calm', 'spike', 'depeg'] as OraclePtMode[]).map((m) => (
                <Button
                  key={m}
                  borderRadius={0}
                  bg="transparent"
                  border="1px solid"
                  borderColor={m === mode ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.borderStrong}
                  color={m === mode ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.textSecondary}
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="9.5px"
                  letterSpacing="0.12em"
                  textTransform="uppercase"
                  px={SPACING.md}
                  py={SPACING.sm}
                  _hover={{ borderColor: SEMANTIC_COLORS.success }}
                  _focus={FOCUS_STYLES.ring}
                  transition={TRANSITIONS.colors}
                  onClick={() => setMode(m)}
                >
                  {MODE_LABEL[m]}
                </Button>
              ))}
            </HStack>
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.label} color={SEMANTIC_COLORS.textSecondary} lineHeight={1.6}>
              model — how the price behaves over the term under each scenario
            </Text>
          </>
        )}

        <SectionLabel>In simple terms</SectionLabel>
        {o.li.map((t, i) => (
          <Text
            key={i}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.label}
            color={SEMANTIC_COLORS.textSecondary}
            lineHeight={1.65}
            pl={SPACING.md}
            position="relative"
            py="5px"
            sx={{ '&::before': { content: '"▪"', position: 'absolute', left: 0, color: SEMANTIC_COLORS.textTertiary } }}
          >
            <RichText html={t} />
          </Text>
        ))}

        {o.wire && (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.label}
            color={SEMANTIC_COLORS.warning}
            border="1px solid"
            borderColor="rgba(216,178,74,0.4)"
            p={SPACING.md}
            my={SPACING.md}
            lineHeight={1.6}
          >
            {o.wire}
          </Text>
        )}

        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="9px"
          color={SEMANTIC_COLORS.textTertiary}
          letterSpacing="0.1em"
          lineHeight={1.7}
          mt={SPACING.md}
          pt={SPACING.md}
          borderTop="1px solid"
          borderColor={SEMANTIC_COLORS.borderSubtle}
        >
          {ORACLE_PROV}
        </Text>

        <Button
          mt={SPACING.md}
          borderRadius={0}
          bg="transparent"
          color={SEMANTIC_COLORS.textSecondary}
          border="1px solid"
          borderColor={SEMANTIC_COLORS.borderStrong}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          letterSpacing="0.14em"
          textTransform="uppercase"
          py={SPACING.sm}
          px={SPACING.base}
          _hover={{ borderColor: SEMANTIC_COLORS.textSecondary }}
          _focus={FOCUS_STYLES.ring}
          transition={TRANSITIONS.colors}
          onClick={onClose}
        >
          Close
        </Button>
      </Box>
    </Flex>
  )
}

export default OracleCard
