// DEV ONLY — "design states" for the /position order slip. Renders the slip (LeverSlip) in
// each state from fixtures captured from real mainnet reads (components/PositionV0/dev),
// so every state can be screenshot without a wallet. 404 in production; not linked; no
// signing (every button is inert here).
//
//   /dev/slip-states?state=<key>      keys: components/PositionV0/dev/slipStates.ts

import React from 'react'
import Head from 'next/head'
import NextLink from 'next/link'
import { useRouter } from 'next/router'
import { Box } from '@chakra-ui/react'
import type { GetServerSideProps } from 'next'

import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES } from '@/config/transitions'
import { NEWS } from '@/components/NewsEdition/tokens'
import { CAPTURED_AT, DESIGN_STATES } from '@/components/PositionV0/dev/slipStates'
import { LeverSlip } from '@/components/PositionV0/LeverSheet'
import { Headline, Kicker, Mono, Small } from '@/components/PositionV0/primitives'

export const getServerSideProps: GetServerSideProps = async () =>
  process.env.NODE_ENV === 'production' ? { notFound: true } : { props: {} }

const noop = () => {}

export default function SlipStates() {
  const router = useRouter()
  const key = typeof router.query.state === 'string' ? router.query.state : null
  const current = DESIGN_STATES.find((s) => s.key === key) ?? null
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
        {current && (
          <Mono data-testid="design-state-label">
            {current.key} · {current.title}
            {current.forced ? ` · forced: ${current.forced}` : ' · as read'}
          </Mono>
        )}
        <Box as="ul" listStyleType="none" m={0} p={0} borderTop={`1px solid ${NEWS.rule}`}>
          {DESIGN_STATES.map((s) => (
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
      {current && (
        <LeverSlip
          key={current.key}
          intent={current.intent}
          prepared={current.prepared}
          sim={current.sim}
          sheet={current.sheet}
          txHash={current.txHash}
          busy={false}
          onButton={noop}
          onClose={() => void router.push('/dev/slip-states')}
          onExplorer={noop}
        />
      )}
    </Box>
  )
}
