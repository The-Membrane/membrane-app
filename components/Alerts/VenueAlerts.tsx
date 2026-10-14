// Where "Alert me at" mounts today:
//   VenueAlerts    — the venue page: one control for utilization, one for supply APR,
//                    beside the page's "next" links, with ONE shared address input
//                    (the venue page has no address of its own; never invented).
//   VenueCardAlert — Radar: one folded control per held venue card, keyed to the
//                    address the user pasted. Utilization where the venue records it,
//                    else supply APR where the net-APY registry reads it, else none.
// Both hide entirely while alert storage is unavailable, and show a control only
// where a live value source exists for that venue (DESIGN_RULES §4: no live source →
// omit the element).

import React, { useId, useState } from 'react'
import { Box, Grid, Input, Text } from '@chakra-ui/react'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { ADDRESS_RE, venueSubject } from '@/lib/userAlerts/metrics'

import { AlertMeAt } from './AlertMeAt'
import { useAlertsStatus } from './useAlertsStatus'
import { useVenueAlertValues } from './useVenueAlertValues'

const LABEL = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.label,
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
  color: SEMANTIC_COLORS.textSecondary,
} as const

/** One address input for every control in the block; an invalid entry says so. */
const SharedAddress: React.FC<{ value: string; onChange: (v: string) => void; invalid: boolean }> = ({ value, onChange, invalid }) => {
  const uid = useId()
  return (
    <>
      <Text as="label" htmlFor={`${uid}-addr`} {...LABEL} display="block">
        alert me · your address
      </Text>
      <Input
        id={`${uid}-addr`}
        mt={SPACING.xs}
        h="44px"
        px={SPACING.md}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0x…"
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.small}
        textAlign="left"
        color={SEMANTIC_COLORS.textPrimary}
        bg={SEMANTIC_COLORS.bgSecondary}
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderMedium}
        borderRadius={0}
        _focus={FOCUS_STYLES.ring}
        _focusVisible={FOCUS_STYLES.ring}
        spellCheck={false}
        autoComplete="off"
        isInvalid={invalid}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${uid}-addr-e` : undefined}
      />
      {invalid && (
        <Text id={`${uid}-addr-e`} fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.label} color={SEMANTIC_COLORS.danger} mt={SPACING.xs}>
          ✖ Enter a 0x address.
        </Text>
      )}
    </>
  )
}

export const VenueAlerts: React.FC<{ venue: string }> = ({ venue }) => {
  const status = useAlertsStatus()
  const storage = !!status.data?.storage
  const v = useVenueAlertValues(venue, storage)
  const [address, setAddress] = useState('')

  if (!storage || !v.settled || (v.utilization === null && !v.aprCovered)) return null

  const trimmed = address.trim()
  const owner = ADDRESS_RE.test(trimmed) ? trimmed : null
  const both = v.utilization !== null && v.aprCovered
  const subject = venueSubject(venue)

  return (
    <Card variant="default" p={SPACING.base} mt={SPACING.lg} data-testid="venue-alerts">
      <SharedAddress value={address} onChange={setAddress} invalid={trimmed.length > 0 && owner === null} />
      <Grid templateColumns={{ base: '1fr', lg: both ? '1fr 1fr' : '1fr' }} columnGap={SPACING.lg}>
        {v.utilization && (
          <Box minW={0}>
            <AlertMeAt
              metric="utilization"
              subject={subject}
              currentValue={v.utilization.value}
              asOf={v.utilization.asOf}
              stale={v.utilization.stale}
              ownerAddress={owner}
              askAddress={false}
            />
          </Box>
        )}
        {v.aprCovered && (
          <Box minW={0}>
            <AlertMeAt
              metric="apr"
              subject={subject}
              currentValue={v.apr?.value ?? null}
              asOf={v.apr?.asOf ?? null}
              stale={v.apr?.stale ?? false}
              ownerAddress={owner}
              askAddress={false}
            />
          </Box>
        )}
      </Grid>
    </Card>
  )
}

export const VenueCardAlert: React.FC<{ venue: string; address: string }> = ({ venue, address }) => {
  const status = useAlertsStatus()
  const storage = !!status.data?.storage
  const v = useVenueAlertValues(venue, storage)
  if (!storage || !v.settled) return null
  const subject = venueSubject(venue)
  if (v.utilization) {
    return (
      <AlertMeAt
        metric="utilization"
        subject={subject}
        currentValue={v.utilization.value}
        asOf={v.utilization.asOf}
        stale={v.utilization.stale}
        ownerAddress={address}
        collapsible
      />
    )
  }
  if (v.aprCovered) {
    return (
      <AlertMeAt
        metric="apr"
        subject={subject}
        currentValue={v.apr?.value ?? null}
        asOf={v.apr?.asOf ?? null}
        stale={v.apr?.stale ?? false}
        ownerAddress={address}
        collapsible
      />
    )
  }
  return null
}
