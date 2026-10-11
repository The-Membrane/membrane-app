import React, { useState } from 'react'
import { Box, Grid, Input, Select, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import {
  calculateCuratorCapPlan,
  formatAssetDisplayUnits,
  type CapProposalState,
  type CuratorCapPlanInput,
  type CuratorVaultAsset,
} from '@/lib/carry/curatorCapPlan'

type AmountKey =
  | 'currentVenueAssets'
  | 'currentCap'
  | 'proposedCap'
  | 'targetVenueAssets'
  | 'matchingWithdrawal'
  | 'daysUntilNeeded'
  | 'timelockDays'
  | 'pendingValidInDays'

const fields: { key: AmountKey; label: string }[] = [
  { key: 'currentVenueAssets', label: 'Current assets in target venue' },
  { key: 'currentCap', label: 'Current venue cap' },
  { key: 'proposedCap', label: 'Proposed venue cap' },
  { key: 'targetVenueAssets', label: 'Desired assets in target venue' },
  { key: 'matchingWithdrawal', label: 'Planned withdrawal from other venue' },
  { key: 'daysUntilNeeded', label: 'Days until rotation is needed' },
]

const initial: CuratorCapPlanInput = {
  asset: 'CDT',
  currentVenueAssets: '60000',
  currentCap: '100000',
  proposedCap: '150000',
  targetVenueAssets: '120000',
  matchingWithdrawal: '60000',
  daysUntilNeeded: '14',
  proposalState: 'not-submitted',
  timelockDays: '7',
  pendingValidInDays: '7',
}

const controlStyle = {
  bg: SEMANTIC_COLORS.bgTertiary,
  borderColor: SEMANTIC_COLORS.borderMedium,
  borderRadius: 0,
  color: SEMANTIC_COLORS.textPrimary,
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '16px',
  h: '44px',
  _focus: { borderColor: SEMANTIC_COLORS.borderStrong, boxShadow: 'none' },
  _focusVisible: { boxShadow: `0 0 0 2px ${SEMANTIC_COLORS.textPrimary}` },
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <Box minW={0}>
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.xs}
        color={SEMANTIC_COLORS.textSecondary}
      >
        {label}
      </Text>
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.small}
        color={SEMANTIC_COLORS.textPrimary}
        overflowWrap="anywhere"
        sx={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {value}
      </Text>
    </Box>
  )
}

/** A planning worksheet, never a live vault read or executable quote. */
export default function CuratorCapPlanner() {
  const [input, setInput] = useState(initial)
  const setField = (key: AmountKey, value: string) => setInput((old) => ({ ...old, [key]: value }))
  const result = calculateCuratorCapPlan(input)
  const applicableTimingField =
    input.proposalState === 'not-submitted' || input.proposalState === 'revoked'
      ? { key: 'timelockDays' as const, label: 'Assumed new-raise wait (whole days)' }
      : input.proposalState === 'pending'
        ? { key: 'pendingValidInDays' as const, label: 'Pending valid in (whole days)' }
        : null

  return (
    <Box
      as="section"
      aria-labelledby="curator-cap-planner-title"
      mt={SPACING.lg}
      p={{ base: SPACING.base, md: SPACING.lg }}
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      bg={SEMANTIC_COLORS.bgSecondary}
      minW={0}
    >
      <Text
        id="curator-cap-planner-title"
        fontFamily={TYPOGRAPHY.fontDisplay}
        fontSize={TYPOGRAPHY.h4}
        color={SEMANTIC_COLORS.textPrimary}
      >
        Plan a venue cap rotation
      </Text>
      <Text
        mt={SPACING.xs}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.xs}
        color={SEMANTIC_COLORS.textSecondary}
        maxW="72ch"
      >
        Hypothetical CuratorVault inputs only. CDT and USDC are supported worksheet examples, not
        verified vault identity. For “cap already set,” enter the same current and proposed cap.
      </Text>

      <Grid
        templateColumns={{
          base: '1fr',
          sm: 'repeat(2, minmax(0, 1fr))',
          xl: 'repeat(3, minmax(0, 1fr))',
        }}
        gap={SPACING.md}
        mt={SPACING.lg}
      >
        <Box minW={0}>
          <Text
            as="label"
            htmlFor="curator-cap-asset"
            display="block"
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textSecondary}
            mb={SPACING.sm}
          >
            Assumed vault deposit asset
          </Text>
          <Select
            id="curator-cap-asset"
            value={input.asset}
            onChange={(event) =>
              setInput((old) => ({ ...old, asset: event.target.value as CuratorVaultAsset }))
            }
            {...controlStyle}
          >
            <option value="CDT">CDT</option>
            <option value="USDC">USDC</option>
          </Select>
        </Box>
        {fields.map(({ key, label }) => (
          <Box key={key} minW={0}>
            <Text
              as="label"
              htmlFor={`curator-cap-${key}`}
              display="block"
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
              mb={SPACING.sm}
            >
              {label}
              {key === 'daysUntilNeeded' ? '' : ` (${input.asset})`}
            </Text>
            <Input
              id={`curator-cap-${key}`}
              type="text"
              inputMode={key === 'daysUntilNeeded' ? 'numeric' : 'decimal'}
              value={input[key]}
              onChange={(event) => setField(key, event.target.value)}
              {...controlStyle}
            />
          </Box>
        ))}
        <Box minW={0}>
          <Text
            as="label"
            htmlFor="curator-cap-proposal-state"
            display="block"
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textSecondary}
            mb={SPACING.sm}
          >
            Assumed cap action state
          </Text>
          <Select
            id="curator-cap-proposal-state"
            value={input.proposalState}
            onChange={(event) =>
              setInput((old) => ({ ...old, proposalState: event.target.value as CapProposalState }))
            }
            {...controlStyle}
          >
            <option value="not-submitted">Not submitted</option>
            <option value="pending">Pending raise</option>
            <option value="accepted">Cap already set / accepted</option>
            <option value="revoked">Raise revoked</option>
          </Select>
        </Box>
        {applicableTimingField && (
          <Box minW={0}>
            <Text
              as="label"
              htmlFor={`curator-cap-${applicableTimingField.key}`}
              display="block"
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
              mb={SPACING.sm}
            >
              {applicableTimingField.label}
            </Text>
            <Input
              id={`curator-cap-${applicableTimingField.key}`}
              type="text"
              inputMode="numeric"
              value={input[applicableTimingField.key]}
              onChange={(event) => setField(applicableTimingField.key, event.target.value)}
              {...controlStyle}
            />
          </Box>
        )}
      </Grid>

      {!result ? (
        <Text
          role="status"
          mt={SPACING.lg}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.danger}
        >
          Enter nonnegative selected-asset amounts up to 1 trillion with at most six decimal places,
          and a target above current assets. A new raise needs a 1–14 whole-day timelock assumption.
          Pending remaining time can be zero; an already-set cap must equal the current cap.
        </Text>
      ) : (
        <Box
          mt={SPACING.lg}
          borderTop="1px solid"
          borderColor={SEMANTIC_COLORS.borderMedium}
          pt={SPACING.base}
        >
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            fontWeight="bold"
            color={result.structuralReady ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.textPrimary}
          >
            {result.structuralReady
              ? 'Necessary structural checks pass'
              : 'Not structurally ready yet'}
          </Text>
          <Text
            mt={SPACING.xs}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textSecondary}
          >
            {input.proposalState === 'accepted'
              ? 'You marked this cap as already set. That state is an assumption, not a verified vault read.'
              : result.capStep === 'immediate'
                ? 'A lower or unchanged cap can be set immediately by the curator, but is not set by this worksheet.'
                : input.proposalState === 'revoked'
                  ? `The revoked raise has no pending acceptance. If resubmitted now, the assumed earliest eligible day is in ${result.earliestCapEligibleInDays} days; a new submission and later acceptance are still needed.`
                  : `A raise is time-eligible ${result.earliestCapEligibleInDays === 0 ? 'today' : `in ${result.earliestCapEligibleInDays} days`}, but it still needs a separate acceptance.`}
            {result.needsSubmission ? ' Submission is still needed.' : ''}
          </Text>
          <Grid
            templateColumns={{
              base: '1fr',
              sm: 'repeat(2, minmax(0, 1fr))',
              xl: 'repeat(4, minmax(0, 1fr))',
            }}
            gap={SPACING.base}
            mt={SPACING.base}
          >
            <Readout
              label="Supply toward target"
              value={formatAssetDisplayUnits(result.requiredSupply, input.asset)}
            />
            <Readout
              label="Target above proposed cap"
              value={formatAssetDisplayUnits(result.capShortfall, input.asset)}
            />
            <Readout
              label="Matching withdrawal still needed"
              value={formatAssetDisplayUnits(result.matchingWithdrawalShortfall, input.asset)}
            />
            <Readout
              label="Unmatched extra withdrawal"
              value={formatAssetDisplayUnits(result.excessWithdrawal, input.asset)}
            />
          </Grid>
          <Text
            mt={SPACING.base}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textSecondary}
            maxW="90ch"
          >
            Flow check: withdraw from the other venue → supply into the target venue → exact net
            zero. The contract clamps supply by cap headroom and idle assets; any unmatched
            withdrawal or supply shortfall can revert the rotation. Amounts use fixed six-place
            display arithmetic, not on-chain token units. Enter whole-day timing assumptions; round
            actual seconds up if known. submitCap requires the curator, reallocate requires an
            allocator, and acceptCap is permissionless after its exact validAt timestamp. This does
            not verify actors, balances, venue withdrawal liquidity, successful calls, or live cap
            state. Eligibility never accepts a pending cap automatically.
          </Text>
        </Box>
      )}
    </Box>
  )
}
