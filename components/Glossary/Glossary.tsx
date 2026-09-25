import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'

import { GLOSSARY_GROUPS, GLOSSARY_TERMS, type GlossaryTerm } from './terms'

// Public glossary. Static content, server-rendered, one anchor per term so
// /ethereum/glossary#cooldown-tier is citable. Definitions live in ./terms.ts.

const Eyebrow: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text
    as="span"
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="10px"
    letterSpacing="0.24em"
    textTransform="uppercase"
    color={SEMANTIC_COLORS.textSecondary}
  >
    {children}
  </Text>
)

const TermRow: React.FC<{ t: GlossaryTerm }> = ({ t }) => (
  <Box
    as="dl"
    id={t.id}
    scrollMarginTop="80px"
    py={SPACING.md}
    borderTop="1px solid"
    borderColor={SEMANTIC_COLORS.borderSubtle}
    display={{ base: 'block', md: 'grid' }}
    gridTemplateColumns="220px 1fr"
    columnGap={SPACING.lg}
  >
    <Box as="dt">
      <Text
        as="a"
        href={`#${t.id}`}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.small}
        color={SEMANTIC_COLORS.textPrimary}
        _hover={{ textDecoration: 'underline' }}
      >
        {t.term}
      </Text>
      {t.alarmKind && (
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.textTertiary} mt="2px">
          {t.alarmKind}
        </Text>
      )}
    </Box>
    <Box as="dd" mt={{ base: SPACING.xs, md: 0 }}>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} lineHeight={1.7} color={SEMANTIC_COLORS.textSecondary}>
        {t.definition}
      </Text>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" letterSpacing="0.12em" color={SEMANTIC_COLORS.textTertiary} mt={SPACING.xs}>
        source · {t.source}
      </Text>
    </Box>
  </Box>
)

export const Glossary: React.FC = () => (
  <Box maxW="1140px" mx="auto" px={SPACING.base} py={SPACING.lg} bg={SEMANTIC_COLORS.bgPrimary} color={SEMANTIC_COLORS.textPrimary}>
    <Eyebrow>Reference</Eyebrow>
    <Text as="h1" fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h1} letterSpacing="-0.01em" mt={SPACING.xs}>
      Glossary
    </Text>
    <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textSecondary} mt={SPACING.sm} maxW="640px">
      The terms Radar, Strats, Carry and the venue alarms use, each measured from the code that computes it.
    </Text>

    {GLOSSARY_GROUPS.map((g, i) => (
      <Box as="section" key={g.id} id={`group-${g.id}`} mt={SPACING.xl}>
        <Box display="flex" alignItems="baseline" gap={SPACING.md} mb={SPACING.sm}>
          <Eyebrow>{String(i + 1).padStart(2, '0')} /</Eyebrow>
          <Text as="h2" fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h2} letterSpacing="-0.01em">
            {g.title}
          </Text>
        </Box>
        <Box borderBottom="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} borderRadius={0}>
          {GLOSSARY_TERMS.filter((t) => t.group === g.id).map((t) => (
            <TermRow key={t.id} t={t} />
          ))}
        </Box>
      </Box>
    ))}

    <Box as="footer" mt={SPACING.xl} pt={SPACING.md} borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" letterSpacing="0.12em" color={SEMANTIC_COLORS.textTertiary}>
        Data compiled by Membrane.
      </Text>
    </Box>
  </Box>
)

export default Glossary
