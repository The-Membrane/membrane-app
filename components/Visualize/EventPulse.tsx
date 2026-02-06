import React, { useRef, useMemo, useEffect, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { SystemEvent } from '@/types/visualization'
import { DEFAULT_VIS_CONFIG } from '@/types/visualization'

interface EventPulseProps {
    event: SystemEvent
    position: [number, number, number]
}

export const EventPulse: React.FC<EventPulseProps> = ({ event, position }) => {
    const [isActive, setIsActive] = useState(true)
    const pulseRef = useRef<THREE.Mesh>(null)
    const rippleRefs = useRef<THREE.Mesh[]>([])

    const eventColor = useMemo(() => {
        return DEFAULT_VIS_CONFIG.colors.event[event.type as keyof typeof DEFAULT_VIS_CONFIG.colors.event] || '#ffffff'
    }, [event.type])

    // Create ripple effect for liquidations
    useEffect(() => {
        if (event.type === 'liquidation') {
            const timer = setTimeout(() => {
                setIsActive(false)
            }, 3000)
            return () => clearTimeout(timer)
        }
    }, [event.type])

    useFrame(({ clock }) => {
        if (pulseRef.current && isActive) {
            const pulse = Math.sin(clock.elapsedTime * 5) * 0.3 + 1
            pulseRef.current.scale.setScalar(pulse * event.magnitude)
        }

        // Animate ripples for liquidations
        if (event.type === 'liquidation') {
            rippleRefs.current.forEach((ripple, index) => {
                if (ripple) {
                    const delay = index * 0.3
                    const elapsed = clock.elapsedTime - delay
                    if (elapsed > 0 && elapsed < 2) {
                        const scale = 1 + elapsed * 2
                        const opacity = Math.max(0, 1 - elapsed / 2)
                        ripple.scale.setScalar(scale)
                        if (ripple.material) {
                            (ripple.material as THREE.Material).opacity = opacity * 0.5
                        }
                    }
                }
            })
        }
    })

    const pulseMaterial = useMemo(() => {
        return new THREE.MeshBasicMaterial({
            color: eventColor,
            transparent: true,
            opacity: event.magnitude * 0.6,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
        })
    }, [eventColor, event.magnitude])

    if (!isActive && event.type !== 'liquidation') {
        return null
    }

    return (
        <group position={position}>
            {/* Main pulse sphere */}
            <mesh ref={pulseRef}>
                <sphereGeometry args={[0.5, 16, 16]} />
                <primitive object={pulseMaterial} />
            </mesh>

            {/* Ripple rings for liquidations */}
            {event.type === 'liquidation' && (
                <>
                    {[0, 1, 2].map((index) => (
                        <mesh
                            key={index}
                            ref={(el) => {
                                if (el) rippleRefs.current[index] = el
                            }}
                        >
                            <ringGeometry args={[0.5, 0.7, 32]} />
                            <primitive object={pulseMaterial} />
                        </mesh>
                    ))}
                </>
            )}
        </group>
    )
}

