// THE SHEET BEHIND BOTH DOORS — the placeholder the migrate flow (feat/migrate-flow)
// replaces. It renders the exact rows the replay prefilled, so the intent survives:
//   demo / no wallet  the button is "Connect wallet" (V20). After connect the same sheet
//                     stays open on the same rows.
//   connected         no signature yet: Membrane is pre-launch, so the sheet says "Not
//                     live yet" and offers nothing to sign. Never a disabled gate button.

import React from 'react'
import {
  Box,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalHeader,
  ModalOverlay,
  Text,
} from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { DemoAwareCta } from '@/components/demo'
import { amt, pct, shortAddress, usd } from '@/components/Simulator/format'
import useDemoMode from '@/hooks/useDemoMode'
import type { Door, PositionIntent } from '@/lib/landing/doors'

import { kicker, rule, small, tabularNums } from './styles'

export interface DoorSheetProps {
  door: Door | null
  intent: PositionIntent | null
  onClose: () => void
}

export const DOOR_TITLE: Record<Door, string> = {
  migrate: 'Migrate this position',
  fresh: 'Deploy fresh',
}

const DOOR_LINE: Record<Door, string> = {
  migrate: 'Repays the old venue, moves the collateral and reopens it on Membrane, with these rows.',
  fresh: 'Opens a new Membrane position with these rows. Any part of it can go first.',
}

const Row: React.FC<{ k: string; v: string; testId?: string }> = ({ k, v, testId }) => (
  <Box display="flex" justifyContent="space-between" gap={SPACING.md} borderTop={rule} py={SPACING.xs} data-testid={testId}>
    <Text {...small}>{k}</Text>
    <Text {...small} {...tabularNums} color={SEMANTIC_COLORS.textPrimary} textAlign="right">
      {v}
    </Text>
  </Box>
)

export const DoorSheet: React.FC<DoorSheetProps> = ({ door, intent, onClose }) => {
  const { isWalletConnected, address } = useDemoMode()
  const open = door !== null && intent !== null
  return (
    <Modal isOpen={open} onClose={onClose} size={{ base: 'full', md: 'lg' }} scrollBehavior="inside">
      <ModalOverlay />
      <ModalContent
        aria-labelledby="door-sheet-title"
        data-testid="door-sheet"
        bg={SEMANTIC_COLORS.bgSecondary}
        borderRadius={0}
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderSubtle}
        boxShadow={`3px 3px 0 ${SEMANTIC_COLORS.borderStrong}`}
      >
        {door && intent && (
          <>
            <ModalHeader id="door-sheet-title" fontFamily={TYPOGRAPHY.fontDisplay} fontWeight={TYPOGRAPHY.normal} fontSize={TYPOGRAPHY.h2}>
              {DOOR_TITLE[door]}
            </ModalHeader>
            <ModalCloseButton _focus={FOCUS_STYLES.ring} borderRadius={0} />
            <ModalBody pb={SPACING_PATTERNS.modalPadding} display="grid" gap={SPACING.md}>
              <Text {...small}>{DOOR_LINE[door]}</Text>
              <Box>
                <Text {...kicker} mb={SPACING.xs}>
                  Prefilled from the replay{intent.source === 'demo' ? ' · demo wallet' : intent.source === 'manual' ? ' · entered by hand' : ''}
                </Text>
                {intent.address && <Row k="Wallet read" v={shortAddress(intent.address)} />}
                <Row k="From" v={intent.venueLabel} testId="door-row-venue" />
                {intent.collateral.map((c) => (
                  <Row key={`c-${c.symbol}`} k={`Collateral · ${c.symbol}`} v={`${amt(c.amount)} · ${usd(c.valueUsd)}`} />
                ))}
                {intent.debt.map((d) => (
                  <Row key={`d-${d.symbol}`} k={`Debt · ${d.symbol}`} v={`${amt(d.amount)} · ${usd(d.valueUsd)}`} />
                ))}
                <Row k="LTV now" v={pct(intent.ltv)} />
                <Row k={`${intent.venueLabel} line`} v={pct(intent.venueLine)} />
                <Row k="Membrane line (modelled)" v={pct(intent.membraneLine)} />
              </Box>

              {isWalletConnected ? (
                <Box borderTop={rule} pt={SPACING.sm} data-testid="door-not-live">
                  <Text {...small} color={SEMANTIC_COLORS.textPrimary}>Not live yet.</Text>
                  <Text {...small}>
                    Membrane is pre-launch, so there is nothing to sign. These rows stay as they are
                    {address && intent.address && address.toLowerCase() !== intent.address.toLowerCase()
                      ? `; the connected wallet ${shortAddress(address)} is not the one replayed`
                      : ''}
                    .
                  </Text>
                </Box>
              ) : (
                <Box display="grid" gap={SPACING.xs} borderTop={rule} pt={SPACING.sm}>
                  <DemoAwareCta
                    onAction={() => {}}
                    data-testid="door-connect"
                    minH="44px"
                    bg={SEMANTIC_COLORS.success}
                    color={SEMANTIC_COLORS.bgPrimary}
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize="12px"
                    letterSpacing="0.12em"
                    textTransform="uppercase"
                    _hover={{ bg: SEMANTIC_COLORS.success }}
                  >
                    Connect wallet
                  </DemoAwareCta>
                  <Text {...small}>Not live yet: Membrane is pre-launch. Connecting keeps this sheet and its rows.</Text>
                </Box>
              )}
            </ModalBody>
          </>
        )}
      </ModalContent>
    </Modal>
  )
}

export default DoorSheet
