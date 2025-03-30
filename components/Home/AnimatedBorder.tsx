import React, { useState, useEffect } from 'react';

const AnimatedBorderImage = () => {
    const [rotation, setRotation] = useState(0);

    useEffect(() => {
        const interval = setInterval(() => {
            setRotation(prev => (prev + 2) % 360);
        }, 16); // ~60fps

        return () => clearInterval(interval);
    }, []);

    // Image dimensions
    const imageSize = 65;
    // Small gap between image and border
    const gap = 3;
    // Total size including the border
    const totalSize = imageSize + (gap * 2);

    return (
        <div className="flex items-center justify-center">
            <div className="relative" style={{ width: totalSize, height: totalSize }}>
                {/* The image */}
                <img
                    src="/api/placeholder/65/65"
                    alt="Logo"
                    className="absolute"
                    style={{
                        width: imageSize,
                        height: imageSize,
                        top: gap,
                        left: gap,
                        zIndex: 2
                    }}
                />

                {/* The spinning border */}
                <svg
                    className="absolute top-0 left-0"
                    width={totalSize}
                    height={totalSize}
                    viewBox={`0 0 ${totalSize} ${totalSize}`}
                >
                    <circle
                        cx={totalSize / 2}
                        cy={totalSize / 2}
                        r={(totalSize - 2) / 2}
                        fill="none"
                        stroke="#3498db"
                        strokeWidth={2}
                        strokeDasharray="20 40"
                        style={{
                            transformOrigin: 'center',
                            transform: `rotate(${rotation}deg)`,
                        }}
                    />
                </svg>
            </div>
        </div>
    );
};

export default AnimatedBorderImage;