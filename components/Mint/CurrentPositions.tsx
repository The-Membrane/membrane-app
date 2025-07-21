import { HStack, Stack, TabPanel, Card, Text, useBreakpointValue, Box, Collapse, IconButton, useDisclosure, Flex, Button } from '@chakra-ui/react'
import { useCurrentPosition } from './hooks/useCurrentPosition'
import React from 'react'
import { colors } from '@/config/defaults'
import { ChevronDownIcon } from '@chakra-ui/icons'

const CurrentPositions = () => {
  const stats = useCurrentPosition()
  const isMobile = useBreakpointValue({ base: true, xxs: true, xs: true, sm: true, md: true, lg: false })
  const { isOpen, onToggle } = useDisclosure();

  return (
    <Card
      boxShadow={"0 0 25px rgba(90, 90, 90, 0.5)"}
      minW={{ base: '100%', md: '363px' }}
      maxW={{ base: '100%', md: '363px' }}
      gap="12"
      h="max-content"
      px="2"
      alignSelf={{ base: 'center', md: 'flex-start' }}
      marginTop={{base: "3%", md: "0"}}
    >
      <Stack gap="5" padding="3%" paddingTop="0">
        <Text color={stats.health < 10 ? colors.alert : undefined} variant="title" textTransform={"none"} alignSelf="center" fontSize="xl" letterSpacing="1px" display="flex">
          Health: {Math.min(Math.max(0, stats.health), 100)}%
        </Text>


        <Button
          onClick={onToggle}
          rightIcon={<ChevronDownIcon
            transform={isOpen ? "rotate(180deg)" : "rotate(0deg)"}
            transition="transform 0.2s"
          />}
          size="lg"
          variant="ghost"
          aria-label="Toggle"
        >
          {isOpen ? "Collapse" : "Expand"}
        </Button>

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