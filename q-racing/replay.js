'use strict';

(function (global) {
    'use strict';

    const TILE_SIZE = 24;

    class Car {
        constructor(id, color) {
            this.id = id;
            this.color = color;
            this.x = 0;
            this.y = 0;
            this.finished = false;
            this.finishFlash = 0;
        }
        updatePosition(x, y) {
            this.x = x;
            this.y = y;
        }
        draw(ctx) {
            const px = this.x * TILE_SIZE + TILE_SIZE / 2;
            const py = this.y * TILE_SIZE + TILE_SIZE / 2;
            const r = TILE_SIZE / 3;
            ctx.beginPath();
            ctx.arc(px, py, r, 0, Math.PI * 2);
            ctx.fillStyle = this.finishFlash-- > 0 ? '#ffff00' : this.color;
            ctx.fill();
            ctx.fillStyle = '#000';
            ctx.font = '8px monospace';
            ctx.textAlign = 'center';
            ctx.fillText(this.id, px, py + 2);
        }
    }

    function startReplay({ ctx, track, playByPlay, palette, fps = 60 }) {
        const cars = new Map();
        let tick = 0;
        let playing = true;
        const frameInterval = 1000 / fps;
        let lastTime = performance.now();

        // init cars
        if (playByPlay.length) {
            Object.keys(playByPlay[0].positions).forEach((id, i) => {
                cars.set(id, new Car(id, palette[i % palette.length]));
            });
        }

        const updateCars = () => {
            const entry = playByPlay[tick];
            if (!entry) return;
            for (const [id, [x, y]] of Object.entries(entry.positions)) {
                const car = cars.get(id);
                if (car) {
                    car.updatePosition(x, y);
                    if (track[y] && track[y][x] === 'F' && !car.finished) {
                        car.finished = true;
                        car.finishFlash = 18;
                    }
                }
            }
        };

        const drawHUD = () => {
            ctx.fillStyle = '#fff';
            ctx.font = '12px "Press Start 2P"';
            ctx.textAlign = 'left';
            ctx.fillText(`Tick: ${tick}`, 10, 20);
            let leader = null;
            let best = -1;
            cars.forEach(c => {
                const prog = c.x + c.y * track[0].length;
                if (prog > best) { best = prog; leader = c.id; }
            });
            if (leader) ctx.fillText(`Leader: ${leader}`, 10, 40);
        };

        const render = () => {
            global.renderMaze(ctx, track);
            cars.forEach(c => c.draw(ctx));
            drawHUD();
        };

        const loop = (now) => {
            if (playing && now - lastTime >= frameInterval) {
                if (tick < playByPlay.length - 1) {
                    tick++;
                    updateCars();
                }
                lastTime = now;
            }
            render();
            requestAnimationFrame(loop);
        };

        updateCars();
        render();
        requestAnimationFrame(loop);

        // controls
        document.addEventListener('keydown', (e) => {
            switch (e.code) {
                case 'Space': e.preventDefault(); playing = !playing; break;
                case 'ArrowRight': if (!playing && tick < playByPlay.length - 1) { tick++; updateCars(); render(); } break;
                case 'ArrowLeft': if (!playing && tick > 0) { tick--; updateCars(); render(); } break;
                case 'KeyR': tick = 0; cars.forEach(c => { c.finished = false; c.finishFlash = 0; }); updateCars(); render(); break;
            }
        });

        return {
            replaceTrack(newTrack) { track = newTrack; render(); },
            replaceLog(newLog) { playByPlay = newLog; tick = 0; updateCars(); },
            restart() { tick = 0; updateCars(); },
        };
    }

    global.startReplay = startReplay;
})(window); 