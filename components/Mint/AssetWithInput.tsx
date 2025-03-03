import { HStack, useDisclosure, Text, Stack, Button, ModalOverlay, Modal, ModalContent, ModalFooter, ModalHeader, ModalCloseButton, ModalBody, Input, Tabs, TabList, Tab, TabIndicator, TabPanels } from "@chakra-ui/react";
import { AssetWithBalance } from "./hooks/useCombinBalance";
import useMintState from "./hooks/useMintState";
import { useEffect, useState } from "react";
import { num } from "@/helpers/num";
import { getSummary } from "@/helpers/mint";
import { colors } from "@/config/defaults";


export type AssetWithInputProps = {
  label: string;
  asset: AssetWithBalance;
};

type TabProps = {
  onClick: any
  label: string
}

const CustomTab = ({ onClick, label }: TabProps) => (
  <Tab zIndex={1} onClick={onClick} _selected={{ color: 'white' }}>
    {label}
  </Tab>
)

export const AssetWithInput = ({ asset, label }: AssetWithInputProps) => {
  const { mintState, setMintState } = useMintState();
  // const { isOpen: isDepositOpen, onOpen: onDepositOpen, onClose: onDepositClose } = useDisclosure();
  // const { isOpen: isWithdrawOpen, onOpen: onWithdrawOpen, onClose: onWithdrawClose } = useDisclosure();
  const [transactionValue, setTransactionValue] = useState('');
  const [transactionType, setTransactionType] = useState<string>("deposit");

  const [changeValue, setChangeValue] = useState(0);

  const handleTransaction = (transactionType: string, transactionValue: number) => {
    if (!transactionType) return;

    let updatedAssets = mintState.assets.map((a) => {
      if (a.symbol !== label) return a;

      const sliderValue = transactionType === "deposit" ? Number(transactionValue) : -Number(transactionValue);

      const diffInUsd = num(asset.depositUsdValue).minus(sliderValue).toNumber()
      const newDeposit = num(asset.depositUsdValue).minus(diffInUsd).toNumber()
      const amountValue = num(diffInUsd).isGreaterThan(asset.depositUsdValue)
        ? newDeposit
        : -diffInUsd
      const amount = num(amountValue).dividedBy(asset.price).dp(asset.decimal ?? 6).toNumber()
      //
      // setChangeValue(amountValue);
      //
      return {
        ...asset,
        amount,
        amountValue,
        sliderValue: sliderValue + asset.depositUsdValue,
      }
    });

    const { summary, totalUsdValue } = getSummary(updatedAssets);
    setMintState({ assets: updatedAssets, summary, totalUsdValue });
  };

  // const isAdditionDisabled = asset.walletsdValue === 0 || transactionValue === '';
  // const isSubtractionDisabled = asset.depositUsdValue === 0 || transactionValue === '';
  console.log("asset in withInput", asset);


  //Handle Reset Button
  useEffect(() => {
    setTransactionValue("");
  }, [mintState.reset]);

  // const onTabChange = (index: number) => {
  //   setMintState({ isTakeAction: index === 1 })
  // }
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const handleTabClick = (index: string) => {
    setActiveTabIndex(index === "deposit" ? 0 : 1);
    setTransactionType(index);
  };

  return (

    <Stack gap="0">
      <HStack justifyContent="space-between" alignItems={"baseline"}>
        <HStack>
          <Text >${(asset?.sliderValue ?? 0).toFixed(2)}</Text>
          <Text >{label}</Text>
          {/* <Text paddingLeft="5%" color={num(changeValue).isGreaterThan(0) ? "green.200" : "red.200"}>{changeValue != 0 ? changeValue > 0 ? `+$${changeValue.toFixed(2)}` : `-$${Math.abs(changeValue).toFixed(2)}` : ""}</Text> */}
        </HStack>
        <HStack width={"66%"} alignItems="undefined">
          <Stack gap="0">
            <Input
              type="number"
              placeholder="Enter amount"
              min={0}
              step="0.01"
              value={transactionValue}
              onChange={(e) => {
                e.preventDefault();
                setTransactionValue(String(Math.min(Number(e.target.value), (asset?.walletsdValue ?? 0))));
                handleTransaction(transactionType, Math.min(Number(e.target.value), (asset?.walletsdValue ?? 0)));
              }}
            />
            <HStack alignContent={"right"} width={"100%"} justifyContent={"right"} height={"3vh"}>
              <Button
                onClick={() => { setTransactionValue(transactionType === "deposit" ? String(asset.walletsdValue) : String(asset.depositUsdValue)); handleTransaction(transactionType, transactionType === "deposit" ? (asset.walletsdValue) : (asset.depositUsdValue)) }}
                width="10%" variant="unstyled" fontWeight="normal"
              >
                <Text
                  variant="body"
                  justifySelf={"center"}
                  textTransform="none"
                  fontSize="sm"
                  letterSpacing="1px"
                  display="flex"
                >
                  max
                </Text>
              </Button>
            </HStack>
          </Stack>
          <HStack width={"33%"} alignItems="undefined">
            <Stack gap="0">
              <Tabs position="relative" variant="unstyled" align="center" w="full" index={activeTabIndex}>
                <TabList bg="white" borderRadius="28px" color="black" w="fit-content">
                  <CustomTab onClick={() => handleTabClick("deposit")} label="Deposit" />
                  <CustomTab onClick={() => handleTabClick("withdraw")} label="Withdraw" />
                </TabList>

                <TabIndicator
                  top="0"
                  position="absolute"
                  height="40px"
                  bg={colors.walletIcon}
                  borderRadius="28px"
                />
                {/* <TabPanels paddingBottom={activeTabIndex === 1 ? 0 : 4}>
                <TakeAction />
                <LPTab />
              </TabPanels> */}
              </Tabs>
              {/* <Button
                // isDisabled={isAdditionDisabled}
                alignSelf={"center"}
                variant={"ghost"}
                width={"100%"}
                size="md"
                onClick={() => { setTransactionType('deposit'); }}
                opacity={transactionType === "deposit" ? 1 : 0.33}
              >
                Deposit
              </Button>
            </Stack>
            <Text alignSelf="undefined" fontSize="3.7vh">/</Text>
            <Stack gap="0">
              <Button
                // isDisabled={isSubtractionDisabled}
                alignSelf={"center"}
                variant={"ghost"}
                width={"100"}
                size="md"
                onClick={() => { setTransactionType('withdraw'); }}
                opacity={transactionType === "withdraw" ? 1 : 0.33}
              >
                Withdraw
              </Button> */}
            </Stack>
          </HStack>
        </HStack>

      </HStack>
    </Stack>
  );
};
