import { useQuery } from '@tanstack/react-query';
import { getQRacingTrack, getQRacingLog, Track, PlayByPlayEntry } from '../services/q-racing';

// Query keys – keeping them stable helpers
const TRACK_KEY = ['q-racing', 'track'];
const LOG_KEY = ['q-racing', 'log'];

export function useQRacingTrack(trackId = 'sample') {
    return useQuery<Track>({
        queryKey: [...TRACK_KEY, trackId],
        queryFn: () => getQRacingTrack(trackId),
        staleTime: 5 * 60 * 1000,
    });
}

export function useQRacingLog(raceId = 'sample') {
    return useQuery<PlayByPlayEntry[]>({
        queryKey: [...LOG_KEY, raceId],
        queryFn: () => getQRacingLog(raceId),
        staleTime: 5 * 60 * 1000,
    });
}

// Convenience hook that fetches both pieces of data in parallel
export function useQRacing(trackId = 'sample', raceId = 'sample') {
    const trackQuery = useQRacingTrack(trackId);
    const logQuery = useQRacingLog(raceId);

    return {
        track: trackQuery.data,
        log: logQuery.data,
        isLoading: trackQuery.isLoading || logQuery.isLoading,
        error: trackQuery.error ?? logQuery.error,
        refetch: () => {
            trackQuery.refetch();
            logQuery.refetch();
        },
    } as const;
} 