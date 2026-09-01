import React, { useCallback } from 'react'
import { Box, Text, Select } from '@chakra-ui/react'
import { SPACING } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { FOCUS_STYLES } from '@/config/transitions'
import type { SimConfig, SimEvent, UtilizationPoint } from './engine/types'
import { DEFAULT_CONFIG } from './engine/types'
import { PRESETS } from './presets'

interface SimControlsPresetsProps {
  onConfigChange: (config: SimConfig) => void
  onEventsChange: (events: SimEvent[]) => void
  onUtilizationChange: (curve: UtilizationPoint[]) => void
}

export const SimControlsPresets: React.FC<SimControlsPresetsProps> = ({
  onConfigChange,
  onEventsChange,
  onUtilizationChange,
}) => {
  // ── Preset selection ──
  const handlePreset = useCallback(
    (presetId: string) => {
      const preset = PRESETS.find((p) => p.id === presetId)
      if (!preset) return
      onConfigChange({ ...DEFAULT_CONFIG, ...preset.config })
      onEventsChange([...preset.events])
      onUtilizationChange([...preset.utilizationCurve])
    },
    [onConfigChange, onEventsChange, onUtilizationChange]
  )

  return (
    <Box>
      <Text
        fontSize={TYPOGRAPHY.label}
        textTransform="uppercase"
        color={SEMANTIC_COLORS.textTertiary}
        mb={SPACING.sm}
      >
        Preset Scenarios
      </Text>
      <Select
        placeholder="Select a scenario..."
        onChange={(e) => handlePreset(e.target.value)}
        bg={SEMANTIC_COLORS.borderSubtle}
        borderColor={SEMANTIC_COLORS.borderSubtle}
        _hover={{ borderColor: SEMANTIC_COLORS.borderStrong }}
        _focus={FOCUS_STYLES.ring}
        fontSize={TYPOGRAPHY.small}
      >
        {PRESETS.map((p) => (
          <option key={p.id} value={p.id} style={{ background: SEMANTIC_COLORS.bgSecondary }}>
            {p.label}
          </option>
        ))}
      </Select>
    </Box>
  )
}
