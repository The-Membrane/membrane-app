import { CampaignConfig } from '@/persisted-state/useRacingCampaign'
import { trackComponents } from './utils/trackComponents'

const campaignConfig: CampaignConfig = {
    name: 'Trials Campaign',
    tracks: [
        {
            trackId: '3', //right
            iqTargetPercent: 100,
            afterEachRaceModals: [
                {
                    id: 't3-race-0',
                    title: 'The Singularity is Near',
                    body: 'These trials train you to escape the maze.....if that\'s even possible. The world rests on your shoul...hood...brain, FKGKLFD, we need you.',
                    raceCount: 0,
                },
                {
                    id: 't3-race-1',
                    title: 'Practice Makes Perfect',
                    body: '1 race down, do you think you\'re fast enough to escape the maze? Well don\'t get too ahead of yourself.  You\'ll also notice the race simulation is pretty slow, why don\'t you speed it up in the Race Controls?',
                    raceCount: 1,
                },
                {
                    id: 't3-race-3',
                    title: '1 Technique at a Time',
                    body: 'You are improving! Continue training to reach 100% Track IQ & master going straight...lol',
                    raceCount: 2,
                },
            ],
            onCompletionModals: [
                {
                    id: 't3-complete',
                    title: 'Trial Complete',
                    body: 'You have mastered this track and the skills you\'ve gained will help you escape the maze. Get ready for the next challenge!',
                    showConfetti: true,
                    navigateTo: { trackId: '13' },
                },
            ],
            unlocksOnRace: [
                { raceCount: 1, unlocks: { showRaceControls: true } },
                { raceCount: 2, unlocks: { showTileLegend: true } },
            ],
            unlocksOnCompletion: { showTileLegend: true },
        },
        {
            trackId: '13', //down
            iqTargetPercent: 100,
            afterEachRaceModals: [
                {
                    id: 't13-race-1',
                    title: 'Onwards',
                    body: 'Your car is learning fast. Continue the trial.',
                    raceCount: 1,
                },
                {
                    id: 't13-race-2',
                    title: 'Progress',
                    body: 'Great progress! You are mastering this track.',
                    raceCount: 2,
                },
            ],
            onCompletionModals: [
                {
                    id: 't13-complete',
                    title: 'Another Victory',
                    body: 'Showcase mode unlocked for the next challenge!',
                    showConfetti: true,
                    navigateTo: { trackId: '18' },
                },
            ],
            unlocksOnRace: [
                // { raceCount: 2, unlocks: { showRaceCountControl: true } },
            ],
            // unlocksOnCompletion: { showRaceCountControl: true },
        },
        {
            trackId: '18', // up
            iqTargetPercent: 100,
            afterEachRaceModals: [
                {
                    id: 't18-race-1',
                    title: 'Onwards',
                    body: 'Your car is learning fast. Continue the trial.',
                    raceCount: 1,
                },
            ],
            onCompletionModals: [
                {
                    id: 't18-complete',
                    title: 'Another Victory',
                    body: 'Showcase mode unlocked for the next challenge!',
                    showConfetti: true,
                    navigateTo: { trackId: '20' },
                },
            ],
            unlocksOnRace: [
                // { raceCount: 1, unlocks: { showAdvancedParams: true } },
                // { raceCount: 2, unlocks: { showRaceCountControl: true } },
            ],
            // unlocksOnCompletion: { showRaceCountControl: true },
        },
        {
            trackId: '20', // left
            iqTargetPercent: 100,
            afterEachRaceModals: [
                {
                    id: 't20-race-1',
                    title: 'Confusion Arrives',
                    body: 'You\'ll realize this is the opposite of the first track, will your car be able to navigate it? Or will it get lost in the nuance',
                    raceCount: 0,
                },
            ],
            onCompletionModals: [
                {
                    id: 't20-complete',
                    title: 'I\'m Impressed',
                    body: 'This is the first real obstacle and you\'ve conquered it with ease....I hope. The next tracks will be a breeze if you can learn how to turn.',
                    showConfetti: true,
                    navigateTo: { trackId: '19' },
                },
            ],
            unlocksOnRace: [
                // { raceCount: 1, unlocks: { showAdvancedParams: true } },
                // { raceCount: 2, unlocks: { showRaceCountControl: true } },
            ],
            // unlocksOnCompletion: { showRaceCountControl: true },
        },
        {
            trackId: '19', //right then down
            iqTargetPercent: 100,
            afterEachRaceModals: [
                {
                    id: 't19-race-1',
                    title: 'About Face',
                    body: 'How is this *turning* out for you? You may need to fiddle with the parameters to get it right.',
                    raceCount: 1,
                },
            ],
            onCompletionModals: [
                {
                    id: 't19-complete',
                    title: 'Turning it Up',
                    body: 'From here on out it\'s about mastering the corners, don\'t hit your head!',
                    showConfetti: true,
                    navigateTo: { trackId: '14' },
                },
            ],
            unlocksOnRace: [
                { raceCount: 1, unlocks: { showAdvancedParams: true } },
                // { raceCount: 2, unlocks: { showRaceCountControl: true } },
            ],
            // unlocksOnCompletion: { showRaceCountControl: true },
        },
        {
            trackId: '14', // down then right
            iqTargetPercent: 100,
            afterEachRaceModals: [
                //     {
                //         id: 't14-race-1',
                //         title: 'Onwards',
                //         body: 'Your car is learning fast. Continue the trial.',
                //         raceCount: 1,
                //     },
            ],
            onCompletionModals: [
                {
                    id: 't14-complete',
                    title: '',
                    body: '',
                    showConfetti: true,
                    navigateTo: { trackId: '15' },
                },
            ],
            unlocksOnRace: [
                // { raceCount: 1, unlocks: { showAdvancedParams: true } },
                // { raceCount: 2, unlocks: { showRaceCountControl: true } },
            ],
            // unlocksOnCompletion: { showRaceCountControl: true },
        },
        {
            trackId: '15', // down then left
            iqTargetPercent: 100,
            afterEachRaceModals: [
                // {
                //     id: 't15-race-1',
                //     title: 'Onwards',
                //     body: 'Your car is learning fast. Continue the trial.',
                //     raceCount: 1,
                // },
            ],
            onCompletionModals: [
                {
                    id: 't15-complete',
                    title: '',
                    body: '',
                    showConfetti: true,
                    navigateTo: { trackId: '16' },
                },
            ],
            unlocksOnRace: [
                // { raceCount: 1, unlocks: { showAdvancedParams: true } },
                // { raceCount: 2, unlocks: { showRaceCountControl: true } },
            ],
            // unlocksOnCompletion: { showRaceCountControl: true },
        },
        {
            trackId: '16', // up then right
            iqTargetPercent: 100,
            afterEachRaceModals: [
                {
                    id: 't16-race-1',
                    title: '',
                    body: '',
                    raceCount: 1,
                },
            ],
            onCompletionModals: [
                {
                    id: 't16-complete',
                    title: '',
                    body: '',
                    showConfetti: true,
                    navigateTo: { trackId: '17' },
                },
            ],
            unlocksOnRace: [
                // { raceCount: 1, unlocks: { showAdvancedParams: true } },
                // { raceCount: 2, unlocks: { showRaceCountControl: true } },
            ],
            // unlocksOnCompletion: { showRaceCountControl: true },
        },
        {
            trackId: '17', // up then left
            iqTargetPercent: 100,
            afterEachRaceModals: [
                {
                    id: 't17-race-1',
                    title: '',
                    body: '',
                    raceCount: 1,
                },
            ],
            onCompletionModals: [
                {
                    id: 't17-complete',
                    title: '',
                    body: '',
                    showConfetti: true,
                    // navigateTo: { trackId: '18' },
                },
            ],
            unlocksOnRace: [
                // { raceCount: 1, unlocks: { showAdvancedParams: true } },
                // { raceCount: 2, unlocks: { showRaceCountControl: true } },
            ],
            // unlocksOnCompletion: { showRaceCountControl: true },
        }
    ],
}

export default campaignConfig
