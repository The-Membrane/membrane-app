import React from 'react'
import { Button, Text, Card } from '@chakra-ui/react'
import NextLink from 'next/link'

type Props = {
  label: string
  FeatureIcon: React.FC<{
    width: string
    height: string
  }>
  href: string
  ctaLabel: string
}

const FeatureCard = ({ label, FeatureIcon, href, ctaLabel }: Props) => {
  return (
    <Card w="256px" alignItems="center" justifyContent="space-between" p="8" gap="0">
      <Text variant="title" fontSize="16px">
        {label}
      </Text>

      <FeatureIcon width="140" height="auto" />

      <Button as={NextLink} href={href}>
        {ctaLabel}
      </Button>
    </Card>
  )
}

export default FeatureCard
