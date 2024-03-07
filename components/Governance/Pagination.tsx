import { ProposalResponse } from '@/contracts/codegen/governance/Governance.types'
import { Pagination as PaginationType } from '@/hooks/usePagination'
import { HStack, IconButton, Text } from '@chakra-ui/react'
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
    <HStack w="fit-content" gap="1">
      <IconButton
        icon={<MdKeyboardDoubleArrowLeft size="20" />}
        aria-label="first page"
        size="sm"
        variant="unstyled"
        onClick={() => setPage(1)}
        isDisabled={isFirst}
        minW="unset"
      />
      <IconButton
        icon={<MdKeyboardArrowLeft size="20" />}
        aria-label="first page"
        size="sm"
        variant="unstyled"
        onClick={previousPage}
        isDisabled={isFirst}
        minW="unset"
      />

      <Text fontSize="14">{currentPage}</Text>

      <IconButton
        icon={<MdKeyboardArrowRight size="20" />}
        aria-label="first page"
        size="sm"
        variant="unstyled"
        onClick={nextPage}
        isDisabled={isLast}
        minW="unset"
      />
      <IconButton
        icon={<MdKeyboardDoubleArrowRight size="20" />}
        aria-label="first page"
        size="sm"
        variant="unstyled"
        onClick={() => setPage(totalPages)}
        isDisabled={isLast}
        minW="unset"
      />
    </HStack>
  )
}
