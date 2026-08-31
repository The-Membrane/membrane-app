import React, { useMemo, useState } from 'react'
import {
  Box,
  Select,
  Slider,
  SliderFilledTrack,
  SliderThumb,
  SliderTrack,
  Text,
} from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'

import { useCanvasPainter } from './hooks/useCanvasPainter'
import { INITIAL_PARAMS } from './fixtures'
import { SectionHeading, Stamp, statusColor } from './Primitives'
import { computeDecision, drawDecisionSurface } from './utils'
import { DecisionParams, DecisionReadout } from './types'

const selectSx = {
  bg: SEMANTIC_COLORS.bgTertiary,
  color: SEMANTIC_COLORS.textPrimary,
  border: '1px solid',
  borderColor: SEMANTIC_COLORS.borderStrong,
  borderRadius: 0,
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.label,
  h: 'auto',
  py: '3px',
  w: 'auto',
  _focus: FOCUS_STYLES.ring,
}

const CtlHead: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <Box display="flex" justifyContent="space-between" fontSize={TYPOGRAPHY.label} mt={SPACING.md}>
    <Text as="span" fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textSecondary}>
      {label}
    </Text>
    <Text as="span" fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textPrimary}>
      {value}
    </Text>
  </Box>
)

const LeverSlider: React.FC<{
  ariaLabel: string
  min: number
  max: number
  value: number
  onChange: (v: number) => void
}> = ({ ariaLabel, min, max, value, onChange }) => (
  <Slider
    aria-label={ariaLabel}
    min={min}
    max={max}
    step={1}
    value={value}
    onChange={onChange}
    mt="2px"
    focusThumbOnChange={false}
  >
    <SliderTrack bg={SEMANTIC_COLORS.borderStrong} h="2px" borderRadius={0}>
      <SliderFilledTrack bg={SEMANTIC_COLORS.success} />
    </SliderTrack>
    <SliderThumb
      w="11px"
      h="11px"
      borderRadius={0}
      bg={SEMANTIC_COLORS.success}
      _focusVisible={FOCUS_STYLES.ring}
    />
  </Slider>
)

const DRow: React.FC<{ label: React.ReactNode; value: string; color?: string; topRule?: boolean }> = ({
  label,
  value,
  color = SEMANTIC_COLORS.textPrimary,
  topRule,
}) => (
  <Box
    display="flex"
    justifyContent="space-between"
    gap={SPACING.sm}
    fontSize={TYPOGRAPHY.label}
    color={SEMANTIC_COLORS.textSecondary}
    mt={topRule ? SPACING.sm : undefined}
    pt={topRule ? SPACING.sm : undefined}
    borderTop={topRule ? '1px solid' : undefined}
    borderColor={SEMANTIC_COLORS.borderSubtle}
  >
    <Text as="span" fontFamily={TYPOGRAPHY.fontMono}>
      {label}
    </Text>
    <Text as="b" fontFamily={TYPOGRAPHY.fontMono} fontWeight={400} color={color} textAlign="right">
      {value}
    </Text>
  </Box>
)

const CapBar: React.FC<{ readout: DecisionReadout }> = ({ readout }) => {
  const { greenPct, over, redLeftPct, redWidthPct, tickPct } = readout.capBar
  return (
    <Box
      position="relative"
      h="7px"
      mt="5px"
      bg={SEMANTIC_COLORS.bgPrimary}
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
    >
      <Box position="absolute" top={0} bottom={0} left={0} w={`${greenPct}%`} bg="rgba(155,220,79,0.5)" />
      {over && (
        <Box
          position="absolute"
          top={0}
          bottom={0}
          left={`${redLeftPct}%`}
          w={`${redWidthPct}%`}
          bg="rgba(207,64,52,0.6)"
        />
      )}
      <Box position="absolute" top="-3px" bottom="-3px" left={`${tickPct}%`} w="2px" bg={SEMANTIC_COLORS.info} />
    </Box>
  )
}

export const DecisionSurface: React.FC = () => {
  const [P, setP] = useState<DecisionParams>(INITIAL_PARAMS)
  const readout = useMemo(() => computeDecision(P), [P])

  const canvasRef = useCanvasPainter((ctx, w, h) => drawDecisionSurface(ctx, w, h, P), [P])

  const set = (patch: Partial<DecisionParams>) => setP((prev) => ({ ...prev, ...patch }))

  return (
    <>
      <SectionHeading
        index="01"
        title="The decision surface"
        note="every lever your program outputs · move any of them and watch the couplings"
      />
      <Card
        display="grid"
        gridTemplateColumns={{ base: '1fr', md: 'minmax(0,1.25fr) minmax(0,1fr)' }}
        gap={SPACING.base}
        p={SPACING.base}
      >
        {/* controls + viz */}
        <Box>
          <Box
            position="relative"
            h="250px"
            bg={SEMANTIC_COLORS.bgPrimary}
            border="1px solid"
            borderColor={SEMANTIC_COLORS.borderSubtle}
          >
            <Box as="canvas" ref={canvasRef} position="absolute" inset={0} w="100%" h="100%" />
          </Box>

          <CtlHead label="Liquidation LTV (M)" value={readout.mVal} />
          <LeverSlider
            ariaLabel="Liquidation LTV"
            min={70}
            max={95}
            value={Math.round(P.M * 100)}
            onChange={(v) => set({ M: v / 100 })}
          />

          <CtlHead label="Borrow gap (g)" value={readout.gVal} />
          <LeverSlider
            ariaLabel="Borrow gap"
            min={10}
            max={50}
            value={Math.round(P.g * 1000)}
            onChange={(v) => set({ g: v / 1000 })}
          />

          <CtlHead label="Collateral cap" value={readout.capVal} />
          <LeverSlider
            ariaLabel="Collateral cap"
            min={5}
            max={100}
            value={P.cap}
            onChange={(v) => set({ cap: v })}
          />

          <Box
            display="flex"
            gap={SPACING.md}
            mt={SPACING.md}
            fontSize={TYPOGRAPHY.label}
            flexWrap="wrap"
          >
            <Box display="flex" alignItems="center" gap={SPACING.sm}>
              <Text as="span" fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textSecondary}>
                Delay window
              </Text>
              <Select
                aria-label="Delay window"
                value={P.delay}
                onChange={(e) => set({ delay: +e.target.value })}
                sx={selectSx}
              >
                <option value={0}>none</option>
                <option value={2}>2h</option>
                <option value={8}>8h</option>
                <option value={24}>24h</option>
              </Select>
            </Box>
            <Box display="flex" alignItems="center" gap={SPACING.sm}>
              <Text as="span" fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textSecondary}>
                Oracle staleness
              </Text>
              <Select
                aria-label="Oracle staleness tolerance"
                value={P.stale}
                onChange={(e) => set({ stale: +e.target.value })}
                sx={selectSx}
              >
                <option value={1}>60s</option>
                <option value={15}>15m</option>
                <option value={60}>1h</option>
              </Select>
            </Box>
          </Box>
        </Box>

        {/* readout */}
        <Box>
          <DRow label="Borrow LTV — B = M − g" value={readout.bVal} />
          <DRow label="Wipeout frontier √M" value={readout.wipeVal} color={SEMANTIC_COLORS.danger} />
          <DRow label="Headroom, trigger → wipeout" value={readout.headVal} color={statusColor(readout.headClass)} />
          <DRow label="Capital efficiency vs Aave BTC" value={readout.effVal} />

          <DRow label="Max safe delay at this M — crash depth vs headroom" value={readout.dSafeVal} topRule />
          <DRow label="Your delay" value={readout.dYourVal} color={statusColor(readout.dYourClass)} />

          <DRow label="House cap formula — depth × (1 + junior − vol stress)" value={readout.capHouse} topRule />
          <CapBar readout={readout} />
          <DRow
            label={
              <Text as="span" fontSize="9.5px" color={SEMANTIC_COLORS.textTertiary}>
                teal tick = formula cap · your cap past it is cascade exposure
              </Text>
            }
            value={readout.capFlag}
            color={statusColor(readout.capFlagClass)}
          />

          <DRow label="Oracle: max price error at liquidation" value={readout.oraErr} topRule />
          <DRow label="Oracle: expected frozen time per week" value={readout.oraFrz} color={statusColor(readout.oraFrzClass)} />

          <Stamp>
            Every number is a consequence, not a setting — and the levers couple. A delay that is safe
            at 86% is lethal at 95%. A cap that ignores clearable depth only fails in the cascade
            regime. Your program outputs this whole vector, per collateral, every step.
          </Stamp>
        </Box>
      </Card>
    </>
  )
}

export default DecisionSurface
