import { Coin } from '@cosmjs/stargate'
import { getAssetByDenom } from '@/helpers/chain'
import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'
import { Asset } from '@/helpers/chain'
import { Badge, HStack, Image, Stack, Text } from '@chakra-ui/react'
import { colors } from '@/config/defaults'
import { useChainRoute } from '@/hooks/useChainRoute'
import { SPACING } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

type SummaryItemProps = Partial<Asset> & {
  label: string
  amount?: string | number
  showBadge?: boolean
  badge?: string
  logo?: string
  asset?: Asset
}

const SummaryItem = ({
  label,
  amount = 0,
  badge,
  showBadge = true,
  logo,
  asset,
}: SummaryItemProps) => (
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
        {asset?.isLP ? (
          <HStack>
            <Image src={asset?.logos?.[0]} w="24px" h="24px" />
            <Image src={asset?.logos?.[1]} w="24px" h="24px" ml="-16px" />
          </HStack>
        ) : (
          <Image src={asset?.logo} w="24px" h="24px" />
        )}
        <Text textTransform="unset" fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textPrimary}>
          {label}
        </Text>
      </HStack>

      {showBadge && (
        <Badge fontSize={TYPOGRAPHY.label} colorScheme={colors.summaryScheme}>
          {badge}
        </Badge>
      )}
    </HStack>
    <HStack>
      <Text fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textPrimary}>
        {num(amount).abs().toString()}
      </Text>
    </HStack>
  </HStack>
)

type Props = {
  claims?: Coin[]
}

export const ClaimSummary = ({ claims = [] }: Props) => {
  // Hoisted out of the .map below: route info is the same for every claim, and a Hook
  // must not be called inside a loop/callback (Rules of Hooks).
  const { chainName } = useChainRoute()
  return (
    <Stack h="max-content" overflow="auto" w="full">
      {claims.flatMap((claim) => {
        if (!num(claim.amount).isGreaterThan(0)) return []
        const asset = getAssetByDenom(claim.denom, chainName)
        const amount = shiftDigits(
          claim.amount,
          -asset?.decimal!,
        ).toNumber()
        return [
          <SummaryItem
            key={claim.denom}
            label={asset?.symbol!}
            amount={amount}
            badge="Claim"
            asset={asset}
          />,
        ]
      })}
    </Stack>
  )
}
