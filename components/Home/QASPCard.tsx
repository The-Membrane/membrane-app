import { Card, Text, Stack, HStack, Input, Button } from "@chakra-ui/react"
import { TxButton } from "../TxButton"
import useSPCompound from "./hooks/useSPCompound"
import { useMemo, useState } from "react"
import EstimatedAPRLabel from "./EstimatedAPRLabel"

          
const SPCard = () => {
    const { action: compound } = useSPCompound()
    const [calcAPR, setCalcAPR] = useState(false)

    return (
        <Card>
          <Text variant="title" fontSize={"lg"} letterSpacing={"1px"}>Global Management</Text>
          <Stack>
            {/* <HStack>
              <Stack py="5" w="full" gap="3" mb={"0"} >
              <Text variant="body"> Max CDT to Loop </Text>
              <HStack>
                  <Input 
                    width={"40%"} 
                    textAlign={"center"} 
                    placeholder="0" 
                    type="number" 
                    value={earnState.loopMax ?? 0} 
                    onChange={handleInputChange}
                  />
                  <TxButton
                    maxW="75px"
                    isLoading={loop?.simulate.isLoading || loop?.tx.isPending}
                    isDisabled={loop?.simulate.isError || !loop?.simulate.data}
                    onClick={() => loop?.tx.mutate()}
                    toggleConnectLabel={false}
                    style={{ alignSelf: "end" }}
                  >
                    Loop
                  </TxButton>
              </HStack>
              </Stack>
            </HStack>            
            <HStack>
              <Stack py="5" w="full" gap="3" mb={"0"} >
              <Text variant="body"> Did you buy CDT {`<= $`}{num(basket?.credit_price.price??"0").multipliedBy(0.985).toFixed(3)}?</Text>
              <HStack>
                  <Input 
                    width={"40%"} 
                    textAlign={"center"} 
                    placeholder="0" 
                    type="number" 
                    value={earnState.redeemAmount ?? 0} 
                    max={CDTBalance}
                    onChange={handleRedeemInputChange}
                  />
                  <TxButton
                    maxW="75px"
                    isLoading={redeem?.simulate.isLoading || redeem?.tx.isPending}
                    isDisabled={redeem?.simulate.isError || !redeem?.simulate.data}
                    onClick={() => redeem?.tx.mutate()}
                    toggleConnectLabel={false}
                    style={{ alignSelf: "end" }}
                  >
                    Redeem
                  </TxButton>
                </HStack>
              </Stack>
            </HStack>     */}
              <Button onClick={() => setCalcAPR(true)}>Calc APR</Button>
              {calcAPR && <EstimatedAPRLabel />}
              {/* Compound normal SP Button*/}
              <TxButton
                maxW="100%"
                isLoading={compound?.simulate.isLoading || compound?.tx.isPending}
                isDisabled={compound?.simulate.isError || !compound?.simulate.data}
                onClick={() => compound?.tx.mutate()}
                toggleConnectLabel={false}
                style={{ alignSelf: "center" }}
              >
                Compound
              </TxButton>
          </Stack>
        </Card>
    )
}

export default SPCard