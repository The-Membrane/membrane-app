import React, { useEffect, useState } from 'react'
import { m, useMotionValue, useSpring } from 'framer-motion'

// Animated Counter Component using framer-motion
export const AnimatedCounter: React.FC<{ value: number; decimals?: number; prefix?: string; suffix?: string }> = ({
    value,
    decimals = 0,
    prefix = '',
    suffix = '',
}) => {
    const motionValue = useMotionValue(0)
    const spring = useSpring(motionValue, { stiffness: 50, damping: 30 })
    const [displayValue, setDisplayValue] = useState(0)

    useEffect(() => {
        motionValue.set(value)
    }, [value, motionValue])

    useEffect(() => {
        // spring.on returns its own unsubscribe handle — return it directly as cleanup.
        const unsubscribe = spring.on('change', (latest) => {
            setDisplayValue(latest)
        })
        return unsubscribe
    }, [spring])

    const formattedValue = decimals > 0
        ? parseFloat(displayValue.toFixed(decimals)).toLocaleString('en-US')
        : Math.round(displayValue).toLocaleString('en-US')

    return (
        <m.span
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5 }}
        >
            {prefix}
            {formattedValue}
            {suffix}
        </m.span>
    )
}
