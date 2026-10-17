// DEV ONLY — "design states" for the /position order slip. Renders the slip (LeverSlip) in
// each state from fixtures captured from real mainnet reads (components/PositionV0/dev),
// so every state can be screenshot without a wallet. 404 in production; not linked; no
// signing (every button is inert here).
//
//   /dev/slip-states?state=<key>      one state; keys: components/PositionV0/dev/slipStates.ts
//   /dev/slip-states?walk=<key>       walk the flow: Next / Back with the slip open, along
//                                     reading → ready → signing → pending → settled, and
//                                     into each branch (walk=1 starts at reading)
//   &layout=b                         design candidate B: steps first, checks by the button
//   /dev/slip-states?state=dust-…     the collect-dust slip (components/PositionV0/DustSlip),
//                                     keys: components/PositionV0/dev/dustStates.ts

import React from 'react'
import Head from 'next/head'
import NextLink from 'next/link'
import { useRouter } from 'next/router'
import { Box, Button } from '@chakra-ui/react'
import type { GetServerSideProps } from 'next'

import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { NEWS, NEWS_FONT } from '@/components/NewsEdition/tokens'
import {
  CAPTURED_AT,
  DESIGN_STATES,
  WALK_MAIN,
  walkStep,
  type DesignState,
} from '@/components/PositionV0/dev/slipStates'
import { DUST_CAPTURED_AT, DUST_STATES } from '@/components/PositionV0/dev/dustStates'
import { DustSlip } from '@/components/PositionV0/DustSlip'
import { LeverSlip } from '@/components/PositionV0/LeverSheet'
import { Headline, Kicker, Mono, Small } from '@/components/PositionV0/primitives'
import { CAPS, TYPE } from '@/components/PositionV0/typeScale'

export const getServerSideProps: GetServerSideProps = async () =>
  process.env.NODE_ENV === 'production' ? { notFound: true } : { props: {} }

const noop = () => {}
const byKey = (k: string | null) => DESIGN_STATES.find((s) => s.key === k) ?? null

const LAYOUTS = {
  a: { prop: 'rows', note: 'A · rows first (as built): what changes, then the steps, then the checks' },
  b: {
    prop: 'steps',
    note: 'B · steps first: the approval and the calls in the order your wallet shows them, then what changes, then the checks, last before the button',
  },
} as const
type LayoutKey = keyof typeof LAYOUTS

const WALK_BTN = {
  flex: '0 0 auto',
  w: 'auto',
  borderRadius: 0,
  minH: '44px',
  h: 'auto',
  px: SPACING.sm,
  py: SPACING.xs,
  fontFamily: NEWS_FONT.mono,
  fontSize: TYPE.label,
  fontWeight: 700,
  whiteSpace: 'normal',
  bg: 'transparent',
  color: NEWS.ink,
  border: `1px solid ${NEWS.ink}`,
  transition: TRANSITIONS.colors,
  _hover: { bg: NEWS.raised },
  _focusVisible: FOCUS_STYLES.ring,
  _disabled: { opacity: 1, color: NEWS.muted, borderColor: NEWS.rule, cursor: 'not-allowed' },
  ...CAPS,
} as const

/** The walkthrough's bar, inside the slip above its head. */
const WalkBar: React.FC<{ s: DesignState; go: (key: string) => void }> = ({ s, go }) => {
  const w = walkStep(s.key)
  const title = (k: string) => byKey(k)?.title.split(':')[0] ?? k
  return (
    <Box
      data-testid="walk-bar"
      px={SPACING.base}
      pt={SPACING.sm}
      pb={SPACING.sm}
      pr={SPACING['2xl']}
      borderBottom={`1px dashed ${NEWS.ruleStrong}`}
      bg={NEWS.raised}
      display="grid"
      gap={SPACING.xs}
    >
      <Kicker tone="muted">
        Walk the flow · dev ·{' '}
        {w.index !== null ? `step ${w.index} of ${WALK_MAIN.length}` : `branch from ${title(w.from!)}`}
      </Kicker>
      <Box as="ol" listStyleType="none" m={0} p={0} display="flex" flexWrap="wrap" columnGap={SPACING.sm}>
        {WALK_MAIN.map((k, i) => {
          const here = k === s.key || k === w.from
          return (
            <Mono as="li" key={k} fontSize={TYPE.label} fontWeight={here ? 700 : 400} color={here ? NEWS.ink : NEWS.muted}>
              {i + 1} {title(k)}
              {i < WALK_MAIN.length - 1 ? ' →' : ''}
            </Mono>
          )
        })}
      </Box>
      <Box display="flex" flexWrap="wrap" gap={SPACING.xs}>
        <Button {...WALK_BTN} isDisabled={!w.back} onClick={() => w.back && go(w.back)} data-testid="walk-back">
          ← Back{w.back ? ` · ${title(w.back)}` : ''}
        </Button>
        <Button {...WALK_BTN} isDisabled={!w.next} onClick={() => w.next && go(w.next)} data-testid="walk-next">
          Next{w.next ? ` · ${title(w.next)}` : ' · end'} →
        </Button>
        {w.branches.map((b) => (
          <Button key={b} {...WALK_BTN} borderStyle="dashed" onClick={() => go(b)} data-testid={`walk-branch-${b}`}>
            ↳ {title(b)}
          </Button>
        ))}
      </Box>
    </Box>
  )
}

export default function SlipStates() {
  const router = useRouter()
  const q = router.query
  const walkKey = typeof q.walk === 'string' ? (q.walk === '1' || q.walk === '' ? 'reading' : q.walk) : null
  const walking = walkKey !== null && byKey(walkKey) !== null
  const key = walking ? walkKey : typeof q.state === 'string' ? q.state : null
  const current = byKey(key)
  const dust = DUST_STATES.find((d) => d.key === key) ?? null
  const layout: LayoutKey = q.layout === 'b' ? 'b' : 'a'
  const suffix = layout === 'b' ? '&layout=b' : ''
  const go = (k: string) => void router.replace(`/dev/slip-states?walk=${k}${suffix}`, undefined, { shallow: true })

  return (
    <Box className="news-edition" minH="100vh">
      <Head>
        <title>Order slip · design states</title>
        <meta name="robots" content="noindex,nofollow" />
      </Head>
      <Box
        maxW="960px"
        mx="auto"
        px={{ base: SPACING.base, md: SPACING.lg }}
        py={SPACING.lg}
        display="grid"
        gap={SPACING.sm}
      >
        <Kicker>Design states · dev only</Kicker>
        <Headline as="h1">Order slip</Headline>
        <Small>
          Fixtures from real mainnet reads captured {CAPTURED_AT}{' '}
          (scripts/position/capture-slip-fixtures.ts). Buttons do nothing here; nothing is signed.
        </Small>
        <Mono data-testid="design-layout-label">Layout {LAYOUTS[layout].note}</Mono>
        <Box display="flex" flexWrap="wrap" gap={SPACING.sm}>
          {(Object.keys(LAYOUTS) as LayoutKey[]).map((l) => (
            <NextLink
              key={l}
              href={`/dev/slip-states?${walking ? `walk=${walkKey}` : key ? `state=${key}` : 'walk=1'}${l === 'b' ? '&layout=b' : ''}`}
              passHref
              legacyBehavior
            >
              <Box
                as="a"
                display="inline-flex"
                alignItems="center"
                minH="44px"
                px={SPACING.sm}
                border={`1px solid ${l === layout ? NEWS.ink : NEWS.rule}`}
                color={NEWS.ink}
                _focusVisible={FOCUS_STYLES.ring}
              >
                <Mono as="span" fontWeight={l === layout ? 700 : 400}>
                  Layout {l.toUpperCase()}
                </Mono>
              </Box>
            </NextLink>
          ))}
          <NextLink href={`/dev/slip-states?walk=1${suffix}`} passHref legacyBehavior>
            <Box
              as="a"
              display="inline-flex"
              alignItems="center"
              minH="44px"
              px={SPACING.sm}
              bg={NEWS.cta}
              color={NEWS.onCta}
              border={`1px solid ${NEWS.ink}`}
              boxShadow={NEWS.shadowRaised}
              _focusVisible={FOCUS_STYLES.ring}
              data-testid="walk-start"
            >
              <Mono as="span" fontWeight={700} color={NEWS.onCta}>
                Walk the flow →
              </Mono>
            </Box>
          </NextLink>
        </Box>
        {dust && (
          <Mono data-testid="design-state-label">
            {dust.key} · {dust.title}
            {dust.forced ? ` · forced: ${dust.forced}` : ' · as read'}
          </Mono>
        )}
        {current && (
          <Mono data-testid="design-state-label">
            {current.key} · {current.title}
            {current.forced ? ` · forced: ${current.forced}` : ' · as read'}
          </Mono>
        )}
        <Box as="ul" listStyleType="none" m={0} p={0} borderTop={`1px solid ${NEWS.rule}`}>
          {DESIGN_STATES.map((s) => (
            <Box as="li" key={s.key} borderBottom={`1px solid ${NEWS.rule}`}>
              <NextLink href={`/dev/slip-states?state=${s.key}${suffix}`} passHref legacyBehavior>
                <Box
                  as="a"
                  display="flex"
                  alignItems="center"
                  minH="44px"
                  color={NEWS.ink}
                  _focusVisible={FOCUS_STYLES.ring}
                >
                  <Mono as="span" fontWeight={s.key === key ? 700 : 400}>
                    {s.key} · {s.title}
                  </Mono>
                </Box>
              </NextLink>
            </Box>
          ))}
        </Box>
        <Kicker tone="muted" pt={SPACING.base}>
          Collect dust · read {DUST_CAPTURED_AT}
        </Kicker>
        <Box as="ul" listStyleType="none" m={0} p={0} borderTop={`1px solid ${NEWS.rule}`}>
          {DUST_STATES.map((s) => (
            <Box as="li" key={s.key} borderBottom={`1px solid ${NEWS.rule}`}>
              <NextLink href={`/dev/slip-states?state=${s.key}`} passHref legacyBehavior>
                <Box
                  as="a"
                  display="flex"
                  alignItems="center"
                  minH="44px"
                  color={NEWS.ink}
                  _focusVisible={FOCUS_STYLES.ring}
                >
                  <Mono as="span" fontWeight={s.key === key ? 700 : 400}>
                    {s.key} · {s.title}
                  </Mono>
                </Box>
              </NextLink>
            </Box>
          ))}
        </Box>
      </Box>
      {dust && (
        <DustSlip
          key={dust.key}
          owner={dust.owner}
          dust={dust.dust}
          kept={dust.kept}
          sim={dust.sim}
          ethUsd={dust.ethUsd}
          block={dust.block}
          at={dust.at}
          source={dust.source}
          sheet={dust.sheet}
          txHash={null}
          busy={false}
          onButton={noop}
          onClose={() => void router.push('/dev/slip-states')}
          onExplorer={noop}
        />
      )}
      {current && (
        <LeverSlip
          // One slip for the whole walk, so a step changes the slip in place.
          key={walking ? 'walk' : current.key}
          intent={current.intent}
          prepared={current.prepared}
          sim={current.sim}
          sheet={current.sheet}
          txHash={current.txHash}
          busy={false}
          onButton={noop}
          onClose={() => void router.push(`/dev/slip-states${layout === 'b' ? '?layout=b' : ''}`)}
          onExplorer={noop}
          layout={LAYOUTS[layout].prop}
          harness={walking ? <WalkBar s={current} go={go} /> : undefined}
        />
      )}
    </Box>
  )
}
