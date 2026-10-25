// MANUAL POSITION. For the reader who will not paste a wallet: collateral, debt and the
// venue's line. The venue's own parameters fill the rest (lib/landing/manualPosition.ts).

import React, { useEffect, useMemo, useState } from 'react'
import { Box, Button, FormControl, FormLabel, Input, Select, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { pct } from '@/components/Simulator/format'
import {
  MANUAL_COLLATERAL,
  MANUAL_ERROR_TEXT,
  aaveLine,
  morphoLltvs,
  validateManual,
  type ManualCollateral,
  type ManualError,
  type ManualInput,
  type ManualVenue,
  type ProtocolsDoc,
} from '@/lib/landing/manualPosition'

import { CAPS, small, tabularNums } from './styles'

const LABEL = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.label,
  textTransform: 'uppercase' as const,
  letterSpacing: CAPS,
  color: SEMANTIC_COLORS.textSecondary,
  mb: SPACING.xs,
}

const FIELD = {
  borderRadius: 0,
  border: '1px solid',
  borderColor: SEMANTIC_COLORS.borderSubtle,
  bg: SEMANTIC_COLORS.bgSecondary,
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '13px',
  minH: '44px',
  transition: TRANSITIONS.colors,
  _focus: FOCUS_STYLES.ring,
  _hover: { borderColor: SEMANTIC_COLORS.borderStrong },
}

export interface ManualPositionFormProps {
  protocols: ProtocolsDoc | null
  initial: ManualInput | null
  onSubmit: (m: ManualInput) => void
  /** An error the replay itself raised (e.g. no price at the scenario start). */
  error: ManualError | null
}

export const ManualPositionForm: React.FC<ManualPositionFormProps> = ({ protocols, initial, onSubmit, error }) => {
  const [venue, setVenue] = useState<ManualVenue>(initial?.venue ?? 'aave-v3')
  const [collateral, setCollateral] = useState<ManualCollateral>(initial?.collateral ?? 'WETH')
  const [collUsd, setCollUsd] = useState(initial ? String(initial.collateralUsd) : '')
  const [debtUsd, setDebtUsd] = useState(initial ? String(initial.debtUsd) : '')
  const [linePct, setLinePct] = useState(initial ? (initial.liquidationLtv * 100).toFixed(1) : '')

  const lltvs = useMemo(() => morphoLltvs(protocols, collateral), [protocols, collateral])
  const aave = useMemo(() => aaveLine(protocols, collateral), [protocols, collateral])

  // The venue's own line fills the field whenever the venue or asset changes.
  useEffect(() => {
    if (initial && initial.venue === venue && initial.collateral === collateral) return
    if (venue === 'aave-v3' && aave !== null) setLinePct((aave * 100).toFixed(1))
    if (venue === 'morpho-blue' && lltvs.length) setLinePct((lltvs[lltvs.length - 1] * 100).toFixed(1))
  }, [venue, collateral, aave, lltvs, initial])

  const parsed: ManualInput = {
    venue,
    collateral,
    collateralUsd: Number(collUsd.replace(/[$,\s]/g, '')),
    debtUsd: Number(debtUsd.replace(/[$,\s]/g, '')),
    liquidationLtv: Number(linePct) / 100,
  }
  const touched = collUsd !== '' && debtUsd !== ''
  const localError = touched ? validateManual(parsed) : null
  const shownError = localError ?? error
  const ltvNow = parsed.collateralUsd > 0 && parsed.debtUsd > 0 ? parsed.debtUsd / parsed.collateralUsd : null

  return (
    <Box
      as="form"
      data-testid="manual-form"
      display="grid"
      gap={SPACING.md}
      gridTemplateColumns={{ base: 'minmax(0, 1fr)', md: 'repeat(5, minmax(0, 1fr))' }}
      alignItems="end"
      onSubmit={(e: React.FormEvent) => {
        e.preventDefault()
        if (!validateManual(parsed)) onSubmit(parsed)
      }}
    >
      <FormControl>
        <FormLabel {...LABEL} htmlFor="manual-venue">Venue</FormLabel>
        <Select id="manual-venue" {...FIELD} value={venue} onChange={(e) => setVenue(e.target.value as ManualVenue)}>
          <option value="aave-v3">Aave V3</option>
          <option value="morpho-blue">Morpho Blue</option>
        </Select>
      </FormControl>
      <FormControl>
        <FormLabel {...LABEL} htmlFor="manual-collateral">Collateral</FormLabel>
        <Select id="manual-collateral" {...FIELD} value={collateral} onChange={(e) => setCollateral(e.target.value as ManualCollateral)}>
          {MANUAL_COLLATERAL.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </FormControl>
      <FormControl isInvalid={shownError === 'collateral'}>
        <FormLabel {...LABEL} htmlFor="manual-coll-usd">Collateral, $</FormLabel>
        <Input id="manual-coll-usd" {...FIELD} inputMode="decimal" value={collUsd} onChange={(e) => setCollUsd(e.target.value)} />
      </FormControl>
      <FormControl isInvalid={shownError === 'debt' || shownError === 'underwater'}>
        <FormLabel {...LABEL} htmlFor="manual-debt-usd">Debt (USDC), $</FormLabel>
        <Input id="manual-debt-usd" {...FIELD} inputMode="decimal" value={debtUsd} onChange={(e) => setDebtUsd(e.target.value)} />
      </FormControl>
      <FormControl isInvalid={shownError === 'line'}>
        <FormLabel {...LABEL} htmlFor="manual-line">Liquidation LTV, %</FormLabel>
        {venue === 'morpho-blue' && lltvs.length > 0 ? (
          <Select id="manual-line" {...FIELD} value={linePct} onChange={(e) => setLinePct(e.target.value)}>
            {lltvs.map((l) => (
              <option key={l} value={(l * 100).toFixed(1)}>
                {(l * 100).toFixed(1)}
              </option>
            ))}
          </Select>
        ) : (
          <Input id="manual-line" {...FIELD} inputMode="decimal" value={linePct} onChange={(e) => setLinePct(e.target.value)} />
        )}
      </FormControl>
      <Box gridColumn="1 / -1" display="flex" flexWrap="wrap" gap={SPACING.md} alignItems="center">
        <Button
          type="submit"
          data-testid="manual-submit"
          minH="44px"
          borderRadius={0}
          border="1px solid"
          borderColor={SEMANTIC_COLORS.textPrimary}
          bg="transparent"
          color={SEMANTIC_COLORS.textPrimary}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="12px"
          letterSpacing={CAPS}
          textTransform="uppercase"
          transition={TRANSITIONS.colors}
          _hover={{ borderColor: SEMANTIC_COLORS.success, color: SEMANTIC_COLORS.success }}
          _focus={FOCUS_STYLES.ring}
        >
          Replay this position
        </Button>
        {ltvNow !== null && (
          <Text {...small} {...tabularNums}>
            LTV now {pct(ltvNow)}
            {venue === 'aave-v3' && aave !== null ? ` · Aave V3 ${collateral} line ${pct(aave)} (read on-chain)` : ''}
            {venue === 'morpho-blue' ? ' · Morpho LLTVs from live markets for this collateral' : ''}
          </Text>
        )}
        {shownError && (
          <Text {...small} color={SEMANTIC_COLORS.danger} role="alert">
            ✖ {MANUAL_ERROR_TEXT[shownError]}
          </Text>
        )}
      </Box>
    </Box>
  )
}

export default ManualPositionForm
