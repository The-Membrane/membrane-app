import React, { memo, useId, useState, useSyncExternalStore, type FormEvent } from 'react'
import { useRouter } from 'next/router'
import { Box, Flex, Grid, Input, Text } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { NEWS, NEWS_FONT } from '@/components/NewsEdition/tokens'
import { CuratorFeedCard } from '@/components/CuratorFeed/CuratorFeed'
import { useChainRoute } from '@/hooks/useChainRoute'
import useWallet from '@/hooks/useWallet'

import { ActionLink, Credit, Deck, Figure, Headline, Kicker, Module, Withheld } from './newsAtoms'
import { CAPS, DASH, HATCH, LEAD_MIN_H, TABULAR, TARGET } from './newsStyle'
import { alarmsView, radarHref, SAFETY_COPY, shortAddr, type AlarmRowView } from './safetyView'
import { useRecorderSummaries, useVenueAlarms } from './useTodayData'

// THE SAFETY BODY (choppy, or no regime): your position first (paste an address, or use
// the connected wallet, and Radar reads it), then the open venue alarms, then curator
// exits. Nothing personal is printed here and no position number is invented. Words and
// figures come from safetyView.ts. No freeze-vote module: there is no live source.

const noSubscribe = () => () => {}
const onClient = () => true
const onServer = () => false

/** Your position: the gesture that personalises Safety. */
function PositionLead({ kicker }: { kicker: string }) {
  const router = useRouter()
  const { chainName } = useChainRoute()
  const { address } = useWallet()
  // wagmi reconnects after mount; the wallet link's slot is reserved either way.
  const mounted = useSyncExternalStore(noSubscribe, onClient, onServer)
  const [value, setValue] = useState('')
  const [invalid, setInvalid] = useState(false)
  const errorId = useId()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const href = radarHref(chainName, value)
    if (!href) {
      setInvalid(true)
      return
    }
    router.push(href)
  }
  const walletHref = mounted && address ? radarHref(chainName, address) : null

  return (
    <Box minH={LEAD_MIN_H} pt={SPACING.lg} pb={SPACING.sm} data-module="position">
      <Kicker>{kicker}</Kicker>
      <Headline id="safety-head">{SAFETY_COPY.headline}</Headline>
      <Deck>{SAFETY_COPY.deck}</Deck>
      <Flex as="form" onSubmit={submit} pt={SPACING.md} columnGap={SPACING.sm} rowGap={SPACING.sm} wrap="wrap" noValidate>
        <Input
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            if (invalid) setInvalid(false)
          }}
          placeholder={SAFETY_COPY.placeholder}
          aria-label={SAFETY_COPY.inputLabel}
          aria-invalid={invalid}
          aria-describedby={invalid ? errorId : undefined}
          spellCheck={false}
          autoComplete="off"
          flex="1 1 160px"
          minW={0}
          textAlign="left"
          h={TARGET}
          px={SPACING.sm}
          borderRadius={0}
          bg="transparent"
          border="none"
          borderBottom={`1px solid ${invalid ? NEWS.danger : NEWS.ruleStrong}`}
          fontFamily={NEWS_FONT.mono}
          fontSize="13px"
          color={NEWS.ink}
          _placeholder={{ color: NEWS.muted }}
          _hover={{ borderBottomColor: NEWS.ink }}
          _focusVisible={{ borderBottomColor: NEWS.ink, boxShadow: 'none' }}
          transition={TRANSITIONS.colors}
          sx={TABULAR}
        />
        <Box
          as="button"
          type="submit"
          minH={TARGET}
          px={SPACING.base}
          fontFamily={NEWS_FONT.mono}
          fontSize="13px"
          fontWeight={TYPOGRAPHY.bold}
          color={NEWS.onCta}
          bg={NEWS.cta}
          borderRadius={0}
          transition={TRANSITIONS.colors}
          _hover={{ bg: NEWS.ink, color: NEWS.paper }}
          whiteSpace="nowrap"
        >
          {SAFETY_COPY.action}
        </Box>
      </Flex>
      <Flex minH={TARGET} align="center" justify="space-between" columnGap={SPACING.base} wrap="wrap">
        <Text
          id={errorId}
          role={invalid ? 'alert' : undefined}
          fontFamily={NEWS_FONT.mono}
          fontSize={TYPOGRAPHY.label}
          lineHeight="16px"
          color={NEWS.danger}
        >
          {invalid && (
            <>
              <Box as="span" aria-hidden="true" mr="0.3em">
                ✖
              </Box>
              {SAFETY_COPY.invalid}
            </>
          )}
        </Text>
        {walletHref && address && (
          <ActionLink href={walletHref}>
            {SAFETY_COPY.useWallet} {shortAddr(address)} →
          </ActionLink>
        )}
      </Flex>
    </Box>
  )
}

function AlarmRow({ r }: { r: AlarmRowView }) {
  const f = r.finding
  return (
    <Box as="li" listStyleType="none" borderBottom={`1px solid ${NEWS.rule}`} py={SPACING.xs}>
      <Flex justify="space-between" align="center" columnGap={SPACING.sm} wrap="wrap">
        <Flex align="center" columnGap={SPACING.sm}>
          <Text as="span" fontFamily={NEWS_FONT.mono} fontSize={TYPOGRAPHY.label} fontWeight={TYPOGRAPHY.bold} color={NEWS.ink} sx={CAPS}>
            {r.severity}
          </Text>
          <ActionLink href={r.href}>{r.label} →</ActionLink>
        </Flex>
        <Credit>{r.fired}</Credit>
      </Flex>
      <Text fontFamily={NEWS_FONT.mono} fontSize="13px" lineHeight="20px" color={NEWS.ink} sx={TABULAR}>
        {f.lead}{' '}
        {f.figure && (
          <Figure loss={f.loss} face="text">
            {f.figure}
          </Figure>
        )}{' '}
        {f.tail}
      </Text>
    </Box>
  )
}

function Alarms({ nowMs }: { nowMs: number }) {
  const { chainName } = useChainRoute()
  const alarms = useVenueAlarms()
  const summaries = useRecorderSummaries()
  const v = alarmsView({ alarms, summaries: summaries.map((s) => s.load), chain: chainName, nowMs })
  return (
    <Module label="Venue alarms" hatched={v.hatched}>
      <Kicker>{SAFETY_COPY.alarmsKicker}</Kicker>
      <Box data-module="alarms" data-module-state={v.state}>
        {v.withheld ? (
          <Withheld slot={false}>{v.withheld}</Withheld>
        ) : (
          <Headline slot={false}>{v.headline ?? DASH}</Headline>
        )}
        <Box minH="16px" pt={SPACING.xs}>
          <Credit align="left">{v.asOf ?? ''}</Credit>
        </Box>
      </Box>
      {v.rows.length > 0 && (
        <Box as="ul" pt={SPACING.sm} bgImage={v.hatched ? HATCH : undefined}>
          {v.rows.map((r) => (
            <AlarmRow key={r.key} r={r} />
          ))}
        </Box>
      )}
    </Module>
  )
}

export interface SafetyProps {
  /** The kicker over the lead (regimeHome: "Safety" or "Safety, by default"). */
  kicker: string
  nowMs: number
  /** The anchor id, when this body is the page's section (not inside the jump). */
  id?: string
}

export const Safety = memo(function Safety({ kicker, nowMs, id }: SafetyProps) {
  return (
    <Box as="section" id={id} aria-labelledby="safety-head" data-news-section="safety" data-body="safety">
      <Grid
        templateColumns={{ base: 'minmax(0, 1fr)', lg: 'minmax(0, 5fr) minmax(0, 7fr)' }}
        columnGap={SPACING.xl}
      >
        <PositionLead kicker={kicker} />
        <Box
          pt={{ base: 0, lg: SPACING.lg }}
          pl={{ base: 0, lg: SPACING.xl }}
          borderLeft={{ base: 'none', lg: `1px solid ${NEWS.rule}` }}
          minW={0}
        >
          <Alarms nowMs={nowMs} />
        </Box>
      </Grid>
      {/* The card carries its own kicker ("Curator actions") and its own states. */}
      <Module label={SAFETY_COPY.curatorLabel}>
        <CuratorFeedCard />
      </Module>
    </Box>
  )
})

export default Safety
