import React, { useCallback } from 'react'
import {
  Text,
  VStack,
  HStack,
  Button,
  NumberInput,
  NumberInputField,
  Select,
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
import type { SimEvent } from './engine/types'

interface SimControlsEventsProps {
  events: SimEvent[]
  onEventsChange: (events: SimEvent[]) => void
}

export const SimControlsEvents: React.FC<SimControlsEventsProps> = ({
  events,
  onEventsChange,
}) => {
  // ── Event management ──
  const addEvent = useCallback(() => {
    onEventsChange([
      ...events,
      { dayOffset: 1, type: 'deposit', amount: 100_000_000 },
    ])
  }, [events, onEventsChange])

  const removeEvent = useCallback(
    (index: number) => {
      onEventsChange(events.filter((_, i) => i !== index))
    },
    [events, onEventsChange]
  )

  const updateEvent = useCallback(
    (index: number, field: keyof SimEvent, value: any) => {
      const updated = events.map((e, i) =>
        i === index ? { ...e, [field]: value } : e
      )
      onEventsChange(updated)
    },
    [events, onEventsChange]
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
          Events ({events.length})
        </Text>
        <AccordionIcon color={SEMANTIC_COLORS.textTertiary} />
      </AccordionButton>
      <AccordionPanel px={0} pb={SPACING.base}>
        <VStack spacing={SPACING.sm} align="stretch">
          {events.map((evt, i) => (
            <HStack key={`${evt.type}-${evt.dayOffset}-${evt.amount}`} spacing={SPACING.xs}>
              <Select
                value={evt.type}
                onChange={(e) =>
                  updateEvent(i, 'type', e.target.value)
                }
                size="sm"
                w="110px"
                bg={SEMANTIC_COLORS.borderSubtle}
                borderColor={SEMANTIC_COLORS.borderSubtle}
                _focus={FOCUS_STYLES.ring}
                fontSize={TYPOGRAPHY.xs}
              >
                <option
                  value="deposit"
                  style={{ background: SEMANTIC_COLORS.bgSecondary }}
                >
                  Deposit
                </option>
                <option
                  value="withdrawal"
                  style={{ background: SEMANTIC_COLORS.bgSecondary }}
                >
                  Withdraw
                </option>
              </Select>
              <NumberInput
                value={evt.dayOffset}
                onChange={(_, v) =>
                  updateEvent(i, 'dayOffset', isNaN(v) ? 0 : v)
                }
                size="sm"
                min={0}
                step={0.5}
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
              <Text fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textTertiary} whiteSpace="nowrap">
                d
              </Text>
              <NumberInput
                value={evt.amount}
                onChange={(_, v) =>
                  updateEvent(i, 'amount', isNaN(v) ? 0 : v)
                }
                size="sm"
                min={0}
                step={50_000_000}
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
                aria-label="Remove event"
                icon={<DeleteIcon />}
                size="xs"
                variant="ghost"
                colorScheme="red"
                onClick={() => removeEvent(i)}
              />
            </HStack>
          ))}
          <Button
            size="sm"
            variant="ghost"
            leftIcon={<AddIcon />}
            onClick={addEvent}
            fontSize={TYPOGRAPHY.xs}
          >
            Add Event
          </Button>
        </VStack>
      </AccordionPanel>
    </AccordionItem>
  )
}
