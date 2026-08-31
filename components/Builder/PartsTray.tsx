// Parts tray: templates, venue-class legend, and draggable venue tiles.
// Proto sections: .tray, paintTemplates (:813), paintLegend (:841), paintTiles (:852).

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { MockStamp } from '@/components/demo'

import { CLASS_COLOR, CLASS_NM, TEMPLATES, TILES } from './fixtures'
import { TileDrag } from './hooks/useTileDrag'
import { eyebrowPhos, monoXs, tabular } from './styles'
import { pct } from './utils'
import { VenueClass } from './types'

const LEGEND_WHY: Record<VenueClass, string> = {
  stable: 'one lending panic drains them together',
  lst: 'one staking queue shuts them all',
  synth: 'one funding flip reaches every one',
}

export interface PartsTrayProps {
  slots: (string | null)[]
  vet: boolean
  onTemplate: (i: number) => void
  onPlaceFree: (id: string) => void
  drag: TileDrag
}

export const PartsTray: React.FC<PartsTrayProps> = ({ slots, vet, onTemplate, onPlaceFree, drag }) => {
  const used = slots.filter(Boolean) as string[]
  return (
    <Box
      bg={SEMANTIC_COLORS.bgSecondary}
      borderRight={{ base: 'none', lg: '1px solid' }}
      borderBottom={{ base: '1px solid', lg: 'none' }}
      borderColor={{ base: SEMANTIC_COLORS.borderStrong, lg: SEMANTIC_COLORS.borderStrong }}
      p={SPACING.md}
      display="grid"
      gap={SPACING.sm}
      alignContent="start"
    >
      <Text {...eyebrowPhos}>Templates</Text>
      <Box display="grid" gap={SPACING.xs}>
        {TEMPLATES.map((t, i) => (
          <Box
            key={t.nm}
            as="button"
            type="button"
            title={t.doc}
            onClick={() => onTemplate(i)}
            textAlign="left"
            bg="transparent"
            border="1px solid"
            borderColor={SEMANTIC_COLORS.borderStrong}
            color={SEMANTIC_COLORS.textSecondary}
            px={SPACING.sm}
            py={SPACING.xs}
            cursor="pointer"
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="10.5px"
            transition={TRANSITIONS.colors}
            _hover={{ borderColor: SEMANTIC_COLORS.success, color: SEMANTIC_COLORS.success }}
            _focus={FOCUS_STYLES.ring}
            borderRadius={0}
          >
            <Text as="span" display="block" color={SEMANTIC_COLORS.textPrimary} fontSize="11px" fontFamily={TYPOGRAPHY.fontMono}>
              {t.nm}
            </Text>
            <Box as="span" {...tabular}>
              {(t.ltv * 100).toFixed(0)}% LTV · {t.slots.length} venues
            </Box>
          </Box>
        ))}
      </Box>

      <Text {...eyebrowPhos} mt={SPACING.xs}>
        Venues <MockStamp ml={SPACING.xs} />
      </Text>
      <Box display="grid" gap={SPACING.xs}>
        {(Object.keys(CLASS_COLOR) as VenueClass[]).map((k) => (
          <Box key={k} display="grid" gridTemplateColumns="10px 1fr" gap={SPACING.sm} alignItems="start">
            <Box w="10px" h="10px" mt="2px" bg={CLASS_COLOR[k]} />
            <Box fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" lineHeight={1.5} color={SEMANTIC_COLORS.textTertiary}>
              <Text as="span" display="block" letterSpacing="0.16em" textTransform="uppercase" color={CLASS_COLOR[k]}>
                {CLASS_NM[k]}
              </Text>
              {!vet && <Text as="span">{LEGEND_WHY[k]}</Text>}
            </Box>
          </Box>
        ))}
      </Box>
      {!vet && (
        <Text {...monoXs} lineHeight={1.5}>
          Drag onto a slot. Three per position — a contract limit, not a preference. Shocks travel by{' '}
          <Box as="em">what a venue holds</Box>, so three venues of the same class is one bet, not three.
        </Text>
      )}

      <Box display="grid" gap={SPACING.sm} gridTemplateColumns={{ base: 'repeat(auto-fill, minmax(150px, 1fr))', lg: '1fr' }}>
        {TILES.map((t) => {
          const isUsed = used.indexOf(t.id) >= 0
          const col = CLASS_COLOR[t.cls]
          return (
            <Box
              key={t.id}
              role={isUsed ? undefined : 'button'}
              aria-label={isUsed ? undefined : 'Place ' + t.nm}
              tabIndex={isUsed ? undefined : 0}
              border="1px solid"
              borderColor={SEMANTIC_COLORS.borderStrong}
              borderLeft={`3px solid ${col}`}
              bg={SEMANTIC_COLORS.bgTertiary}
              px={SPACING.sm}
              py={SPACING.sm}
              display="grid"
              gap="3px"
              cursor={isUsed ? 'not-allowed' : 'grab'}
              opacity={isUsed ? 0.32 : 1}
              userSelect="none"
              sx={{ touchAction: 'none' }}
              transition={TRANSITIONS.colors}
              _hover={isUsed ? undefined : { borderColor: SEMANTIC_COLORS.success }}
              _focusVisible={FOCUS_STYLES.ring}
              onPointerDown={isUsed ? undefined : (e) => drag.onTilePointerDown(t.id, t.nm, e)}
              onPointerMove={isUsed ? undefined : drag.onTilePointerMove}
              onPointerUp={isUsed ? undefined : drag.onTilePointerUp}
              onPointerCancel={isUsed ? undefined : drag.onTilePointerCancel}
              onKeyDown={
                isUsed
                  ? undefined
                  : (e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return
                      e.preventDefault()
                      onPlaceFree(t.id)
                    }
              }
            >
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11.5px" color={SEMANTIC_COLORS.textPrimary}>
                {t.nm}{' '}
                <Text as="span" color={col} fontSize="9px" letterSpacing="0.14em" textTransform="uppercase">
                  {CLASS_NM[t.cls]}
                </Text>
              </Text>
              <Box display="flex" justifyContent="space-between" gap={SPACING.sm} fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" {...tabular}>
                <Text as="span" color={SEMANTIC_COLORS.success}>
                  {(t.apr * 100).toFixed(1)}%
                </Text>
                <Text as="span" color={SEMANTIC_COLORS.textSecondary}>
                  recall {pct(t.liq)}
                </Text>
              </Box>
              {t.note && (
                <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" color={SEMANTIC_COLORS.textTertiary}>
                  {t.note}
                </Text>
              )}
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}

export default PartsTray
