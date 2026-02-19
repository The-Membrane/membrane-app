import React from 'react'
import {
  Box,
  Table,
  TableProps,
  Thead,
  Tbody,
  Tr,
  Th,
  Td,
  VStack,
  HStack,
  Text,
  useBreakpointValue,
} from '@chakra-ui/react'
import { Card } from './Card'

/**
 * Mobile Card Data Item
 */
export interface MobileCardDataItem {
  label: string
  value: React.ReactNode
  isHighlight?: boolean
}

/**
 * Mobile Card Props
 */
export interface MobileCardProps {
  data: MobileCardDataItem[]
  onClick?: () => void
  isSelected?: boolean
}

/**
 * MobileCard Component
 *
 * Displays table row data as a card on mobile devices.
 * Used as an alternative to table rows for better mobile UX.
 *
 * @example
 * ```tsx
 * <MobileCard
 *   data={[
 *     { label: 'Asset', value: <HStack><Image /><Text>ATOM</Text></HStack> },
 *     { label: 'TVL', value: '$1.2M' },
 *     { label: 'APY', value: '5.2%', isHighlight: true },
 *   ]}
 *   onClick={() => handleClick()}
 * />
 * ```
 */
export const MobileCard: React.FC<MobileCardProps> = ({
  data,
  onClick,
  isSelected,
}) => {
  return (
    <Card
      variant="default"
      p={4}
      mb={3}
      cursor={onClick ? 'pointer' : 'default'}
      onClick={onClick}
      bg={isSelected ? 'whiteAlpha.100' : 'rgba(10, 10, 10, 0.8)'}
      _hover={onClick ? { bg: 'whiteAlpha.150' } : undefined}
      transition="background 0.2s"
    >
      <VStack align="stretch" spacing={3}>
        {data.map((item, index) => (
          <HStack key={index} justify="space-between" align="flex-start">
            <Text
              fontSize="sm"
              color="whiteAlpha.600"
              fontWeight="medium"
              minW="100px"
            >
              {item.label}
            </Text>
            <Box
              flex={1}
              textAlign="right"
              color={item.isHighlight ? 'cyan.400' : 'white'}
              fontWeight={item.isHighlight ? 'bold' : 'normal'}
            >
              {item.value}
            </Box>
          </HStack>
        ))}
      </VStack>
    </Card>
  )
}

/**
 * ResponsiveTableContainer Props
 */
export interface ResponsiveTableContainerProps {
  /**
   * Desktop table content
   */
  desktopTable: React.ReactNode

  /**
   * Mobile cards content
   */
  mobileCards: React.ReactNode

  /**
   * Breakpoint at which to switch from mobile to desktop
   * @default 'md'
   */
  breakpoint?: 'sm' | 'md' | 'lg'
}

/**
 * ResponsiveTableContainer Component
 *
 * Container that switches between table and card layouts based on screen size.
 * Shows desktop table on larger screens, mobile cards on smaller screens.
 *
 * @example
 * ```tsx
 * <ResponsiveTableContainer
 *   desktopTable={
 *     <Table>
 *       <Thead>...</Thead>
 *       <Tbody>...</Tbody>
 *     </Table>
 *   }
 *   mobileCards={
 *     <>
 *       {data.map(item => (
 *         <MobileCard key={item.id} data={[...]} />
 *       ))}
 *     </>
 *   }
 * />
 * ```
 */
export const ResponsiveTableContainer: React.FC<ResponsiveTableContainerProps> = ({
  desktopTable,
  mobileCards,
  breakpoint = 'md',
}) => {
  const isMobile = useBreakpointValue({
    base: true,
    [breakpoint]: false,
  })

  if (isMobile) {
    return <Box>{mobileCards}</Box>
  }

  return <Box overflowX="auto">{desktopTable}</Box>
}

/**
 * Helper hook to determine if mobile card layout should be used
 */
export const useIsMobileTable = (breakpoint: 'sm' | 'md' | 'lg' = 'md'): boolean => {
  return useBreakpointValue({
    base: true,
    [breakpoint]: false,
  }) ?? false
}

export default ResponsiveTableContainer
