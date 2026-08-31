// The modelled inputs.
//
// These five values are the difference between a claim and a model. Each one is
// exposed because none of them can be read from a live Membrane deployment — there
// isn't one. Moving a slider re-runs the comparison immediately and rewrites the URL,
// so a shared link carries the inputs that produced the number.

import React from 'react'
import { Box, Button, Input, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { eyebrow, monoXs, tabular } from '@/components/Builder/styles'
import { BORROW_LTV_GAP, CURE_WINDOW_HOURS, MAX_LIQ_FEE, type Provenance } from '@/lib/position-sim'

import Stamp from './Stamp'
import { pct, usd } from './format'

const RANGE_SX = {
  appearance: 'none',
  WebkitAppearance: 'none',
  width: '100%',
  height: '18px',
  background: 'transparent',
  cursor: 'pointer',
  '&::-webkit-slider-runnable-track': { height: '2px', background: SEMANTIC_COLORS.borderStrong },
  '&::-moz-range-track': { height: '2px', background: SEMANTIC_COLORS.borderStrong },
  '&::-webkit-slider-thumb': {
    WebkitAppearance: 'none',
    appearance: 'none',
    width: '11px',
    height: '11px',
    background: SEMANTIC_COLORS.success,
    marginTop: '-4.5px',
    border: 0,
    borderRadius: 0,
  },
  '&::-moz-range-thumb': {
    width: '11px',
    height: '11px',
    background: SEMANTIC_COLORS.success,
    border: 0,
    borderRadius: 0,
  },
  '&:focus-visible': { outline: `1px solid ${SEMANTIC_COLORS.success}`, outlineOffset: '2px' },
} as const

const HEAD = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '9px',
  letterSpacing: '0.18em',
  textTransform: 'uppercase' as const,
  color: SEMANTIC_COLORS.textSecondary,
}

interface SliderProps {
  id: string
  label: string
  value: number
  display: string
  min: number
  max: number
  step: number
  note: string
  onChange: (v: number) => void
}

const Slider: React.FC<SliderProps> = ({
  id,
  label,
  value,
  display,
  min,
  max,
  step,
  note,
  onChange,
}) => (
  <Box
    display="grid"
    gap={SPACING.xs}
    borderTop="1px solid"
    borderColor={SEMANTIC_COLORS.borderSubtle}
    pt={SPACING.sm}
  >
    <Box display="flex" justifyContent="space-between" gap={SPACING.sm}>
      <Text as="label" htmlFor={id} {...HEAD}>
        {label}
      </Text>
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="12px"
        {...tabular}
        color={SEMANTIC_COLORS.textPrimary}
      >
        {display}
      </Text>
    </Box>
    <Box
      as="input"
      id={id}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(parseFloat(e.target.value))}
      sx={RANGE_SX}
    />
    <Text {...monoXs} lineHeight={1.7}>
      {note}
    </Text>
  </Box>
)

export interface ControlValues {
  membraneMaxLtv: number
  membraneLiqFee: number
  recallRate: number
  fastRate: number
  deployedUsd: number
}

export interface ControlsProps {
  values: ControlValues
  onChange: (patch: Partial<ControlValues>) => void
  onReset: () => void
  /** The collateral-weighted modelled line for this position, before any override. */
  derivedMaxLtv: number
  /** Assets in the position with no modelled Membrane LTV at all. */
  unknownLtvSymbols: string[]
  /** True when a deployment venue was actually detected on-chain for this address. */
  venueDetected: boolean
  ltvProvenance: Provenance
  venueProvenance: Provenance
  /** Where the default liquidation fee came from, in plain words. */
  liqFeeDefaultNote: string
}

export const Controls: React.FC<ControlsProps> = ({
  values,
  onChange,
  onReset,
  derivedMaxLtv,
  unknownLtvSymbols,
  venueDetected,
  ltvProvenance,
  venueProvenance,
  liqFeeDefaultNote,
}) => (
  <Box
    bg={SEMANTIC_COLORS.bgSecondary}
    border="1px solid"
    borderColor={SEMANTIC_COLORS.borderSubtle}
    p={SPACING.base}
    display="grid"
    gap={SPACING.md}
    alignContent="start"
  >
    <Box
      display="flex"
      justifyContent="space-between"
      alignItems="baseline"
      gap={SPACING.sm}
      flexWrap="wrap"
    >
      <Text {...eyebrow}>02 / what you are assuming</Text>
      <Button
        type="button"
        onClick={onReset}
        bg="transparent"
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderStrong}
        color={SEMANTIC_COLORS.textSecondary}
        borderRadius={0}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="9px"
        letterSpacing="0.16em"
        textTransform="uppercase"
        h="auto"
        px={SPACING.sm}
        py="5px"
        transition={TRANSITIONS.colors}
        _hover={{
          borderColor: SEMANTIC_COLORS.success,
          color: SEMANTIC_COLORS.success,
          bg: 'transparent',
        }}
        _focus={FOCUS_STYLES.ring}
      >
        Reset
      </Button>
    </Box>

    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="11.5px"
      color={SEMANTIC_COLORS.textSecondary}
      lineHeight={1.75}
    >
      None of these five can be read from a live Membrane market, because there is no Membrane
      deployment on Ethereum mainnet. They are the model. Change one and the number above changes
      with it.
    </Text>

    <Box display="flex" gap={SPACING.sm} flexWrap="wrap">
      <Stamp provenance={ltvProvenance} />
      <Stamp provenance={venueProvenance} />
    </Box>

    <Slider
      id="sim-membrane-ltv"
      label="Membrane max LTV"
      value={values.membraneMaxLtv}
      display={pct(values.membraneMaxLtv)}
      min={0.3}
      max={0.9}
      step={0.005}
      onChange={(v) => onChange({ membraneMaxLtv: v })}
      note={`The line this position would be liquidated past. Our weighted assumption for this basket is ${pct(
        derivedMaxLtv,
      )}; the 90% ceiling is real (lib/Constants.sol:23). The borrow cap sits a fixed ${(
        BORROW_LTV_GAP * 100
      ).toFixed(
        0,
      )}pp below, at ${pct(Math.max(0, values.membraneMaxLtv - BORROW_LTV_GAP))} — that is the level a partial repay restores to.${
        unknownLtvSymbols.length
          ? ` No modelled LTV exists for ${unknownLtvSymbols.join(', ')}, so ${
              unknownLtvSymbols.length > 1 ? 'those legs are' : 'that leg is'
            } left out of the weighting rather than guessed.`
          : ''
      }`}
    />

    <Slider
      id="sim-liq-fee"
      label="Membrane liquidation fee"
      value={values.membraneLiqFee}
      display={pct(values.membraneLiqFee)}
      min={0}
      max={MAX_LIQ_FEE}
      step={0.0025}
      onChange={(v) => onChange({ membraneLiqFee: v })}
      note={`What a Membrane liquidator takes on top of the value repaid. The ${pct(
        MAX_LIQ_FEE,
        0,
      )} ceiling is real (lib/Constants.sol:57, MAX_LIQ_FEE). ${liqFeeDefaultNote}`}
    />

    <Box
      display="grid"
      gap={SPACING.xs}
      borderTop="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      pt={SPACING.sm}
    >
      <Box display="flex" justifyContent="space-between" gap={SPACING.sm}>
        <Text as="label" htmlFor="sim-deployed" {...HEAD}>
          Deployed to venues
        </Text>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="12px"
          {...tabular}
          color={SEMANTIC_COLORS.textPrimary}
        >
          {usd(values.deployedUsd)}
        </Text>
      </Box>
      <Input
        id="sim-deployed"
        type="number"
        min={0}
        step={1000}
        value={String(Math.round(values.deployedUsd))}
        onChange={(e) => {
          const n = Number(e.target.value)
          onChange({ deployedUsd: Number.isFinite(n) && n > 0 ? n : 0 })
        }}
        bg={SEMANTIC_COLORS.bgPrimary}
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderSubtle}
        borderRadius={0}
        color={SEMANTIC_COLORS.textPrimary}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="12.5px"
        h="auto"
        px={SPACING.md}
        py={SPACING.sm}
        transition={TRANSITIONS.colors}
        _hover={{ borderColor: SEMANTIC_COLORS.borderStrong }}
        _focus={FOCUS_STYLES.ring}
      />
      <Text {...monoXs} lineHeight={1.7}>
        {venueDetected
          ? 'Read on-chain from the venue balances below. Membrane pulls from here before it sells any collateral.'
          : 'No deployment was detected for this address, so this starts at zero and Membrane sells collateral for the whole call. Raise it yourself only to model a deployment you know about — the simulator will not invent one.'}
      </Text>
    </Box>

    <Slider
      id="sim-recall"
      label="Recall rate"
      value={values.recallRate}
      display={pct(values.recallRate)}
      min={0}
      max={1}
      step={0.01}
      onChange={(v) => onChange({ recallRate: v, fastRate: Math.min(values.fastRate, v) })}
      note="The share of deployed value that comes back when it is asked for. This is the single biggest lever on the result, and it is not measured — a venue that pays out in a calm market is not the same venue in the middle of a crash."
    />

    <Slider
      id="sim-fast"
      label="Fast rate"
      value={values.fastRate}
      display={pct(values.fastRate)}
      min={0}
      max={Math.max(0, values.recallRate)}
      step={0.01}
      onChange={(v) => onChange({ fastRate: Math.min(v, values.recallRate) })}
      note={`The share that can arrive inside the ${CURE_WINDOW_HOURS}-hour cure window. If it covers the whole call, the breach is cured and no collateral is sold. It cannot exceed the recall rate.`}
    />
  </Box>
)

export default Controls
