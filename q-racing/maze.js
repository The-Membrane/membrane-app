(function (global) {
    'use strict';

    const TILE_SIZE = 24;
    const WALL_COLOR = '#0033ff';
    const BACKGROUND_COLOR = '#000';
    const FINISH_COLOR = '#00ff00';

    /**
     * Draws the maze directly onto the provided 2-D context.
     * @param {CanvasRenderingContext2D} ctx
     * @param {string[][]} track
     */
    function renderMaze(ctx, track) {
        ctx.fillStyle = BACKGROUND_COLOR;
        ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

        for (let y = 0; y < track.length; y++) {
            for (let x = 0; x < track[y].length; x++) {
                const tile = track[y][x];
                const px = x * TILE_SIZE;
                const py = y * TILE_SIZE;
                if (tile === 'W') {
                    ctx.fillStyle = WALL_COLOR;
                    ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
                } else if (tile === 'F') {
                    // Animated finish checkerboard
                    const time = Date.now() * 0.005;
                    const size = 6;
                    for (let cy = 0; cy < TILE_SIZE; cy += size) {
                        for (let cx = 0; cx < TILE_SIZE; cx += size) {
                            const idx = ((cx + cy) / size) | 0;
                            ctx.fillStyle = Math.sin(time + idx) > 0 ? FINISH_COLOR : BACKGROUND_COLOR;
                            ctx.fillRect(px + cx, py + cy, size, size);
                        }
                    }
                }
            }
        }
    }

    global.renderMaze = renderMaze;
})(window); 