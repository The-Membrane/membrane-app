import React, { useCallback } from 'react'
import {
  Text,
  VStack,
  HStack,
  Button,
  NumberInput,
  NumberInputField,
  IconButton,
  AccordionItem,
  AccordionButton,
  AccordionPanel,
  AccordionIcon,
} from '@chakra-ui/react'
import { AddIcon, DeleteIcon } from '@chakra-ui/icons'
import { SPACING } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { FOCUS_STYLES } from '@/config/transitions'
import type { UtilizationPoint } from './engine/types'

interface SimControlsUtilizationProps {
  utilizationCurve: UtilizationPoint[]
  onUtilizationChange: (curve: UtilizationPoint[]) => void
}

export const SimControlsUtilization: React.FC<SimControlsUtilizationProps> = ({
  utilizationCurve,
  onUtilizationChange,
}) => {
  // ── Utilization point management ──
  const addUtilPoint = useCallback(() => {
    const lastDay =
      utilizationCurve.length > 0
        ? utilizationCurve[utilizationCurve.length - 1].dayOffset + 5
        : 0
    onUtilizationChange([
      ...utilizationCurve,
      { dayOffset: lastDay, utilization: 0.5 },
    ])
  }, [utilizationCurve, onUtilizationChange])

  const removeUtilPoint = useCallback(
    (index: number) => {
      onUtilizationChange(utilizationCurve.filter((_, i) => i !== index))
    },
    [utilizationCurve, onUtilizationChange]
  )

  const updateUtilPoint = useCallback(
    (index: number, field: keyof UtilizationPoint, value: number) => {
      const updated = utilizationCurve.map((p, i) =>
        i === index ? { ...p, [field]: value } : p
      )
      onUtilizationChange(updated)
    },
    [utilizationCurve, onUtilizationChange]
  )

  return (
    <AccordionItem border="none">
      <AccordionButton
        px={0}
        _hover={{ bg: 'transparent' }}
      >
        <Text
          flex="1"
          textAlign="left"
          fontSize={TYPOGRAPHY.label}
          textTransform="uppercase"
          color={SEMANTIC_COLORS.textTertiary}
        >
          Utilization Curve ({utilizationCurve.length} pts)
        </Text>
        <AccordionIcon color={SEMANTIC_COLORS.textTertiary} />
      </AccordionButton>
      <AccordionPanel px={0} pb={SPACING.base}>
        <VStack spacing={SPACING.sm} align="stretch">
          {utilizationCurve.map((pt, i) => (
            <HStack key={`${pt.dayOffset}-${pt.utilization}`} spacing={SPACING.xs}>
              <Text
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textTertiary}
                w="30px"
              >
                Day
              </Text>
              <NumberInput
                value={pt.dayOffset}
                onChange={(_, v) =>
                  updateUtilPoint(i, 'dayOffset', isNaN(v) ? 0 : v)
                }
                size="sm"
                min={0}
                step={1}
                precision={1}
                w="70px"
              >
                <NumberInputField
                  bg={SEMANTIC_COLORS.borderSubtle}
                  borderColor={SEMANTIC_COLORS.borderSubtle}
                  _focus={FOCUS_STYLES.ring}
                  fontSize={TYPOGRAPHY.xs}
                  px={SPACING.xs}
                />
              </NumberInput>
              <Text
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textTertiary}
                w="30px"
              >
                Util
              </Text>
              <NumberInput
                value={pt.utilization}
                onChange={(_, v) =>
                  updateUtilPoint(i, 'utilization', isNaN(v) ? 0 : v)
                }
                size="sm"
                min={0}
                max={1}
                step={0.05}
                precision={2}
                flex={1}
              >
                <NumberInputField
                  bg={SEMANTIC_COLORS.borderSubtle}
                  borderColor={SEMANTIC_COLORS.borderSubtle}
                  _focus={FOCUS_STYLES.ring}
                  fontSize={TYPOGRAPHY.xs}
                  px={SPACING.xs}
                />
              </NumberInput>
              <IconButton
                aria-label="Remove point"
                icon={<DeleteIcon />}
                size="xs"
                variant="ghost"
                colorScheme="red"
                onClick={() => removeUtilPoint(i)}
              />
            </HStack>
          ))}
          <Button
            size="sm"
            variant="ghost"
            leftIcon={<AddIcon />}
            onClick={addUtilPoint}
            fontSize={TYPOGRAPHY.xs}
          >
            Add Point
          </Button>
        </VStack>
      </AccordionPanel>
    </AccordionItem>
  )
}
