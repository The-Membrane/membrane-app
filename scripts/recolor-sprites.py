"""Usage: recolor-sprites.py OUTDIR FILE...

Ditto palette migration: legacy blue/violet -> Living Typeface phosphor/teal.

The sprites are rasters, so this is a per-pixel hue remap rather than a token swap.
Method: the artwork's own hues sit in a narrow 190-245 degree band (cyan -> violet).
That band is remapped onto 157 -> 86 (teal -> phosphor), which PRESERVES the internal
shading gradient instead of flattening the character to one colour. Near-black outlines
and near-grey pixels are left alone: they carry the linework, and hue-rotating a
desaturated pixel produces mud.
"""
import base64, io, re, sys
import numpy as np
from PIL import Image

SRC_LO, SRC_HI = 174.0, 250.0     # measured band; 188 stranded a cyan patch on the body
DST_HI, DST_LO = 157.0, 86.0      # teal .. phosphor (note: direction inverted)
SAT_FLOOR = 0.18                  # below this a pixel is linework, not colour

def remap(im: Image.Image) -> Image.Image:
    a = np.asarray(im.convert('RGBA')).astype(np.float32) / 255.0
    rgb, alpha = a[..., :3], a[..., 3:]
    mx, mn = rgb.max(-1), rgb.min(-1)
    v, c = mx, mx - mn
    s = np.where(mx > 0, c / np.maximum(mx, 1e-6), 0)

    # rgb -> hue
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    h = np.zeros_like(v)
    nz = c > 1e-6
    idx = (mx == r) & nz; h[idx] = ((g - b)[idx] / c[idx]) % 6
    idx = (mx == g) & nz; h[idx] = ((b - r)[idx] / c[idx]) + 2
    idx = (mx == b) & nz; h[idx] = ((r - g)[idx] / c[idx]) + 4
    h *= 60.0

    # Remap ONLY hues that fall inside the source band. An earlier version clipped t
    # to [0,1] and repainted every saturated pixel, which dragged out-of-band props
    # into the band: manic's yellow lightning (hue ~30-60) and disco's pink headphones
    # (hue ~330) were clamped to the endpoints and came out green. Membership test,
    # not a clamp.
    in_band = (h >= SRC_LO) & (h <= SRC_HI)
    t = (h - SRC_LO) / (SRC_HI - SRC_LO)
    h_new = DST_HI + t * (DST_LO - DST_HI)
    paint = in_band & (s >= SAT_FLOOR) & (alpha[..., 0] > 0.05)
    h = np.where(paint, h_new, h)

    # hue -> rgb
    hp = h / 60.0
    x = c * (1 - np.abs(hp % 2 - 1))
    z = np.zeros_like(c)
    seg = np.floor(hp).astype(int) % 6
    opts = np.stack([
        np.stack([c, x, z], -1), np.stack([x, c, z], -1), np.stack([z, c, x], -1),
        np.stack([z, x, c], -1), np.stack([x, z, c], -1), np.stack([c, z, x], -1)], 0)
    out = np.take_along_axis(opts, seg[None, ..., None], 0)[0] + (v - c)[..., None]
    return Image.fromarray((np.concatenate([np.clip(out, 0, 1), alpha], -1) * 255)
                           .round().astype(np.uint8), 'RGBA')

def load(p):
    if p.endswith('.svg'):
        s = open(p).read()
        m = re.search(r'base64,([A-Za-z0-9+/=]+)', s)
        return Image.open(io.BytesIO(base64.b64decode(m.group(1)))), s
    return Image.open(p), None

def save(im, p, wrapper):
    buf = io.BytesIO(); im.save(buf, 'PNG', optimize=True)
    if wrapper is None:
        open(p, 'wb').write(buf.getvalue())
    else:
        b64 = base64.b64encode(buf.getvalue()).decode()
        open(p, 'w').write(re.sub(r'base64,[A-Za-z0-9+/=]+', 'base64,' + b64, wrapper))

if __name__ == '__main__':
    import os
    outdir = sys.argv[1]
    os.makedirs(outdir, exist_ok=True)
    for p in sys.argv[2:]:
        im, wrapper = load(p)
        out = os.path.join(outdir, os.path.basename(p))
        if os.path.abspath(out) == os.path.abspath(p):
            raise SystemExit(f'refusing to overwrite the source: {p}')
        save(remap(im), out, wrapper)
        print(f'  {os.path.basename(p):26} -> {out}')
