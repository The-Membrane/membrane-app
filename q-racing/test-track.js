'use strict';

import { track } from './sample-track.js';

console.log('=== TRACK TEST ===');
console.log('Track dimensions:', track.length, 'x', track[0].length);
console.log('First row:', track[0]);
console.log('Second row:', track[1]);
console.log('Last row:', track[track.length - 1]);

// Count walls
let wallCount = 0;
let emptyCount = 0;
let finishCount = 0;

for (let y = 0; y < track.length; y++) {
    for (let x = 0; x < track[y].length; x++) {
        const tile = track[y][x];
        if (tile === 'W') wallCount++;
        else if (tile === 'E') emptyCount++;
        else if (tile === 'F') finishCount++;
    }
}

console.log('Wall tiles:', wallCount);
console.log('Empty tiles:', emptyCount);
console.log('Finish tiles:', finishCount);
console.log('=== END TEST ==='); 