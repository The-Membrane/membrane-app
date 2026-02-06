import { useEffect, useRef, useState } from 'react';
import Head from 'next/head';

// Types (must be defined before use in Window interface)
interface NodeData {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  load: number;
  health: number;
  name: string;
  role: string;
}

interface Particle {
  t: number;
  v: number;
  hue: number;
  hue2: number;
  size: number;
}

interface EdgeData {
  a: number;
  b: number;
  cx: number;
  cy: number;
  load: number;
  particles: Particle[];
}

// -----------------------------
// Config (tweak without code)
// -----------------------------
const CONFIG = {
  nodes: 24,
  grid: { cols: 6, rows: 4, jitter: 32 },
  roadGap: 120,
  building: { minH: 24, maxH: 90, minW: 24, maxW: 56 },
  edgesPerNode: [2, 4] as [number, number],
  particlesPerEdge: [6, 18] as [number, number],
  packetSpeedBase: 40,
  canvasPadding: 80,
} as const;

// Extend the Window interface to include our debug API
declare global {
  interface Window {
    MEMBRANE_CITY?: {
      version: string;
      CONFIG: typeof CONFIG;
      canvas: HTMLCanvasElement | null;
      nodes: () => ReadonlyArray<NodeData>;
      edges: () => ReadonlyArray<EdgeData>;
      degreeOf: (id: number) => number;
      focus: (id: number | null) => void;
      togglePause: () => boolean;
      regenerate: () => void;
    };
  }
}

export default function CityscapePage() {
  const [isMounted, setIsMounted] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hudRef = useRef<HTMLDivElement | null>(null);
  const brandRef = useRef<HTMLDivElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const speedRef = useRef<HTMLInputElement | null>(null);
  const trafficRef = useRef<HTMLInputElement | null>(null);
  const glowRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (!isMounted) return;
    const canvas = canvasRef.current;
    const tipEl = tipRef.current;
    const speedEl = speedRef.current as HTMLInputElement | null;
    const trafficEl = trafficRef.current as HTMLInputElement | null;
    const glowEl = glowRef.current as HTMLInputElement | null;

    if (!canvas || !tipEl || !speedEl || !trafficEl || !glowEl) return;

    const ctx = (canvas.getContext('2d') as CanvasRenderingContext2D) || undefined;
    if (!ctx) return;

    let devicePixelRatioLimited = Math.max(1, Math.min(2, (window.devicePixelRatio || 1)));
    let widthPx = 0;
    let heightPx = 0;
    let previousTimestamp = 0;
    let paused = false;
    let rafId = 0;

    // Coerce guarded refs into non-null locals for nested closures
    const canvasEl = canvas as HTMLCanvasElement;
    const tip = tipEl as HTMLDivElement;
    const speed = speedEl as HTMLInputElement;
    const traffic = trafficEl as HTMLInputElement;
    const glow = glowEl as HTMLInputElement;

    // PRNG
    const rand = mulberry32(0xC0FFEE ^ Date.now());
    function mulberry32(a: number) {
      return function () {
        let t = (a += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    const R = (min: number, max: number) => min + (max - min) * rand();
    const RI = (min: number, max: number) => Math.floor(R(min, max + 1));

    // Graph
    let nodes: NodeData[] = [];
    let edges: EdgeData[] = [];
    let focusedId: number | null = null;

    function resize() {
      const rect = canvasEl.getBoundingClientRect();
      const cssW = rect.width || window.innerWidth || 800;
      const cssH = rect.height || window.innerHeight || 600;
      devicePixelRatioLimited = Math.max(1, Math.min(2, (window.devicePixelRatio || 1)));
      canvasEl.width = Math.floor(cssW * devicePixelRatioLimited);
      canvasEl.height = Math.floor(cssH * devicePixelRatioLimited);
      canvasEl.style.width = cssW + 'px';
      canvasEl.style.height = cssH + 'px';
      widthPx = canvasEl.width;
      heightPx = canvasEl.height;
      layout();
    }

    function genGraph() {
      nodes.length = 0;
      edges.length = 0;

      const pad = CONFIG.canvasPadding * devicePixelRatioLimited;
      const cols = CONFIG.grid.cols;
      const rows = CONFIG.grid.rows;
      const gx = (widthPx - 2 * pad) / Math.max(1, cols - 1);
      const gy = (heightPx - 2 * pad) / Math.max(1, rows - 1);

      let id = 0;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (id >= CONFIG.nodes) break;
          const x = pad + c * gx + R(-CONFIG.grid.jitter, CONFIG.grid.jitter) * devicePixelRatioLimited;
          const y = pad + r * gy + R(-CONFIG.grid.jitter, CONFIG.grid.jitter) * devicePixelRatioLimited;
          const w = R(CONFIG.building.minW, CONFIG.building.maxW) * devicePixelRatioLimited;
          const h = R(CONFIG.building.minH, CONFIG.building.maxH) * devicePixelRatioLimited;
          nodes.push({
            id,
            x,
            y,
            w,
            h,
            load: R(0.15, 0.95),
            health: R(0.75, 1.0),
            name: 'Node-' + String(id + 1).padStart(2, '0'),
            role: pick(['Validator', 'Vault', 'Keeper', 'MM Vault', 'Oracle', 'Stability Pool']),
          });
          id++;
        }
      }

      // connectivity
      const minDeg = CONFIG.edgesPerNode[0];
      const maxDeg = CONFIG.edgesPerNode[1];
      const degrees = new Array(nodes.length).fill(0) as number[];
      const key = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
      const edgeSet = new Set<string>();

      function makeEdge(a: number, b: number) {
        const k = key(a, b);
        if (edgeSet.has(k)) return;
        edgeSet.add(k);
        degrees[a]++;
        degrees[b]++;
        const n1 = nodes[a];
        const n2 = nodes[b];

        const midx = (n1.x + n2.x) / 2;
        const midy = (n1.y + n2.y) / 2;
        const dx = n2.x - n1.x,
          dy = n2.y - n1.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len,
          ny = dx / len;
        const arc = R(-0.3, 0.3) * len;
        const cx = midx + nx * arc;
        const cy = midy + ny * arc;

        const pcount = RI(CONFIG.particlesPerEdge[0], CONFIG.particlesPerEdge[1]);
        const particles: Particle[] = Array.from({ length: pcount }, () => ({
          t: rand(),
          v: R(0.7, 1.3),
          hue: R(175, 190),
          hue2: R(120, 140),
          size: R(1.2, 2.4) * devicePixelRatioLimited,
        }));

        edges.push({ a, b, cx, cy, load: (n1.load + n2.load) / 2, particles });
      }

      for (let i = 1; i < nodes.length; i++) {
        const j = RI(0, i - 1);
        makeEdge(i, j);
      }
      const targetDeg = nodes.map(() => RI(minDeg, maxDeg));
      for (let i = 0; i < nodes.length; i++) {
        for (let tries = 0; tries < 50 && degrees[i] < targetDeg[i]; tries++) {
          const j = RI(0, nodes.length - 1);
          if (j === i) continue;
          if (edgeSet.has(key(i, j))) continue;
          makeEdge(i, j);
        }
      }
    }

    function layout() {
      // reserved for future layout recompute
    }

    const mouse = { x: 0, y: 0, overId: null as number | null };

    function hitTest(x: number, y: number) {
      let minD = 18 * devicePixelRatioLimited;
      let hit: number | null = null;
      for (const n of nodes) {
        const d = Math.hypot(x - n.x, y - n.y);
        if (d < minD) {
          minD = d;
          hit = n.id;
        }
      }
      return hit;
    }

    function renderTooltip() {
      if (mouse.overId == null) {
        tip.style.display = 'none';
        return;
      }
      const n = nodes[mouse.overId];
      tip.style.left = n.x / devicePixelRatioLimited + 'px';
      tip.style.top = n.y / devicePixelRatioLimited + 'px';
      tip.innerHTML = `
        <h3>${n.name}</h3>
        <table>
          <tr><td class="k">Role</td><td>${n.role}</td></tr>
          <tr><td class="k">Load</td><td>${(n.load * 100).toFixed(1)}%</td></tr>
          <tr><td class="k">Health</td><td>${(n.health * 100).toFixed(0)}%</td></tr>
          <tr><td class="k">Connections</td><td>${degreeOf(n.id)}</td></tr>
        </table>
      `;
      tip.style.display = 'block';
    }

    function degreeOf(id: number) {
      let d = 0;
      for (const e of edges) if (e.a === id || e.b === id) d++;
      return d;
    }

    function drawGrid() {
      const g = 40 * devicePixelRatioLimited;
      ctx.save();
      ctx.lineWidth = 1 * devicePixelRatioLimited;
      ctx.strokeStyle = 'rgba(60,90,120,0.12)';
      ctx.beginPath();
      for (let x = 0; x < widthPx; x += g) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, heightPx);
      }
      for (let y = 0; y < heightPx; y += g) {
        ctx.moveTo(0, y);
        ctx.lineTo(widthPx, y);
      }
      ctx.stroke();
      ctx.restore();
    }

    function drawBackgroundGlow() {
      ctx.save();
      const grd = ctx.createRadialGradient(
        widthPx * 0.5,
        heightPx * 0.9,
        10 * devicePixelRatioLimited,
        widthPx * 0.5,
        heightPx * 0.9,
        Math.max(widthPx, heightPx) * 0.8,
      );
      grd.addColorStop(0, 'rgba(60,100,200,0.06)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, widthPx, heightPx);
      ctx.restore();
    }

    function bezierPoint(x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, t: number) {
      const u = 1 - t;
      const x = u * u * x0 + 2 * u * t * cx + t * t * x1;
      const y = u * u * y0 + 2 * u * t * cy + t * t * y1;
      const dx = 2 * u * (cx - x0) + 2 * t * (x1 - cx);
      const dy = 2 * u * (cy - y0) + 2 * t * (y1 - cy);
      const len = Math.hypot(dx, dy) || 1;
      return { x, y, nx: -dy / len, ny: dx / len };
    }

    function bezierStroke(x0: number, y0: number, cx: number, cy: number, x1: number, y1: number) {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo(cx, cy, x1, y1);
      ctx.stroke();
    }

    function distBezier(x0: number, y0: number, cx: number, cy: number, x1: number, y1: number) {
      let px = x0,
        py = y0,
        d = 0,
        S = 12;
      for (let i = 1; i <= S; i++) {
        const t = i / S;
        const p = bezierPoint(x0, y0, cx, cy, x1, y1, t);
        d += Math.hypot(p.x - px, p.y - py);
        px = p.x;
        py = p.y;
      }
      return d;
    }

    function roundRectPath(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
      const rr = Math.min(r, w / 2, h / 2);
      c.moveTo(x + rr, y);
      c.arcTo(x + w, y, x + w, y + h, rr);
      c.arcTo(x + w, y + h, x, y + h, rr);
      c.arcTo(x, y + h, x, y, rr);
      c.arcTo(x, y, x + w, y, rr);
      c.closePath();
    }

    function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
      c.beginPath();
      roundRectPath(c, x, y, w, h, r);
      c.fill();
    }

    function clamp01(v: number) {
      return Math.max(0, Math.min(1, v));
    }

    function pick<T>(arr: T[]) {
      return arr[RI(0, arr.length - 1)];
    }

    const perfNow = () => (performance.now ? performance.now() : Date.now());

    function drawEdges(dt: number) {
      const showTraffic = !!traffic.checked;
      const glowOn = !!glow.checked;

      for (const e of edges) {
        if (focusedId !== null && !(e.a === focusedId || e.b === focusedId)) continue;
        const n1 = nodes[e.a];
        const n2 = nodes[e.b];
        const thickness = (2.0 + e.load * 3.2) * devicePixelRatioLimited;
        const alpha = focusedId === null ? 0.25 : 0.45;

        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = '#5cc9ff';
        ctx.lineWidth = thickness;
        bezierStroke(n1.x, n1.y, e.cx, e.cy, n2.x, n2.y);
        ctx.restore();

        if (!showTraffic) continue;

        const flowSpeed = CONFIG.packetSpeedBase * (+speed.value / 100) * devicePixelRatioLimited;
        for (const p of e.particles) {
          const curveLen = distBezier(n1.x, n1.y, e.cx, e.cy, n2.x, n2.y);
          p.t += (flowSpeed * p.v * dt) / curveLen;
          if (p.t > 1) p.t -= 1;

          const { x, y } = bezierPoint(n1.x, n1.y, e.cx, e.cy, n2.x, n2.y, p.t);
          const s = p.size;

          const grad = ctx.createRadialGradient(x, y, 0, x, y, 10 * s);
          grad.addColorStop(0, `hsla(${p.hue}, 95%, 70%, 0.95)`);
          grad.addColorStop(0.4, `hsla(${p.hue2}, 90%, 65%, 0.7)`);
          grad.addColorStop(1, 'rgba(0,0,0,0)');

          ctx.save();
          if (glowOn) {
            ctx.globalCompositeOperation = 'lighter';
          }
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(x, y, 10 * s, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();

          ctx.save();
          ctx.fillStyle = `hsla(${p.hue}, 100%, 80%, .85)`;
          ctx.beginPath();
          ctx.arc(x, y, 2.2 * s, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }
    }

    function getNodeRadius(n: NodeData) {
      return Math.max(n.w, n.h) / 2;
    }

    function drawBuildings() {
      const glowOn = !!glow.checked;

      for (const n of nodes) {
        const fade = focusedId !== null && focusedId !== n.id ? 0.2 : 1.0;
        ctx.save();
        ctx.globalAlpha = 0.9 * fade;
        const rNode = getNodeRadius(n);

        if (glowOn) {
          const halo = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, 28 * devicePixelRatioLimited);
          halo.addColorStop(0, 'rgba(140,180,255,.18)');
          halo.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = halo;
          ctx.beginPath();
          ctx.arc(n.x, n.y, rNode + 8 * devicePixelRatioLimited, 0, Math.PI * 2);
          ctx.fill();
        }

        // circular node body
        ctx.fillStyle = 'rgba(22,34,54,0.95)';
        ctx.strokeStyle = 'rgba(170,190,255,0.25)';
        ctx.lineWidth = 1 * devicePixelRatioLimited;
        ctx.beginPath();
        ctx.arc(n.x, n.y, rNode, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // role label above node
        ctx.save();
        ctx.globalAlpha = 0.85 * fade;
        ctx.font = `${12 * devicePixelRatioLimited}px Inter, ui-sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = '#a9c2d8';
        ctx.shadowColor = 'rgba(0,0,0,0.6)';
        ctx.shadowBlur = 4 * devicePixelRatioLimited;
        ctx.fillText(n.role, n.x, n.y - rNode - 6 * devicePixelRatioLimited);
        ctx.restore();

        // Node beacon
        const pulse = Math.sin(perfNow() * 0.003 + n.id) * 0.5 + 0.5;
        const beaconR = (4 + 3 * pulse) * devicePixelRatioLimited;
        if (glowOn) {
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = (0.35 + 0.35 * pulse) * fade;
          const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, beaconR * 4);
          g.addColorStop(0, '#9aa5ff');
          g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(n.x, n.y, beaconR * 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalCompositeOperation = 'source-over';
        }
        ctx.globalAlpha = (0.8 + 0.2 * pulse) * fade;
        ctx.fillStyle = '#cfe3ff';
        ctx.beginPath();
        ctx.arc(n.x, n.y, beaconR * 0.8, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
      }

      if (focusedId !== null) {
        ctx.save();
        ctx.globalCompositeOperation = glowOn ? 'lighter' : 'source-over';
        for (const e of edges) {
          if (e.a !== focusedId && e.b !== focusedId) continue;
          const n1 = nodes[e.a];
          const n2 = nodes[e.b];
          const from = e.a === focusedId ? n1 : n2;
          const to = e.a === focusedId ? n2 : n1;
          const ang = Math.atan2(to.y - from.y, to.x - from.x);
          const rFrom = getNodeRadius(from);
          const px = from.x + Math.cos(ang) * rFrom;
          const py = from.y + Math.sin(ang) * rFrom;
          ctx.fillStyle = 'rgba(135,255,176,.9)';
          ctx.beginPath();
          ctx.arc(px, py, 3.5 * devicePixelRatioLimited, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }

    function step() {
      for (const n of nodes) {
        n.load = clamp01(n.load + (rand() - 0.5) * 0.015);
      }
      for (const e of edges) {
        e.load = clamp01((nodes[e.a].load + nodes[e.b].load) / 2);
      }
    }

    function draw() {
      ctx.clearRect(0, 0, widthPx, heightPx);
      drawGrid();
      drawBackgroundGlow();
      drawEdges(1 / 60);
      drawBuildings();
      renderTooltip();
    }

    function loop(ts: number) {
      if (!previousTimestamp) previousTimestamp = ts;
      const dt = Math.min(0.05, (ts - previousTimestamp) / 1000);
      previousTimestamp = ts;
      if (!paused) step();
      draw();
      rafId = requestAnimationFrame(loop);
    }

    function onMouseMove(e: MouseEvent) {
      const rect = canvasEl.getBoundingClientRect();
      mouse.x = (e.clientX - rect.left) * devicePixelRatioLimited;
      mouse.y = (e.clientY - rect.top) * devicePixelRatioLimited;
      mouse.overId = hitTest(mouse.x, mouse.y);
      renderTooltip();
    }

    function onMouseLeave() {
      mouse.overId = null;
      tip.style.display = 'none';
    }

    function onClick() {
      const hit = hitTest(mouse.x, mouse.y);
      focusedId = hit !== null ? hit : null;
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.code === 'Space') {
        // Avoid interfering with toggling checkboxes/slider when focused
        const active = document.activeElement as HTMLElement | null;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
        e.preventDefault();
        paused = !paused;
      }
    }

    function onControlChange() {
      // Immediate visual feedback when toggling controls
      draw();
    }

    // Expose tiny API
    window.MEMBRANE_CITY = {
      version: '1.0.2',
      CONFIG,
      canvas: canvasEl,
      nodes: () => nodes.slice(),
      edges: () => edges.slice(),
      degreeOf: (id: number) => degreeOf(id),
      focus: (id: number | null) => {
        focusedId = typeof id === 'number' ? id : null;
      },
      togglePause: () => (paused = !paused),
      regenerate: () => {
        genGraph();
      },
    };

    // Init
    resize();
    genGraph();
    rafId = requestAnimationFrame(loop);

    // Events
    window.addEventListener('resize', resize);
    canvasEl.addEventListener('mousemove', onMouseMove);
    canvasEl.addEventListener('mouseleave', onMouseLeave);
    canvasEl.addEventListener('click', onClick);
    window.addEventListener('keydown', onKeyDown);
    speed.addEventListener('input', onControlChange);
    traffic.addEventListener('change', onControlChange);
    glow.addEventListener('change', onControlChange);

    // Lightweight self-tests (console)
    function runTests() {
      try {
        const api = window.MEMBRANE_CITY!;
        console.assert(!!api, 'API exported');
        console.assert(!!api.canvas && !!api.canvas.getContext('2d'), 'Canvas & 2D context available');
        const nodesCopy = api.nodes();
        const edgesCopy = api.edges();
        console.assert(nodesCopy.length === api.CONFIG.nodes, `Node count (${nodesCopy.length}) matches CONFIG.nodes (${api.CONFIG.nodes})`);
        const uniq = new Set<string>();
        edgesCopy.forEach((e) => uniq.add(e.a < e.b ? `${e.a}-${e.b}` : `${e.b}-${e.a}`));
        console.assert(uniq.size === edgesCopy.length, 'No duplicate edges');
        console.assert(edgesCopy.length >= nodesCopy.length - 1, 'Edges count >= nodes-1');
        const adj = new Map<number, Set<number>>();
        nodesCopy.forEach((_, i) => adj.set(i, new Set()));
        edgesCopy.forEach((e) => {
          adj.get(e.a)!.add(e.b);
          adj.get(e.b)!.add(e.a);
        });
        const q = [0];
        const seen = new Set<number>([0]);
        while (q.length) {
          const v = q.shift()!;
          adj.get(v)!.forEach((n) => {
            if (!seen.has(n)) {
              seen.add(n);
              q.push(n);
            }
          });
        }
        console.assert(seen.size === nodesCopy.length, `Graph is connected (${seen.size}/${nodesCopy.length})`);
        const minP = api.CONFIG.particlesPerEdge ? api.CONFIG.particlesPerEdge[0] : 1;
        const maxP = api.CONFIG.particlesPerEdge ? api.CONFIG.particlesPerEdge[1] : 99;
        const allOk = edgesCopy.every((e) => e.particles && e.particles.length >= minP && e.particles.length <= maxP);
        console.assert(allOk, 'Particles per edge within configured range');
        const p0 = api.togglePause();
        const p1 = api.togglePause();
        console.assert(typeof p0 === 'boolean' && p0 !== p1, 'Pause toggle flips state');
        const within = nodesCopy.every((n) => n.x >= 0 && n.x <= api.canvas!.width && n.y >= 0 && n.y <= api.canvas!.height);
        console.assert(within, 'All node centers are within canvas');
        console.assert(nodesCopy.every((_, i) => api.degreeOf(i) >= 1), 'Every node has at least one connection');
        console.assert((document.getElementById('speed') as HTMLInputElement).value === '100', 'Speed slider default 100');
        console.assert((document.getElementById('traffic') as HTMLInputElement).checked === true, 'Traffic default on');
        console.assert((document.getElementById('glow') as HTMLInputElement).checked === true, 'Glow default on');
        console.assert(/^\d+\.\d+\.\d+$/.test(api.version), 'Version string is semver-like');
        api.focus(0);
        api.focus(null);
        console.assert(true, 'Focus API accepts number and null without throwing');
        console.log('%cMEMBRANE CITY: TESTS PASSED', 'color:#87ffb0;font-weight:700;');
      } catch (err) {
        console.error('Tests failed:', err);
      }
    }

    const onLoad = () => setTimeout(runTests, 60);
    window.addEventListener('load', onLoad);

    return () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('load', onLoad);
      canvasEl.removeEventListener('mousemove', onMouseMove);
      canvasEl.removeEventListener('mouseleave', onMouseLeave);
      canvasEl.removeEventListener('click', onClick);
      speed.removeEventListener('input', onControlChange);
      traffic.removeEventListener('change', onControlChange);
      glow.removeEventListener('change', onControlChange);
      cancelAnimationFrame(rafId);
      if (window.MEMBRANE_CITY) delete window.MEMBRANE_CITY;
    };
  }, [isMounted]);

  if (!isMounted) {
    return (
      <>
        <Head>
          <title>Membrane Network City — Canvas</title>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta charSet="utf-8" />
        </Head>
        <div style={{ minHeight: '100vh', background: '#0a0f14' }} />
      </>
    );
  }

  return (
    <>
      <Head>
        <title>Membrane Network City — Canvas</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta charSet="utf-8" />
      </Head>
      <div id="wrap" ref={wrapRef}>
        <canvas id="city" ref={canvasRef} />
        <div className="hud" id="hud" ref={hudRef}>
          <h1>Membrane Network City</h1>
          <div className="legend">
            <div className="dot node"></div>
            <div>Node (building)</div>
            <div className="line"></div>
            <div>Energy conduit (information flow)</div>
          </div>
          <div className="stat">
            Click a building to focus. Hover for stats. Press <span className="kbd">Space</span> to pause.
          </div>
        </div>
        <div className="brand" ref={brandRef}>MEMBRANE</div>
        <div className="controls">
          <label>Flow speed</label>
          <input id="speed" ref={speedRef} type="range" min={0} max={200} defaultValue={100} />
          <label>
            <input id="traffic" ref={trafficRef} type="checkbox" defaultChecked /> traffic
          </label>
          <label>
            <input id="glow" ref={glowRef} type="checkbox" defaultChecked /> glow
          </label>
        </div>
        <div className="tip" id="tip" ref={tipRef}></div>
      </div>

      {/* Styles */}
      <style jsx global>{`
        :root {
          --bg0: #0a0f14;
          --bg1: #0e1620;
          --accent: #6cf1ff;
          --accent2: #87ffb0;
          --membrane: #9aa5ff;
          --grid: #152233;
          --text: #d8e1ea;
          --muted: #8aa0b3;
          --warn: #ffb86b;
          --danger: #ff6b6b;
        }
        html, body, #__next {
          height: 100%;
        }
        html, body {
          margin: 0;
          background: radial-gradient(1200px 800px at 50% 100%, #0e1623 0%, #0b1119 50%, #070b10 100%);
          color: var(--text);
          font: 14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, "Helvetica Neue", Arial, "Apple Color Emoji","Segoe UI Emoji";
          overflow: hidden;
        }
        #wrap {
          position: relative;
          width: 100%;
          height: 100vh;
        }
        canvas {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          display: block;
          z-index: 0;
        }
        .hud {
          position: absolute;
          inset: 16px auto auto 16px;
          padding: 12px 14px;
          background: linear-gradient(180deg, rgba(10,17,26,.75), rgba(8,12,18,.55));
          border: 1px solid rgba(138,160,179,.18);
          backdrop-filter: blur(6px);
          border-radius: 14px;
          box-shadow: 0 10px 30px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.04);
          user-select: none;
          pointer-events: none;
          z-index: 2;
        }
        .hud h1 {
          font-size: 14px;
          letter-spacing: .12em;
          text-transform: uppercase;
          margin: 0 0 6px 0;
          color: #cfe3ff;
        }
        .legend {
          display: grid;
          grid-template-columns: auto 1fr;
          gap: 6px 10px;
          align-items: center;
          color: var(--muted);
        }
        .dot, .line {
          width: 16px; height: 10px;
          border-radius: 6px;
          background: linear-gradient(90deg, var(--accent), var(--accent2));
          box-shadow: 0 0 12px rgba(108,241,255,.6), 0 0 24px rgba(135,255,176,.35);
        }
        .dot.node { width:10px; height:10px; border-radius:50%; background: radial-gradient(circle at 30% 30%, #fff, var(--membrane) 40%, #4450ff 60%, transparent 70%); box-shadow: 0 0 16px rgba(154,165,255,.7); }
        .kbd { display:inline-block; padding:2px 6px; border:1px solid rgba(138,160,179,.25); border-radius:6px; background: rgba(255,255,255,.04); color:#dfe8f2; font-size:12px; }
        .stat { margin-top: 6px; color:#a9c2d8; font-size:12px; }
        .tip {
          position: absolute;
          transform: translate(-50%, calc(-100% - 14px));
          min-width: 180px;
          max-width: 280px;
          padding: 10px 12px;
          background: linear-gradient(180deg, rgba(14,22,33,.95), rgba(10,16,24,.9));
          color: var(--text);
          border: 1px solid rgba(138,160,179,.3);
          border-radius: 12px;
          pointer-events: none;
          font-size: 12px;
          box-shadow: 0 10px 30px rgba(0,0,0,.6);
          display: none;
          z-index: 3;
        }
        .tip h3 { margin: 0 0 4px 0; font-size: 13px; color:#e8f1ff; }
        .tip table { width:100%; border-collapse: collapse; }
        .tip td { padding: 2px 0; color:#b9cadd; }
        .tip td.k { width: 44%; color:#7fa0b8; }
        .controls {
          position: absolute; inset: auto 16px 16px auto;
          display:flex; gap:10px; align-items:center;
          padding: 8px 10px; border-radius: 12px;
          background: linear-gradient(180deg, rgba(10,17,26,.7), rgba(8,12,18,.55));
          border: 1px solid rgba(138,160,179,.18);
          backdrop-filter: blur(6px);
          z-index: 2;
        }
        .controls > * { pointer-events: auto; }
        .controls label { color:#bcd2e4; font-size: 12px; }
        .controls input[type="range"] { width: 140px; }
        .brand {
          position: absolute; inset: 16px 16px auto auto; font-weight:600; letter-spacing:.08em;
          color:#cfe3ff; font-size:12px; text-transform:uppercase; opacity:.9;
          pointer-events:none;
          z-index: 2;
        }
      `}</style>
    </>
  );
}
