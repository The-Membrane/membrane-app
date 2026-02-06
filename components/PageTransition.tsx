import React from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useRouter } from 'next/router'

interface PageTransitionProps {
    children: React.ReactNode
}

export const PageTransition: React.FC<PageTransitionProps> = ({ children }) => {
    const router = useRouter()

    return (
        <AnimatePresence mode="wait" initial={true}>
            <motion.div
                key={router.asPath}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{
                    duration: 0.4,
                    ease: [0.4, 0, 0.2, 1], // Custom easing for smooth fade
                }}
                style={{ 
                    width: '100%', 
                    minHeight: '100%',
                }}
            >
                {children}
            </motion.div>
        </AnimatePresence>
    )
}

