import { Pagination as PaginationType } from '@/hooks/usePagination'
import { ProposalResponse } from '@/services/governance'
import { ChevronLeftIcon, ChevronRightIcon } from '@chakra-ui/icons'
import { Button, HStack, IconButton, Text } from '@chakra-ui/react'
import {
  MdKeyboardArrowLeft,
  MdKeyboardArrowRight,
  MdKeyboardDoubleArrowLeft,
  MdKeyboardDoubleArrowRight,
} from 'react-icons/md'

type Props = Omit<PaginationType<ProposalResponse>, 'paginatedData'>

export const Pagination = ({
  totalPages,
  currentPage,
  setPage,
  nextPage,
  previousPage,
  isFirst,
  isLast,
}: Props) => {
  return (
    // <HStack w="fit-content" gap="1">
    //   <IconButton
    //     icon={<MdKeyboardDoubleArrowLeft size="20" />}
    //     aria-label="first page"
    //     size="sm"
    //     variant="unstyled"
    //     onClick={() => setPage(1)}
    //     isDisabled={isFirst}
    //     minW="unset"
    //   />
    //   <IconButton
    //     icon={<MdKeyboardArrowLeft size="20" />}
    //     aria-label="first page"
    //     size="sm"
    //     variant="unstyled"
    //     onClick={previousPage}
    //     isDisabled={isFirst}
    //     minW="unset"
    //   />

    //   <Text fontSize="14">{currentPage}</Text>

    //   <IconButton
    //     icon={<MdKeyboardArrowRight size="20" />}
    //     aria-label="first page"
    //     size="sm"
    //     variant="unstyled"
    //     onClick={nextPage}
    //     isDisabled={isLast}
    //     minW="unset"
    //   />
    //   <IconButton
    //     icon={<MdKeyboardDoubleArrowRight size="20" />}
    //     aria-label="first page"
    //     size="sm"
    //     variant="unstyled"
    //     onClick={() => setPage(totalPages)}
    //     isDisabled={isLast}
    //     minW="unset"
    //   />
    // </HStack>

    <HStack w="full" justifyContent="center" gap="3" p="2" borderRadius="md">
      <Button
        variant="ghost"
        size="sm"
        leftIcon={<ChevronLeftIcon />}
        w="fit-content"
        colorScheme="gray"
        onClick={previousPage}
        isDisabled={isFirst}
      >
        Previous
      </Button>
      <Text fontSize="sm" px="3" py="1" borderRadius="md" bg="whiteAlpha.300">
        {currentPage}
      </Text>
      <Text fontSize="sm">of {totalPages}</Text>
      <Button
        variant="ghost"
        size="sm"
        rightIcon={<ChevronRightIcon />}
        w="fit-content"
        colorScheme="gray"
        onClick={nextPage}
        isDisabled={isLast}
      >
        Next
      </Button>
    </HStack>
  )
}
