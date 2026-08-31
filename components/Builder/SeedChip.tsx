// Daily-challenge seed chip: today's seed, share link, seed loader + the seed book of
// previously run seeds. Proto: .seedchip markup (:471-486) + paintChip/renderSeedHistory/
// applySeed wiring (:2321-2500).

import React, { useState } from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { loadSeedBook } from './hooks/useBuilderStorage'
import { TINTS } from './styles'
import { fmtUTC } from './utils'
import { SeedBookEntry, SeedInfo } from './types'

const chipBtn = (practice: boolean) => ({
  bg: 'transparent',
  border: '1px solid',
  borderColor: practice ? TINTS.goldBorder : SEMANTIC_COLORS.borderStrong,
  color: practice ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.textSecondary,
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '9px',
  letterSpacing: '0.18em',
  textTransform: 'uppercase' as const,
  px: SPACING.sm,
  py: '4px',
  cursor: 'pointer',
  borderRadius: 0,
  transition: TRANSITIONS.colors,
  _hover: { color: SEMANTIC_COLORS.textPrimary, borderColor: SEMANTIC_COLORS.textPrimary },
  _focusVisible: FOCUS_STYLES.ring,
})

export interface SeedChipProps {
  seed: SeedInfo
  scenarioCount: number
  onApplySeed: (raw: string) => void
  onRandomize: () => void
  onBackToDaily: () => void
  challengeUrl: () => string
}

export const SeedChip: React.FC<SeedChipProps> = ({ seed, scenarioCount, onApplySeed, onRandomize, onBackToDaily, challengeUrl }) => {
  const [formOpen, setFormOpen] = useState(false)
  const [seedIn, setSeedIn] = useState('')
  const [shareLabel, setShareLabel] = useState('copy challenge link')
  const [book, setBook] = useState<SeedBookEntry[]>([])

  const openForm = () => {
    const next = !formOpen
    setFormOpen(next)
    if (next) {
      const bk = loadSeedBook()
      const list = Object.values(bk)
      list.sort((a, b) => (b.last || '').localeCompare(a.last || ''))
      setBook(list.slice(0, 8))
      setSeedIn('')
    }
  }

  const load = (raw: string) => {
    onApplySeed(raw)
    setFormOpen(false)
  }

  const share = () => {
    const u = challengeUrl()
    const flag = (t: string) => {
      setShareLabel(t)
      setTimeout(() => setShareLabel('copy challenge link'), 1600)
    }
    const fallback = () => {
      setFormOpen(true)
      setSeedIn(u)
      flag('copy blocked — link below')
    }
    try {
      navigator.clipboard.writeText(u).then(
        () => flag('copied'),
        () => fallback(),
      )
    } catch {
      fallback()
    }
  }

  const practice = !seed.isDaily

  return (
    <Box
      position="sticky"
      top={0}
      zIndex={60}
      mt={SPACING.base}
      bg={SEMANTIC_COLORS.bgPrimary}
      border="1px solid"
      borderColor={practice ? TINTS.goldBorder : SEMANTIC_COLORS.borderSubtle}
      px={SPACING.md}
      py={SPACING.sm}
      display="flex"
      flexWrap="wrap"
      alignItems="baseline"
      gap="6px 14px"
    >
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="9.5px"
        letterSpacing="0.24em"
        textTransform="uppercase"
        color={practice ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.success}
      >
        Challenge
      </Text>
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="10px"
        letterSpacing="0.16em"
        textTransform="uppercase"
        color={practice ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.textSecondary}
      >
        {seed.isDaily ? (
          <>
            {fmtUTC(new Date())} · seed{' '}
            <Text as="b" fontWeight={TYPOGRAPHY.normal} color={SEMANTIC_COLORS.textPrimary}>
              #{seed.id}
            </Text>{' '}
            · same floors for everyone today · new challenge at 00:00 UTC
          </>
        ) : (
          <>
            PRACTICE — UNRANKED · seed{' '}
            <Text as="b" fontWeight={TYPOGRAPHY.normal} color={SEMANTIC_COLORS.warning}>
              #{seed.id}
            </Text>{' '}
            · daily challenge is the ranked one
          </>
        )}
      </Text>
      <Box display="flex" gap="6px" flexWrap="wrap" ml="auto">
        <Box as="button" type="button" onClick={share} {...chipBtn(false)}>
          {shareLabel}
        </Box>
        <Box as="button" type="button" onClick={openForm} {...chipBtn(false)}>
          play a different challenge
        </Box>
        {practice && (
          <Box as="button" type="button" onClick={onBackToDaily} {...chipBtn(true)}>
            back to today’s challenge
          </Box>
        )}
      </Box>

      {formOpen && (
        <Box flexBasis="100%" display="flex" gap="6px" flexWrap="wrap" alignItems="center" borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} pt={SPACING.sm} mt="2px">
          <Box
            as="input"
            value={seedIn}
            placeholder="seed — e.g. A7F3, or any word"
            aria-label="Challenge seed"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSeedIn(e.target.value)}
            onKeyDown={(e: React.KeyboardEvent) => {
              if (e.key === 'Enter') load(seedIn)
            }}
            bg={TINTS.sunk}
            border="1px solid"
            borderColor={SEMANTIC_COLORS.borderStrong}
            color={SEMANTIC_COLORS.textPrimary}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="10.5px"
            letterSpacing="0.08em"
            px={SPACING.sm}
            py="5px"
            w="220px"
            borderRadius={0}
            sx={{ '&:focus-visible': { outline: `1px solid ${SEMANTIC_COLORS.success}`, outlineOffset: '2px' } }}
          />
          <Box as="button" type="button" onClick={() => load(seedIn)} {...chipBtn(false)}>
            load
          </Box>
          <Box as="button" type="button" onClick={() => { onRandomize(); setFormOpen(false) }} {...chipBtn(false)}>
            randomize
          </Box>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" letterSpacing="0.14em" textTransform="uppercase" color={SEMANTIC_COLORS.textTertiary}>
            any seed is replayable &amp; shareable · only the daily seed ranks
          </Text>
          <Box flexBasis="100%" display="flex" flexWrap="wrap" gap="6px" alignItems="center" borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} pt={SPACING.sm}>
            {book.length === 0 ? (
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" letterSpacing="0.14em" textTransform="uppercase" color={SEMANTIC_COLORS.textTertiary}>
                no seeds run yet — the ones you play collect here
              </Text>
            ) : (
              <>
                <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" letterSpacing="0.14em" textTransform="uppercase" color={SEMANTIC_COLORS.textTertiary}>
                  seeds you’ve run — tap to reload
                </Text>
                {book.map((e) => (
                  <Box key={e.id} as="button" type="button" onClick={() => load(e.id)} {...chipBtn(false)} letterSpacing="0.1em" textTransform="none">
                    #{e.id} · {e.label || '?'}
                    {e.best >= 0 ? ' · best ' + e.best + '/' + scenarioCount : ''}
                    {e.daily ? ' · daily ' + e.daily : ''}
                  </Box>
                ))}
              </>
            )}
          </Box>
        </Box>
      )}
    </Box>
  )
}

export default SeedChip
