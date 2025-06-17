import ConfirmModal from '@/components/ConfirmModal'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { Card, HStack, Input, Stack, Text, useColorModeValue } from '@chakra-ui/react'
import { SliderWithState } from '../Mint/SliderWithState'
import Summary from './Summary'
import useBid from './hooks/useBid'
import useBidState from './hooks/useBidState'
import { ChangeEvent, useMemo, useState } from 'react'
import { num } from '@/helpers/num'
import { delayTime } from '@/config/defaults'
import { useQueue } from '@/hooks/useLiquidations'

const PlaceBid = () => {
  const { bidState, setBidState } = useBidState()

  const txSuccess = () => {
    setBidState({ placeBid: { cdt: 0, premium: 0 } })
  }

  const bid = useBid({ txSuccess })
  const { data: queue } = useQueue(bidState?.selectedAsset)
  const cdt = useAssetBySymbol('CDT')
  const cdtBalance = useBalanceByAsset(cdt)
  const [inputAmount, setInputAmount] = useState(0);
  const [premiuminputAmount, setPremiumInputAmount] = useState(0);

  const maxPremium = queue?.max_premium

  const cardBg = useColorModeValue('#181F2A', '#232B3E')

  //CDT Input
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
  //Premium Input
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
  //Instead of changing the premium input amount on the slider, we useMemo to account for premium x-axis clicks
  useMemo(() => { setPremiumInputAmount(bidState?.placeBid.premium) }, [bidState?.placeBid.premium])


  const isDisabled = (bidState?.placeBid?.cdt) === 0

  return (
    <Card p={8} alignItems="center" gap={8} borderRadius="2xl" boxShadow="lg" w="full" bg={cardBg}>
      <Text variant="title" fontSize="2xl" fontWeight="bold" mb={2} color="white">
        Place Bid
      </Text>
      <HStack w="full" gap={10} mb={2} alignItems="flex-end">
        <Stack w="full" gap={2}>
          <HStack justifyContent="space-between">
            <Input
              width={"49%"}
              textAlign={"center"}
              placeholder="0"
              type="number"
              value={inputAmount}
              onChange={handleInputChange}
            />
            <Text fontSize="md" fontWeight="bold">
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
        <Stack w="full" gap={2}>
          <HStack justifyContent="space-between">
            <Input
              width={"38%"}
              textAlign={"center"}
              placeholder="0"
              type="number"
              value={premiuminputAmount}
              onChange={handlePremiumInputChange}
            />
            <Text fontSize="md" fontWeight="bold">
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
      <Stack gap={5} w="full">
        <Stack>
          <HStack justifyContent="space-between">
            <Text fontSize="md" fontWeight="bold">
              Single Asset Pool
            </Text>
            <Text fontSize="md" fontWeight="bold">
              0-{maxPremium}%
            </Text>
          </HStack>
          <Text fontSize="sm">
            Bid to earn from liquidations of your chosen collateral in the order of descending premiums (i.e. 0% is first). There is a 1 hour waiting period that is handled automatically, so there is no need to activate your bid manually. If you bid too high a premium, other liquidators can undercut you so beware!
          </Text>
        </Stack>
        <Stack>
          <HStack justifyContent="space-between">
            <Text fontSize="md" fontWeight="bold">
              Omni Asset Pool
            </Text>
            <Text fontSize="md" fontWeight="bold">
              10%
            </Text>
          </HStack>
          <Text fontSize="sm">
            Earn from every liquidation of every asset done at a non-zero premium. This is First In First Out with a 1 day unstaking period where your bid can still be used to liquidate. Get your bid in early then sit back and enjoy the flow of assets!
          </Text>
        </Stack>
      </Stack>
      <ConfirmModal label="Place Bid" action={bid} isDisabled={isDisabled}>
        <Summary />
      </ConfirmModal>
    </Card>
  )
}

export default PlaceBid
