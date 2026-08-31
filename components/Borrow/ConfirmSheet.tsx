import React, { useEffect } from 'react'
import {
  Modal,
  ModalOverlay,
  ModalContent,
  Button,
  Text,
  VStack,
  HStack,
  Box,
} from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { useMockExec } from './hooks/useMockExec'
import type { ExecSheetData } from './types'

export interface ConfirmSheetProps {
  isOpen: boolean
  onClose: () => void
  data: ExecSheetData | null
}

/**
 * The one confirmation an irreversible action gets (VETERAN_UX_RULESET V6),
 * ported from window.__exec in public/proto/borrow.html (lines ~353-392):
 * numbers, not prose; then a pending state; then settled. Mock chain, real
 * choreography — see hooks/useMockExec.
 */
export const ConfirmSheet: React.FC<ConfirmSheetProps> = ({ isOpen, onClose, data }) => {
  const { phase, confirm, reset } = useMockExec()

  useEffect(() => {
    if (!isOpen) reset()
  }, [isOpen, reset])

  const handleClose = () => {
    reset()
    onClose()
  }

  if (!data) return null

  return (
    <Modal isOpen={isOpen} onClose={phase === 'confirm' ? handleClose : () => {}} isCentered>
      <ModalOverlay bg="rgba(7,7,8,0.78)" />
      <ModalContent
        bg={SEMANTIC_COLORS.bgSecondary}
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderStrong}
        borderRadius={0}
        maxW="430px"
        p={SPACING.lg}
      >
        <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h3} mb={SPACING.md} color={SEMANTIC_COLORS.textPrimary}>
          {data.title}
        </Text>

        <VStack spacing={0} align="stretch">
          {data.rows.map(([label, value], i) => (
            <HStack
              key={i}
              justify="space-between"
              spacing={SPACING.md}
              py={SPACING.sm}
              borderBottom={i < data.rows.length - 1 ? '1px solid' : 'none'}
              borderColor={SEMANTIC_COLORS.borderSubtle}
            >
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary}>
                {label}
              </Text>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.small}
                fontWeight={TYPOGRAPHY.normal}
                color={SEMANTIC_COLORS.textPrimary}
                textAlign="right"
              >
                {value}
              </Text>
            </HStack>
          ))}
        </VStack>

        {data.note && (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textTertiary}
            lineHeight={1.6}
            mt={SPACING.md}
          >
            {data.note}
          </Text>
        )}

        {phase === 'confirm' && (
          <HStack spacing={SPACING.sm} mt={SPACING.lg}>
            <Button
              flex={1}
              bg={SEMANTIC_COLORS.success}
              borderColor={SEMANTIC_COLORS.success}
              color={SEMANTIC_COLORS.bgPrimary}
              border="1px solid"
              borderRadius={0}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.small}
              letterSpacing="0.14em"
              textTransform="uppercase"
              _hover={{ bg: SEMANTIC_COLORS.success }}
              _focus={FOCUS_STYLES.ring}
              transition={TRANSITIONS.colors}
              onClick={confirm}
            >
              {data.cta || 'Confirm'}
            </Button>
            <Button
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
              onClick={handleClose}
            >
              Cancel
            </Button>
          </HStack>
        )}

        {phase === 'signing' && (
          <Text
            mt={SPACING.lg}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            color={SEMANTIC_COLORS.warning}
            letterSpacing="0.08em"
          >
            signing…
          </Text>
        )}

        {phase === 'pending' && (
          <Text
            mt={SPACING.lg}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            color={SEMANTIC_COLORS.warning}
            letterSpacing="0.08em"
          >
            pending — waiting for the receipt…
          </Text>
        )}

        {phase === 'done' && (
          <Box>
            <Text
              mt={SPACING.lg}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.small}
              color={SEMANTIC_COLORS.success}
              letterSpacing="0.08em"
            >
              {data.done || 'Settled'} · mock chain
            </Text>
            <Button
              mt={SPACING.md}
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
              onClick={handleClose}
            >
              Close
            </Button>
          </Box>
        )}
      </ModalContent>
    </Modal>
  )
}

export default ConfirmSheet
