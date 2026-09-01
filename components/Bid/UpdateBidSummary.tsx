import { num, shiftDigits } from '@/helpers/num'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { Badge, HStack, Image, Stack, Text } from '@chakra-ui/react'
import { Asset, getAssetLogo } from '@/helpers/chain'
import useBidState from './hooks/useBidState'
import { colors } from '@/config/defaults'
import { SPACING } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

type SummaryItemProps = Partial<Asset> & {
  label: string
  amount?: string | number
  showBadge?: boolean
  badge?: string
  logo?: string
  selectedAsset: Asset
  premium: number
}

const SummaryItem = ({
  label,
  amount = 0,
  badge,
  showBadge = true,
  logo,
  selectedAsset,
  premium,
}: SummaryItemProps) => (
  <Stack gap={SPACING.xl}>
    <Stack alignSelf="center">
      <Text textTransform="unset" fontSize={TYPOGRAPHY.body} color={SEMANTIC_COLORS.textPrimary}>
        Retracting bid on
      </Text>
      <HStack justifyContent="center">
        <Image src={selectedAsset?.logo} w="30px" h="30px" />
        <Text textTransform="unset" fontSize={TYPOGRAPHY.body} color={SEMANTIC_COLORS.textPrimary}>
          {selectedAsset?.symbol}
        </Text>
      </HStack>
    </Stack>

    <HStack
      key={label}
      justifyContent="space-between"
      pb={SPACING.xs}
      my={SPACING.xs}
      borderBottom="1px solid"
      borderColor={SEMANTIC_COLORS.borderMedium}
    >
      <HStack>
        <HStack>
          <Image src={logo} w="20px" h="20px" />
          <Text textTransform="unset" fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textPrimary}>
            {label}
          </Text>
        </HStack>

        <Badge fontSize={TYPOGRAPHY.label} colorScheme={colors.summaryScheme}>
          {badge}
        </Badge>
      </HStack>
      <HStack>
        <Text fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textPrimary}>
          {num(amount).abs().toString()}
        </Text>
      </HStack>
    </HStack>
  </Stack>
)

const UpdateBidSummary = () => {
  const cdtAsset = useAssetBySymbol('CDT')
  const logo = getAssetLogo(cdtAsset!)
  const { bidState } = useBidState()
  const selectedAsset = bidState?.selectedAsset
  const updateBids = bidState?.updateBids
  const newAmount = updateBids?.[0]?.newAmount
  const originalAmount = shiftDigits(updateBids?.[0]?.amount, -6).toString()
  const amountDiff = num(originalAmount).minus(newAmount).toNumber()
  const isClose = newAmount === 0

  return (
    <Stack h="max-content" overflow="auto" w="full">
      <SummaryItem
        label={cdtAsset?.symbol!}
        badge={isClose ? 'Cancle Bid' : 'Retract Bid'}
        amount={amountDiff}
        logo={logo}
        selectedAsset={selectedAsset}
      />
    </Stack>
  )
}

export default UpdateBidSummary
