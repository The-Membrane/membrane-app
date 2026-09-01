import ConfirmModal from '@/components/ConfirmModal'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { HStack, Input, Stack, Text, VStack } from '@chakra-ui/react'
import { Card } from '@/components/ui/Card'
import { SliderWithState } from '../Mint/SliderWithState'
import Summary from './Summary'
import useBid from './hooks/useBid'
import useBidState from './hooks/useBidState'
import { ChangeEvent, useMemo, useState } from 'react'
import { num } from '@/helpers/num'
import { delayTime } from '@/config/defaults'
import { useQueue } from '@/hooks/useLiquidations'
import { useChainRoute } from '@/hooks/useChainRoute'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'

const PlaceBid = () => {
  const { bidState, setBidState } = useBidState()

  const txSuccess = () => {
    setBidState({ placeBid: { cdt: 0, premium: 0 } })
  }

  const bid = useBid({ txSuccess })
  const { data: queue } = useQueue(bidState?.selectedAsset)
  const { chainName } = useChainRoute()
  const cdt = useAssetBySymbol('CDT', chainName)
  const cdtBalance = useBalanceByAsset(cdt)
  const [inputAmount, setInputAmount] = useState(0);
  const [premiuminputAmount, setPremiumInputAmount] = useState(0);

  const maxPremium = queue?.max_premium

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    e.preventDefault()
    const newAmount = e.target.value

    if (num(newAmount).isGreaterThan(cdtBalance)) setInputAmount(parseInt(cdtBalance))
    else setInputAmount(parseInt(e.target.value))

    setTimeout(() => {
      if (num(newAmount).isGreaterThan(cdtBalance)) setBidState({ placeBid: { ...bidState?.placeBid, cdt: parseInt(cdtBalance) } })
      else setBidState({ placeBid: { ...bidState?.placeBid, cdt: parseInt(e.target.value) } })
    }, delayTime);
  }

  const handlePremiumInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    e.preventDefault()
    const newAmount = e.target.value

    if (num(newAmount).isGreaterThan(maxPremium ?? 10)) setPremiumInputAmount(parseInt(maxPremium ?? '10'))
    else setPremiumInputAmount(parseInt(e.target.value))

    setTimeout(() => {
      if (num(newAmount).isGreaterThan(maxPremium ?? 10)) setBidState({ placeBid: { ...bidState?.placeBid, premium: parseInt(maxPremium ?? '10') } })
      else setBidState({ placeBid: { ...bidState?.placeBid, premium: parseInt(e.target.value) } })
    }, delayTime);
  }

  const onCDTChange = (value: number) => {
    const existingBid = bidState?.placeBid || {}
    const placeBid = {
      ...existingBid,
      cdt: value,
    }
    setBidState({ ...bidState, placeBid })
    setInputAmount(value)
  }

  const onPremiumChange = (value: number) => {
    const existingBid = bidState?.placeBid || {}
    const placeBid = {
      ...existingBid,
      premium: value,
    }
    setBidState({ ...bidState, placeBid })
  }

  useMemo(() => { setPremiumInputAmount(bidState?.placeBid.premium) }, [bidState?.placeBid.premium])

  const isDisabled = (bidState?.placeBid?.cdt) === 0

  return (
    <Card variant="default" display="flex" flexDirection="column" alignItems="center" gap={SPACING.lg} w="full">
      <Text fontSize={TYPOGRAPHY.h2} fontWeight={TYPOGRAPHY.bold} color={SEMANTIC_COLORS.textPrimary}>
        Place Bid
      </Text>
      <HStack w="full" gap={SPACING.xl} mb={SPACING.sm} alignItems="flex-end">
        <Stack w="full" gap={SPACING.sm}>
          <HStack justifyContent="space-between">
            <Input
              width="49%"
              textAlign="center"
              placeholder="0"
              type="number"
              value={inputAmount}
              onChange={handleInputChange}
              transition={TRANSITIONS.all}
              _focus={FOCUS_STYLES.ring}
            />
            <Text fontSize={TYPOGRAPHY.body} fontWeight={TYPOGRAPHY.bold} color={SEMANTIC_COLORS.textPrimary}>
              CDT with
            </Text>
          </HStack>
          <SliderWithState
            value={bidState?.placeBid?.cdt}
            onChange={onCDTChange}
            min={0}
            max={Number(cdtBalance)}
          />
        </Stack>
        <Stack w="full" gap={SPACING.sm}>
          <HStack justifyContent="space-between">
            <Input
              width="38%"
              textAlign="center"
              placeholder="0"
              type="number"
              value={premiuminputAmount}
              onChange={handlePremiumInputChange}
              transition={TRANSITIONS.all}
              _focus={FOCUS_STYLES.ring}
            />
            <Text fontSize={TYPOGRAPHY.body} fontWeight={TYPOGRAPHY.bold} color={SEMANTIC_COLORS.textPrimary}>
              % Premium
            </Text>
          </HStack>
          <SliderWithState
            value={bidState?.placeBid?.premium}
            onChange={onPremiumChange}
            min={0}
            max={10}
          />
        </Stack>
      </HStack>
      <VStack gap={SPACING.lg} w="full">
        <Stack>
          <HStack justifyContent="space-between">
            <Text fontSize={TYPOGRAPHY.body} fontWeight={TYPOGRAPHY.bold} color={SEMANTIC_COLORS.textPrimary}>
              Single Asset Pool
            </Text>
            <Text fontSize={TYPOGRAPHY.body} fontWeight={TYPOGRAPHY.bold} color={SEMANTIC_COLORS.textPrimary}>
              0-{maxPremium}%
            </Text>
          </HStack>
          <Text fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary}>
            Bid to earn from liquidations of your chosen collateral in the order of descending premiums (i.e. 0% is first). There is a 1 hour waiting period that is handled automatically, so there is no need to activate your bid manually. If you bid too high a premium, other liquidators can undercut you so beware!
          </Text>
        </Stack>
        <Stack>
          <HStack justifyContent="space-between">
            <Text fontSize={TYPOGRAPHY.body} fontWeight={TYPOGRAPHY.bold} color={SEMANTIC_COLORS.textPrimary}>
              Omni Asset Pool
            </Text>
            <Text fontSize={TYPOGRAPHY.body} fontWeight={TYPOGRAPHY.bold} color={SEMANTIC_COLORS.textPrimary}>
              10%
            </Text>
          </HStack>
          <Text fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary}>
            Earn from every liquidation of every asset done at a non-zero premium. This is First In First Out with a 1 day unstaking period where your bid can still be used to liquidate. Get your bid in early then sit back and enjoy the flow of assets!
          </Text>
        </Stack>
      </VStack>
      <ConfirmModal label="Place Bid" action={bid} isDisabled={isDisabled}>
        <Summary />
      </ConfirmModal>
    </Card>
  )
}

export default PlaceBid
