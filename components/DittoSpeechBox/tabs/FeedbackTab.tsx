import React, { useState, useCallback } from 'react'
import {
  VStack,
  Box,
  Text,
  Textarea,
  Select,
  Button,
  FormControl,
  FormLabel,
  FormErrorMessage,
} from '@chakra-ui/react'
import { SPACING_PATTERNS } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { submitFeedbackToGithub, type FeedbackResult } from '@/helpers/submitFeedbackToGithub'

const CATEGORIES = ['bug', 'feature-request', 'ux', 'performance', 'other'] as const
const FEATURE_AREAS = ['disco', 'mint', 'transmuter', 'portfolio', 'swap', 'other'] as const

const inputStyles = {
  bg: 'rgba(10, 10, 10, 0.8)',
  borderColor: 'rgba(166, 146, 255, 0.25)',
  color: '#F5F5F5',
  fontSize: TYPOGRAPHY.small,
  _hover: { borderColor: 'rgba(166, 146, 255, 0.4)' },
  _focus: FOCUS_STYLES.ring,
  _placeholder: { color: '#F5F5F550' },
}

export const FeedbackTab: React.FC = () => {
  const [feedbackText, setFeedbackText] = useState('')
  const [category, setCategory] = useState('')
  const [featureArea, setFeatureArea] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [result, setResult] = useState<FeedbackResult | null>(null)
  const [attempted, setAttempted] = useState(false)

  const isValid =
    feedbackText.trim().length > 0 &&
    category !== '' &&
    featureArea !== ''

  const resetForm = useCallback(() => {
    setFeedbackText('')
    setCategory('')
    setFeatureArea('')
    setResult(null)
    setAttempted(false)
  }, [])

  const handleSubmit = useCallback(async () => {
    setAttempted(true)
    if (!isValid) return

    setIsSubmitting(true)
    setResult(null)

    const res = await submitFeedbackToGithub({
      feedback_text: feedbackText.trim(),
      category,
      feature_area: featureArea,
    })

    setResult(res)
    setIsSubmitting(false)
  }, [isValid, feedbackText, category, featureArea])

  // Success state
  if (result?.success) {
    return (
      <VStack spacing={SPACING_PATTERNS.stackSpacing} align="stretch" p={3} h="100%" justify="center">
        <Box
          bg="rgba(34, 211, 238, 0.1)"
          border="1px solid"
          borderColor={SEMANTIC_COLORS.success}
          borderRadius="md"
          p={SPACING_PATTERNS.cardPadding}
          textAlign="center"
        >
          <Text color={SEMANTIC_COLORS.success} fontSize={TYPOGRAPHY.body} fontWeight={TYPOGRAPHY.semibold} mb={1}>
            Feedback submitted
          </Text>
          <Text color={SEMANTIC_COLORS.textSecondary} fontSize={TYPOGRAPHY.xs}>
            Thank you for helping improve Membrane.
          </Text>
        </Box>
        <Button
          variant="ghost"
          color={SEMANTIC_COLORS.primary}
          size="sm"
          onClick={resetForm}
          transition={TRANSITIONS.all}
          _hover={HOVER_EFFECTS.borderHighlight}
          _focus={FOCUS_STYLES.ring}
        >
          Submit Another
        </Button>
      </VStack>
    )
  }

  return (
    <VStack spacing={SPACING_PATTERNS.formFieldGap} align="stretch" p={3} h="100%" overflowY="auto">
      <Text fontSize={TYPOGRAPHY.xs} color="#F5F5F580" fontWeight="medium" textTransform="uppercase" letterSpacing="wide">
        Share Feedback
      </Text>

      {/* Feedback text */}
      <FormControl isInvalid={attempted && feedbackText.trim().length === 0}>
        <FormLabel fontSize={TYPOGRAPHY.label} textTransform="uppercase" color={SEMANTIC_COLORS.textSecondary}>
          Feedback
        </FormLabel>
        <Textarea
          placeholder="Describe your feedback..."
          value={feedbackText}
          onChange={(e) => setFeedbackText(e.target.value)}
          rows={3}
          resize="none"
          {...inputStyles}
        />
        <FormErrorMessage color={SEMANTIC_COLORS.danger} fontSize={TYPOGRAPHY.xs}>
          Required
        </FormErrorMessage>
      </FormControl>

      {/* Category */}
      <FormControl isInvalid={attempted && category === ''}>
        <FormLabel fontSize={TYPOGRAPHY.label} textTransform="uppercase" color={SEMANTIC_COLORS.textSecondary}>
          Category
        </FormLabel>
        <Select
          placeholder="Select category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          {...inputStyles}
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c} style={{ background: '#15171E' }}>
              {c}
            </option>
          ))}
        </Select>
        <FormErrorMessage color={SEMANTIC_COLORS.danger} fontSize={TYPOGRAPHY.xs}>
          Required
        </FormErrorMessage>
      </FormControl>

      {/* Feature Area */}
      <FormControl isInvalid={attempted && featureArea === ''}>
        <FormLabel fontSize={TYPOGRAPHY.label} textTransform="uppercase" color={SEMANTIC_COLORS.textSecondary}>
          Feature Area
        </FormLabel>
        <Select
          placeholder="Select feature area"
          value={featureArea}
          onChange={(e) => setFeatureArea(e.target.value)}
          {...inputStyles}
        >
          {FEATURE_AREAS.map((f) => (
            <option key={f} value={f} style={{ background: '#15171E' }}>
              {f}
            </option>
          ))}
        </Select>
        <FormErrorMessage color={SEMANTIC_COLORS.danger} fontSize={TYPOGRAPHY.xs}>
          Required
        </FormErrorMessage>
      </FormControl>

      {/* Error message */}
      {result && !result.success && (
        <Box
          bg="rgba(239, 68, 68, 0.1)"
          border="1px solid"
          borderColor={SEMANTIC_COLORS.danger}
          borderRadius="md"
          p={2}
        >
          <Text color={SEMANTIC_COLORS.danger} fontSize={TYPOGRAPHY.xs}>
            {result.error}
          </Text>
        </Box>
      )}

      {/* Submit */}
      <Button
        bg={SEMANTIC_COLORS.primary}
        color="white"
        size="sm"
        isLoading={isSubmitting}
        loadingText="Submitting"
        onClick={handleSubmit}
        transition={TRANSITIONS.transformAndShadow}
        _hover={HOVER_EFFECTS.lift}
        _active={ACTIVE_EFFECTS.press}
        _focus={FOCUS_STYLES.ring}
      >
        Submit Feedback
      </Button>
    </VStack>
  )
}

export default FeedbackTab
