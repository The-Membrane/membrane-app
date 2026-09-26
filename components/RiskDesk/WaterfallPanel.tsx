import React from 'react'
import { Box, HStack, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import type { AssetDesk, RiskDeskSnapshot } from '@/lib/riskDesk/loadRiskDesk'
import { fmtToken, shortAddr, type WaterfallRow } from '@/lib/riskDesk/riskLogic'

import { Eyebrow, Panel, PanelHead, Provenance } from './atoms'

const SOURCE_NAME: Record<WaterfallRow['source'], string> = {
  revenueDistributor: 'RevenueDistributor',
  ltvDisco: 'LtvDisco',
  transmuter: 'Transmuter',
}

const Row: React.FC<{ step: string; label: string; amount: bigint; unit: string; basis: string; tag?: string; hole?: boolean; address: string; contract: string }> = ({
  step,
  label,
  amount,
  unit,
  basis,
  tag,
  hole,
  address,
  contract,
}) => (
  <HStack
    align="baseline"
    justify="space-between"
    flexWrap="wrap"
    gap={SPACING.sm}
    py={SPACING.sm}
    borderBottom="1px solid"
    borderColor={SEMANTIC_COLORS.borderSubtle}
  >
    <HStack align="baseline" spacing={SPACING.md} minW="260px">
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" color={SEMANTIC_COLORS.textTertiary} w="18px">
        {step}
      </Text>
      <Box>
        <Text fontSize="14px" color={hole ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textPrimary}>
          {label}
          {tag && (
            <Text as="span" ml={SPACING.sm} fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" letterSpacing="0.24em" textTransform="uppercase" color={SEMANTIC_COLORS.info}>
              {tag}
            </Text>
          )}
        </Text>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.textTertiary}>
          {basis} · {contract} {shortAddr(address)}
        </Text>
      </Box>
    </HStack>
    <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="16px" color={amount === 0n ? SEMANTIC_COLORS.textTertiary : hole ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textPrimary}>
      {fmtToken(amount)} <Text as="span" fontSize="11px" color={SEMANTIC_COLORS.textTertiary}>{unit}</Text>
    </Text>
  </HStack>
)

export const WaterfallPanel: React.FC<{ a: AssetDesk; s: RiskDeskSnapshot }> = ({ a, s }) => {
  const addrOf = (src: WaterfallRow['source']) => s.addresses[src]
  return (
    <Panel mt={SPACING.md}>
      <PanelHead eyebrow="Bad debt" title="Who pays, in order" />

      <Eyebrow>Before the cascade</Eyebrow>
      <Row
        step="0"
        label="Liquidation queue bids"
        amount={a.liqQueueBids}
        unit="CDT"
        basis="totalBidSupply"
        address={s.addresses.liqQueue}
        contract="LiqQueue"
      />

      <Box mt={SPACING.md}>
        <Eyebrow>Cascade</Eyebrow>
      </Box>
      {a.waterfall.map((r) => (
        <Row
          key={r.key}
          step={String(r.step)}
          label={r.label}
          amount={r.amount}
          unit={r.unit}
          basis={r.basis}
          tag={r.scope === 'global' ? 'shared across assets' : undefined}
          hole={r.kind === 'hole'}
          address={addrOf(r.source)}
          contract={SOURCE_NAME[r.source]}
        />
      ))}

      <Box mt={SPACING.md} fontSize="12px" color={SEMANTIC_COLORS.textSecondary}>
        <Text>
          Revenue stops share <Text as="span" fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textPrimary}>{fmtToken(a.pendingRevenue)} CDT</Text> of pending revenue.
        </Text>
        <Text mt={1}>
          Disco auction: <Text as="span" fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textPrimary}>{a.auction.active ? 'active' : 'none'}</Text>
          {' · '}
          <Text as="span" fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textPrimary}>
            {fmtToken(a.auction.cdtFulfilled)} / {fmtToken(a.auction.cdtBadDebt)} CDT
          </Text>{' '}
          filled ·{' '}
          <Text as="span" fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textPrimary}>
            {fmtToken(a.auction.mbrnUsed)} / {fmtToken(a.auction.mbrnAllocated)} MBRN
          </Text>{' '}
          used
        </Text>
        <Text mt={1}>Curator bonds are not in this cascade and are not assigned to assets.</Text>
      </Box>

      <Provenance contract="RevenueDistributor" address={s.addresses.revenueDistributor} block={s.block} />
      <Provenance contract="Transmuter" address={s.addresses.transmuter} block={s.block} />
      <Provenance contract="Auction" address={s.addresses.auction} block={s.block} />
    </Panel>
  )
}
