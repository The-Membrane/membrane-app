import { HStack, Stack, TabPanel, Card, Text, useBreakpointValue, Box, Collapse, IconButton, useDisclosure, Flex, Icon } from '@chakra-ui/react'
import { useCurrentPosition } from './hooks/useCurrentPosition'
import React from 'react'
import { colors } from '@/config/defaults'
import { ChevronDownIcon } from '@chakra-ui/icons'

const CurrentPositions = () => {
  const stats = useCurrentPosition()
  const isMobile = useBreakpointValue({ base: true, xxs: true, xs: true, sm: true, md: true, lg: false })
  const { isOpen, onToggle } = useDisclosure();

  return (
    <Card boxShadow={"0 0 25px rgba(90, 90, 90, 0.5)"} minW="363px" gap="12" h="max-content" px="2" alignSelf={isMobile ? "center" : "undefined"}>
      <Stack gap="5" padding="3%" paddingTop="0">
        <Text color={stats.health < 10 ? colors.alert : undefined} variant="title" textTransform={"none"} alignSelf="center" fontSize="xl" letterSpacing="1px" display="flex">
          Health: {Math.min(Math.max(0, stats.health), 100)}%
        </Text>

        <Flex align="center" gap={1} transition="transform 0.2s">
          <Text fontSize="sm" color="gray.600">
            {isOpen ? "Collapse" : "Expand"}
          </Text>
          <Icon
            as={ChevronDownIcon}
            boxSize={4}
            transform={isOpen ? "rotate(180deg)" : "rotate(0deg)"}
            transition="transform 0.2s"
          />
        </Flex>

        <Collapse in={isOpen} animateOpacity>
          {stats.stats.map(({ label, value, textColor = 'white' }) => (
            <HStack key={label + value} justifyContent="space-between">
              <Text variant="lable" textTransform={"none"} letterSpacing={0}>{label}</Text>
              <Text variant="value" color={textColor}>{value}</Text>
            </HStack>
          ))}
        </Collapse>
      </Stack>

    </Card>
  )
}

export default CurrentPositions