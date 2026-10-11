import React, { useState } from 'react'
import { Box, Grid, Input, Select, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { calculateCuratorScenario } from '@/lib/carry/curatorScenario'
import { describeRouteReading } from '@/lib/carry/liveRouteFreshness'

import CuratorScenarioDisco from './CuratorScenarioDisco'
import CuratorCapPlanner from './CuratorCapPlanner'

type RateReading = { borrowApy: number; yieldApy: number; observedAt: string }
type InventoryReading = {
  vaultCashGho: number
  totalAssetsGho: number
  withdrawalsPaused: boolean
  observedAt: string
}

type Props = {
  rateReading: RateReading | null
  inventoryReading: InventoryReading | null
  nowMs: number
}

const fmtGho = (value: number) =>
  `${value < 0 ? '−' : value > 0 ? '+' : ''}${
    value !== 0 && Math.abs(value) < 0.005
      ? '<0.01'
      : new Intl.NumberFormat('en-US', {
          maximumFractionDigits: 2,
        }).format(Math.abs(value))
  } GHO`
const fmtUnsignedGho = (value: number) =>
  `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)} GHO`
const fmtPp = (value: number) =>
  `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(2)} pp`
const sourceStamp = (observedAt: string, nowMs: number) => {
  const observedMs = Date.parse(observedAt)
  if (!Number.isFinite(observedMs) || observedMs > nowMs + 60_000) return 'Source time unavailable'
  const { ageSeconds, stale } = describeRouteReading(observedAt, nowMs)
  const age =
    ageSeconds < 3600
      ? `${Math.floor(ageSeconds / 60)}m`
      : ageSeconds < 86_400
        ? `${Math.floor(ageSeconds / 3600)}h`
        : `${Math.floor(ageSeconds / 86_400)}d`
  return `${stale ? 'Stale' : 'Measured'} ${new Date(observedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${age} ago`
}

const selectionStyle = {
  bg: SEMANTIC_COLORS.bgTertiary,
  borderColor: SEMANTIC_COLORS.borderStrong,
  borderRadius: 0,
  color: SEMANTIC_COLORS.textPrimary,
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '16px',
  h: '44px',
  _focus: { borderColor: SEMANTIC_COLORS.borderStrong, boxShadow: 'none' },
  _focusVisible: { boxShadow: `0 0 0 2px ${SEMANTIC_COLORS.textPrimary}` },
}

/** Measured inputs stay visible; every changed leg is a user-chosen hypothetical. */
export default function CuratorScenario({ rateReading, inventoryReading, nowMs }: Props) {
  const [principalInput, setPrincipalInput] = useState('10000')
  const [horizonInput, setHorizonInput] = useState('30')
  const [borrowRisePp, setBorrowRisePp] = useState(1)
  const [yieldFallPp, setYieldFallPp] = useState(1)
  const [cashDrawdownPct, setCashDrawdownPct] = useState(25)
  const principalText = principalInput.replaceAll(',', '').trim()
  const principalGho = /^\d+(?:\.\d+)?$/.test(principalText) ? Number(principalText) : NaN
  const validPrincipal = Number.isFinite(principalGho) && principalGho > 0 && principalGho <= 1e12
  const horizonText = horizonInput.trim()
  const horizonDays = /^\d+$/.test(horizonText) ? Number(horizonText) : NaN
  const validHorizon = Number.isInteger(horizonDays) && horizonDays >= 1 && horizonDays <= 365
  const validInventory =
    inventoryReading &&
    Number.isFinite(inventoryReading.vaultCashGho) &&
    inventoryReading.vaultCashGho >= 0 &&
    Number.isFinite(inventoryReading.totalAssetsGho) &&
    inventoryReading.totalAssetsGho >= 0 &&
    typeof inventoryReading.withdrawalsPaused === 'boolean'
      ? inventoryReading
      : null
  const result = rateReading
    ? calculateCuratorScenario({
        principalGho,
        horizonDays,
        borrowApy: rateReading.borrowApy,
        yieldApy: rateReading.yieldApy,
        borrowRisePp,
        yieldFallPp,
        cashDrawdownPct,
        ...(validInventory
          ? {
              vaultCashGho: validInventory.vaultCashGho,
              vaultAssetsGho: validInventory.totalAssetsGho,
              withdrawalsPaused: validInventory.withdrawalsPaused,
            }
          : {}),
      })
    : null

  return (
    <Box
      as="section"
      aria-labelledby="curator-scenario-title"
      borderTop="1px solid"
      borderColor={SEMANTIC_COLORS.borderStrong}
      pt={SPACING.lg}
      mb={SPACING.xl}
    >
      <Text
        id="curator-scenario-title"
        fontFamily={TYPOGRAPHY.fontDisplay}
        fontSize={TYPOGRAPHY.h3}
        color={SEMANTIC_COLORS.textPrimary}
      >
        Stress the carry before it moves
      </Text>
      <Text
        mt={SPACING.xs}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.xs}
        color={SEMANTIC_COLORS.textSecondary}
        maxW="70ch"
      >
        Curator what-if for Aave GHO into sGHO. Choose changes to rates and vault cash; these are
        assumptions, not predicted moves.
      </Text>

      <Grid
        templateColumns={{
          base: '1fr',
          sm: 'repeat(2, minmax(0, 1fr))',
          xl: 'repeat(5, minmax(0, 1fr))',
        }}
        gap={SPACING.md}
        mt={SPACING.lg}
      >
        <Box minW={0}>
          <Text
            as="label"
            htmlFor="curator-principal"
            display="block"
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textSecondary}
            mb={SPACING.sm}
          >
            GHO principal
          </Text>
          <Input
            id="curator-principal"
            type="text"
            inputMode="decimal"
            value={principalInput}
            onChange={(event) => setPrincipalInput(event.target.value)}
            aria-invalid={!validPrincipal}
            {...selectionStyle}
          />
        </Box>
        <Box minW={0}>
          <Text
            as="label"
            htmlFor="curator-horizon"
            display="block"
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textSecondary}
            mb={SPACING.sm}
          >
            Planning horizon (days)
          </Text>
          <Input
            id="curator-horizon"
            type="text"
            inputMode="numeric"
            value={horizonInput}
            onChange={(event) => setHorizonInput(event.target.value)}
            aria-invalid={!validHorizon}
            {...selectionStyle}
          />
        </Box>
        <Box minW={0}>
          <Text
            as="label"
            htmlFor="curator-borrow-shock"
            display="block"
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textSecondary}
            mb={SPACING.sm}
          >
            Borrow cost rises
          </Text>
          <Select
            id="curator-borrow-shock"
            value={borrowRisePp}
            onChange={(event) => setBorrowRisePp(Number(event.target.value))}
            {...selectionStyle}
          >
            {[0, 0.5, 1, 2].map((value) => (
              <option key={value} value={value}>
                +{value} pp
              </option>
            ))}
          </Select>
        </Box>
        <Box minW={0}>
          <Text
            as="label"
            htmlFor="curator-yield-shock"
            display="block"
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textSecondary}
            mb={SPACING.sm}
          >
            sGHO yield falls
          </Text>
          <Select
            id="curator-yield-shock"
            value={yieldFallPp}
            onChange={(event) => setYieldFallPp(Number(event.target.value))}
            {...selectionStyle}
          >
            {[0, 0.5, 1, 2].map((value) => (
              <option key={value} value={value}>
                −{value} pp
              </option>
            ))}
          </Select>
        </Box>
        <Box minW={0}>
          <Text
            as="label"
            htmlFor="curator-cash-shock"
            display="block"
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textSecondary}
            mb={SPACING.sm}
          >
            Vault cash falls
          </Text>
          <Select
            id="curator-cash-shock"
            value={cashDrawdownPct}
            onChange={(event) => setCashDrawdownPct(Number(event.target.value))}
            {...selectionStyle}
          >
            {[0, 25, 50, 75].map((value) => (
              <option key={value} value={value}>
                −{value}%
              </option>
            ))}
          </Select>
        </Box>
      </Grid>

      {!rateReading ? (
        <Text
          role="status"
          mt={SPACING.lg}
          color={SEMANTIC_COLORS.textSecondary}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
        >
          No measured rate legs yet. Scenario output is unavailable.
        </Text>
      ) : !result ? (
        <Text
          role="status"
          mt={SPACING.lg}
          color={SEMANTIC_COLORS.danger}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
        >
          Enter a positive GHO principal up to 1 trillion, a whole-day horizon from 1 to 365, and
          valid rate assumptions to run the what-if.
        </Text>
      ) : (
        <Grid
          templateColumns={{ base: '1fr', md: 'repeat(3, minmax(0, 1fr))' }}
          gap={SPACING.md}
          mt={SPACING.lg}
        >
          <Box
            border="1px solid"
            borderColor={SEMANTIC_COLORS.borderSubtle}
            p={SPACING.base}
            minW={0}
          >
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
            >
              At measured rates
            </Text>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.h4}
              color={SEMANTIC_COLORS.textPrimary}
              sx={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {fmtPp(result.currentSpreadPp)}
            </Text>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
            >
              {fmtGho(result.currentAnnualNetGho)} annualized on equal principal
            </Text>
            <Text
              mt={SPACING.sm}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textPrimary}
            >
              {fmtGho(result.currentHorizonNetGho)} over your {result.horizonDays}-day horizon
            </Text>
            <Text
              mt={SPACING.sm}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
            >
              Borrow {(rateReading.borrowApy * 100).toFixed(2)}% APY · trailing sGHO yield{' '}
              {(rateReading.yieldApy * 100).toFixed(2)}%
            </Text>
            <Text
              mt={SPACING.md}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
            >
              {sourceStamp(rateReading.observedAt, nowMs)}
            </Text>
          </Box>
          <Box
            border="1px solid"
            borderColor={SEMANTIC_COLORS.borderSubtle}
            p={SPACING.base}
            minW={0}
          >
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
            >
              With your rate changes
            </Text>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.h4}
              color={
                result.stressedSpreadPp < 0 ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textPrimary
              }
              sx={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {fmtPp(result.stressedSpreadPp)}
            </Text>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
            >
              {fmtGho(result.stressedAnnualNetGho)} annualized;{' '}
              {fmtGho(result.changeInAnnualNetGho)} vs measured rates
            </Text>
            <Text
              mt={SPACING.sm}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textPrimary}
            >
              {fmtGho(result.stressedHorizonNetGho)} over your {result.horizonDays}-day horizon;{' '}
              {fmtGho(result.changeInHorizonNetGho)} vs measured rates
            </Text>
            <Text
              mt={SPACING.md}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
            >
              {result.combinedShockRoomPp >= 0
                ? 'Combined rate-shock room before break-even: '
                : 'Already below break-even by: '}
              {fmtPp(Math.abs(result.combinedShockRoomPp))}
            </Text>
          </Box>
          <Box
            border="1px solid"
            borderColor={SEMANTIC_COLORS.borderSubtle}
            p={SPACING.base}
            minW={0}
          >
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
            >
              Vault-side cash check
            </Text>
            {result.inventory && validInventory ? (
              <>
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.h4}
                  color={SEMANTIC_COLORS.textPrimary}
                  sx={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {fmtUnsignedGho(result.inventory.stressedVaultSideGho)}
                </Text>
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.textSecondary}
                >
                  after assumed cash change; now{' '}
                  {fmtUnsignedGho(result.inventory.currentVaultSideGho)}
                </Text>
                <Text
                  mt={SPACING.sm}
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.textSecondary}
                >
                  {result.inventory.stressedShortfallGho > 0
                    ? `${fmtUnsignedGho(result.inventory.stressedShortfallGho)} below the entered size`
                    : 'Vault-side cash remains above the entered size'}
                </Text>
                {result.inventory.cashDrawdownRoomPct != null && (
                  <Text
                    mt={SPACING.sm}
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.xs}
                    color={SEMANTIC_COLORS.textSecondary}
                  >
                    Cash-only room before this size exceeds the vault-side bound:{' '}
                    {result.inventory.cashDrawdownRoomPct.toFixed(1)}%
                  </Text>
                )}
                <Text
                  mt={SPACING.md}
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.textSecondary}
                >
                  {sourceStamp(validInventory.observedAt, nowMs)}
                </Text>
              </>
            ) : (
              <Text
                mt={SPACING.sm}
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textSecondary}
              >
                No measured cash reading. Cash scenario is unavailable.
              </Text>
            )}
          </Box>
        </Grid>
      )}
      <Text
        mt={SPACING.md}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.xs}
        color={SEMANTIC_COLORS.textSecondary}
        maxW="90ch"
      >
        Horizon amounts are annualized net × days / 365 on equal GHO borrowed and held. They assume
        unchanged rates and principal, with no compounding, incentives, gas, or exit cost. They are
        not realized profit or a forecast. Vault cash is not a wallet maxRedeem, executable quote,
        or warning. Stale rate and cash readings retain separate ages.
      </Text>
      <CuratorCapPlanner />
      <CuratorScenarioDisco />
    </Box>
  )
}
