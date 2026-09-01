import { num } from '@/helpers/num'
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
        Bidding on {premium === 10 ? 'All Assets' : null}
      </Text>
      <HStack>
        {premium !== 10 ? <><Image src={selectedAsset?.logo} w="30px" h="30px" />
          <Text textTransform="unset" fontSize={TYPOGRAPHY.body} color={SEMANTIC_COLORS.textPrimary}>
            {selectedAsset?.symbol}
          </Text></>
          : null}
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
        <Text textTransform="unset" fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary}>
          with {premium}% premium
        </Text>
      </HStack>
      <HStack>
        <Text fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textPrimary}>
          {num(amount).abs().toString()}
        </Text>
      </HStack>
    </HStack>
  </Stack>
)

const Summary = () => {
  const cdtAsset = useAssetBySymbol('CDT')
  const logo = getAssetLogo(cdtAsset!)
  const { bidState } = useBidState()
  const selectedAsset = bidState?.selectedAsset
  const { premium, cdt: amount } = bidState?.placeBid

  return (
    <Stack h="max-content" overflow="auto" w="full">
      <SummaryItem
        label={cdtAsset?.symbol!}
        badge="Bid"
        amount={amount}
        logo={logo}
        selectedAsset={selectedAsset}
        premium={premium}
      />
    </Stack>
  )
}

export default Summary
