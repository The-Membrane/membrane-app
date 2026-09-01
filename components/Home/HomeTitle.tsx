import { Button, HStack, List, ListItem, Modal, Image, ModalBody, ModalCloseButton, ModalContent, ModalHeader, ModalOverlay, Stack, Text } from '@chakra-ui/react'
import React, { PropsWithChildren, useCallback, useMemo, useState } from 'react'
import Divider from '../Divider'
import { colors } from '@/config/defaults'
import { useBasket } from '@/hooks/useCDP'
import { shiftDigits } from '@/helpers/math'
import { Formatter } from '@/helpers/formatter'
import { num } from '@/helpers/num'


// Extracted FAQ component to reduce main component complexity
const FAQ = React.memo(function FAQ({ isExpanded }: { isExpanded: boolean }) {
  if (!isExpanded) return null

  return (
    <List spacing={3} styleType="disc" padding="3%" paddingTop="0" paddingBottom="0">
      <Divider mt={2} />
      <Text variant="title" mb={1} letterSpacing={0} fontSize="md" color={colors.walletIcon}>
        Where does the yield come from?
      </Text>
      <ListItem fontFamily="var(--font-inter)" fontSize="md">
        It&apos;ll automatically open a loan and deposit the CDT into the Market Making vault which earns from distributed protocol revenue & price arbitrage.
      </ListItem>
      <Text variant="title" mb={1} letterSpacing={0} fontSize="md" color={colors.walletIcon}>
        Can I get liquidated?
      </Text>
      <ListItem fontFamily="var(--font-inter)" fontSize="md">
        Only if the smart contract malfunctions. Otherwise once the position&apos;s health hits 0%, your loan will be withdrawn from The Membrane LP and used to repay the debt.
      </ListItem>
      <Text variant="title" letterSpacing={0} fontSize="md" color={colors.walletIcon}>
        Why is the yield negative?
      </Text>
      <ListItem fontFamily="var(--font-inter)" fontSize="md">
        The APR is derived using the cost of the position. If the cost is higher than the yield, the yield will be negative. Because yield comes directly from revenue, negative yields are more common for high risk assets with low caps. Otherwise, costs will transfer to the yield and balance out. In other words, the collateral&apos;s cost must be way over the average cost for the yield to be negative.
      </ListItem>
      <Text variant="title" letterSpacing={0} fontSize="md" color={colors.walletIcon}>
        Who automates this? Is it centralized?
      </Text>
      <ListItem fontFamily="var(--font-inter)" fontSize="md">
        Compounds can be initiated by anyone in the Upper Management tab.
      </ListItem>
      <Text variant="title" letterSpacing={0} fontSize="md" color={colors.walletIcon}>
        Why can&apos;t I see my Guardian in the &quot;Your CDPs&quot; section?
      </Text>
      <ListItem fontFamily="var(--font-inter)" fontSize="md">
        You can see your Guardian&apos;s CDP on the Mint page to edit it precisely. It&apos;s not on the Home page to reduce confusion.
      </ListItem>
      <Text variant="title" letterSpacing={0} fontSize="md" color={colors.walletIcon}>
        Are there close fees?
      </Text>
      <ListItem fontFamily="var(--font-inter)" fontSize="md">
        No, the closure pulls funds from The Membrane vault to repay the debt. The only close fee you&apos;ll see is slippage from a swap to repay 1 CDT, a buffer left for easier executions.
      </ListItem>
    </List>
  )
})

export const FAQModal = React.memo(function FAQModal({
  isOpen, onClose, children
}: PropsWithChildren<{ isOpen: boolean, onClose: () => void }>) {

  return (<>
    {/* <Button onClick={() => { }} variant="unstyled" fontWeight="normal" mb="3">
      {children}
    </Button> */}

    <Modal isOpen={isOpen} onClose={onClose} closeOnOverlayClick={true}>
      <ModalOverlay />
      <ModalContent maxW="800px">
        <ModalHeader>
          <Text variant="title">Yield FAQ</Text>
        </ModalHeader>
        <ModalCloseButton />
        <ModalBody pb="5">
          <FAQ isExpanded={true} />
        </ModalBody>
        {/* {(
          <ModalFooter
            as={HStack}
            justifyContent="end"
            borderTop="1px solid"
            borderColor="whiteAlpha.200"
            pt="5"
            gap="5"
          >
            <ActionButtons
              proposal={proposal}
              isExecuteAllowed={isExecuteAllowed}
              isRemoveAllowed={isRemoveAllowed}
              isVoteAllowed={isVoteAllowed}
              isPending={isPending}
              vote={vote}
            />
          </ModalFooter>
        )} */}
      </ModalContent>
    </Modal>
  </>)
})


// Memoize child components
const HomeHeader = React.memo(function HomeHeader() {

  // const { data: basket } = useBasket()

  // const mintedAmount = useMemo(() => {
  //   return shiftDigits(num(basket?.credit_asset.amount).toString(), -6).dp(0).toNumber()
  // }, [basket])

  return (
    <Stack
      direction="column"
      gap="0.5rem"
      justifyContent="center"
      alignItems="center"
      mb="3%"
      textAlign="center"
    >
      <Text
        variant="title"
        letterSpacing="unset"
        fontSize={{ base: '2xl', md: '50px' }}
        textTransform="none"
      >
        Power the Indestructible Evolution of Money
      </Text>
      <Image src="/images/cdt.png" w={{ base: '50px', md: '65px' }} h={{ base: '70px', md: '90px' }} alignSelf="center" />
    </Stack>
  )
})

export const HomeTitle = React.memo(function HomeTitle() {

  return (
    <Stack gap={5}>
      <HStack mt="3%" mb="2%" gap="24" justifyContent="center">
        <Stack gap={"0.5rem"} width="100%">
          <HomeHeader />
          {/* <Button alignSelf="center" width="50%" minWidth="180px"
            onClick={() => setOpen(true)}>
            Add Funds to Osmosis
          </Button> */}
        </Stack>
      </HStack>
      {/* <OnboardModal isOpen={isOpen} setOpen={setOpen} /> */}
      {/* <Divider mx="0" mb="5" /> */}
    </Stack>
  )
})