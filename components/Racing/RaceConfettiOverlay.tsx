import React from 'react';

interface RaceConfettiOverlayProps {
    confettiCanvasRef: React.RefObject<HTMLCanvasElement>;
}

const RaceConfettiOverlay: React.FC<RaceConfettiOverlayProps> = ({ confettiCanvasRef }) => {
    // `window` is not available during SSR — read the viewport size in an effect (client
    // only) so the initial server/client render matches (0×0), then track resizes.
    const [size, setSize] = React.useState({ width: 0, height: 0 });
    React.useEffect(() => {
        const update = () => setSize({ width: window.innerWidth, height: window.innerHeight });
        update();
        window.addEventListener('resize', update);
        return () => window.removeEventListener('resize', update);
    }, []);

    return (
        <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            pointerEvents: 'none',
            zIndex: 9999
        }}>
            <canvas
                ref={confettiCanvasRef}
                width={size.width}
                height={size.height}
                style={{
                    position: 'absolute',
                    top: 0,
                    left: 0
                }}
            />
        </div>
    );
};

export default RaceConfettiOverlay;
