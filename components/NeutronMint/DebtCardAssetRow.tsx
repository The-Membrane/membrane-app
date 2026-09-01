import { num } from '@/helpers/num'
import {
  Box,
  Button,
  Collapse,
  Grid,
  HStack,
  Icon,
  Image,
  Menu,
  MenuButton,
  MenuItem,
  MenuList,
  Stack,
  Text,
  Tooltip,
} from '@chakra-ui/react'
import { ChevronDownIcon, ChevronUpIcon } from '@chakra-ui/icons'
import { HandCoins, Plus } from 'lucide-react'
import { DebtRowData } from './types'
import { GRID_COLUMNS } from './DebtCardConstants'
import { DebtCardSegments } from './DebtCardSegments'

export interface DebtAsset {
  symbol: string
  subtext?: string
  logo: string
  segments: DebtRowData[]
}

interface DebtCardAssetRowProps {
  asset: DebtAsset
  isExpanded: boolean
  onToggle: (symbol: string) => void
  onRepay?: (asset: string) => void
  onBorrowMore: (symbol: string) => void
  isBorrowDisabled: boolean
}

export const DebtCardAssetRow = ({
  asset,
  isExpanded,
  onToggle,
  onRepay,
  onBorrowMore,
  isBorrowDisabled,
}: DebtCardAssetRowProps) => {
  const totalAmount = asset.segments.reduce((acc, s) => acc + s.amount, 0)
  const weightedRate = totalAmount > 0
    ? asset.segments.reduce((acc, s) => acc + s.rate * s.amount, 0) / totalAmount
    : 0

  return (
    <Box>
      <Grid
        templateColumns={GRID_COLUMNS}
        gap={2}
        px={2}
        py={3}
        alignItems="center"
        _hover={{ bg: 'whiteAlpha.50' }}
        borderRadius="md"
      >
        {/* Asset */}
        <HStack spacing={2}>
          <Image
            src={asset.logo}
            alt={asset.symbol}
            w="24px"
            h="24px"
            borderRadius="full"
            fallbackSrc="/images/default-token.svg"
          />
          <Stack spacing={0}>
            <Text color="white" fontWeight="medium" fontSize="sm">
              {asset.symbol}
            </Text>
            {asset.subtext && (
              <Text color="whiteAlpha.500" fontSize="xs">
                {asset.subtext}
              </Text>
            )}
          </Stack>
        </HStack>

        {/* Debt amount */}
        <Stack spacing={0} alignItems="flex-end">
          <Text color="white" fontSize="sm" fontWeight="medium">
            ${num(totalAmount).toFixed(2)}
          </Text>
          <Text color="whiteAlpha.500" fontSize="xs">
            {num(totalAmount).toFixed(2)}
          </Text>
        </Stack>

        {/* Borrow APY */}
        <Text
          color={weightedRate > 0 ? 'red.400' : 'whiteAlpha.700'}
          fontSize="sm"
          textAlign="right"
        >
          {weightedRate > 0 ? `${weightedRate.toFixed(2)}%` : '-'}
        </Text>

        {/* Actions */}
        <HStack spacing={1} justify="flex-end">
          <Menu placement="bottom">
            <MenuButton
              as={Button}
              size="xs"
              variant="outline"
              colorScheme="purple"
              rightIcon={<ChevronDownIcon />}
              w="auto"
            >
              <Text pl={2}>Manage</Text>
            </MenuButton>
            <MenuList
              bg="rgba(10, 10, 10, 0.95)"
              borderColor="whiteAlpha.200"
              minW="auto"
              w="fit-content"
              py={0}
              overflow="hidden"
              borderRadius="md"
            >
              <MenuItem
                bg="transparent"
                _hover={{ bg: 'whiteAlpha.50' }}
                color="white"
                fontSize="sm"
                px={4}
                py={3}
                borderBottom="1px solid"
                borderColor="whiteAlpha.100"
                icon={<Icon as={HandCoins} w={4} h={4} color="whiteAlpha.600" />}
                onClick={() => onRepay?.(asset.symbol)}
              >
                Repay
              </MenuItem>
              <Tooltip
                label="LTV at max borrow limit"
                isDisabled={!isBorrowDisabled}
                placement="left"
              >
                <MenuItem
                  bg="transparent"
                  _hover={isBorrowDisabled ? {} : { bg: 'whiteAlpha.50' }}
                  color={isBorrowDisabled ? 'whiteAlpha.300' : 'white'}
                  fontSize="sm"
                  px={4}
                  py={3}
                  icon={<Icon as={Plus} w={4} h={4} color={isBorrowDisabled ? 'whiteAlpha.200' : 'whiteAlpha.600'} />}
                  onClick={() => !isBorrowDisabled && onBorrowMore(asset.symbol)}
                  cursor={isBorrowDisabled ? 'not-allowed' : 'pointer'}
                >
                  Borrow More
                </MenuItem>
              </Tooltip>
            </MenuList>
          </Menu>

          <Icon
            as={isExpanded ? ChevronUpIcon : ChevronDownIcon}
            color="whiteAlpha.600"
            w={5}
            h={5}
            cursor="pointer"
            onClick={() => onToggle(asset.symbol)}
            _hover={{ color: 'whiteAlpha.800' }}
          />
        </HStack>
      </Grid>

      {/* Expanded: rate segments */}
      <Collapse in={isExpanded} animateOpacity>
        <DebtCardSegments segments={asset.segments} totalAmount={totalAmount} />
      </Collapse>
    </Box>
  )
}
