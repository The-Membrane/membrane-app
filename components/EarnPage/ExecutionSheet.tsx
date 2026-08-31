import React from 'react'
import { Button, HStack, Modal, ModalContent, ModalOverlay, Text, VStack } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { useExecutionSheet } from './hooks/useExecutionSheet'

/**
 * The one confirm-and-sign sheet every transact CTA on the page opens — ported from the
 * proto's `.xsheet`/`.xcard` overlay (public/proto/supply.html script :344-368). Numbers,
 * not prose; then a mock signing → pending → done choreography (owned by useExecutionSheet).
 * Mount this once per page inside an ExecutionSheetProvider.
 */
export const ExecutionSheet: React.FC = () => {
  const { request, phase, close, confirm } = useExecutionSheet()

  if (!request) return null

  return (
    <Modal isOpen onClose={close} isCentered closeOnOverlayClick={phase === 'idle'} size="sm">
      <ModalOverlay bg="rgba(7,7,8,0.78)" />
      <ModalContent
        bg={SEMANTIC_COLORS.bgSecondary}
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderStrong}
        borderRadius={0}
        p={SPACING_PATTERNS.modalPadding}
        m={SPACING.base}
      >
        <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h3} color={SEMANTIC_COLORS.textPrimary} mb={SPACING.md}>
          {request.title}
        </Text>

        <VStack spacing={0} align="stretch">
          {request.rows.map((row, i) => (
            <HStack
              key={`${row.label}-${i}`}
              justify="space-between"
              align="baseline"
              spacing={SPACING.md}
              py={SPACING.xs}
              borderBottom={i < request.rows.length - 1 ? '1px solid' : undefined}
              borderColor={SEMANTIC_COLORS.borderSubtle}
            >
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary}>
                {row.label}
              </Text>
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textPrimary} textAlign="right">
                {row.value}
              </Text>
            </HStack>
          ))}
        </VStack>

        {request.note && (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textTertiary}
            lineHeight={1.6}
            mt={SPACING.md}
          >
            {request.note}
          </Text>
        )}

        {phase === 'idle' && (
          <HStack spacing={SPACING.sm} mt={SPACING.lg}>
            <Button
              flex={1}
              borderRadius={0}
              bg={SEMANTIC_COLORS.success}
              color={SEMANTIC_COLORS.bgPrimary}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.small}
              textTransform="uppercase"
              letterSpacing="0.14em"
              transition={TRANSITIONS.colors}
              _hover={{ bg: SEMANTIC_COLORS.success, opacity: 0.85 }}
              _focus={FOCUS_STYLES.ring}
              onClick={confirm}
            >
              {request.cta ?? 'Confirm'}
            </Button>
            <Button
              bg="transparent"
              border="1px solid"
              borderColor={SEMANTIC_COLORS.borderStrong}
              color={SEMANTIC_COLORS.textSecondary}
              borderRadius={0}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.small}
              textTransform="uppercase"
              letterSpacing="0.14em"
              transition={TRANSITIONS.colors}
              _hover={{ borderColor: SEMANTIC_COLORS.textSecondary }}
              _focus={FOCUS_STYLES.ring}
              onClick={close}
            >
              Cancel
            </Button>
          </HStack>
        )}

        {phase === 'signing' && (
          <Text mt={SPACING.lg} fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.warning} letterSpacing="0.08em">
            signing…
          </Text>
        )}

        {phase === 'pending' && (
          <Text mt={SPACING.lg} fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.warning} letterSpacing="0.08em">
            pending — waiting for the receipt…
          </Text>
        )}

        {phase === 'done' && (
          <VStack align="stretch" spacing={SPACING.md} mt={SPACING.lg}>
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.success} letterSpacing="0.08em">
              {(request.done ?? 'Settled') + ' · mock chain'}
            </Text>
            <Button
              alignSelf="flex-start"
              bg="transparent"
              border="1px solid"
              borderColor={SEMANTIC_COLORS.borderStrong}
              color={SEMANTIC_COLORS.textSecondary}
              borderRadius={0}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.small}
              textTransform="uppercase"
              letterSpacing="0.14em"
              transition={TRANSITIONS.colors}
              _hover={{ borderColor: SEMANTIC_COLORS.textSecondary }}
              _focus={FOCUS_STYLES.ring}
              onClick={close}
            >
              Close
            </Button>
          </VStack>
        )}
      </ModalContent>
    </Modal>
  )
}

export default ExecutionSheet
