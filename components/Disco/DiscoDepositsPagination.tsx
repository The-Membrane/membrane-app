import React from 'react'
import { HStack, IconButton, Button } from '@chakra-ui/react'
import { ChevronLeftIcon, ChevronRightIcon } from '@chakra-ui/icons'
import { PRIMARY_PURPLE } from './DiscoDepositsShared'
import type { DiscoDepositsData } from './hooks/useDiscoDepositsData'

type DiscoDepositsPaginationProps = Pick<
    DiscoDepositsData,
    'depositCarouselData' | 'currentDepositIndex' | 'handlePrevDeposit' | 'handleNextDeposit' | 'handlePageClick'
>

export const DiscoDepositsPagination: React.FC<DiscoDepositsPaginationProps> = ({
    depositCarouselData,
    currentDepositIndex,
    handlePrevDeposit,
    handleNextDeposit,
    handlePageClick,
}) => {
    return (
        <HStack justify="center" spacing={4} mt={4}>
            <IconButton
                aria-label="Previous deposit"
                icon={<ChevronLeftIcon />}
                size="md"
                variant="ghost"
                color="white"
                bg="rgba(10, 10, 10, 0.8)"
                border="1px solid"
                borderColor={PRIMARY_PURPLE}
                _hover={{
                    bg: 'rgba(155, 220, 79, 0.2)',
                    borderColor: 'rgb(186, 166, 255)',
                }}
                onClick={handlePrevDeposit}
            />

            {/* Pagination dots */}
            <HStack spacing={2}>
                {depositCarouselData.map((deposit, index) => (
                    <Button
                        key={`${deposit.slot}-${deposit.depositId}`}
                        size="xs"
                        minW="10px"
                        h="10px"
                        p={0}
                        borderRadius="full"
                        bg={index === currentDepositIndex ? PRIMARY_PURPLE : "rgba(255, 255, 255, 0.3)"}
                        _hover={{
                            bg: index === currentDepositIndex ? 'rgb(186, 166, 255)' : 'rgba(255, 255, 255, 0.5)',
                        }}
                        onClick={() => handlePageClick(index)}
                        aria-label={`Go to deposit ${index + 1}`}
                    />
                ))}
            </HStack>

            <IconButton
                aria-label="Next deposit"
                icon={<ChevronRightIcon />}
                size="md"
                variant="ghost"
                color="white"
                bg="rgba(10, 10, 10, 0.8)"
                border="1px solid"
                borderColor={PRIMARY_PURPLE}
                _hover={{
                    bg: 'rgba(155, 220, 79, 0.2)',
                    borderColor: 'rgb(186, 166, 255)',
                }}
                onClick={handleNextDeposit}
            />
        </HStack>
    )
}
