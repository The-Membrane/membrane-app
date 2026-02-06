import React, { useRef, useMemo, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import * as THREE from 'three'
import type { FlowEdge } from '@/types/visualization'
import { DEFAULT_VIS_CONFIG } from '@/types/visualization'

interface MyceliumTendrilProps {
    flow: FlowEdge
    source: [number, number, number]
    target: [number, number, number]
}

export const MyceliumTendril: React.FC<MyceliumTendrilProps> = ({
    flow,
    source,
    target,
}) => {
    const curveRef = useRef<THREE.CatmullRomCurve3 | null>(null)
    const tubeRef = useRef<THREE.Mesh>(null)
    const particlesRef = useRef<THREE.Points>(null)

    // Create curved path with some organic variation
    const curve = useMemo(() => {
        const midPoint: [number, number, number] = [
            (source[0] + target[0]) / 2 + (Math.random() - 0.5) * 5,
            (source[1] + target[1]) / 2 + (Math.random() - 0.5) * 5,
            (source[2] + target[2]) / 2 + (Math.random() - 0.5) * 3,
        ]

        const points = [
            new THREE.Vector3(...source),
            new THREE.Vector3(...midPoint),
            new THREE.Vector3(...target),
        ]

        return new THREE.CatmullRomCurve3(points)
    }, [source, target])

    curveRef.current = curve

    // Create tube geometry along the curve
    const tubeGeometry = useMemo(() => {
        const radius = 0.1 + flow.intensity * 0.3
        const segments = 50
        const radialSegments = 8

        return new THREE.TubeGeometry(curve, segments, radius, radialSegments, false)
    }, [curve, flow.intensity])

    // Create particle system for flow animation
    const particles = useMemo(() => {
        const count = Math.floor(flow.intensity * 20) + 5
        const positions = new Float32Array(count * 3)
        const colors = new Float32Array(count * 3)

        const color = new THREE.Color(flow.color)

        for (let i = 0; i < count; i++) {
            const t = i / count
            const point = curve.getPoint(t)
            positions[i * 3] = point.x
            positions[i * 3 + 1] = point.y
            positions[i * 3 + 2] = point.z

            colors[i * 3] = color.r
            colors[i * 3 + 1] = color.g
            colors[i * 3 + 2] = color.b
        }

        return { positions, colors }
    }, [curve, flow.intensity, flow.color])

    const [hovered, setHovered] = useState(false)

    // Get flow speed from metadata, or use default
    const flowSpeed = flow.metadata?.flowSpeed || DEFAULT_VIS_CONFIG.animations.flowSpeed

    // Animate particles flowing along the curve
    useFrame(({ clock }) => {
        if (particlesRef.current && flow.animated) {
            const positions = particlesRef.current.geometry.attributes.position.array as Float32Array
            const offset = (clock.elapsedTime * flowSpeed) % 1

            for (let i = 0; i < positions.length / 3; i++) {
                const t = (i / (positions.length / 3) + offset) % 1
                const point = curve.getPoint(t)
                positions[i * 3] = point.x
                positions[i * 3 + 1] = point.y
                positions[i * 3 + 2] = point.z
            }

            particlesRef.current.geometry.attributes.position.needsUpdate = true
        }
    })

    const material = useMemo(() => {
        return new THREE.MeshStandardMaterial({
            color: flow.color,
            emissive: flow.color,
            emissiveIntensity: flow.intensity * 0.3,
            transparent: true,
            opacity: flow.intensity * 0.6,
            side: THREE.DoubleSide,
        })
    }, [flow.color, flow.intensity])

    const particleMaterial = useMemo(() => {
        return new THREE.PointsMaterial({
            color: flow.color,
            size: 0.2,
            transparent: true,
            opacity: 0.8,
            blending: THREE.AdditiveBlending,
        })
    }, [flow.color])

    if (!flow.animated && flow.intensity < 0.1) {
        return null // Don't render very faint, non-animated flows
    }

    // Format hover tooltip data
    const tooltipContent = useMemo(() => {
        if (flow.id === 'transmuter_to_manic') {
            const usdcBalance = flow.metadata?.usdcBalance || 0
            const recentVolume = flow.metadata?.recentVolume || 0
            return (
                <div style={{
                    background: 'rgba(10, 10, 15, 0.95)',
                    border: '1px solid rgba(255, 0, 255, 0.5)',
                    borderRadius: '4px',
                    padding: '8px 12px',
                    color: '#ff00ff',
                    fontFamily: 'monospace',
                    fontSize: '12px',
                    pointerEvents: 'none',
                    whiteSpace: 'nowrap',
                }}>
                    <div><strong>Transmuter → Manic</strong></div>
                    <div>USDC Balance: ${(usdcBalance / 1e6).toFixed(2)}M</div>
                    <div>Recent Volume: ${(recentVolume / 1e6).toFixed(2)}M</div>
                    <div>Flow Speed: {flowSpeed.toFixed(2)}x</div>
                </div>
            )
        } else if (flow.id === 'manic_to_disco') {
            const annualRevenue = flow.metadata?.estimatedAnnualRevenue || 0
            return (
                <div style={{
                    background: 'rgba(10, 10, 15, 0.95)',
                    border: '1px solid rgba(138, 43, 226, 0.5)',
                    borderRadius: '4px',
                    padding: '8px 12px',
                    color: '#8a2be2',
                    fontFamily: 'monospace',
                    fontSize: '12px',
                    pointerEvents: 'none',
                    whiteSpace: 'nowrap',
                }}>
                    <div><strong>Manic → Disco</strong></div>
                    <div>Est. Annual Revenue: ${(annualRevenue / 1e6).toFixed(2)}M</div>
                    <div>Daily: ${((annualRevenue / 365) / 1e6).toFixed(2)}M</div>
                </div>
            )
        }
        return null
    }, [flow, flowSpeed])

    // Calculate midpoint for tooltip position
    const midpoint = useMemo(() => {
        const mid = curve.getPoint(0.5)
        return [mid.x, mid.y, mid.z] as [number, number, number]
    }, [curve])

    return (
        <group
            onPointerOver={() => setHovered(true)}
            onPointerOut={() => setHovered(false)}
        >
            {/* Main tendril tube */}
            <mesh
                ref={tubeRef}
                geometry={tubeGeometry}
                material={material}
            />

            {/* Flowing particles */}
            {flow.animated && (
                <points ref={particlesRef}>
                    <bufferGeometry>
                        <bufferAttribute
                            attach="attributes-position"
                            count={particles.positions.length / 3}
                            array={particles.positions}
                            itemSize={3}
                        />
                        <bufferAttribute
                            attach="attributes-color"
                            count={particles.colors.length / 3}
                            array={particles.colors}
                            itemSize={3}
                        />
                    </bufferGeometry>
                    <primitive object={particleMaterial} />
                </points>
            )}

            {/* Hover tooltip */}
            {hovered && tooltipContent && (
                <Html position={midpoint} center>
                    {tooltipContent}
                </Html>
            )}
        </group>
    )
}

