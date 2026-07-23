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

  // Living Typeface canonical interaction transition: fast color/border shift, .15s.
  colors: `color 0.15s ${EASING.easeInOut}, border-color 0.15s ${EASING.easeInOut}, background-color 0.15s ${EASING.easeInOut}`,

  // Combined — kept for API compatibility. No transform/shadow motion in the new
  // system, so these now resolve to the same simple color/border transition.
  transformAndOpacity: `color 0.15s ${EASING.easeInOut}, border-color 0.15s ${EASING.easeInOut}, opacity ${DURATION.standard} ${EASING.easeOut}`,
  transformAndShadow: `color 0.15s ${EASING.easeInOut}, border-color 0.15s ${EASING.easeInOut}`,
} as const

// ============================================
// HOVER EFFECTS
// ============================================

/**
 * Standardized hover transforms
 * Use with `_hover` prop in Chakra UI
 */
// Living Typeface: NO translateY lift, NO glow, NO scale. Interaction is
// communicated through border + text color shifts only. Keys are preserved so
// the ~100 consuming components keep compiling; the VALUES no longer transform.
export const HOVER_EFFECTS = {
  // Was "lift" — now a hairline + ink shift (border brightens, text goes to full bone).
  lift: {
    transition: TRANSITIONS.colors,
    borderColor: 'rgba(236, 230, 216, 0.22)',
    color: '#ece6d8',
  },

  liftSubtle: {
    transition: TRANSITIONS.colors,
    borderColor: 'rgba(236, 230, 216, 0.22)',
  },

  // Was "scale" — now a phosphor border highlight (cards).
  scale: {
    transition: TRANSITIONS.colors,
    borderColor: '#9bdc4f',
  },

  scaleSubtle: {
    transition: TRANSITIONS.colors,
    borderColor: 'rgba(236, 230, 216, 0.22)',
  },

  // Was "glow" — now a phosphor border (special emphasis), no shadow.
  glow: {
    transition: TRANSITIONS.colors,
    borderColor: '#9bdc4f',
  },

  glowCyan: {
    transition: TRANSITIONS.colors,
    borderColor: '#46d39a',
  },

  // Brightness → ink brighten toward full bone (icon buttons).
  brighten: {
    transition: TRANSITIONS.colors,
    color: '#ece6d8',
  },

  // Border highlight — the canonical Living Typeface hover.
  borderHighlight: {
    transition: TRANSITIONS.colors,
    borderColor: 'rgba(236, 230, 216, 0.22)',
  },
} as const

/**
 * Active (pressed) states
 * Use with `_active` prop in Chakra UI
 */
// Living Typeface: pressed/selected state = phosphor border + phosphor text +
// raised bg. No translate, no scale. Keys preserved.
export const ACTIVE_EFFECTS = {
  press: {
    transition: TRANSITIONS.colors,
    borderColor: '#9bdc4f',
    color: '#9bdc4f',
    bg: '#100f12',
  },

  pressDown: {
    transition: TRANSITIONS.colors,
    borderColor: '#9bdc4f',
    color: '#9bdc4f',
    bg: '#100f12',
  },

  scaleDown: {
    transition: TRANSITIONS.colors,
    borderColor: '#9bdc4f',
    color: '#9bdc4f',
  },
} as const

// ============================================
// FOCUS INDICATORS
// ============================================

/**
 * Accessible focus indicators
 * Use with `_focus` and `_focusVisible` props
 */
// Living Typeface: focus = a crisp phosphor outline (not a blurred ring).
// A 2px solid outline with a small offset, plus a phos border. No box-shadow glow.
export const FOCUS_STYLES = {
  // Default focus indicator (phosphor)
  ring: {
    outline: '2px solid #9bdc4f',
    outlineOffset: '1px',
    boxShadow: 'none',
    borderColor: '#9bdc4f',
    transition: TRANSITIONS.colors,
  },

  // Alt accent focus (cyber teal)
  ringCyan: {
    outline: '2px solid #46d39a',
    outlineOffset: '1px',
    boxShadow: 'none',
    borderColor: '#46d39a',
    transition: TRANSITIONS.colors,
  },

  // Subtle border highlight (1px phos border, no outline)
  borderHighlight: {
    outline: 'none',
    borderColor: '#9bdc4f',
    transition: TRANSITIONS.colors,
  },

  // Was "glow" — now identical crisp phosphor outline, no shadow.
  glow: {
    outline: '2px solid #9bdc4f',
    outlineOffset: '1px',
    boxShadow: 'none',
    borderColor: '#9bdc4f',
    transition: TRANSITIONS.colors,
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

  // Was "hover lift" — Living Typeface has no lift/scale. Neutralized to a static
  // (color-driven) interaction so consumers using this variant no longer translate.
  hoverLift: {
    rest: { y: 0, scale: 1 },
    hover: {
      y: 0,
      scale: 1,
      transition: { duration: 0.15, ease: 'easeInOut' },
    },
    tap: {
      y: 0,
      scale: 1,
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
