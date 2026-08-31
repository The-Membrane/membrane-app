import React from 'react'
import { Modal, ModalOverlay, ModalContent, Box, Text, VStack, HStack, Button } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { EmphasisText } from './EmphasisText'
import { ORACLE_PROVENANCE } from './fixtures'
import type { OracleCardEntry } from './types'

export interface OracleCardProps {
  entry: OracleCardEntry | null
  isOpen: boolean
  onClose: () => void
}

const TAG_COLOR = {
  med: SEMANTIC_COLORS.warning,
  plan: SEMANTIC_COLORS.info,
} as const

/**
 * Oracle info modal, ported from window.__oracleCard in
 * public/proto/borrow.html (lines ~633-660). Any element with
 * data-oracle="SYM" opened this in the proto; here it's driven by the
 * `oracleSym` piece of state the wallet strip and the parent component share.
 * Copy is written in DEPLOYED VOICE (owner ruling, Aug 26 2026) — it
 * describes the oracle path as live, gated on each named asset actually
 * being wired before this page ships publicly (docs/GAME_LAUNCH_PLAN.md P3).
 */
export const OracleCard: React.FC<OracleCardProps> = ({ entry, isOpen, onClose }) => {
  if (!entry) return null

  return (
    <Modal isOpen={isOpen} onClose={onClose} isCentered scrollBehavior="inside">
      <ModalOverlay bg="rgba(7,7,8,0.82)" />
      <ModalContent
        bg={SEMANTIC_COLORS.bgSecondary}
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderStrong}
        borderRadius={0}
        maxW="640px"
        maxH="92vh"
        p={SPACING.lg}
      >
        <HStack justify="space-between" align="baseline" flexWrap="wrap" spacing={SPACING.md}>
          <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h3} color={SEMANTIC_COLORS.textPrimary}>
            Oracle info — {entry.sym}
          </Text>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.label}
            letterSpacing="0.18em"
            textTransform="uppercase"
            border="1px solid"
            borderColor={TAG_COLOR[entry.tag.variant]}
            color={TAG_COLOR[entry.tag.variant]}
            px={SPACING.sm}
            py={SPACING.xs}
            whiteSpace="nowrap"
          >
            {entry.tag.label}
          </Text>
        </HStack>

        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.small}
          color={SEMANTIC_COLORS.textPrimary}
          lineHeight={1.7}
          mt={SPACING.md}
        >
          {entry.summary}
        </Text>

        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.label}
          letterSpacing="0.24em"
          textTransform="uppercase"
          color={SEMANTIC_COLORS.textSecondary}
          mt={SPACING.lg}
          mb={SPACING.sm}
        >
          In simple terms
        </Text>

        <VStack align="stretch" spacing={SPACING.sm}>
          {entry.bullets.map((bullet, i) => (
            <HStack key={i} align="start" spacing={SPACING.sm}>
              <Text color={SEMANTIC_COLORS.textTertiary} lineHeight={1.65} mt="1px">
                ▪
              </Text>
              <EmphasisText
                markup={bullet}
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.small}
                color={SEMANTIC_COLORS.textSecondary}
                lineHeight={1.65}
              />
            </HStack>
          ))}
        </VStack>

        {entry.wire && (
          <Box
            border="1px solid"
            borderColor={SEMANTIC_COLORS.warning}
            bg="rgba(216,178,74,0.06)"
            color={SEMANTIC_COLORS.warning}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            lineHeight={1.6}
            p={SPACING.md}
            mt={SPACING.md}
          >
            {entry.wire}
          </Box>
        )}

        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.label}
          color={SEMANTIC_COLORS.textTertiary}
          lineHeight={1.7}
          mt={SPACING.md}
          pt={SPACING.md}
          borderTop="1px solid"
          borderColor={SEMANTIC_COLORS.borderSubtle}
        >
          {ORACLE_PROVENANCE}
        </Text>

        <Button
          mt={SPACING.md}
          alignSelf="start"
          bg="transparent"
          border="1px solid"
          borderColor={SEMANTIC_COLORS.borderStrong}
          color={SEMANTIC_COLORS.textSecondary}
          borderRadius={0}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.small}
          letterSpacing="0.14em"
          textTransform="uppercase"
          _hover={{ borderColor: SEMANTIC_COLORS.textSecondary }}
          _focus={FOCUS_STYLES.ring}
          transition={TRANSITIONS.colors}
          onClick={onClose}
        >
          Close
        </Button>
      </ModalContent>
    </Modal>
  )
}

export default OracleCard
