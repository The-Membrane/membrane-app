import React, { useEffect, useState } from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { NEWS, NEWS_FONT } from '@/components/NewsEdition/tokens'
import { useNow, useWeather } from '@/components/Weather/useWeather'

import { Masthead } from './Masthead'
import { Deck, Headline, Kicker } from './newsAtoms'
import { CAPS, DASH, LEAD_MIN_H, TARGET } from './newsStyle'
import { Opportunities } from './Opportunities'
import { BODY_ID, HOME_COPY, regimeHome, type HomeBody, type HomeJump } from './regimeHome'
import { Safety } from './Safety'
import { DAGGER_NOTE, METHOD_JUMP, regimeCredit, regimeRows } from './todayCopy'

// THE TODAY EDITION (/[chain]/today): the newspaper masthead with the weather strip, then
// the body the M0 regime gives the screen (components/Today/regimeHome.ts): Opportunities
// when calm, Safety when choppy or when no regime is known. Below it, two folds, each one
// jump line until opened (in place, or by its #id): the other body, then how the regime
// is set (#regime). Then the dagger note. The `.news-edition` root switches on the
// newspaper token layer (styles/news-edition.css).

const ROWS = regimeRows()
const CREDIT = regimeCredit()

/** How the regime is set: the M0 rule as label/value rows, with its provenance. */
function RegimeMethod() {
  return (
    <Box maxW="720px" pb={SPACING.sm}>
      <Box
        as="dl"
        display="grid"
        gridTemplateColumns={{
          base: 'minmax(0, 9rem) minmax(0, 1fr)',
          md: 'minmax(0, 12rem) minmax(0, 1fr)',
        }}
        borderTop={`1px solid ${NEWS.ruleStrong}`}
        fontFamily={NEWS_FONT.mono}
        sx={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {ROWS.map((r) => (
          <React.Fragment key={r.label}>
            <Box
              as="dt"
              py={SPACING.sm}
              borderBottom={`1px solid ${NEWS.rule}`}
              fontSize={TYPOGRAPHY.label}
              lineHeight="16px"
              color={NEWS.muted}
              sx={CAPS}
            >
              {r.label}
            </Box>
            <Box
              as="dd"
              py={SPACING.sm}
              pl={SPACING.base}
              borderBottom={`1px solid ${NEWS.rule}`}
              fontSize="13px"
              lineHeight="16px"
              color={NEWS.ink}
            >
              {r.value}
            </Box>
          </React.Fragment>
        ))}
      </Box>
      <Text
        as="p"
        textAlign="right"
        pt={SPACING.sm}
        fontFamily={NEWS_FONT.mono}
        fontSize={TYPOGRAPHY.label}
        lineHeight="16px"
        color={NEWS.muted}
        overflowWrap="anywhere"
      >
        {CREDIT}
      </Text>
    </Box>
  )
}

function Body({ which, kicker, nowMs, id }: { which: HomeBody; kicker: string; nowMs: number; id?: string }) {
  return which === 'safety' ? (
    <Safety kicker={kicker} nowMs={nowMs} id={id} />
  ) : (
    <Opportunities kicker={kicker} nowMs={nowMs} id={id} />
  )
}

/** While the weather loads no body owns the screen: the lead's space is reserved, with
 *  dashes, and nothing below it is drawn yet, so the arriving body moves nothing. */
function LeadSkeleton() {
  return (
    <Box minH={LEAD_MIN_H} pt={SPACING.lg} aria-hidden="true">
      <Kicker>{DASH}</Kicker>
      <Headline>{DASH}</Headline>
      <Deck>{DASH}</Deck>
    </Box>
  )
}

/**
 * A section folded to its one jump line (Redaction italic, 44px). It opens in place, or
 * when the URL's hash is its #id; its content is drawn only once open, so a folded body
 * fetches nothing.
 */
function Fold({
  id,
  summary,
  children,
}: {
  id: string
  summary: string
  children: () => React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const check = () => {
      if (window.location.hash === `#${id}`) setOpen(true)
    }
    check()
    window.addEventListener('hashchange', check)
    return () => window.removeEventListener('hashchange', check)
  }, [id])
  return (
    <Box
      as="details"
      id={id}
      data-news-section={id}
      open={open}
      onToggle={(e: React.SyntheticEvent<HTMLElement>) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      borderTop={`1px solid ${NEWS.ruleStrong}`}
    >
      <Box
        as="summary"
        display="flex"
        alignItems="center"
        minH={TARGET}
        cursor="pointer"
        fontFamily={TYPOGRAPHY.fontDisplay}
        fontStyle="italic"
        fontSize="13px"
        lineHeight="20px"
        color={NEWS.ink}
        transition={TRANSITIONS.colors}
        _hover={{ color: NEWS.accent }}
        sx={{ listStyle: 'none', '&::-webkit-details-marker': { display: 'none' } }}
      >
        {summary}
      </Box>
      {open && children()}
    </Box>
  )
}

/** The other body, folded to its jump line. */
function Jump({ jump, nowMs }: { jump: HomeJump; nowMs: number }) {
  return (
    <Box mt={SPACING.base}>
      <Fold id={BODY_ID[jump.body]} summary={jump.text}>
        {() => <Body which={jump.body} kicker={HOME_COPY.name[jump.body]} nowMs={nowMs} />}
      </Fold>
    </Box>
  )
}

function RegimeHomeBody() {
  const now = useNow(15_000)
  const q = useWeather()
  // Before the clock mounts, judge ages at the server's read time (as the strip does).
  const nowMs = now ?? q.data?.now ?? 0
  const home = regimeHome({ status: q.status, data: q.data, nowMs })
  return (
    <Box data-home-state={home.state} data-home-owner={home.owner ?? 'none'} aria-busy={home.owner === null}>
      {home.owner === null || home.kicker === null || home.jump === null ? (
        <Box minH="100vh">
          <LeadSkeleton />
        </Box>
      ) : (
        <>
          <Body which={home.owner} kicker={home.kicker} nowMs={nowMs} id={BODY_ID[home.owner]} />
          <Jump jump={home.jump} nowMs={nowMs} />
        </>
      )}
    </Box>
  )
}

export function TodayEdition() {
  return (
    <Box
      className="news-edition"
      minH="100vh"
      px={{ base: SPACING.base, md: SPACING.lg, lg: SPACING.xl }}
    >
      <Box maxW="1200px" mx="auto" pb={SPACING['2xl']}>
        <Masthead />
        <RegimeHomeBody />
        <Fold id="regime" summary={METHOD_JUMP}>
          {() => <RegimeMethod />}
        </Fold>
        <Text
          as="p"
          pt={SPACING.lg}
          fontFamily={NEWS_FONT.mono}
          fontSize={TYPOGRAPHY.label}
          lineHeight="16px"
          color={NEWS.muted}
          sx={CAPS}
        >
          {DAGGER_NOTE}
        </Text>
      </Box>
    </Box>
  )
}

export default TodayEdition
