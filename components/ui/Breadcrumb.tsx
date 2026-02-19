import React from 'react'
import { Breadcrumb as ChakraBreadcrumb, BreadcrumbItem, BreadcrumbLink, Text, Icon } from '@chakra-ui/react'
import { ChevronRightIcon } from '@chakra-ui/icons'
import NextLink from 'next/link'
import { useRouter } from 'next/router'

export interface BreadcrumbSegment {
  label: string
  href?: string
  isCurrentPage?: boolean
}

export interface BreadcrumbProps {
  /**
   * Array of breadcrumb segments
   */
  segments?: BreadcrumbSegment[]

  /**
   * Auto-generate breadcrumbs from current route
   * @default false
   */
  auto?: boolean

  /**
   * Show home icon as first item
   * @default true
   */
  showHome?: boolean
}

/**
 * Breadcrumb Navigation Component
 *
 * Provides navigational context for nested pages.
 * Can auto-generate from route or use custom segments.
 *
 * @example
 * ```tsx
 * // Auto-generate from route
 * <Breadcrumb auto />
 *
 * // Custom segments
 * <Breadcrumb
 *   segments={[
 *     { label: 'Portfolio', href: '/portfolio' },
 *     { label: 'Position #123', isCurrentPage: true }
 *   ]}
 * />
 * ```
 */
export const Breadcrumb: React.FC<BreadcrumbProps> = ({
  segments: customSegments,
  auto = false,
  showHome = true,
}) => {
  const router = useRouter()

  // Generate segments from route if auto is true
  const autoSegments = React.useMemo(() => {
    if (!auto) return []

    const { chainName, ...params } = router.query
    const pathSegments = router.pathname.split('/').filter(Boolean)

    const result: BreadcrumbSegment[] = []

    // Add home if requested
    if (showHome) {
      result.push({
        label: 'Home',
        href: chainName ? `/${chainName}` : '/',
      })
    }

    // Build breadcrumb from path segments
    let currentPath = chainName ? `/${chainName}` : ''

    pathSegments.forEach((segment, index) => {
      // Skip [chain] param
      if (segment === '[chain]') return

      // Convert segment to label
      const label = segment
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')

      // Build path
      currentPath += `/${segment}`

      // Last segment is current page
      const isLast = index === pathSegments.length - 1

      result.push({
        label,
        href: isLast ? undefined : currentPath,
        isCurrentPage: isLast,
      })
    })

    return result
  }, [auto, router.pathname, router.query, showHome])

  const segments = customSegments || autoSegments

  if (segments.length === 0) return null

  return (
    <ChakraBreadcrumb
      spacing={2}
      separator={<Icon as={ChevronRightIcon} color="whiteAlpha.500" boxSize={3} />}
      fontSize="sm"
      mb={4}
    >
      {segments.map((segment, index) => (
        <BreadcrumbItem
          key={index}
          isCurrentPage={segment.isCurrentPage}
        >
          {segment.href && !segment.isCurrentPage ? (
            <BreadcrumbLink
              as={NextLink}
              href={segment.href}
              color="whiteAlpha.700"
              _hover={{ color: 'white', textDecoration: 'underline' }}
              transition="color 0.2s"
            >
              {segment.label}
            </BreadcrumbLink>
          ) : (
            <Text
              color={segment.isCurrentPage ? 'white' : 'whiteAlpha.700'}
              fontWeight={segment.isCurrentPage ? 'semibold' : 'normal'}
            >
              {segment.label}
            </Text>
          )}
        </BreadcrumbItem>
      ))}
    </ChakraBreadcrumb>
  )
}

export default Breadcrumb
