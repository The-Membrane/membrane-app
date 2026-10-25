// R: THE REVEAL AND THE TWO DOORS. "This is a replay. Membrane is the live version."
// Then two equal-weight buttons, both prefilled from the replay's position. The handlers
// are the typed seam in lib/landing/doors.ts; the migrate flow supplies its own.

import React from 'react'
import { Box, Button, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import type { DoorButton, DoorHandlers, PositionIntent } from '@/lib/landing/doors'

import { CAPS } from './styles'

export const REVEAL_LINE = 'This is a replay. Membrane is the live version.'

const DOOR_BTN = {
  flex: '1 1 220px',
  minH: '52px',
  borderRadius: 0,
  border: '1px solid',
  borderColor: SEMANTIC_COLORS.textPrimary,
  bg: 'transparent',
  color: SEMANTIC_COLORS.textPrimary,
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '12px',
  letterSpacing: CAPS,
  textTransform: 'uppercase' as const,
  boxShadow: `3px 3px 0 ${SEMANTIC_COLORS.borderStrong}`,
  transition: TRANSITIONS.colors,
  _hover: { borderColor: SEMANTIC_COLORS.success, color: SEMANTIC_COLORS.success, bg: 'transparent' },
  _active: { opacity: 0.85 },
  _focus: FOCUS_STYLES.ring,
}

export interface DoorsProps extends DoorHandlers {
  intent: PositionIntent | null
  buttons: DoorButton[]
  /** "Paste your wallet": focus the address input. */
  onFocusInput: () => void
}

export const Doors: React.FC<DoorsProps> = ({ intent, buttons, onMigrate, onDeployFresh, onFocusInput }) => (
  <Box as="section" aria-labelledby="landing-reveal" data-testid="landing-reveal" data-story="R" display="grid" gap={SPACING.md}>
    <Text id="landing-reveal" fontFamily={TYPOGRAPHY.fontDisplay} fontSize={{ base: '24px', md: '32px' }} lineHeight={1.15}>
      {REVEAL_LINE}
    </Text>
    <Box display="flex" flexWrap="wrap" gap={SPACING.md}>
      {buttons.map((b) => (
        <Button
          key={b.action}
          {...DOOR_BTN}
          {...(b.primary ? { bg: SEMANTIC_COLORS.textPrimary, color: SEMANTIC_COLORS.bgPrimary, _hover: { bg: SEMANTIC_COLORS.textPrimary, opacity: 0.9 } } : {})}
          data-testid={`door-${b.action}`}
          isDisabled={b.action === 'migrate' && !intent}
          onClick={() => {
            if (b.action === 'focus-input') onFocusInput()
            else if (b.action === 'migrate') intent && onMigrate(intent)
            else onDeployFresh(intent)
          }}
        >
          {b.label}
        </Button>
      ))}
    </Box>
  </Box>
)

export default Doors
