"""Ditto -> espresso, and moss on the hologram plinth.

Two separate operations:

BODY. The source band (188-248 deg, cyan->violet) maps to a warm earth band around
espresso #43331f (hue 33). A pure hue swap is not enough: espresso is dark (value 0.26)
while the source art is light (value 0.85), so a hue-only move gives light tan. Value is
therefore compressed toward the espresso end, with a floor so the creature stays legible
against near-black #09090a. VAL_LO is the knob that trades brand accuracy against
contrast, which is why three variants are rendered rather than one.

MOSS. The plinth gets phosphor moss grown with value noise, glyph-masked by the plinth's
own alpha and biased to its upper surfaces, so it reads as growth on a lit top face
rather than a green wash.
"""
import base64, io, re, sys
import numpy as np
from PIL import Image

SRC_LO, SRC_HI = 174.0, 250.0
SAT_FLOOR = 0.18

def to_hsv(rgb):
    mx, mn = rgb.max(-1), rgb.min(-1)
    v, c = mx, mx - mn
    s = np.where(mx > 0, c / np.maximum(mx, 1e-6), 0)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    h = np.zeros_like(v); nz = c > 1e-6
    i = (mx == r) & nz; h[i] = ((g - b)[i] / c[i]) % 6
    i = (mx == g) & nz; h[i] = ((b - r)[i] / c[i]) + 2
    i = (mx == b) & nz; h[i] = ((r - g)[i] / c[i]) + 4
    return h * 60.0, s, v, c

def to_rgb(h, s, v):
    c = v * s
    hp = h / 60.0
    x = c * (1 - np.abs(hp % 2 - 1))
    z = np.zeros_like(c)
    seg = np.floor(hp).astype(int) % 6
    opts = np.stack([np.stack([c,x,z],-1), np.stack([x,c,z],-1), np.stack([z,c,x],-1),
                     np.stack([z,x,c],-1), np.stack([x,z,c],-1), np.stack([c,z,x],-1)], 0)
    return np.clip(np.take_along_axis(opts, seg[None,...,None], 0)[0] + (v - c)[..., None], 0, 1)

def espresso(im, hue_lo=26.0, hue_hi=40.0, val_lo=0.22, val_hi=0.62, sat=0.55):
    a = np.asarray(im.convert('RGBA')).astype(np.float32) / 255.0
    rgb, alpha = a[..., :3], a[..., 3:]
    h, s, v, _ = to_hsv(rgb)
    in_band = (h >= SRC_LO) & (h <= SRC_HI)
    paint = in_band & (s >= SAT_FLOOR) & (alpha[..., 0] > 0.05)
    t = np.clip((h - SRC_LO) / (SRC_HI - SRC_LO), 0, 1)
    h2 = np.where(paint, hue_hi + t * (hue_lo - hue_hi), h)
    # compress the art's own value range into the espresso range, keeping its shading
    vn = np.clip((v - 0.55) / 0.45, 0, 1)
    v2 = np.where(paint, val_lo + vn * (val_hi - val_lo), v)
    s2 = np.where(paint, sat, s)
    return Image.fromarray((np.concatenate([to_rgb(h2, s2, v2), alpha], -1) * 255).round().astype(np.uint8), 'RGBA')

def stone(im, hue=32.0, sat=0.16, val_lo=0.20, val_hi=0.66):
    """Neutral warm stone for the plinth. Moss needs something earthen to grow ON."""
    a = np.asarray(im.convert('RGBA')).astype(np.float32) / 255.0
    rgb, alpha = a[..., :3], a[..., 3:]
    h, s, v, _ = to_hsv(rgb)
    paint = (h >= SRC_LO) & (h <= SRC_HI) & (s >= SAT_FLOOR) & (alpha[..., 0] > 0.05)
    vn = np.clip((v - 0.35) / 0.55, 0, 1)
    h2 = np.where(paint, hue, h)
    s2 = np.where(paint, sat, s)
    v2 = np.where(paint, val_lo + vn * (val_hi - val_lo), v)
    return Image.fromarray((np.concatenate([to_rgb(h2, s2, v2), alpha], -1) * 255).round().astype(np.uint8), 'RGBA')

def moss(im, seed=7, density=0.55, hue=86.0, plate_v=0.80, plate_s=0.42):
    """Phosphor moss grown on the plinth: value noise, masked by the plinth's own alpha,
    biased upward so it colonises lit top surfaces instead of washing the whole prop."""
    a = np.asarray(im.convert('RGBA')).astype(np.float32) / 255.0
    rgb, alpha = a[..., :3], a[..., 3:]
    H, W = rgb.shape[:2]
    rng = np.random.default_rng(seed)
    # value noise: a coarse lattice smoothed by repeated box blur
    lat = rng.random((H // 16 + 2, W // 16 + 2))
    n = np.asarray(Image.fromarray((lat * 255).astype(np.uint8)).resize((W, H), Image.BICUBIC)) / 255.0
    for _ in range(2):
        n = (n + np.roll(n, 1, 0) + np.roll(n, -1, 0) + np.roll(n, 1, 1) + np.roll(n, -1, 1)) / 5.0
    ys = np.linspace(1.0, 0.0, H)[:, None]          # 1 at the top, 0 at the base
    grow = (n * (0.45 + 0.55 * ys)) > (1.0 - density) * 0.75
    h, s, v, _ = to_hsv(rgb)
    # The holo plate is EMISSIVE: bright and desaturated, because it is light rather
    # than a surface. Moss grows on surfaces, so the plate is protected. Testing on
    # appearance (bright AND washed out) rather than on a centre ellipse keeps the lit
    # stone facets, which are bright but still saturated, available to grow on.
    plate = (v > plate_v) & (s < plate_s)
    lit = (v > 0.30) & ~plate
    m = grow & lit & (alpha[..., 0] > 0.4)
    h2 = np.where(m, hue, h)
    s2 = np.where(m, np.clip(s + 0.30, 0, 0.85), s)
    v2 = np.where(m, np.clip(v * 0.92, 0, 1), v)
    return Image.fromarray((np.concatenate([to_rgb(h2, s2, v2), alpha], -1) * 255).round().astype(np.uint8), 'RGBA')

def load(p):
    if p.endswith('.svg'):
        s = open(p).read()
        return Image.open(io.BytesIO(base64.b64decode(re.search(r'base64,([A-Za-z0-9+/=]+)', s).group(1)))), s
    return Image.open(p), None

def save(im, p, wrapper):
    buf = io.BytesIO(); im.save(buf, 'PNG', optimize=True)
    if wrapper is None: open(p, 'wb').write(buf.getvalue())
    else: open(p, 'w').write(re.sub(r'base64,[A-Za-z0-9+/=]+', 'base64,' + base64.b64encode(buf.getvalue()).decode(), wrapper))
