import React, { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { Text } from '@react-three/drei'
import * as THREE from 'three'
import type { MarketNode } from '@/types/visualization'
import { DEFAULT_VIS_CONFIG } from '@/types/visualization'

interface HexDomeProps {
    market: MarketNode
    isSelected: boolean
    onClick: () => void
}

export const HexDome: React.FC<HexDomeProps> = ({
    market,
    isSelected,
    onClick,
}) => {
    const meshRef = useRef<THREE.Mesh>(null)
    const glowRef = useRef<THREE.Mesh>(null)

    // Create hexagon geometry
    const hexGeometry = useMemo(() => {
        const shape = new THREE.Shape()
        const radius = market.size
        const sides = 6

        for (let i = 0; i <= sides; i++) {
            const angle = (i * 2 * Math.PI) / sides
            const x = Math.cos(angle) * radius
            const y = Math.sin(angle) * radius
            if (i === 0) {
                shape.moveTo(x, y)
            } else {
                shape.lineTo(x, y)
            }
        }

        const extrudeSettings = {
            depth: market.size * 0.3,
            bevelEnabled: true,
            bevelThickness: 0.1,
            bevelSize: 0.1,
            bevelSegments: 3,
        }

        return new THREE.ExtrudeGeometry(shape, extrudeSettings)
    }, [market.size])

    // Animate pulse based on recent activity
    useFrame(({ clock }) => {
        if (meshRef.current) {
            const pulse = Math.sin(clock.elapsedTime * 2) * 0.1 + 1
            meshRef.current.scale.setScalar(pulse * (isSelected ? 1.2 : 1))
        }

        if (glowRef.current) {
            const glowPulse = Math.sin(clock.elapsedTime * DEFAULT_VIS_CONFIG.animations.glowPulse / 1000) * 0.3 + 0.7
            glowRef.current.material.opacity = market.glowIntensity * glowPulse
        }
    })

    const material = useMemo(() => {
        return new THREE.MeshStandardMaterial({
            color: market.color,
            emissive: market.color,
            emissiveIntensity: market.glowIntensity * 0.5,
            metalness: 0.8,
            roughness: 0.2,
            transparent: true,
            opacity: 0.9,
        })
    }, [market.color, market.glowIntensity])

    const glowMaterial = useMemo(() => {
        return new THREE.MeshStandardMaterial({
            color: market.color,
            emissive: market.color,
            emissiveIntensity: market.glowIntensity,
            transparent: true,
            opacity: market.glowIntensity * 0.3,
        })
    }, [market.color, market.glowIntensity])

    return (
        <group position={market.position}>
            {/* Glow sphere */}
            <mesh ref={glowRef} position={[0, 0, 0]}>
                <sphereGeometry args={[market.size * 1.5, 32, 32]} />
                <primitive object={glowMaterial} />
            </mesh>

            {/* Hex dome */}
            <mesh
                ref={meshRef}
                geometry={hexGeometry}
                material={material}
                onClick={onClick}
                onPointerOver={(e) => {
                    e.stopPropagation()
                    document.body.style.cursor = 'pointer'
                }}
                onPointerOut={() => {
                    document.body.style.cursor = 'default'
                }}
            />

            {/* Market label */}
            <Text
                position={[0, 0, market.size + 1]}
                fontSize={0.8}
                color={market.color}
                anchorX="center"
                anchorY="middle"
            >
                {market.name}
            </Text>

            {/* Risk indicator rings */}
            {market.risk > 0.5 && (
                <RingIndicator risk={market.risk} size={market.size} color={market.color} />
            )}
        </group>
    )
}

// Ring indicator for high-risk markets
const RingIndicator: React.FC<{ risk: number; size: number; color: string }> = ({
    risk,
    size,
    color,
}) => {
    const ringRef = useRef<THREE.Mesh>(null)

    useFrame(({ clock }) => {
        if (ringRef.current) {
            ringRef.current.rotation.z = clock.elapsedTime * 0.5
            const pulse = Math.sin(clock.elapsedTime * 3) * 0.2 + 1
            ringRef.current.scale.setScalar(pulse)
        }
    })

    return (
        <mesh ref={ringRef} position={[0, 0, size * 0.5]}>
            <ringGeometry args={[size * 1.2, size * 1.3, 32]} />
            <meshBasicMaterial color={color} transparent opacity={risk * 0.5} side={THREE.DoubleSide} />
        </mesh>
    )
}

