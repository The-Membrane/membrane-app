import type { GetServerSideProps } from 'next'
import { readFileSync } from 'fs'
import { join } from 'path'

import React from 'react'
import { Box, HStack, Text } from '@chakra-ui/react'
import NextLink from 'next/link'

import PageSeo from '@/components/PageSeo'
import { Card } from '@/components/ui/Card'
import { Eyebrow, Stamp } from '@/components/Carry/atoms'
import VenuePage from '@/components/Venue/VenuePage'
import { supportedChains, DEFAULT_CHAIN } from '@/config/chains'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { useChainRoute } from '@/hooks/useChainRoute'

// /venue/[name] — the D3 landing. Every headline about a carry venue becomes our
// distribution moment. Valid names come from tools/venue-recorder.config.json;
// an unknown name renders an honest 404-style card listing the venues we DO track
// (not a Next 404 — the page still serves, just without a permalink to sell).

type Props = {
  name: string
  valid: boolean
  validVenues: string[]
}

function loadVenueNames(): string[] {
  const raw = readFileSync(join(process.cwd(), 'tools', 'venue-recorder.config.json'), 'utf8')
  return (JSON.parse(raw).venues as Array<{ name: string; enabled: boolean }>)
    .filter((v) => v.enabled)
    .map((v) => v.name)
}

export const getServerSideProps: GetServerSideProps<Props> = async (context) => {
  const chainParam = context.params?.chain
  const chainName = typeof chainParam === 'string' ? chainParam : DEFAULT_CHAIN
  const isValidChain = supportedChains.some((c) => c.name === chainName)
  if (!isValidChain) {
    return { redirect: { destination: `/${DEFAULT_CHAIN}`, permanent: false } }
  }

  const nameParam = context.params?.name
  const name = typeof nameParam === 'string' ? nameParam : ''
  const validVenues = loadVenueNames()
  const valid = validVenues.includes(name)

  return { props: { name, valid, validVenues } }
}

const NotFoundCard: React.FC<{ name: string; validVenues: string[] }> = ({ name, validVenues }) => {
  const { chainName } = useChainRoute()
  return (
    <Box maxW="1140px" mx="auto" px={SPACING.base} py={SPACING.lg} bg={SEMANTIC_COLORS.bgPrimary} color={SEMANTIC_COLORS.textPrimary}>
      <Eyebrow>venue permalink</Eyebrow>
      <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h1} letterSpacing="-0.01em" mt={SPACING.sm}>
        No such venue
      </Text>
      <Card variant="default" p={SPACING.base} mt={SPACING.base}>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11.5px" color={SEMANTIC_COLORS.textSecondary}>
          {name ? `"${name}" is not a venue we track.` : 'No venue named.'} These are the venues we record:
        </Text>
        <HStack spacing={SPACING.lg} flexWrap="wrap" mt={SPACING.base}>
          {validVenues.map((v) => (
            <NextLink key={v} href={`/${chainName}/venue/${v}`} style={{ textDecoration: 'underline' }}>
              <Text as="span" fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textPrimary} _hover={{ color: SEMANTIC_COLORS.success }}>
                {v}
              </Text>
            </NextLink>
          ))}
        </HStack>
        <HStack spacing={SPACING.lg} flexWrap="wrap" mt={SPACING.lg}>
          <NextLink href={`/${chainName}/carry`} style={{ textDecoration: 'underline' }}>
            <Text as="span" fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary} _hover={{ color: SEMANTIC_COLORS.success }}>
              the board → /carry
            </Text>
          </NextLink>
          <NextLink href={`/${chainName}/radar`} style={{ textDecoration: 'underline' }}>
            <Text as="span" fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary} _hover={{ color: SEMANTIC_COLORS.success }}>
              scan an address → /radar
            </Text>
          </NextLink>
        </HStack>
        <Stamp>carry radar · recorded corpus · {new Date().toISOString().slice(0, 10)}</Stamp>
      </Card>
    </Box>
  )
}

export default function VenuePermalink({ name, valid, validVenues }: Props) {
  if (!valid) {
    return (
      <>
        <PageSeo
          seoClass="internal"
          title="Membrane — Venue not found"
          description="This venue permalink does not match a tracked carry venue."
        />
        <NotFoundCard name={name} validVenues={validVenues} />
      </>
    )
  }

  return (
    <>
      <PageSeo
        seoClass="indexable"
        path={`/${DEFAULT_CHAIN}/venue/${name}`}
        title={`${name} — exit capacity, recorded | Membrane Carry Radar`}
        description={`${name} withdrawal capacity, worst recorded outflows, open failure-pattern flags and blind spots — measured from Membrane's venue recorder corpus, provenance-stamped.`}
      />
      <VenuePage venue={name} />
    </>
  )
}
