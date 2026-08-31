import React, { useCallback, useState } from 'react'
import { Box, Button, Select, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'

import { useCanvasPainter } from './hooks/useCanvasPainter'
import { INITIAL_PARAMS } from './fixtures'
import { Eyebrow, SectionHeading, Stamp } from './Primitives'
import { drawDuelPath, fmtPct, runDuel } from './utils'
import { DuelResult, RegimeKey, SimStep } from './types'

// Borrow gap source: the proto shares the decision-surface `P.g`; here the
// sandbox exposes only M + regime, so it uses the default gap (0.03).
const SANDBOX_G = INITIAL_PARAMS.g

const selectSx = {
  bg: SEMANTIC_COLORS.bgTertiary,
  color: SEMANTIC_COLORS.textPrimary,
  border: '1px solid',
  borderColor: SEMANTIC_COLORS.borderStrong,
  borderRadius: 0,
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.label,
  h: 'auto',
  py: '7px',
  w: 'auto',
  _focus: FOCUS_STYLES.ring,
}

const DuelCanvas: React.FC<{ title: string; out: SimStep[]; showTimer: boolean }> = ({
  title,
  out,
  showTimer,
}) => {
  const ref = useCanvasPainter((ctx, w, h) => drawDuelPath(ctx, w, h, out, showTimer), [out, showTimer])
  return (
    <Box
      position="relative"
      h="190px"
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      bg={SEMANTIC_COLORS.bgPrimary}
    >
      <Text
        position="relative"
        zIndex={1}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="10px"
        letterSpacing="0.2em"
        textTransform="uppercase"
        color={SEMANTIC_COLORS.textSecondary}
        px={SPACING.sm}
        py={SPACING.sm}
      >
        {title}
      </Text>
      <Box as="canvas" ref={ref} position="absolute" inset={0} w="100%" h="100%" />
    </Box>
  )
}

const DuelLine: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.label} color={SEMANTIC_COLORS.textSecondary}>
    {children}
  </Text>
)

const strong = { fontWeight: 400 as const, color: SEMANTIC_COLORS.textPrimary }

export const Sandbox: React.FC = () => {
  const [open, setOpen] = useState(false)
  const [regime, setRegime] = useState<RegimeKey>('stress')
  const [M, setM] = useState(0.86)
  const [duel, setDuel] = useState<DuelResult | null>(null)

  const run = useCallback(() => setDuel(runDuel(M, SANDBOX_G, regime)), [M, regime])

  const openGate = () => {
    setOpen(true)
    run()
  }

  return (
    <>
      <SectionHeading index="04" title="Run one sim before you submit" />
      {!open && (
        <Button
          onClick={openGate}
          w="100%"
          textAlign="left"
          justifyContent="flex-start"
          h="auto"
          whiteSpace="normal"
          bg="transparent"
          border="1px solid"
          borderColor={SEMANTIC_COLORS.borderStrong}
          borderRadius={0}
          color={SEMANTIC_COLORS.textPrimary}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.label}
          letterSpacing="0.16em"
          textTransform="uppercase"
          px={SPACING.base}
          py={SPACING.md}
          transition={TRANSITIONS.colors}
          _hover={{ color: SEMANTIC_COLORS.success, borderColor: SEMANTIC_COLORS.success }}
          _focus={FOCUS_STYLES.ring}
        >
          <Box>
            Open the sandbox
            <Text
              mt="5px"
              fontSize="10.5px"
              letterSpacing="0.02em"
              textTransform="none"
              color={SEMANTIC_COLORS.textTertiary}
            >
              One visible-parameter run. The scored competition uses hidden regimes — this is for
              building intuition, and it will not predict your score.
            </Text>
          </Box>
        </Button>
      )}

      {open && duel && (
        <Card mt={SPACING.md} p={SPACING.base}>
          <Box display="flex" gap={SPACING.md} flexWrap="wrap" alignItems="center" mb={SPACING.md}>
            <Eyebrow>Regime</Eyebrow>
            <Select
              aria-label="Regime"
              value={regime}
              onChange={(e) => setRegime(e.target.value as RegimeKey)}
              sx={selectSx}
            >
              <option value="calm">Calm · 1.2% 8h vol</option>
              <option value="stress">Vol spike · 3% 8h vol</option>
              <option value="cascade">Cascade · 5% vol + jump</option>
            </Select>
            <Eyebrow>Liq LTV</Eyebrow>
            <Select aria-label="Liq LTV" value={M} onChange={(e) => setM(+e.target.value)} sx={selectSx}>
              <option value={0.78}>78%</option>
              <option value={0.83}>83%</option>
              <option value={0.86}>86%</option>
              <option value={0.91}>91%</option>
            </Select>
            <Button
              onClick={run}
              bg={SEMANTIC_COLORS.bgTertiary}
              color={SEMANTIC_COLORS.textPrimary}
              border="1px solid"
              borderColor={SEMANTIC_COLORS.borderStrong}
              borderRadius={0}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.label}
              h="auto"
              px={SPACING.md}
              py="7px"
              transition={TRANSITIONS.colors}
              _hover={{ color: SEMANTIC_COLORS.success, borderColor: SEMANTIC_COLORS.success }}
              _focus={FOCUS_STYLES.ring}
            >
              Run the same path through both venues
            </Button>
          </Box>

          <Box display="grid" gridTemplateColumns={{ base: '1fr', md: '1fr 1fr' }} gap={SPACING.base}>
            <DuelCanvas title="Membrane — 8h window · partial to B" out={duel.membrane.out} showTimer />
            <DuelCanvas
              title="Instant venue — no window · liquidate at breach"
              out={duel.instant.out}
              showTimer={false}
            />
          </Box>

          <Box display="grid" gap="4px" mt={SPACING.md}>
            <DuelLine>
              Same path · drawn at B = {fmtPct(duel.B)} · regime {regime}
            </DuelLine>
            <DuelLine>
              Membrane: <Text as="b" {...strong}>{duel.membrane.liqs}</Text> liquidation
              {duel.membrane.liqs === 1 ? '' : 's'} · timers gave the position time to cure · penalty
              paid <Text as="b" {...strong}>{((1 - duel.membrane.equity) * 100).toFixed(1)}%</Text>
            </DuelLine>
            <DuelLine>
              Instant venue: <Text as="b" {...strong}>{duel.instant.liqs}</Text> liquidation
              {duel.instant.liqs === 1 ? '' : 's'} · every touch of M executed · penalty paid{' '}
              <Text as="b" {...strong}>{((1 - duel.instant.equity) * 100).toFixed(1)}%</Text>
            </DuelLine>
          </Box>

          <Stamp>
            Identical price path, identical position, drawn at B. The only difference is the
            mechanism. This is the required lesson: Membrane’s delay changes what risk means — a
            breach here is a timer, not an execution.
          </Stamp>
        </Card>
      )}
    </>
  )
}

export default Sandbox
