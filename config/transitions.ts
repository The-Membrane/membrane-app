/**
 * Standardized Transitions & Animations
 *
 * Centralized system for all micro-interactions in the app.
 * Ensures consistent timing, easing, and animation patterns.
 *
 * Usage:
 * - Import individual transitions for specific use cases
 * - Use TRANSITIONS constants for Chakra UI components
 * - Use MOTION_VARIANTS for Framer Motion animations
 */

// ============================================
// TIMING & EASING
// ============================================

/**
 * Animation Duration Standards
 * - Instant: For immediate feedback (focus, hover color)
 * - Quick: For micro-interactions (button press, checkbox)
 * - Standard: Default for most transitions (modal, card hover)
 * - Slow: For larger movements (page transitions, slide-ins)
 * - Sluggish: For dramatic effects (rarely used)
 */
export const DURATION = {
  instant: '0.1s',
  quick: '0.2s',
  standard: '0.3s',
  slow: '0.5s',
  sluggish: '0.8s',
} as const

/**
 * Easing Functions
 * - easeOut: Natural deceleration (preferred for entrances)
 * - easeInOut: Smooth start and end (preferred for most transitions)
 * - spring: Bouncy, energetic (use sparingly for delight)
 */
export const EASING = {
  easeOut: 'cubic-bezier(0.16, 1, 0.3, 1)', // Natural deceleration
  easeInOut: 'cubic-bezier(0.4, 0, 0.2, 1)', // Smooth acceleration/deceleration
  spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)', // Slight bounce
  linear: 'linear',
} as const

// ============================================
// CHAKRA UI TRANSITIONS
// ============================================

/**
 * Pre-built transition strings for Chakra UI components
 * Use these with the `transition` prop
 */
export const TRANSITIONS = {
  // All properties (color, transform, shadow, etc.)
  all: `all ${DURATION.standard} ${EASING.easeInOut}`,
  allQuick: `all ${DURATION.quick} ${EASING.easeInOut}`,
  allSlow: `all ${DURATION.slow} ${EASING.easeOut}`,

  // Specific properties (more performant)
  transform: `transform ${DURATION.standard} ${EASING.easeInOut}`,
  transformQuick: `transform ${DURATION.quick} ${EASING.easeInOut}`,
  opacity: `opacity ${DURATION.standard} ${EASING.easeOut}`,
  opacityQuick: `opacity ${DURATION.quick} ${EASING.easeOut}`,
  color: `color ${DURATION.quick} ${EASING.easeInOut}`,
  background: `background-color ${DURATION.quick} ${EASING.easeInOut}`,
  shadow: `box-shadow ${DURATION.standard} ${EASING.easeOut}`,

  // Combined (comma-separated for multiple properties)
  transformAndOpacity: `transform ${DURATION.standard} ${EASING.easeInOut}, opacity ${DURATION.standard} ${EASING.easeOut}`,
  transformAndShadow: `transform ${DURATION.standard} ${EASING.easeInOut}, box-shadow ${DURATION.standard} ${EASING.easeOut}`,
} as const

// ============================================
// HOVER EFFECTS
// ============================================

/**
 * Standardized hover transforms
 * Use with `_hover` prop in Chakra UI
 */
export const HOVER_EFFECTS = {
  // Elevation - lift element up slightly
  lift: {
    transform: 'translateY(-2px)',
    transition: TRANSITIONS.transformAndShadow,
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
  },

  liftSubtle: {
    transform: 'translateY(-1px)',
    transition: TRANSITIONS.transformQuick,
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
  },

  // Scale - grow element slightly
  scale: {
    transform: 'scale(1.02)',
    transition: TRANSITIONS.transformAndShadow,
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.2)',
  },

  scaleSubtle: {
    transform: 'scale(1.01)',
    transition: TRANSITIONS.transform,
  },

  // Glow - add glowing border/shadow
  glow: {
    transition: TRANSITIONS.shadow,
    boxShadow: '0 0 20px rgba(166, 146, 255, 0.6)', // Primary purple glow
  },

  glowCyan: {
    transition: TRANSITIONS.shadow,
    boxShadow: '0 0 20px rgba(34, 211, 238, 0.6)', // Cyan glow
  },

  // Brightness - lighten element
  brighten: {
    transition: TRANSITIONS.allQuick,
    filter: 'brightness(1.1)',
  },

  // Border highlight
  borderHighlight: {
    transition: TRANSITIONS.all,
    borderColor: 'whiteAlpha.400',
  },
} as const

/**
 * Active (pressed) states
 * Use with `_active` prop in Chakra UI
 */
export const ACTIVE_EFFECTS = {
  press: {
    transform: 'translateY(0)', // Reset lift
    transition: TRANSITIONS.transformQuick,
  },

  pressDown: {
    transform: 'translateY(1px) scale(0.98)',
    transition: TRANSITIONS.transformQuick,
  },

  scaleDown: {
    transform: 'scale(0.98)',
    transition: TRANSITIONS.transformQuick,
  },
} as const

// ============================================
// FOCUS INDICATORS
// ============================================

/**
 * Accessible focus indicators
 * Use with `_focus` and `_focusVisible` props
 */
export const FOCUS_STYLES = {
  // Default focus ring (purple)
  ring: {
    outline: 'none',
    boxShadow: '0 0 0 3px rgba(166, 146, 255, 0.4)',
    transition: TRANSITIONS.shadow,
  },

  // Cyan focus ring
  ringCyan: {
    outline: 'none',
    boxShadow: '0 0 0 3px rgba(34, 211, 238, 0.4)',
    transition: TRANSITIONS.shadow,
  },

  // Subtle border highlight
  borderHighlight: {
    outline: 'none',
    borderColor: 'primary.400',
    transition: TRANSITIONS.all,
  },

  // Glow effect
  glow: {
    outline: 'none',
    boxShadow: '0 0 0 3px rgba(166, 146, 255, 0.3), 0 0 20px rgba(166, 146, 255, 0.2)',
    transition: TRANSITIONS.shadow,
  },
} as const

// ============================================
// FRAMER MOTION VARIANTS
// ============================================

/**
 * Reusable Framer Motion animation variants
 * Use with <motion.div variants={MOTION_VARIANTS.fadeIn} />
 */
export const MOTION_VARIANTS = {
  // Fade in from transparent
  fadeIn: {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: { duration: 0.3, ease: 'easeOut' },
    },
  },

  // Fade in and slide up
  fadeInUp: {
    hidden: { opacity: 0, y: 20 },
    visible: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.3, ease: 'easeOut' },
    },
  },

  // Fade in and slide down
  fadeInDown: {
    hidden: { opacity: 0, y: -20 },
    visible: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.3, ease: 'easeOut' },
    },
  },

  // Fade in and slide from left
  fadeInLeft: {
    hidden: { opacity: 0, x: -20 },
    visible: {
      opacity: 1,
      x: 0,
      transition: { duration: 0.3, ease: 'easeOut' },
    },
  },

  // Fade in and slide from right
  fadeInRight: {
    hidden: { opacity: 0, x: 20 },
    visible: {
      opacity: 1,
      x: 0,
      transition: { duration: 0.3, ease: 'easeOut' },
    },
  },

  // Scale in (grow from center)
  scaleIn: {
    hidden: { opacity: 0, scale: 0.9 },
    visible: {
      opacity: 1,
      scale: 1,
      transition: { duration: 0.3, ease: 'easeOut' },
    },
  },

  // Modal entrance (scale + fade)
  modalEntrance: {
    hidden: { opacity: 0, scale: 0.95, y: 10 },
    visible: {
      opacity: 1,
      scale: 1,
      y: 0,
      transition: { duration: 0.2, ease: 'easeOut' },
    },
    exit: {
      opacity: 0,
      scale: 0.95,
      y: 10,
      transition: { duration: 0.15, ease: 'easeIn' },
    },
  },

  // Slide in from bottom (mobile menu, toast)
  slideInBottom: {
    hidden: { y: '100%', opacity: 0 },
    visible: {
      y: 0,
      opacity: 1,
      transition: { duration: 0.3, ease: 'easeOut' },
    },
    exit: {
      y: '100%',
      opacity: 0,
      transition: { duration: 0.2, ease: 'easeIn' },
    },
  },

  // Stagger children (for lists)
  staggerContainer: {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.05,
        delayChildren: 0.1,
      },
    },
  },

  // Stagger child item
  staggerItem: {
    hidden: { opacity: 0, y: 10 },
    visible: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.3, ease: 'easeOut' },
    },
  },

  // Hover lift (for cards, buttons)
  hoverLift: {
    rest: { y: 0, scale: 1 },
    hover: {
      y: -4,
      scale: 1.02,
      transition: { duration: 0.2, ease: 'easeOut' },
    },
    tap: {
      y: 0,
      scale: 0.98,
      transition: { duration: 0.1 },
    },
  },

  // Pulse (for notifications, badges)
  pulse: {
    scale: [1, 1.05, 1],
    transition: {
      duration: 2,
      repeat: Infinity,
      ease: 'easeInOut',
    },
  },

  // Spin (for loading indicators)
  spin: {
    rotate: 360,
    transition: {
      duration: 1,
      repeat: Infinity,
      ease: 'linear',
    },
  },
} as const

// ============================================
// LOADING ANIMATIONS
// ============================================

/**
 * Loading state animations
 */
export const LOADING = {
  // Skeleton shimmer effect
  skeleton: {
    background: 'linear-gradient(90deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.15) 50%, rgba(255,255,255,0.05) 100%)',
    backgroundSize: '200% 100%',
    animation: 'shimmer 2s infinite',
  },

  // Spinner rotation
  spinner: {
    animation: 'spin 1s linear infinite',
  },

  // Pulse (fade in/out)
  pulse: {
    animation: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
  },
} as const

// ============================================
// TOAST ANIMATIONS
// ============================================

/**
 * Toast notification animations
 * Use with Chakra UI's useToast
 */
export const TOAST_MOTION = {
  // Slide in from right
  slideRight: {
    initial: { x: '100%', opacity: 0 },
    animate: { x: 0, opacity: 1 },
    exit: { x: '100%', opacity: 0 },
    transition: { duration: 0.3, ease: 'easeOut' },
  },

  // Slide in from top
  slideTop: {
    initial: { y: '-100%', opacity: 0 },
    animate: { y: 0, opacity: 1 },
    exit: { y: '-100%', opacity: 0 },
    transition: { duration: 0.3, ease: 'easeOut' },
  },

  // Scale in
  scaleIn: {
    initial: { scale: 0.8, opacity: 0 },
    animate: { scale: 1, opacity: 1 },
    exit: { scale: 0.8, opacity: 0 },
    transition: { duration: 0.2, ease: 'easeOut' },
  },
} as const

// ============================================
// KEYFRAMES (for CSS animations)
// ============================================

/**
 * CSS keyframes for animations
 * Add these to your global styles or theme
 */
export const KEYFRAMES = `
  @keyframes shimmer {
    0% { background-position: -200% 0; }
    100% { background-position: 200% 0; }
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  @keyframes slideInRight {
    from { transform: translateX(100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }

  @keyframes slideInLeft {
    from { transform: translateX(-100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes scaleIn {
    from { transform: scale(0.9); opacity: 0; }
    to { transform: scale(1); opacity: 1; }
  }
`

// ============================================
// USAGE EXAMPLES
// ============================================

/**
 * Example 1: Button with hover lift
 *
 * <Button
 *   transition={TRANSITIONS.transformAndShadow}
 *   _hover={HOVER_EFFECTS.lift}
 *   _active={ACTIVE_EFFECTS.press}
 *   _focus={FOCUS_STYLES.ring}
 * >
 *   Click me
 * </Button>
 */

/**
 * Example 2: Card with scale hover
 *
 * <Card
 *   transition={TRANSITIONS.all}
 *   _hover={HOVER_EFFECTS.scale}
 *   cursor="pointer"
 * >
 *   Card content
 * </Card>
 */

/**
 * Example 3: Animated entrance with Framer Motion
 *
 * <motion.div
 *   variants={MOTION_VARIANTS.fadeInUp}
 *   initial="hidden"
 *   animate="visible"
 * >
 *   Content
 * </motion.div>
 */

/**
 * Example 4: Staggered list
 *
 * <motion.div variants={MOTION_VARIANTS.staggerContainer} initial="hidden" animate="visible">
 *   {items.map(item => (
 *     <motion.div key={item.id} variants={MOTION_VARIANTS.staggerItem}>
 *       {item.name}
 *     </motion.div>
 *   ))}
 * </motion.div>
 */

/**
 * Example 5: Interactive card with Motion
 *
 * <motion.div
 *   variants={MOTION_VARIANTS.hoverLift}
 *   initial="rest"
 *   whileHover="hover"
 *   whileTap="tap"
 * >
 *   <Card>Card content</Card>
 * </motion.div>
 */
