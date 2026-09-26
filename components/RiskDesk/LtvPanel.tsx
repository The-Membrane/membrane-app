import React, { useState } from 'react'
import { Box, Button, Collapse, HStack, SimpleGrid, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import type { AssetDesk, RiskDeskSnapshot } from '@/lib/riskDesk/loadRiskDesk'
import {
  TARGET_SOURCE_LABEL,
  discoFloor,
  fmtPp,
  fmtTime,
  fmtToken,
  fmtWadPct,
  projectGlide,
  targetSource,
} from '@/lib/riskDesk/riskLogic'

import { Eyebrow, Fact, Panel, PanelHead, Provenance } from './atoms'
import { GlideBar } from './GlideBar'

const dirTone = (d: 'up' | 'down' | 'flat') =>
  d === 'down' ? SEMANTIC_COLORS.danger : d === 'up' ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.textSecondary

const Mono: React.FC<{ children: React.ReactNode; color?: string }> = ({ children, color }) => (
  <Text as="span" fontFamily={TYPOGRAPHY.fontMono} color={color ?? SEMANTIC_COLORS.textPrimary}>
    {children}
  </Text>
)

export const LtvPanel: React.FC<{ a: AssetDesk; s: RiskDeskSnapshot }> = ({ a, s }) => {
  const [open, setOpen] = useState(false)
  const p = projectGlide(a.cap, a.glide, s.blockTime)
  const src = targetSource({ nowS: s.blockTime, onboardingWindowEnd: a.onboardingWindowEnd, discoOracle: s.discoOracle, discoAverage: a.disco.average })
  const floor = discoFloor(a.disco.assetFloor)

  return (
    <Panel>
      <PanelHead eyebrow="Max LTV" title="Where the line is and where it is going" />
      <SimpleGrid columns={{ base: 2, md: 4 }} spacing={SPACING.md}>
        <Fact label="Listing cap" value={fmtWadPct(a.cap)} sub="fixed at listing" />
        <Fact label="Enforced now" value={fmtWadPct(a.current)} sub={`${p.pctOfCapNow.toFixed(1)}% of cap`} />
        <Fact label="Target" value={fmtWadPct(a.target)} sub={TARGET_SOURCE_LABEL[src]} tone={SEMANTIC_COLORS.warning} />
        <Fact label="In flight" value={fmtPp(a.glide.committed)} sub={p.direction === 'flat' ? 'no move' : `lands ${fmtWadPct(p.end)}`} tone={dirTone(p.direction)} />
      </SimpleGrid>

      <GlideBar cap={a.cap} applied={a.glide.applied} target={a.target} p={p} />

      <SimpleGrid columns={{ base: 1, md: 3 }} spacing={SPACING.md} mt={SPACING.md} fontSize="12px" color={SEMANTIC_COLORS.textSecondary}>
        <Text>
          Window <Mono>{fmtTime(a.glide.windowStart)}</Mono> → <Mono>{fmtTime(p.windowEnd)}</Mono>
          {p.windowOpen ? <Mono color={SEMANTIC_COLORS.textTertiary}> · {(p.progress * 100).toFixed(1)}% elapsed</Mono> : <Mono color={SEMANTIC_COLORS.textTertiary}> · closed</Mono>}
        </Text>
        <Text>
          Window opened at <Mono>{fmtWadPct(a.glide.applied)}</Mono>
        </Text>
        <Text>
          Next poke arms <Mono color={dirTone(a.pendingMove > 0n ? 'up' : a.pendingMove < 0n ? 'down' : 'flat')}>{fmtPp(a.pendingMove)}</Mono>
        </Text>
      </SimpleGrid>

      <Box mt={SPACING.md} borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} pt={SPACING.md}>
        <Eyebrow>Who sets the target</Eyebrow>
        <Text fontSize="12px" color={SEMANTIC_COLORS.textSecondary} mt={1} maxW="760px">
          Disco&apos;s MBRN per vault token for this asset, clamped to the cap. Below <Mono>{fmtToken(floor, 0)} MBRN</Mono> staked, or during
          onboarding, the listing LTV (<Mono>{fmtWadPct(a.tempLtv)}</Mono>) applies. Staking and unstaking keep the ratio; a bad-debt slash lowers
          it; auction revenue raises it. No vote and no role sets it.
        </Text>
        <SimpleGrid columns={{ base: 2, md: 4 }} spacing={SPACING.md} mt={SPACING.sm}>
          <Fact label="Disco MBRN" value={fmtToken(a.disco.totalMbrn)} sub="MBRN" />
          <Fact label="Vault tokens" value={fmtToken(a.disco.totalVt)} sub="VT" />
          <Fact label="Disco ratio" value={fmtWadPct(a.disco.average)} sub={a.disco.average === 0n ? 'returns 0 → listing LTV' : 'queryAverageLTV'} />
          <Fact label="Onboarding ends" value={a.onboardingWindowEnd === 0n ? 'genesis' : fmtTime(a.onboardingWindowEnd)} />
        </SimpleGrid>
        <Provenance contract="LtvDisco" address={s.addresses.ltvDisco} block={s.block} />
      </Box>

      <Box mt={SPACING.md} borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} pt={SPACING.sm}>
        <Button
          variant="unstyled"
          h="auto"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="11px"
          letterSpacing="0.24em"
          textTransform="uppercase"
          color={SEMANTIC_COLORS.textSecondary}
          _hover={{ color: SEMANTIC_COLORS.textPrimary }}
        >
          {open ? '−' : '+'} History · {a.history.length} {a.history.length === 1 ? 'update' : 'updates'}
        </Button>
        <Collapse in={open} animateOpacity>
          <Box overflowX="auto" mt={SPACING.sm}>
            <Box as="table" w="100%" fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" style={{ borderCollapse: 'collapse' }}>
              <Box as="thead">
                <Box as="tr" color={SEMANTIC_COLORS.textTertiary} textAlign="left">
                  {['Block', 'Time', 'Opened at', 'Move', 'Lands at', 'Window ends'].map((h) => (
                    <Box as="th" key={h} fontWeight={400} py={1} pr={SPACING.md} borderBottom="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
                      {h}
                    </Box>
                  ))}
                </Box>
              </Box>
              <Box as="tbody">
                {a.history.length === 0 && (
                  <Box as="tr">
                    <Box as="td" colSpan={6} py={2} color={SEMANTIC_COLORS.textTertiary}>
                      0 updates
                    </Box>
                  </Box>
                )}
                {a.history.map((h) => (
                  <Box as="tr" key={`${h.txHash}-${h.logIndex}`} color={SEMANTIC_COLORS.textPrimary}>
                    <Box as="td" py={1} pr={SPACING.md}>{h.blockNumber.toString()}</Box>
                    <Box as="td" py={1} pr={SPACING.md}>{fmtTime(h.blockTime)}</Box>
                    <Box as="td" py={1} pr={SPACING.md}>{fmtWadPct(h.applied)}</Box>
                    <Box as="td" py={1} pr={SPACING.md} color={dirTone(h.direction)}>{fmtPp(h.committed)}</Box>
                    <Box as="td" py={1} pr={SPACING.md}>{fmtWadPct(h.landsAt)}</Box>
                    <Box as="td" py={1} pr={SPACING.md}>{fmtTime(h.windowEnd)}</Box>
                  </Box>
                ))}
              </Box>
            </Box>
          </Box>
        </Collapse>
      </Box>
      <HStack>
        <Provenance contract="Collateral" address={s.addresses.collateral} block={s.block} extra="LtvGlideUpdated" />
      </HStack>
    </Panel>
  )
}
