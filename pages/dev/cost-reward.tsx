// DEV ONLY — design candidates for the cost-vs-reward tracker (board Q34), side by side.
// History is real: archive reads of one captured position's legs
// (components/PositionV0/dev/costRewardFixture.json, from
// scripts/position/capture-slip-fixtures.ts --rates). The forward segment is "model
// pending" until Q33's rate model passes: its region and extent only; on the spread charts
// (B, C) its first 7 days show the untested baseline, model-only (costRewardBaseline.json,
// --baseline: 12 months of the same reads). 404 in production;
// not linked.
//
//   /dev/cost-reward               A, B and C side by side
//   /dev/cost-reward?variant=B     one variant at full width

import React from 'react'
import Head from 'next/head'
import NextLink from 'next/link'
import { useRouter } from 'next/router'
import { Box } from '@chakra-ui/react'
import type { GetServerSideProps } from 'next'

import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES } from '@/config/transitions'
import { NEWS } from '@/components/NewsEdition/tokens'
import {
  CostRewardVariant,
  VARIANTS,
  type VariantKey,
} from '@/components/PositionV0/dev/CostRewardVariants'
import raw from '@/components/PositionV0/dev/costRewardFixture.json'
import rawBaseline from '@/components/PositionV0/dev/costRewardBaseline.json'
import { Headline, Kicker, Mono, Small } from '@/components/PositionV0/primitives'
import { baselineFan } from '@/lib/position/baselineFan'
import { baselineSpreadSeries, costRewardTrack, sourceStamps, type BaselineFixture, type RateFixture } from '@/lib/position/costReward'

export const getServerSideProps: GetServerSideProps = async () =>
  process.env.NODE_ENV === 'production' ? { notFound: true } : { props: {} }

const FX = raw as RateFixture
const TRACK = costRewardTrack(FX)
const BASELINE = rawBaseline as BaselineFixture
// The spread's untested baseline (model-only): today's spread, moved by the real 1–7-day moves
// of the same spread over the 12 months of archive reads ending at the fixture block.
const FAN = baselineFan(baselineSpreadSeries(FX, BASELINE), TRACK.points[TRACK.points.length - 1].spread, TRACK.to, 'diff')

const LinkBox: React.FC<{ href: string; active?: boolean; children: React.ReactNode }> = ({ href, active, children }) => (
  <NextLink href={href} passHref legacyBehavior>
    <Box
      as="a"
      display="inline-flex"
      alignItems="center"
      minH="44px"
      px={SPACING.sm}
      border={`1px solid ${active ? NEWS.ink : NEWS.rule}`}
      color={NEWS.ink}
      _focusVisible={FOCUS_STYLES.ring}
    >
      <Mono as="span" fontWeight={active ? 700 : 400}>
        {children}
      </Mono>
    </Box>
  </NextLink>
)

export default function CostReward() {
  const router = useRouter()
  const v = typeof router.query.variant === 'string' ? router.query.variant.toUpperCase() : null
  const one = VARIANTS.find((x) => x.key === v) ?? null
  const shown = one ? [one] : VARIANTS
  return (
    <Box className="news-edition" minH="100vh">
      <Head>
        <title>Cost vs reward · design candidates</title>
        <meta name="robots" content="noindex,nofollow" />
      </Head>
      <Box
        maxW={one ? '1100px' : '1400px'}
        mx="auto"
        px={{ base: SPACING.base, md: SPACING.lg }}
        py={SPACING.lg}
        display="grid"
        gap={SPACING.base}
        minW={0}
      >
        <Box display="grid" gap={SPACING.xs}>
          <Kicker>Design candidates · dev only · Q34</Kicker>
          <Headline as="h1">Cost vs reward</Headline>
          <Mono>
            {FX.position.label} · {FX.position.collateral.map((l) => l.symbol).join(' + ')} /{' '}
            {FX.position.debt.map((l) => l.symbol).join(' + ')} · borrower {FX.owner.slice(0, 6)}…{FX.owner.slice(-4)}
          </Mono>
        </Box>
        <Box display="flex" flexWrap="wrap" gap={SPACING.sm}>
          <LinkBox href="/dev/cost-reward" active={!one}>
            Side by side
          </LinkBox>
          {VARIANTS.map((x) => (
            <LinkBox key={x.key} href={`/dev/cost-reward?variant=${x.key}`} active={one?.key === x.key}>
              {x.key} · {x.title}
            </LinkBox>
          ))}
        </Box>
        <Box
          display="grid"
          gridTemplateColumns={{ base: 'minmax(0, 1fr)', lg: one ? 'minmax(0, 1fr)' : 'repeat(3, minmax(0, 1fr))' }}
          gap={SPACING.lg}
          minW={0}
        >
          {shown.map((x) => (
            <Box
              as="section"
              key={x.key}
              data-testid={`variant-${x.key}`}
              display="grid"
              alignContent="start"
              gap={SPACING.sm}
              borderTop={`1px solid ${NEWS.ruleStrong}`}
              pt={SPACING.sm}
              minW={0}
            >
              <Kicker>
                {x.key} · {x.title}
              </Kicker>
              <CostRewardVariant variant={x.key as VariantKey} fx={FX} track={TRACK} wide={one !== null} fan={FAN} />
            </Box>
          ))}
        </Box>
        {/* One collapsed "Sources": a line per source with its fetched stamp (round 7: prose goes). */}
        <Box as="details" borderTop={`1px solid ${NEWS.rule}`} sx={{ '& > summary': { cursor: 'pointer', minHeight: '44px', display: 'flex', alignItems: 'center' } }}>
          <Box as="summary" _focusVisible={FOCUS_STYLES.ring}>
            <Mono as="span">Sources</Mono>
          </Box>
          <Box as="ul" listStyleType="none" m={0} p={0} display="grid" gap={SPACING.xs} pb={SPACING.sm}>
            {sourceStamps(FX, FAN, BASELINE).map((l) => (
              <Small as="li" key={l} overflowWrap="anywhere">
                {l}
              </Small>
            ))}
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
