import { useEffect, useRef, useState } from 'react';

// Owns the fullscreen confetti canvas: exposes visibility + the canvas ref for
// rendering, a trigger that shows confetti for 3s, and runs the animation loop.
export default function useConfetti() {
    // Confetti state
    const [showConfetti, setShowConfetti] = useState(false);
    const confettiCanvasRef = useRef<HTMLCanvasElement>(null);

    // Confetti animation effect
    useEffect(() => {
        if (!showConfetti || !confettiCanvasRef.current) return;

        const canvas = confettiCanvasRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Set canvas size
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        // Confetti pieces
        const confetti: Array<{
            x: number;
            y: number;
            vx: number;
            vy: number;
            color: string;
            size: number;
        }> = [];

        // Generate confetti pieces
        for (let i = 0; i < 150; i++) {
            confetti.push({
                x: Math.random() * canvas.width,
                y: -10,
                vx: (Math.random() - 0.5) * 8,
                vy: Math.random() * 3 + 2,
                color: ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#ff8000', '#8000ff'][Math.floor(Math.random() * 8)],
                size: Math.random() * 3 + 2
            });
        }

        let animationId: number;
        const animate = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            confetti.forEach((piece, index) => {
                piece.x += piece.vx;
                piece.y += piece.vy;
                piece.vy += 0.1; // gravity

                ctx.fillStyle = piece.color;
                ctx.fillRect(piece.x, piece.y, piece.size, piece.size);

                // Remove pieces that are off screen
                if (piece.y > canvas.height || piece.x < -10 || piece.x > canvas.width + 10) {
                    confetti.splice(index, 1);
                }
            });

            if (confetti.length > 0) {
                animationId = requestAnimationFrame(animate);
            }
        };

        animate();

        // Handle window resize
        const handleResize = () => {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        };
        window.addEventListener('resize', handleResize);

        return () => {
            if (animationId) {
                cancelAnimationFrame(animationId);
            }
            window.removeEventListener('resize', handleResize);
        };
    }, [showConfetti]);

    // Function to trigger confetti
    const triggerConfetti = () => {
        setShowConfetti(true);
        setTimeout(() => setShowConfetti(false), 3000); // Hide after 3 seconds
    };

    return { showConfetti, confettiCanvasRef, triggerConfetti };
}
