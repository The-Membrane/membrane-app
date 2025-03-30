import React from 'react';

const AnimatedBorderImage = () => {
    const size = 65;
    const containerSize = size + 20;
    const borderWidth = 5;

    return (
        <div className="flex items-center justify-center">
            <div
                className="relative"
                style={{ width: containerSize, height: containerSize }}
            >
                <img
                    src="/api/placeholder/65/65"
                    alt="Logo"
                    style={{
                        position: 'absolute',
                        width: size,
                        height: size,
                        top: '50%',
                        left: '50%',
                        transform: 'translate(-50%, -50%)',
                        zIndex: 10
                    }}
                />
                <div
                    style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: '100%',
                        borderRadius: '50%',
                        border: `${borderWidth}px solid transparent`,
                        borderTopColor: '#3498db',
                        animation: 'spin 1.5s linear infinite'
                    }}
                />
                <style jsx>{`
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
        `}</style>
            </div>
        </div>
    );
};

export default AnimatedBorderImage;