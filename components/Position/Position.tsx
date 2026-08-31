import React from 'react'
import { Box, HStack } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { DemoBanner } from '@/components/demo'

import { VeteranProvider } from './primitives'
import { ExecProvider } from './ExecContext'
import { usePersistentState } from './hooks/usePersistentState'
import { PointsCard } from './PointsCard'
import { BorrowRole } from './BorrowRole'
import { LendRole } from './LendRole'
import { CurateRole } from './CurateRole'
import { DemoTour } from './DemoTour'
import { Role } from './types'

const ROLE_TABS: { role: Role; label: string; count: string }[] = [
  { role: 'borrow', label: 'Borrow', count: '· 1' },
  { role: 'lend', label: 'Lend', count: '· 2 tranches' },
  { role: 'curate', label: 'Curate', count: '· 1 vault' },
]

/**
 * The Position page (ported from public/proto/dash.html — "the page is the
 * account"). THE wallet-scoped page: with no wallet it opens fully populated
 * from fixtures under DemoBanner; every transact CTA is an intent-preserving
 * connect via DemoAwareCta. `?demo` / `#demo` forces demo mode (that covers
 * the proto's demo.html entry) and additionally shows the closeable tour.
 */
export const Position: React.FC = () => {
  const [role, setRole] = usePersistentState<Role>('membrane.role', 'borrow')
  const [view, setView] = usePersistentState<'first' | 'vet'>('membrane.view', 'first')
  const vet = view === 'vet'

  return (
    <VeteranProvider value={vet}>
      <ExecProvider>
        <Box maxW="1240px" mx="auto" px={SPACING_PX} pb="70px">
          <DemoBanner note="every number is a measured mock, not yours" />

          {/* Role tabs + view toggle */}
          <HStack spacing="2px" mt={SPACING.base} mb={SPACING.base} flexWrap="wrap">
            {ROLE_TABS.map((t) => {
              const on = role === t.role
              return (
                <Box
                  key={t.role}
                  as="button"
                  type="button"
                  onClick={() => setRole(t.role)}
                  bg={on ? SEMANTIC_COLORS.bgTertiary : 'transparent'}
                  border="1px solid"
                  borderColor={on ? SEMANTIC_COLORS.borderStrong : SEMANTIC_COLORS.borderSubtle}
                  color={on ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.textSecondary}
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="10.5px"
                  letterSpacing="0.16em"
                  textTransform="uppercase"
                  p="9px 16px"
                  cursor="pointer"
                  transition={TRANSITIONS.colors}
                  _hover={{ color: SEMANTIC_COLORS.success }}
                  _focus={FOCUS_STYLES.ring}
                >
                  {t.label}{' '}
                  <Box as="span" letterSpacing={0} color={SEMANTIC_COLORS.textTertiary}>
                    {t.count}
                  </Box>
                </Box>
              )
            })}

            {/* Veteran view toggle (V9): warm text decays to badges, per switch here. */}
            <Box
              as="button"
              type="button"
              ml="auto"
              bg="transparent"
              border="1px solid"
              borderColor={SEMANTIC_COLORS.borderStrong}
              color={SEMANTIC_COLORS.textSecondary}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="9px"
              letterSpacing="0.18em"
              textTransform="uppercase"
              p="5px 9px"
              cursor="pointer"
              transition={TRANSITIONS.colors}
              _hover={{ borderColor: SEMANTIC_COLORS.success, color: SEMANTIC_COLORS.success }}
              _focus={FOCUS_STYLES.ring}
              onClick={() => setView(vet ? 'first' : 'vet')}
            >
              view: {vet ? 'veteran' : 'first visit'}
            </Box>
          </HStack>

          <PointsCard />

          <Box mt={SPACING.base}>
            {role === 'borrow' && <BorrowRole />}
            {role === 'lend' && <LendRole />}
            {role === 'curate' && <CurateRole />}
          </Box>
        </Box>

        <DemoTour />
      </ExecProvider>
    </VeteranProvider>
  )
}

const SPACING_PX = { base: SPACING.base, md: SPACING.lg }

export default Position
