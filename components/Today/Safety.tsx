import React, { memo, useId, useState, useSyncExternalStore, type FormEvent } from 'react'
import { Box, Flex, Grid, Input, Text, VisuallyHidden } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { NEWS, NEWS_FONT } from '@/components/NewsEdition/tokens'
import { CuratorFeedCard } from '@/components/CuratorFeed/CuratorFeed'
import { RadarReport } from '@/components/Radar/Radar'
import { useChainRoute } from '@/hooks/useChainRoute'
import useWallet from '@/hooks/useWallet'

import { ActionButton, ActionLink, Credit, Deck, Figure, Headline, Kicker, Module, Withheld } from './newsAtoms'
import { CAPS, DASH, HATCH, LEAD_MIN_H, RAISED_BUTTON, TABULAR, TARGET } from './newsStyle'
import {
  alarmsView,
  pressRadar,
  RADAR_CLOSED,
  radarActionLabel,
  radarHref,
  SAFETY_COPY,
  shortAddr,
  type AlarmRowView,
  type RadarPanel,
} from './safetyView'
import { useRecorderSummaries, useVenueAlarms } from './useTodayData'
import { CURATORS_EXAMPLE_ADDRESS } from './curatorsView'
import { YourCurators } from './YourCurators'

// THE SAFETY BODY (choppy, or no regime): your position first (paste an address, or use
// the connected wallet, and Radar reads it, opened in place under the lead), then the
// open venue alarms, then your curators this week (YourCurators, curatorsView.ts), then
// curator exits. No position number is invented. Words and figures come from
// safetyView.ts. No freeze-vote module: there is no live source.

const noSubscribe = () => () => {}
const onClient = () => true
const onServer = () => false

/** Your position: the gesture that personalises Safety. The button opens the Radar in
 *  place (RadarInline); the panel's state lives in Safety, which draws it full width. */
function PositionLead({
  kicker,
  panel,
  onPanel,
  panelId,
}: {
  kicker: string
  panel: RadarPanel
  onPanel: (p: RadarPanel) => void
  panelId: string
}) {
  const { address } = useWallet()
  // wagmi reconnects after mount; the wallet link's slot is reserved either way.
  const mounted = useSyncExternalStore(noSubscribe, onClient, onServer)
  const [value, setValue] = useState('')
  const [invalid, setInvalid] = useState(false)
  const errorId = useId()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const next = pressRadar(panel, value)
    if (next === 'invalid') {
      setInvalid(true)
      return
    }
    onPanel(next)
  }
  const useConnected = () => {
    if (!address) return
    setValue(address)
    setInvalid(false)
    onPanel({ open: true, address })
  }

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
        {/* Ink-2, the page's brown, raised (owner, Q27 round 3: "too green … try one of
            our browns"); its width fits the longer label, so toggling moves nothing. */}
        <Box
          as="button"
          type="submit"
          aria-expanded={panel.open}
          aria-controls={panelId}
          minW="calc(16ch + 32px)"
          px={SPACING.base}
          transition={TRANSITIONS.colors}
          {...RAISED_BUTTON}
        >
          {radarActionLabel(panel, value)}
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
        {mounted && address && (
          <ActionButton onClick={useConnected} expanded={panel.open} controls={panelId}>
            {SAFETY_COPY.useWallet} {shortAddr(address)} ↓
          </ActionButton>
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
        <Credit>
          <VisuallyHidden>fired </VisuallyHidden>
          {r.fired}
        </Credit>
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

/** The Radar, opened in place: the same report the Radar page prints for the address,
 *  and a quiet link to the full page (share line, image, watches). Mounted only while
 *  open, so the scan runs only on expand. */
function RadarInline({ address }: { address: string }) {
  const { chainName } = useChainRoute()
  const href = radarHref(chainName, address)
  return (
    <Module label={SAFETY_COPY.radarKicker}>
      <Flex justify="space-between" align="center" columnGap={SPACING.base} wrap="wrap">
        <Kicker>{SAFETY_COPY.radarKicker}</Kicker>
        <Credit>{shortAddr(address)}</Credit>
      </Flex>
      <RadarReport address={address} inline />
      {href && (
        <Flex justify="flex-end" pt={SPACING.sm}>
          <ActionLink href={href}>{SAFETY_COPY.fullRadar}</ActionLink>
        </Flex>
      )}
    </Module>
  )
}

export const Safety = memo(function Safety({ kicker, nowMs, id }: SafetyProps) {
  const [panel, setPanel] = useState<RadarPanel>(RADAR_CLOSED)
  const panelId = useId()
  return (
    <Box as="section" id={id} aria-labelledby="safety-head" data-news-section="safety" data-body="safety">
      <Grid
        templateColumns={{ base: 'minmax(0, 1fr)', lg: 'minmax(0, 5fr) minmax(0, 7fr)' }}
        columnGap={SPACING.xl}
      >
        <PositionLead kicker={kicker} panel={panel} onPanel={setPanel} panelId={panelId} />
        <Box
          pt={{ base: 0, lg: SPACING.lg }}
          pl={{ base: 0, lg: SPACING.xl }}
          borderLeft={{ base: 'none', lg: `1px solid ${NEWS.rule}` }}
          minW={0}
          order={{ base: 2, lg: 0 }}
        >
          <Alarms nowMs={nowMs} />
        </Box>
        {/* Full width under the lead and alarms; on a phone, straight under the lead. */}
        <Box
          id={panelId}
          gridColumn="1 / -1"
          order={{ base: 1, lg: 3 }}
          minW={0}
          data-module="radar"
          data-module-state={panel.open ? 'open' : 'closed'}
        >
          {panel.open && panel.address && <RadarInline address={panel.address} />}
        </Box>
      </Grid>
      {/* Your curators this week: the address last entered (open or hidden Radar), else a
          typical holder's (CURATORS_EXAMPLE_ADDRESS), marked "not yours" (demo-first).
          Prints nothing for an address that holds no curated vault. */}
      <YourCurators address={panel.address ?? CURATORS_EXAMPLE_ADDRESS} example={!panel.address} nowMs={nowMs} />
      {/* The card draws its own rule and label ("Curator actions") and owns its states. */}
      <Box pt={SPACING.base} pb={SPACING.sm}>
        <CuratorFeedCard />
      </Box>
    </Box>
  )
})

export default Safety
