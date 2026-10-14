// Before an address is read (or when none of the read venues holds a position): venue-level
// analysis, never an empty personal section (DESIGN_RULES §5b). ETH and BTC history at a
// few fall sizes, as small multiples on the same rows. History, not odds.

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { NEWS, NEWS_FONT } from '@/components/NewsEdition/tokens'
import { fmtInt } from '@/lib/position/format'
import { formatFrequency, touchAtLevel } from '@/lib/position/touch'
import { HORIZON_IDS, HORIZON_WORDS, periodYears, shortSha, type HistoryAsset, type TouchTable } from '@/lib/position/touchHistory'

import { Credit, Headline, Kicker, Section, Small } from './primitives'
import { CAPS, TYPE } from './typeScale'
import { MARKET_LEVELS } from './viewModel'

const CELL = { fontFamily: NEWS_FONT.mono, fontSize: TYPE.body, py: '5px', px: '4px', textAlign: 'right' as const }
const HEAD = { ...CELL, ...CAPS, fontSize: TYPE.label, fontWeight: 700, color: NEWS.muted }

const AssetTable: React.FC<{ t: TouchTable; asset: HistoryAsset }> = ({ t, asset }) => {
  const rows = HORIZON_IDS.map((h) => t.assets[asset].fall[h])
  const ns = rows.map((r) => r.n)
  return (
    <Box minW={0}>
      <Box as="table" w="100%" sx={{ borderCollapse: 'collapse' }} aria-label={`Share of days ${asset} fell by at least 10, 20 or 30 percent`}>
        <Box as="thead">
          <Box as="tr" borderBottom={`1px solid ${NEWS.ruleStrong}`}>
            <Text as="th" {...HEAD} textAlign="left" pl={0} color={NEWS.ink}>
              {asset} fell
            </Text>
            {MARKET_LEVELS.map((L) => (
              <Text as="th" key={L} {...HEAD} pr={L === MARKET_LEVELS[MARKET_LEVELS.length - 1] ? 0 : '4px'}>
                {L}%+
              </Text>
            ))}
          </Box>
        </Box>
        <Box as="tbody">
          {HORIZON_IDS.map((h) => (
            <Box as="tr" key={h} borderBottom={`1px solid ${NEWS.rule}`}>
              <Text as="th" {...CELL} textAlign="left" pl={0} fontWeight={400} color={NEWS.ink2} scope="row">
                within {HORIZON_WORDS[h]}
              </Text>
              {MARKET_LEVELS.map((L, i) => {
                const f = touchAtLevel(t, asset, 'fall', h, L)
                return (
                  <Text as="td" key={L} {...CELL} pr={i === MARKET_LEVELS.length - 1 ? 0 : '4px'} color={NEWS.ink} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                    {f ? formatFrequency(f.touched, f.n) : '—'}
                  </Text>
                )
              })}
            </Box>
          ))}
        </Box>
      </Box>
      <Small mt={SPACING.xs}>
        share of days · from {rows[0].from} · n = {fmtInt(Math.min(...ns))}–{fmtInt(Math.max(...ns))}
      </Small>
    </Box>
  )
}

export const MarketHistory: React.FC<{ t: TouchTable }> = ({ t }) => (
  <Section id="market">
    <Kicker>Market history · {periodYears(t, 'ETH', 'fall')}</Kicker>
    <Headline>How often ETH and BTC fell</Headline>
    <Box display="grid" gridTemplateColumns={{ base: '1fr', md: '1fr 1fr' }} gap={SPACING.lg} minW={0}>
      <AssetTable t={t} asset="ETH" />
      <AssetTable t={t} asset="BTC" />
    </Box>
    <Text fontFamily={NEWS_FONT.display} fontStyle="italic" fontSize={TYPE.body} color={NEWS.ink2}>
      History, not a forecast. Paste an address above for your own line.
    </Text>
    <Credit>
      {t.assets.ETH.feed} and {t.assets.BTC.feed} hourly lows · membrane-datasets price-history · {shortSha(t)}
    </Credit>
  </Section>
)
