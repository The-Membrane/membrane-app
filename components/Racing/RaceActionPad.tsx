import React from 'react';
import { Text } from '@chakra-ui/react';

interface RaceActionPadProps {
    tickDisplay: number;
    log: any;
    availableTracks: any[] | undefined;
    selectedTrackId: string | undefined;
    hasPreview: boolean;
    lastActionDisplay: string;
}

const RaceActionPad: React.FC<RaceActionPadProps> = ({
    tickDisplay,
    log,
    availableTracks,
    selectedTrackId,
    hasPreview,
    lastActionDisplay,
}) => {
    return (
        <>
            <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 8, background: '#0a0f1e' }}>
                <Text fontFamily='"Press Start 2P", monospace' fontSize="10px" color="#b8c1ff" pt="0.5%">
                    Action: {tickDisplay}/{Math.max(0, (log?.length ?? 0) - 1)} | Fastest Possible: {(() => {
                        if (availableTracks && selectedTrackId) {
                            const selectedTrack = availableTracks.find((t: any) => t.id === selectedTrackId);
                            if (selectedTrack?.fastest_tick_time) {
                                return selectedTrack.fastest_tick_time;
                            }
                        }
                        return 'N/A';
                    })()}
                </Text>
            </div>
            <div style={{ opacity: hasPreview ? 1 : 0.5, display: 'flex', justifyContent: 'center', padding: '16px 0', background: '#0a0f1e' }}>
                <div className="gameboy-controller">
                    {/* D-pad */}
                    <div className="gameboy-dpad">
                        {/* Up button */}
                        <div style={{
                            gridColumn: '2',
                            gridRow: '1',
                            width: '100%',
                            height: '100%',
                            background: lastActionDisplay === 'Up' ? '#00ff00' : '#666',
                            borderRadius: '4px',
                            border: '2px solid #333',
                            boxShadow: lastActionDisplay === 'Up' ? '0 0 8px #00ff00, inset 0 2px 4px rgba(255,255,255,0.3)' : 'inset 0 2px 4px rgba(0,0,0,0.3)',
                            transition: 'background-color 0.2s ease, box-shadow 0.2s ease'
                        }} />

                        {/* Left button */}
                        <div style={{
                            gridColumn: '1',
                            gridRow: '2',
                            width: '100%',
                            height: '100%',
                            background: lastActionDisplay === 'Left' ? '#00ff00' : '#666',
                            borderRadius: '4px',
                            border: '2px solid #333',
                            boxShadow: lastActionDisplay === 'Left' ? '0 0 8px #00ff00, inset 0 2px 4px rgba(255,255,255,0.3)' : 'inset 0 2px 4px rgba(0,0,0,0.3)',
                            transition: 'background-color 0.2s ease, box-shadow 0.2s ease'
                        }} />

                        {/* Center (not a button) */}
                        <div style={{
                            gridColumn: '2',
                            gridRow: '2',
                            width: '100%',
                            height: '100%',
                            background: '#444',
                            borderRadius: '4px',
                            border: '2px solid #333'
                        }} />

                        {/* Right button */}
                        <div style={{
                            gridColumn: '3',
                            gridRow: '2',
                            width: '100%',
                            height: '100%',
                            background: lastActionDisplay === 'Right' ? '#00ff00' : '#666',
                            borderRadius: '4px',
                            border: '2px solid #333',
                            boxShadow: lastActionDisplay === 'Right' ? '0 0 8px #00ff00, inset 0 2px 4px rgba(255,255,255,0.3)' : 'inset 0 2px 4px rgba(0,0,0,0.3)',
                            transition: 'background-color 0.2s ease, box-shadow 0.2s ease'
                        }} />

                        {/* Down button */}
                        <div style={{
                            gridColumn: '2',
                            gridRow: '3',
                            width: '100%',
                            height: '100%',
                            background: lastActionDisplay === 'Down' ? '#00ff00' : '#666',
                            borderRadius: '4px',
                            border: '2px solid #333',
                            boxShadow: lastActionDisplay === 'Down' ? '0 0 8px #00ff00, inset 0 2px 4px rgba(255,255,255,0.3)' : 'inset 0 2px 4px rgba(0,0,0,0.3)',
                            transition: 'background-color 0.2s ease, box-shadow 0.2s ease'
                        }} />
                    </div>
                </div>
            </div>
        </>
    );
};

export default RaceActionPad;
