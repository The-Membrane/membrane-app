// Calibration panel: Brier-scored forecast tracking, gated behind 20 resolved calls.
// Proto: .cal markup (:554-563) + paintCal (:1465) + the "Is it luck?" explainer (:542).

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { CAL_MIN } from './fixtures'
import { InfoDetails } from './GauntletStage'
import { TINTS, tabular } from './styles'
import { brier } from './utils'
import { Forecast } from './types'

export interface CalibrationPanelProps {
  forecasts: Forecast[]
  skipped: number
  onReset: () => void
}

export const CalibrationPanel: React.FC<CalibrationPanelProps> = ({ forecasts, skipped, onReset }) => {
  const n = forecasts.length
  const b = brier(forecasts)
  const locked = n < CAL_MIN
  const skill = b != null ? (0.25 - b) / 0.25 : 0

  return (
    <Box position={{ base: 'static', md: 'sticky' }} top={SPACING.md}>
      <InfoDetails title="Is it luck?" sr="How calibration is scored">
        Before each floor you post the odds your board holds. Afterwards the floor either sells bitcoin or it does not, and the gap
        between what you said and what happened is squared and averaged — that is a Brier score. Lower is better. 0.25 is what you
        get by always saying 50%, so the figure shown is how far past that you are: above zero means your confidence carries
        information, below it means you are sure about the wrong things. It stays hidden until 20 forecasts have resolved, because a
        score off five is noise wearing a decimal point.
      </InfoDetails>

      <Box border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} p={SPACING.base}>
        <Box display="flex" justifyContent="space-between" alignItems="baseline" gap={SPACING.sm} flexWrap="wrap">
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" letterSpacing="0.28em" textTransform="uppercase" color={SEMANTIC_COLORS.textSecondary}>
            {locked ? 'Calls made' : 'Better than a coin flip'}
          </Text>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="26px"
            {...tabular}
            color={
              locked
                ? SEMANTIC_COLORS.textPrimary
                : b != null && b < 0.25
                  ? SEMANTIC_COLORS.success
                  : b != null && b < 0.3
                    ? SEMANTIC_COLORS.warning
                    : SEMANTIC_COLORS.danger
            }
          >
            {locked ? n + ' / ' + CAL_MIN : (skill >= 0 ? '+' : '−') + Math.abs(skill * 100).toFixed(0) + '%'}
          </Text>
        </Box>
        <Box h="3px" bg={TINTS.sunk} my={SPACING.sm} mb={SPACING.xs}>
          <Box
            h="100%"
            w={locked ? (n / CAL_MIN) * 100 + '%' : Math.min(100, ((b || 0) / 0.5) * 100) + '%'}
            bg={locked ? SEMANTIC_COLORS.warning : b != null && b < 0.25 ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger}
          />
        </Box>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10.5px" color={SEMANTIC_COLORS.textTertiary} letterSpacing="0.06em">
          {locked
            ? n === 0
              ? 'Call a floor before it runs and this starts answering.'
              : CAL_MIN - n + ' more and you find out whether you actually know' + (skipped ? '  ·  ' + skipped + ' skipped' : '')
            : n +
              ' resolved — ' +
              (b != null && b < 0.15
                ? 'well calibrated; your confidence carries information'
                : b != null && b < 0.25
                  ? 'beating the coin flip'
                  : b != null && b < 0.3
                    ? 'no better than answering 50% every time'
                    : 'confident about the wrong things') +
              '  ·  Brier ' +
              (b || 0).toFixed(3)}
        </Text>
        <Box>
          {forecasts
            .slice(-8)
            .reverse()
            .map((f, i) => {
              const loss = (f.p - f.o) * (f.p - f.o)
              return (
                <Box key={i} display="grid" gridTemplateColumns="1fr auto auto" gap={SPACING.sm} fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" {...tabular} py="5px" borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} color={SEMANTIC_COLORS.textSecondary} mt={i === 0 ? SPACING.sm : 0}>
                  <Text as="span">{f.nm}</Text>
                  <Text as="span" color={SEMANTIC_COLORS.textPrimary}>
                    said {(f.p * 100).toFixed(0)}%
                  </Text>
                  <Text as="span" color={loss < 0.25 ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger}>
                    {f.o ? 'held' : 'sold'} · {(Math.abs(f.p - f.o) * 100).toFixed(0)} pts off
                  </Text>
                </Box>
              )
            })}
        </Box>
        <Box
          as="button"
          type="button"
          onClick={onReset}
          w="100%"
          mt={SPACING.sm}
          bg="transparent"
          border="1px solid"
          borderColor={SEMANTIC_COLORS.borderSubtle}
          color={SEMANTIC_COLORS.textTertiary}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="9px"
          letterSpacing="0.18em"
          textTransform="uppercase"
          py="7px"
          cursor="pointer"
          borderRadius={0}
          transition={TRANSITIONS.colors}
          _hover={{ borderColor: SEMANTIC_COLORS.danger, color: SEMANTIC_COLORS.danger }}
          _focusVisible={FOCUS_STYLES.ring}
        >
          Reset my calls
        </Box>
      </Box>
    </Box>
  )
}

export default CalibrationPanel
