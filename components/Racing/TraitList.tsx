import React, { useEffect, useMemo, useState } from 'react'
import { Box, Button, Divider, HStack, Text, VStack } from '@chakra-ui/react'
import type { CarAttribute } from '@/components/Racing/hooks/useMintCar'
import { generateRandomTraits } from '@/components/Racing/traitGenerator'

export type TraitListProps = {
  attributes?: CarAttribute[] | null
}

const sectionOrder = [
  'Color & Paint',
  'Lighting',
  'Body & Shape',
  'Exhaust & Engine',
  'Wheels',
  'Misc Flair',
  'Decal',
] as const

type SectionKey = typeof sectionOrder[number]

const sectionToTraits: Record<SectionKey, string[]> = {
  'Color & Paint': ['Base Color', 'Accent Pattern', 'Paint Finish'],
  Lighting: ['Headlight Color', 'Underglow', 'Brake Light Style'],
  'Body & Shape': ['Front Bumper', 'Spoiler', 'Roof', 'Fender'],
  'Exhaust & Engine': ['Exhaust Length', 'Exhaust Tip', 'Engine Visuals'],
  Wheels: ['Rim Style', 'Rim Color', 'Tire'],
  'Misc Flair': [
    'Number Font',
    'Roof Accessory',
    'Side Mirror',
    'Window Tint',
    'Window Tint Amount',
    'Trail Effect',
  ],
  Decal: ['Decal', 'Decal URL', 'Decal Scale', 'Decal Opacity'],
}

const COLOR_NAME_TO_HEX: Record<string, string> = {
  White: '#ffffff',
  Black: '#000000',
  Silver: '#c0c0c0',
  Gray: '#808080',
  Red: '#ff0000',
  Blue: '#0000ff',
  Green: '#008000',
  Orange: '#ffa500',
  Yellow: '#ffff00',
  Purple: '#800080',
  Teal: '#008080',
  Gold: '#ffd700',
  Chrome: '#c9c9c9',
  NeonGreen: '#39ff14',
  Pink: '#ff66cc',
}

function isColorTrait(label: string): boolean {
  return (
    label.includes('Color') ||
    label === 'Underglow' ||
    label === 'Rim Color' ||
    label === 'Base Color' ||
    label === 'Headlight Color'
  )
}

function extractColorHex(value: string): string | null {
  const hexMatch = value.match(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})/)
  if (hexMatch) {
    const hex = hexMatch[0]
    return hex.length === 4
      ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
      : hex
  }
  const name = (value.split(' ')[0] || '').trim()
  if (name && COLOR_NAME_TO_HEX[name]) return COLOR_NAME_TO_HEX[name]
  return null
}

const TraitRow = ({ label, value }: { label: string; value: string }) => {
  const showSwatch = isColorTrait(label)
  const hex = showSwatch ? extractColorHex(value) : null
  return (
    <HStack justify="space-between" borderBottom="1px dashed #2a3550" pb={2}>
      <Text fontFamily='"Press Start 2P", monospace' fontSize="11px" color="#b8c1ff">
        {label}
      </Text>
      {showSwatch && hex ? (
        <Box w="14px" h="14px" borderRadius={2} border="1px solid #2a3550" style={{ background: hex }} />
      ) : (
        <Text fontFamily='"Press Start 2P", monospace' fontSize="11px" color="#00ffea" textAlign="right">
          {value}
        </Text>
      )}
    </HStack>
  )
}

const TraitList: React.FC<TraitListProps> = ({ attributes }) => {
  const [items, setItems] = useState<CarAttribute[]>([])

  useEffect(() => {
    if (attributes && attributes.length) {
      setItems(attributes)
    } else {
      setItems(generateRandomTraits().attributes)
    }
  }, [attributes])

  const grouped = useMemo(() => {
    const byLabel = new Map(items.map((a) => [a.trait_type, a.value]))
    const tuples: Array<[SectionKey, Array<{ label: string; value: string }>]> = sectionOrder.map((section) => [
      section,
      sectionToTraits[section]
        .filter((label) => byLabel.has(label))
        .map((label) => ({ label, value: byLabel.get(label)! })),
    ])
    return tuples
  }, [items])

  const reroll = () => setItems(generateRandomTraits().attributes)

  return (
    <VStack align="start" spacing={3} p={4} border="2px solid #0033ff" bg="#0b0e17" borderRadius={6} minW="360px" maxW="460px">
      <HStack w="100%" justify="space-between">
        <Text fontFamily='"Press Start 2P", monospace' color="#fff" fontSize="14px">
          Potential Traits
        </Text>
        <Button onClick={reroll} size="xs" fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#0b0e17" bg="#00ffea" _hover={{ bg: '#00e0cc' }}>
          REROLL
        </Button>
      </HStack>

      <VStack align="stretch" spacing={4} w="100%" maxH="480px" overflowY="auto">
        {grouped.map(([section, rows], idx) => (
          <VStack key={section} align="stretch" spacing={2}>
            <Text fontFamily='"Press Start 2P", monospace' fontSize="12px" color="#00ffea">
              {section}
            </Text>
            {rows.map(({ label, value }) => (
              <TraitRow key={`${section}-${label}`} label={label} value={value} />
            ))}
            {idx < grouped.length - 1 && <Divider borderColor="#2a3550" />}
          </VStack>
        ))}
      </VStack>

      <Box>
        <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#b8c1ff">
          Traits are randomized on mint
        </Text>
      </Box>
    </VStack>
  )
}

export default TraitList 