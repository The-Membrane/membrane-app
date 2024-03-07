import { useState } from 'react'

interface PaginationProps<T> {
  currentPage: number
  totalPages: number
  setPage: (pageNumber: number) => void
  nextPage: () => void
  previousPage: () => void
  paginatedData: T[]
  isFirst: boolean
  isLast: boolean
}

interface Filter {
  [key: string]: any
}

const applySearchFilter = (item: T, search: string): boolean => {
  const matchesSearch = (value: any) =>
    typeof value === 'string' && value.toLowerCase().includes(search.toLowerCase())

  return Object.values(item).some(matchesSearch)
}

const applyCustomFilter = (item: T, filter: Filter): boolean => {
  const matchesFilter = (key: string) => item[key] === filter[key]

  return Object.keys(filter).every(matchesFilter)
}

const applyFilter = (item: T, filter?: Filter, search?: string): boolean => {
  if (search) {
    return applySearchFilter(item, search)
  }

  if (filter) {
    return applyCustomFilter(item, filter)
  }

  return true // No filter, include all items
}

export type Pagination<T> = {
  currentPage: number
  totalPages: number
  setPage: (pageNumber: number) => void
  nextPage: () => void
  previousPage: () => void
  paginatedData: T[]
  isFirst: boolean
  isLast: boolean
}

const usePagination = <T>(
  data: T[],
  pageSize: number,
  filter?: Filter,
  search?: string,
): PaginationProps<T> => {
  const [currentPage, setCurrentPage] = useState(1)

  const filteredData = data.filter((item) => applyFilter(item, filter, search))

  const totalPages = Math.ceil(filteredData.length / pageSize)

  const setPage = (pageNumber: number) => {
    if (pageNumber > 0 && pageNumber <= totalPages) {
      setCurrentPage(pageNumber)
    }
  }

  const nextPage = () => {
    if (currentPage < totalPages) {
      setCurrentPage(currentPage + 1)
    }
  }

  const previousPage = () => {
    if (currentPage > 1) {
      setCurrentPage(currentPage - 1)
    }
  }

  const isFirst = currentPage === 1
  const isLast = currentPage === totalPages

  const startIndex = (currentPage - 1) * pageSize
  const endIndex = startIndex + pageSize
  const paginatedData = filteredData.slice(startIndex, endIndex)

  return {
    currentPage,
    totalPages,
    setPage,
    nextPage,
    previousPage,
    paginatedData,
    isFirst,
    isLast,
  } as PaginationProps<T>
}

export default usePagination
