import { useEffect, useRef, useState } from 'react';

// Loads car sprite images (evil car for id '0', default for everything else,
// with a pixel-retro fallback) into a ref map and tracks which ids are ready.
export default function useCarSpriteImages() {
    // Load car sprite images
    const carImgRefs = useRef<Map<string, HTMLImageElement>>(new Map())
    const [carImagesLoaded, setCarImagesLoaded] = useState<Set<string>>(new Set())

    useEffect(() => {
        // Load images for different car types
        const carImages = [
            { id: '0', src: '/images/evil-retro-car.png' }, // Car ID 0 gets evil car
            { id: 'default', src: '/images/retro-car.png' } // All other cars get default
        ]

        let loadedCount = 0
        const totalImages = carImages.length

        carImages.forEach(({ id, src }) => {
            const img = new Image()
            img.src = src
            img.onload = () => {
                carImgRefs.current.set(id, img)
                setCarImagesLoaded(prev => new Set([...prev, id]))
                loadedCount++
                if (loadedCount === totalImages) {
                    // All car images loaded successfully
                }
            }
            img.onerror = () => {
                console.error(`Failed to load car image for ${id}: ${src}`)
                // Try to load fallback image
                const fallbackImg = new Image()
                fallbackImg.src = '/images/pixel-retro-car.png'
                fallbackImg.onload = () => {
                    carImgRefs.current.set(id, fallbackImg)
                    setCarImagesLoaded(prev => new Set([...prev, id]))
                    loadedCount++
                    if (loadedCount === totalImages) {
                        // All car images loaded successfully (with fallbacks)
                    }
                }
            }
        })
    }, [])

    return { carImgRefs, carImagesLoaded };
}
