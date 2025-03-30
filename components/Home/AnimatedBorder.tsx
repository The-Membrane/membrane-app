import React from 'react';

interface AnimatedImageProps {
    imageSrc: string;
    imageAlt?: string;
    size?: number;
    borderWidth?: number;
    borderColor?: string;
    animationDuration?: number;
}

const AnimatedBorderImage: React.FC<AnimatedImageProps> = ({
    imageSrc,
    imageAlt = "Image",
    size = 65,
    borderWidth = 5,
    borderColor = "#3498db",
    animationDuration = 1.5
}) => {
    // Calculate container size (image size + border padding)
    const containerSize = size + 20;
    // Calculate radius for the circle
    const radius = containerSize / 2 - borderWidth / 2;
    // Calculate circumference
    const circumference = 2 * Math.PI * radius;
    // Calculate dash values (1/4 of the circle is visible)
    const dashArray = `${circumference / 4} ${circumference * 0.75}`;

    return (
        <div style={{
            position: 'relative',
            width: containerSize,
            height: containerSize,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center'
        }}>
            <img
                src={imageSrc}
                alt={imageAlt}
                style={{
                    width: size,
                    height: size,
                    position: 'relative',
                    zIndex: 2
                }}
            />
            <svg
                style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: containerSize,
                    height: containerSize,
                    animation: `rotate ${animationDuration}s linear infinite`
                }}
                viewBox={`0 0 ${containerSize} ${containerSize}`}
            >
                <circle
                    cx={containerSize / 2}
                    cy={containerSize / 2}
                    r={radius}
                    fill="none"
                    stroke={borderColor}
                    strokeWidth={borderWidth}
                    strokeLinecap="round"
                    strokeDasharray={dashArray}
                />
            </svg>
            <style jsx>{`
        @keyframes rotate {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>
        </div>
    );
};

export default AnimatedBorderImage;