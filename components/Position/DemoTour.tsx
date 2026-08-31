import React, { useEffect, useState } from 'react'
import { Box, Button, HStack, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import useDemoMode from '@/hooks/useDemoMode'

import { TOUR_STEPS } from './fixtures'

const DISMISS_KEY = 'membrane.demoTour'

/**
 * The closeable demo tour (ported from `tourc` in public/proto/dash.html).
 * Shows only in FORCED demo mode (`?demo` / `#demo`) — the archetype browsing a
 * demo wants to look around, not be boxed in, so one click on X dismisses it
 * for good (localStorage). Steps highlight sections by DOM id and scroll them
 * into view; the highlight is cleaned up on step change and unmount.
 */
export const DemoTour: React.FC = () => {
  const { isForcedDemo } = useDemoMode()
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState(0)

  // Open once per browser unless dismissed.
  useEffect(() => {
    if (!isForcedDemo) return
    try {
      if (window.localStorage.getItem(DISMISS_KEY) === 'dismissed') return
    } catch {
      /* ignore */
    }
    setOpen(true)
  }, [isForcedDemo])

  // Highlight + scroll the current step's section; cleanup restores the outline.
  useEffect(() => {
    if (!open) return
    const el = document.getElementById(TOUR_STEPS[step].key)
    if (!el) return
    const prevOutline = el.style.outline
    const prevOffset = el.style.outlineOffset
    el.style.outline = `1px solid ${SEMANTIC_COLORS.success}`
    el.style.outlineOffset = '3px'
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    return () => {
      el.style.outline = prevOutline
      el.style.outlineOffset = prevOffset
    }
  }, [open, step])

  const dismiss = () => {
    setOpen(false)
    try {
      window.localStorage.setItem(DISMISS_KEY, 'dismissed')
    } catch {
      /* ignore */
    }
  }

  if (!open) return null

  const s = TOUR_STEPS[step]
  const last = step === TOUR_STEPS.length - 1

  return (
    <Box position="fixed" right="16px" bottom="16px" w="min(300px, 86vw)" zIndex={70} bg={SEMANTIC_COLORS.bgSecondary} border="1px solid" borderColor={SEMANTIC_COLORS.borderStrong} p={SPACING.base}>
      <Box
        as="button"
        type="button"
        aria-label="Close tour"
        position="absolute"
        top="6px"
        right="8px"
        bg="none"
        border={0}
        color={SEMANTIC_COLORS.textTertiary}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="13px"
        cursor="pointer"
        p="2px 5px"
        transition={TRANSITIONS.colors}
        _hover={{ color: SEMANTIC_COLORS.danger }}
        onClick={dismiss}
      >
        ×
      </Box>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" letterSpacing="0.24em" textTransform="uppercase" color={SEMANTIC_COLORS.textTertiary}>
        {step + 1} / {TOUR_STEPS.length}
      </Text>
      <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize="15px" color={SEMANTIC_COLORS.textPrimary} m="4px 0 2px">
        {s.title}
      </Text>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" color={SEMANTIC_COLORS.textSecondary} lineHeight={1.6}>
        {s.body}
      </Text>
      <HStack spacing={SPACING.sm} mt={SPACING.md}>
        <Button
          flex={1}
          borderRadius={0}
          bg={SEMANTIC_COLORS.success}
          color={SEMANTIC_COLORS.bgPrimary}
          _hover={{ bg: SEMANTIC_COLORS.success }}
          _focus={FOCUS_STYLES.ring}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.label}
          letterSpacing="0.14em"
          textTransform="uppercase"
          height="auto"
          py={SPACING.sm}
          onClick={() => (last ? dismiss() : setStep((n) => n + 1))}
        >
          {last ? 'Done' : 'Next'}
        </Button>
        <Button
          borderRadius={0}
          variant="outline"
          border="1px solid"
          borderColor={SEMANTIC_COLORS.borderStrong}
          bg="transparent"
          color={SEMANTIC_COLORS.textSecondary}
          _hover={{ borderColor: SEMANTIC_COLORS.success, color: SEMANTIC_COLORS.success }}
          _focus={FOCUS_STYLES.ring}
          transition={TRANSITIONS.colors}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.label}
          letterSpacing="0.14em"
          textTransform="uppercase"
          height="auto"
          py={SPACING.sm}
          onClick={dismiss}
        >
          Skip tour
        </Button>
      </HStack>
    </Box>
  )
}
