import React, { memo } from 'react'
import { Box, Flex, Grid, Link, Text } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'

import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { NEWS, NEWS_FONT } from '@/components/NewsEdition/tokens'
import { EXAMPLE_BANNER } from '@/components/Radar/radarLogic'
import type { HolderResponse } from '@/pages/api/curator-feed/holder'

import { CURATORS_COPY, curatorsView, type LatestRowView, type VaultRowView } from './curatorsView'
import { Credit, Headline, Kicker, Module, Withheld } from './newsAtoms'
import { RAISED_BUTTON, TABULAR } from './newsStyle'
import { shortAddr } from './safetyView'

// YOUR CURATORS THIS WEEK: the curator feed filtered to the vaults this address holds
// (owner ruling, Q27 round 6: the personal ripple map only, no global map). Words and
// dots come from curatorsView.ts; the filter is lib/curatorFeed/holder.ts.

const ETHERSCAN = 'https://etherscan.io'
const DOT = '12px'
const SQUARE = '10px'

async function getHolder(address: string): Promise<HolderResponse> {
  const r = await fetch(`/api/curator-feed/holder?address=${address}`)
  const body = await r.json()
  if (!r.ok) throw new Error(body?.error ?? `holder ${r.status}`)
  return body as HolderResponse
}

function Dot({ cut, label }: { cut: boolean; label: string }) {
  return (
    <Box
      as="span"
      role="img"
      aria-label={label}
      title={label}
      display="inline-block"
      flex="none"
      w={DOT}
      h={DOT}
      borderRadius="50%"
      border={`1.5px solid ${cut ? NEWS.danger : NEWS.ink}`}
      bg={cut ? NEWS.danger : 'transparent'}
    />
  )
}

function VaultSquare({ n }: { n: number }) {
  const label = `${n} vault setting${n === 1 ? '' : 's'} changed`
  return (
    <Box
      as="span"
      role="img"
      aria-label={label}
      title={label}
      display="inline-block"
      flex="none"
      w={SQUARE}
      h={SQUARE}
      border={`1.5px solid ${NEWS.ink2}`}
    />
  )
}

function Legend() {
  const item = (glyph: React.ReactNode, text: string) => (
    <Flex as="li" align="center" columnGap={SPACING.xs} listStyleType="none">
      {glyph}
      <Text as="span" fontFamily={NEWS_FONT.mono} fontSize={TYPOGRAPHY.label} color={NEWS.muted}>
        {text}
      </Text>
    </Flex>
  )
  return (
    <Flex as="ul" aria-label="Legend" columnGap={SPACING.base} rowGap={SPACING.xs} wrap="wrap" pt={SPACING.sm}>
      {item(<Box as="span" aria-hidden="true" w={DOT} h={DOT} borderRadius="50%" bg={NEWS.danger} />, CURATORS_COPY.legendCut)}
      {item(
        <Box as="span" aria-hidden="true" w={DOT} h={DOT} borderRadius="50%" border={`1.5px solid ${NEWS.ink}`} />,
        CURATORS_COPY.legendChange,
      )}
      {item(<Box as="span" aria-hidden="true" w={SQUARE} h={SQUARE} border={`1.5px solid ${NEWS.ink2}`} />, CURATORS_COPY.legendVault)}
    </Flex>
  )
}

function VaultRow({ r }: { r: VaultRowView }) {
  return (
    <Box as="li" listStyleType="none" borderBottom={`1px solid ${NEWS.rule}`} py={SPACING.sm} minW={0}>
      <Flex justify="space-between" align="baseline" columnGap={SPACING.sm} wrap="wrap">
        <Text fontFamily={NEWS_FONT.mono} fontSize="13px" lineHeight="20px" color={NEWS.ink} fontWeight={TYPOGRAPHY.bold}>
          {r.vaultName}{' '}
          <Text as="span" fontWeight={TYPOGRAPHY.normal} fontSize={TYPOGRAPHY.label} color={NEWS.muted}>
            {r.curatorName}
          </Text>
        </Text>
        <Credit>{r.summary}</Credit>
      </Flex>
      <Flex align="center" columnGap={SPACING.sm} rowGap={SPACING.sm} wrap="wrap" pt={SPACING.xs} minH="20px">
        {r.dots.map((d) => (
          <Dot key={d.key} cut={d.cut} label={d.label} />
        ))}
        {r.more > 0 && (
          <Text as="span" fontFamily={NEWS_FONT.mono} fontSize={TYPOGRAPHY.label} color={NEWS.muted} sx={TABULAR}>
            +{r.more}
          </Text>
        )}
        {r.vaultWide > 0 && <VaultSquare n={r.vaultWide} />}
      </Flex>
    </Box>
  )
}

function LatestRow({ l }: { l: LatestRowView }) {
  return (
    <Box as="li" listStyleType="none" borderBottom={`1px solid ${NEWS.rule}`} py={SPACING.xs}>
      <Flex justify="space-between" columnGap={SPACING.sm}>
        <Credit align="left">
          {l.date} · {l.vaultName}
        </Credit>
        <Link
          href={`${ETHERSCAN}/tx/${l.tx}`}
          isExternal
          fontFamily={NEWS_FONT.mono}
          fontSize={TYPOGRAPHY.label}
          color={NEWS.muted}
          flex="none"
        >
          tx ↗
        </Link>
      </Flex>
      <Text fontFamily={NEWS_FONT.mono} fontSize="13px" lineHeight="20px" color={l.cut ? NEWS.danger : NEWS.ink}>
        {l.cut && (
          <Box as="span" aria-hidden="true" mr="0.3em">
            ✖
          </Box>
        )}
        {l.text}
      </Text>
    </Box>
  )
}

/** The CTA, drawn but not live: there is no delivery route for curator alerts yet. */
function AlertCta() {
  return (
    <Box pt={SPACING.base}>
      <Box
        as="button"
        type="button"
        disabled
        aria-disabled="true"
        aria-describedby="curator-alert-pending"
        w="100%"
        px={SPACING.base}
        py={SPACING.sm}
        {...RAISED_BUTTON}
        whiteSpace="normal"
        // Not live: no raised shadow, so it does not read as pressable.
        boxShadow="none"
        opacity={0.55}
        cursor="not-allowed"
        _hover={{}}
      >
        {CURATORS_COPY.cta}
      </Box>
      <Box id="curator-alert-pending" pt={SPACING.xs}>
        <Credit align="left">{CURATORS_COPY.ctaPending}</Credit>
      </Box>
    </Box>
  )
}

export const YourCurators = memo(function YourCurators({
  address,
  example,
  nowMs,
}: {
  address: string
  /** The demo-first read (the Radar's example address), marked "not yours". */
  example: boolean
  nowMs: number
}) {
  const q = useQuery({
    queryKey: ['curator_holder', address.toLowerCase()],
    queryFn: () => getHolder(address),
    staleTime: 5 * 60_000,
    retry: 1,
  })
  const v = curatorsView({ data: q.data, error: q.isError, nowMs })
  if (v.state === 'hidden') return null

  const head = (
    <Flex justify="space-between" align="center" columnGap={SPACING.base} wrap="wrap">
      <Kicker>{CURATORS_COPY.kicker}</Kicker>
      <Credit>{example ? EXAMPLE_BANNER : shortAddr(address)}</Credit>
    </Flex>
  )

  if (v.state === 'unavailable') {
    return (
      <Module label={CURATORS_COPY.kicker} hatched>
        {head}
        <Withheld slot={false}>{v.headline}</Withheld>
      </Module>
    )
  }

  return (
    <Module label={CURATORS_COPY.kicker}>
      <Box data-module="your-curators" data-module-state={v.state} data-example={example ? 'true' : undefined}>
        {head}
        <Headline slot={false}>{v.headline}</Headline>
        {v.state === 'changes' && (
          <Grid
            templateColumns={{ base: 'minmax(0, 1fr)', lg: 'minmax(0, 7fr) minmax(0, 5fr)' }}
            columnGap={SPACING.xl}
            pt={SPACING.sm}
          >
            <Box minW={0}>
              <Box as="ul" aria-label="Changes by vault">
                {v.rows.map((r) => (
                  <VaultRow key={r.key} r={r} />
                ))}
              </Box>
              {v.moreVaults && (
                <Box pt={SPACING.xs}>
                  <Credit align="left">{v.moreVaults}</Credit>
                </Box>
              )}
              <Legend />
            </Box>
            <Box
              minW={0}
              pt={{ base: SPACING.base, lg: 0 }}
              pl={{ base: 0, lg: SPACING.xl }}
              borderLeft={{ base: 'none', lg: `1px solid ${NEWS.rule}` }}
            >
              <Kicker>{CURATORS_COPY.latest}</Kicker>
              <Box as="ul" pt={SPACING.xs}>
                {v.latest.map((l) => (
                  <LatestRow key={l.key} l={l} />
                ))}
              </Box>
              <AlertCta />
            </Box>
          </Grid>
        )}
        {v.state === 'none' && (
          <Box maxW={{ base: 'none', lg: '420px' }}>
            <AlertCta />
          </Box>
        )}
        <Box pt={SPACING.sm}>
          <Credit align="left">{v.credit}</Credit>
        </Box>
      </Box>
    </Module>
  )
})

export default YourCurators
