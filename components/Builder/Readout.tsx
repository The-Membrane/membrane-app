// Readout rail: throughput / LTV / stress-test gauges, BTC + draw sliders, and the
// run/clear buttons. Proto: .meter markup (:423-457) + render() (:991-1048).

import React from 'react'
import { Box, Button, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { MockStamp } from '@/components/demo'

import { BORROW, MAX_BORROW, MAX_LTV } from './fixtures'
import { TINTS, eyebrow, eyebrowPhos, tabular } from './styles'
import { usd } from './utils'
import { Calc } from './types'

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
  '&::-moz-range-thumb': { width: '11px', height: '11px', background: SEMANTIC_COLORS.success, border: 0, borderRadius: 0 },
  '&:focus-visible': { outline: `1px solid ${SEMANTIC_COLORS.success}`, outlineOffset: '2px' },
} as const

export interface ReadoutProps {
  calc: Calc
  btc: number
  liqLine: number
  breakPoint: number | null
  bTestLabel: string
  bTestDisabled: boolean
  onBtc: (v: number) => void
  onLtv: (v: number) => void
  onRun: () => void
  onClear: () => void
}

export const Readout: React.FC<ReadoutProps> = ({
  calc: c,
  btc,
  liqLine,
  breakPoint: bp,
  bTestLabel,
  bTestDisabled,
  onBtc,
  onLtv,
  onRun,
  onClear,
}) => {
  const cut = liqLine < MAX_LTV
  const atRisk = bp == null ? 0 : Math.max(0.02, 1 - bp)
  const ltvBarColor = c.ltv >= liqLine ? SEMANTIC_COLORS.danger : c.ltv > 0.6 ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.success
  const defBarColor = atRisk <= 0 ? SEMANTIC_COLORS.success : atRisk < 0.45 ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.danger

  return (
    <Box
      bg={SEMANTIC_COLORS.bgSecondary}
      borderLeft={{ base: 'none', lg: '1px solid' }}
      borderTop={{ base: '1px solid', lg: 'none' }}
      borderColor={{ base: SEMANTIC_COLORS.borderStrong, lg: SEMANTIC_COLORS.borderStrong }}
      p={SPACING.md}
      display="grid"
      gap={SPACING.md}
      alignContent="start"
      /* Scrolls inside the fixed-height board row rather than setting it. */
      minH={0}
      overflowY={{ base: 'visible', lg: 'auto' }}
    >
      <Text {...eyebrowPhos}>
        Readout <MockStamp ml={SPACING.xs} />
      </Text>

      {/* throughput */}
      <Box display="grid" gap="3px">
        <Text {...eyebrow} letterSpacing="0.18em">
          Throughput
        </Text>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="19px"
          {...tabular}
          color={c.p.length === 0 ? SEMANTIC_COLORS.textPrimary : c.net >= 0 ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger}
        >
          {c.p.length === 0 && c.net === 0 ? '—' : (c.net >= 0 ? '+' : '') + usd(c.net)}
        </Text>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" color={SEMANTIC_COLORS.textTertiary}>
          {c.p.length
            ? 'venues pay ' + (c.apr * 100).toFixed(1) + '% on ' + usd(c.debt) + ', the loan costs ' + (BORROW * 100).toFixed(0) + '%'
            : 'no venues placed'}
        </Text>
      </Box>

      {/* loan to value */}
      <Box display="grid" gap="3px">
        <Text {...eyebrow} letterSpacing="0.18em">
          Loan to value
        </Text>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="19px" {...tabular} color={SEMANTIC_COLORS.textPrimary}>
          {(c.ltv * 100).toFixed(0)}%
        </Text>
        <Box h="5px" bg={TINTS.boneBar} position="relative">
          <Box position="absolute" top={0} bottom={0} left={0} w={Math.min(100, c.ltv * 100) + '%'} bg={ltvBarColor} />
          <Box position="absolute" top={0} bottom={0} left={MAX_BORROW * 100 + '%'} w={Math.max(0, (liqLine - MAX_BORROW) * 100) + '%'} bg={TINTS.bloodBand} />
          <Box position="absolute" top="-2px" bottom="-2px" w="1px" bg={SEMANTIC_COLORS.danger} left={MAX_BORROW * 100 + '%'} />
          <Box position="absolute" top="-2px" bottom="-2px" w="1px" bg={SEMANTIC_COLORS.danger} left={liqLine * 100 + '%'} />
        </Box>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" color={cut ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textTertiary}>
          borrow cap {(MAX_BORROW * 100).toFixed(0)}% · liquidated past {(liqLine * 100).toFixed(0)}%{cut ? ' (CUT)' : ''} · a breach
          repays you back to {(MAX_BORROW * 100).toFixed(0)}%
        </Text>
      </Box>

      {/* stress test */}
      <Box display="grid" gap="3px">
        <Text {...eyebrow} letterSpacing="0.18em">
          Stress test
        </Text>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="19px" {...tabular} color={SEMANTIC_COLORS.textPrimary}>
          {!c.p.length ? '—' : bp == null ? 'past −90%' : '−' + (bp * 100).toFixed(0) + '%'}
        </Text>
        <Box h="5px" bg={TINTS.boneBar} position="relative">
          <Box position="absolute" top={0} bottom={0} left={0} w={atRisk * 100 + '%'} bg={defBarColor} />
        </Box>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" color={SEMANTIC_COLORS.textTertiary}>
          {c.p.length
            ? bp == null
              ? 'no fall short of 90% costs you bitcoin — recall covers every breach'
              : 'how far bitcoin must fall before your venues stop covering you'
            : 'nothing placed yet'}
        </Text>
      </Box>

      {/* controls */}
      <Box display="grid" gap={SPACING.xs} borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} pt={SPACING.sm}>
        <Box display="flex" justifyContent="space-between" fontFamily={TYPOGRAPHY.fontMono} fontSize="11px">
          <Text as="span" color={SEMANTIC_COLORS.textSecondary}>
            Bitcoin in
          </Text>
          <Text as="span" color={SEMANTIC_COLORS.textPrimary} {...tabular}>
            {btc.toFixed(2)} BTC
          </Text>
        </Box>
        <Box
          as="input"
          type="range"
          min={0.25}
          max={5}
          step={0.05}
          value={btc}
          aria-label="Bitcoin collateral"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => onBtc(parseFloat(e.target.value))}
          sx={RANGE_SX}
        />
      </Box>
      <Box display="grid" gap={SPACING.xs} borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} pt={SPACING.sm}>
        <Box display="flex" justifyContent="space-between" fontFamily={TYPOGRAPHY.fontMono} fontSize="11px">
          <Text as="span" color={SEMANTIC_COLORS.textSecondary}>
            Draw
          </Text>
          <Text as="span" color={SEMANTIC_COLORS.textPrimary} {...tabular}>
            {(c.ltv * 100).toFixed(0)}% LTV
          </Text>
        </Box>
        <Box
          as="input"
          type="range"
          min={5}
          max={60}
          step={1}
          value={Math.round(c.ltv * 100)}
          aria-label="Draw as percent LTV"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => onLtv(parseFloat(e.target.value))}
          sx={RANGE_SX}
        />
      </Box>

      <Button
        onClick={onRun}
        isDisabled={bTestDisabled}
        bg={SEMANTIC_COLORS.warning}
        color={SEMANTIC_COLORS.bgPrimary}
        border="1px solid"
        borderColor={SEMANTIC_COLORS.warning}
        borderRadius={0}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="10.5px"
        letterSpacing="0.14em"
        textTransform="uppercase"
        h="auto"
        py={SPACING.md}
        transition={TRANSITIONS.colors}
        _hover={{ bg: SEMANTIC_COLORS.warning, opacity: 0.9 }}
        _active={{ opacity: 0.85 }}
        _focus={FOCUS_STYLES.ring}
        _disabled={{ opacity: 0.35, cursor: 'not-allowed', bg: 'transparent', color: SEMANTIC_COLORS.textTertiary, borderColor: SEMANTIC_COLORS.borderSubtle }}
      >
        {bTestLabel}
      </Button>
      <Button
        onClick={onClear}
        variant="outline"
        bg="transparent"
        color={SEMANTIC_COLORS.textPrimary}
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderStrong}
        borderRadius={0}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="10.5px"
        letterSpacing="0.14em"
        textTransform="uppercase"
        h="auto"
        py={SPACING.md}
        transition={TRANSITIONS.colors}
        _hover={{ borderColor: SEMANTIC_COLORS.success, color: SEMANTIC_COLORS.success, bg: 'transparent' }}
        _active={{ opacity: 0.85 }}
        _focus={FOCUS_STYLES.ring}
      >
        Clear
      </Button>
    </Box>
  )
}

export default Readout
