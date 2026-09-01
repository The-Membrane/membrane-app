import React from 'react';
import { Text } from '@chakra-ui/react';

interface RaceCanvasProps {
    hasPreview: boolean;
    scaledW: number;
    scaledH: number;
    canvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
    selectedTrackId: string | undefined;
}

const RaceCanvas: React.FC<RaceCanvasProps> = ({ hasPreview, scaledW, scaledH, canvasRef, selectedTrackId }) => {
    return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingBottom: 24 }}>
            {hasPreview ? <div style={{
                position: 'relative',
                width: scaledW,
                height: scaledH,
                boxShadow: '0 0 18px #00ffea, inset 0 0 28px rgba(0, 255, 234, 0.15)',
                background: 'radial-gradient(ellipse at center, rgba(0,20,40,0.6) 0%, rgba(0,0,0,0.9) 70%)',
                overflow: 'hidden'
            }}>
                <div style={{ position: 'absolute', inset: 0, backgroundSize: '12px 12px', backgroundImage: 'linear-gradient(rgba(0, 51, 255, 0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(0, 51, 255, 0.07) 1px, transparent 1px)' }} />
                <canvas ref={canvasRef} style={{ position: 'relative', border: '0', width: scaledW, height: scaledH }} />
                <div style={{ position: 'absolute', inset: 0, backgroundImage: 'repeating-linear-gradient(0deg, rgba(255,255,255,0.05) 0px, rgba(255,255,255,0.05) 1px, transparent 3px, transparent 4px)', pointerEvents: 'none' }} />
            </div> :
                <Text opacity={0.5} color="white" fontFamily="Press Start 2P" fontSize="12px">
                    {selectedTrackId ? 'Select a car and run a race to see the playback' : 'Select a track to view'}
                </Text>
            }
        </div>
    );
};

export default RaceCanvas;
