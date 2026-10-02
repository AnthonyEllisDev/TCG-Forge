#!/usr/bin/env python3
"""
Build the icon font that lets rules text carry symbols: {element-fire},
{gem}, {star} and so on.

Every SVG in workspace/assets/icons becomes one glyph, named after its file,
in the Private Use Area of a plain TrueType font:

    python tools/build_icon_font.py
    python tools/build_icon_font.py --icons my/icons --out workspace/assets/fonts/My-Icons.ttf
    python tools/build_icon_font.py --list            # print the name -> code point table

The editor finds any font in workspace/assets/fonts whose Private Use Area
glyphs carry names, so the output needs no sidecar file: put it in the fonts
folder and its icons appear in Card Fields.

Code points are kept stable across rebuilds. If the output file already
exists, every icon it holds keeps its code point and new icons take the next
free one, because a card's text stores the code point itself — renumbering
would quietly swap one icon for another on every saved card. A code point is
never handed out twice: an icon taken out keeps its point reserved (listed in
the font's name table), so a card that still holds it shows an empty box rather
than whatever icon came next, and putting the file back restores it. A new font
starts after the code points the other fonts beside it already use.

What survives the trip from SVG: filled shapes (path, rect, circle, ellipse,
polygon, polyline) and stroked lines with round caps and joins, plus the
`transform` attribute. Colour does not — a font glyph takes the colour of the
text around it. Standard library only.
"""

from __future__ import annotations

import argparse
import math
import os
import re
import struct
import sys
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_ICONS = os.path.join(ROOT, "workspace", "assets", "icons")
DEFAULT_OUT = os.path.join(ROOT, "workspace", "assets", "fonts", "Forge-Icons.ttf")

FAMILY = "Forge Icons"
VERSION = "1.000"
# 2026-10-01, in seconds since 1904 as the head table counts them.
FONT_DATE = 3873657600

PUA_START = 0xE000
PUA_END = 0xF8FF

# The em, and where an icon sits in it: a little below the baseline and about
# as tall as a capital, so it reads as a word in a line of rules text.
UPM = 1000
ASCENT = 800
DESCENT = 200
ICON_BOTTOM = -90
ICON_SIZE = 850
SIDE_BEARING = 60
ADVANCE = ICON_SIZE + 2 * SIDE_BEARING
SPACE_ADVANCE = 300

# Curve fitting tolerance, in font units.
TOLERANCE = 1.0


# --------------------------------------------------------------------------
# geometry
# --------------------------------------------------------------------------

IDENTITY = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def mat_mul(m, n):
    """m then n: the matrix that applies n first and m after it."""
    a, b, c, d, e, f = m
    a2, b2, c2, d2, e2, f2 = n
    return (a * a2 + c * b2, b * a2 + d * b2,
            a * c2 + c * d2, b * c2 + d * d2,
            a * e2 + c * f2 + e, b * e2 + d * f2 + f)


def apply(m, x, y):
    a, b, c, d, e, f = m
    return a * x + c * y + e, b * x + d * y + f


def parse_transform(text: str):
    m = IDENTITY
    for name, args in re.findall(r"(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)", text or ""):
        v = [float(n) for n in re.findall(r"[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?", args)]
        if name == "matrix" and len(v) == 6:
            t = tuple(v)
        elif name == "translate":
            t = (1, 0, 0, 1, v[0] if v else 0, v[1] if len(v) > 1 else 0)
        elif name == "scale":
            sx = v[0] if v else 1
            t = (sx, 0, 0, v[1] if len(v) > 1 else sx, 0, 0)
        elif name == "rotate":
            r = math.radians(v[0] if v else 0)
            t = (math.cos(r), math.sin(r), -math.sin(r), math.cos(r), 0, 0)
            if len(v) == 3:
                t = mat_mul(mat_mul((1, 0, 0, 1, v[1], v[2]), t), (1, 0, 0, 1, -v[1], -v[2]))
        elif name == "skewX":
            t = (1, 0, math.tan(math.radians(v[0] if v else 0)), 1, 0, 0)
        elif name == "skewY":
            t = (1, math.tan(math.radians(v[0] if v else 0)), 0, 1, 0, 0)
        else:
            continue
        m = mat_mul(m, t)
    return m


def arc_to_cubics(x1, y1, rx, ry, phi, large, sweep, x2, y2):
    """SVG's endpoint arc as cubic Béziers, at most a quarter turn each."""
    if (x1, y1) == (x2, y2):
        return []
    rx, ry = abs(rx), abs(ry)
    if rx == 0 or ry == 0:
        return [((x1, y1), (x1, y1), (x2, y2), (x2, y2))]
    cos_p, sin_p = math.cos(math.radians(phi)), math.sin(math.radians(phi))
    dx, dy = (x1 - x2) / 2, (y1 - y2) / 2
    x1p = cos_p * dx + sin_p * dy
    y1p = -sin_p * dx + cos_p * dy
    lam = (x1p ** 2) / (rx ** 2) + (y1p ** 2) / (ry ** 2)
    if lam > 1:
        rx, ry = rx * math.sqrt(lam), ry * math.sqrt(lam)
    num = rx ** 2 * ry ** 2 - rx ** 2 * y1p ** 2 - ry ** 2 * x1p ** 2
    den = rx ** 2 * y1p ** 2 + ry ** 2 * x1p ** 2
    co = math.sqrt(max(0.0, num / den)) if den else 0.0
    if large == sweep:
        co = -co
    cxp, cyp = co * rx * y1p / ry, -co * ry * x1p / rx
    cx = cos_p * cxp - sin_p * cyp + (x1 + x2) / 2
    cy = sin_p * cxp + cos_p * cyp + (y1 + y2) / 2

    def angle(ux, uy, vx, vy):
        a = math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
        return a

    t1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    dt = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if not sweep and dt > 0:
        dt -= 2 * math.pi
    elif sweep and dt < 0:
        dt += 2 * math.pi
    n = max(1, math.ceil(abs(dt) / (math.pi / 2) - 1e-9))
    step = dt / n
    k = 4 / 3 * math.tan(step / 4)
    out = []

    def point(t):
        x, y = rx * math.cos(t), ry * math.sin(t)
        return cos_p * x - sin_p * y + cx, sin_p * x + cos_p * y + cy

    def deriv(t):
        x, y = -rx * math.sin(t), ry * math.cos(t)
        return cos_p * x - sin_p * y, sin_p * x + cos_p * y

    for i in range(n):
        a, b = t1 + i * step, t1 + (i + 1) * step
        p0, p3 = point(a), point(b)
        d0, d3 = deriv(a), deriv(b)
        out.append((p0, (p0[0] + k * d0[0], p0[1] + k * d0[1]),
                    (p3[0] - k * d3[0], p3[1] - k * d3[1]), p3))
    out[-1] = out[-1][:3] + ((x2, y2),)
    return out


# A subpath is a start point plus a list of segments, each ('L', p),
# ('Q', c, p) or ('C', c1, c2, p), and whether it was closed.

def parse_path(d: str):
    tokens = re.findall(r"[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?", d or "")
    subpaths = []
    i = 0
    cmd = None
    cur = (0.0, 0.0)
    start = (0.0, 0.0)
    sub = None
    last_c = None    # previous cubic control, for S
    last_q = None    # previous quadratic control, for T

    def num():
        nonlocal i
        v = float(tokens[i])
        i += 1
        return v

    def flag():
        # Arc flags may be written without separators ("a5 5 0 110-10").
        nonlocal i
        tok = tokens[i]
        if tok in ("0", "1"):
            i += 1
            return int(tok)
        if tok[0] in "01":
            tokens[i] = tok[1:]
            return int(tok[0])
        i += 1
        return int(float(tok))

    while i < len(tokens):
        if re.match(r"[A-Za-z]", tokens[i]):
            cmd = tokens[i]
            i += 1
            if cmd in "Zz":
                if sub is not None:
                    sub["closed"] = True
                    cur = start
                    subpaths.append(sub)
                    sub = None
                last_c = last_q = None
                continue
        elif cmd is None:
            raise ValueError("path data does not start with a command")
        rel = cmd.islower()
        c = cmd.upper()
        ox, oy = cur if rel else (0.0, 0.0)
        if c == "M":
            if sub is not None:
                subpaths.append(sub)
            cur = (ox + num(), oy + num())
            start = cur
            sub = {"start": cur, "segs": [], "closed": False}
            cmd = "l" if rel else "L"      # further pairs are lines
            last_c = last_q = None
            continue
        if sub is None:
            sub = {"start": cur, "segs": [], "closed": False}
            start = cur
        if c == "L":
            p = (ox + num(), oy + num())
            sub["segs"].append(("L", p))
            last_c = last_q = None
        elif c == "H":
            p = ((ox if rel else 0) + num(), cur[1])
            sub["segs"].append(("L", p))
            last_c = last_q = None
        elif c == "V":
            p = (cur[0], (oy if rel else 0) + num())
            sub["segs"].append(("L", p))
            last_c = last_q = None
        elif c == "C":
            c1 = (ox + num(), oy + num())
            c2 = (ox + num(), oy + num())
            p = (ox + num(), oy + num())
            sub["segs"].append(("C", c1, c2, p))
            last_c, last_q = c2, None
        elif c == "S":
            c1 = (2 * cur[0] - last_c[0], 2 * cur[1] - last_c[1]) if last_c else cur
            c2 = (ox + num(), oy + num())
            p = (ox + num(), oy + num())
            sub["segs"].append(("C", c1, c2, p))
            last_c, last_q = c2, None
        elif c == "Q":
            q = (ox + num(), oy + num())
            p = (ox + num(), oy + num())
            sub["segs"].append(("Q", q, p))
            last_q, last_c = q, None
        elif c == "T":
            q = (2 * cur[0] - last_q[0], 2 * cur[1] - last_q[1]) if last_q else cur
            p = (ox + num(), oy + num())
            sub["segs"].append(("Q", q, p))
            last_q, last_c = q, None
        elif c == "A":
            rx, ry, phi = num(), num(), num()
            large, sweep = flag(), flag()
            p = (ox + num(), oy + num())
            for _, c1, c2, p3 in arc_to_cubics(cur[0], cur[1], rx, ry, phi, large, sweep, p[0], p[1]):
                sub["segs"].append(("C", c1, c2, p3))
            last_c = last_q = None
        else:
            raise ValueError(f"unsupported path command {cmd}")
        cur = p
    if sub is not None:
        subpaths.append(sub)
    return subpaths


def ellipse_path(cx, cy, rx, ry):
    return (f"M{cx - rx} {cy}A{rx} {ry} 0 1 0 {cx + rx} {cy}"
            f"A{rx} {ry} 0 1 0 {cx - rx} {cy}Z")


def shape_to_path(el):
    tag = el.tag.split("}")[-1]
    g = lambda k, dv=0.0: float(el.get(k, dv) or dv)  # noqa: E731
    if tag == "path":
        return el.get("d", "")
    if tag == "rect":
        x, y, w, h = g("x"), g("y"), g("width"), g("height")
        if w <= 0 or h <= 0:
            return ""
        return f"M{x} {y}H{x + w}V{y + h}H{x}Z"
    if tag == "circle":
        return ellipse_path(g("cx"), g("cy"), g("r"), g("r"))
    if tag == "ellipse":
        return ellipse_path(g("cx"), g("cy"), g("rx"), g("ry"))
    if tag in ("polygon", "polyline"):
        pts = re.findall(r"[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?", el.get("points", ""))
        if len(pts) < 4:
            return ""
        d = "M" + " ".join(pts[:2]) + "".join(f"L{pts[k]} {pts[k + 1]}" for k in range(2, len(pts) - 1, 2))
        return d + ("Z" if tag == "polygon" else "")
    if tag == "line":
        return f"M{g('x1')} {g('y1')}L{g('x2')} {g('y2')}"
    return None


def cubic_to_quads(p0, p1, p2, p3, tol):
    """A cubic as a run of quadratics within `tol` of it."""
    ex = p3[0] - 3 * p2[0] + 3 * p1[0] - p0[0]
    ey = p3[1] - 3 * p2[1] + 3 * p1[1] - p0[1]
    err = math.sqrt(3) / 36 * math.hypot(ex, ey)
    n = max(1, math.ceil((err / tol) ** (1 / 3))) if err > 0 else 1
    quads = []

    def at(t):
        mt = 1 - t
        return (mt ** 3 * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t ** 3 * p3[0],
                mt ** 3 * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t ** 3 * p3[1])

    def tangent(t):
        mt = 1 - t
        return (3 * mt * mt * (p1[0] - p0[0]) + 6 * mt * t * (p2[0] - p1[0]) + 3 * t * t * (p3[0] - p2[0]),
                3 * mt * mt * (p1[1] - p0[1]) + 6 * mt * t * (p2[1] - p1[1]) + 3 * t * t * (p3[1] - p2[1]))

    for i in range(n):
        a, b = i / n, (i + 1) / n
        q0, q3 = at(a), at(b)
        d0, d3 = tangent(a), tangent(b)
        h = (b - a) / 3
        c1 = (q0[0] + d0[0] * h, q0[1] + d0[1] * h)
        c2 = (q3[0] - d3[0] * h, q3[1] - d3[1] * h)
        ctrl = ((3 * (c1[0] + c2[0]) - q0[0] - q3[0]) / 4, (3 * (c1[1] + c2[1]) - q0[1] - q3[1]) / 4)
        quads.append((ctrl, q3))
    return quads


def fill_contours(subpaths, m):
    """Subpaths in font space as contours of (x, y, on_curve) points."""
    contours = []
    for sub in subpaths:
        pts = [apply(m, *sub["start"]) + (True,)]
        cur = sub["start"]
        for seg in sub["segs"]:
            if seg[0] == "L":
                pts.append(apply(m, *seg[1]) + (True,))
                cur = seg[1]
            elif seg[0] == "Q":
                pts.append(apply(m, *seg[1]) + (False,))
                pts.append(apply(m, *seg[2]) + (True,))
                cur = seg[2]
            else:
                a, b, c = (apply(m, *p) for p in seg[1:])
                for ctrl, end in cubic_to_quads(apply(m, *cur), a, b, c, TOLERANCE):
                    pts.append(ctrl + (False,))
                    pts.append(end + (True,))
                cur = seg[3]
        if len(pts) >= 3:
            contours.append(pts)
    return contours


def flatten(subpaths, m, step=6.0):
    """Subpaths in font space as polylines, for stroking."""
    lines = []
    for sub in subpaths:
        pts = [apply(m, *sub["start"])]
        cur = pts[0]
        for seg in sub["segs"]:
            ends = [apply(m, *p) for p in seg[1:]]
            if seg[0] == "L":
                pts.append(ends[0])
            else:
                ctrl = [cur] + ends
                length = sum(math.dist(ctrl[k], ctrl[k + 1]) for k in range(len(ctrl) - 1))
                n = max(2, math.ceil(length / step))
                for k in range(1, n + 1):
                    t = k / n
                    pts.append(bezier_point(ctrl, t))
            cur = pts[-1]
        if sub["closed"]:
            pts.append(pts[0])
        lines.append(pts)
    return lines


def bezier_point(ctrl, t):
    pts = list(ctrl)
    while len(pts) > 1:
        pts = [((1 - t) * a[0] + t * b[0], (1 - t) * a[1] + t * b[1]) for a, b in zip(pts, pts[1:])]
    return pts[0]


def capsule(a, b, r, steps=8):
    """A stroked segment with round ends, as one closed polygon."""
    ang = math.atan2(b[1] - a[1], b[0] - a[0]) if a != b else 0.0
    pts = []
    # Round the far end from one side to the other, then the near end back.
    for k in range(steps + 1):
        t = ang - math.pi / 2 + math.pi * k / steps
        pts.append((b[0] + r * math.cos(t), b[1] + r * math.sin(t), True))
    for k in range(steps + 1):
        t = ang + math.pi / 2 + math.pi * k / steps
        pts.append((a[0] + r * math.cos(t), a[1] + r * math.sin(t), True))
    return pts


def stroke_contours(subpaths, m, width):
    """Round-capped, round-joined strokes: one capsule per straight piece.

    TrueType fills with the non-zero rule, so overlapping capsules wound the
    same way paint as their union; the overlaps at each join are the round
    join.
    """
    scale = math.sqrt(abs(m[0] * m[3] - m[1] * m[2]))
    r = width * scale / 2
    out = []
    for line in flatten(subpaths, m):
        pieces = list(zip(line, line[1:])) or [(line[0], line[0])]
        for a, b in pieces:
            out.append(capsule(a, b, r))
    return out


def signed_area(contour):
    s = 0.0
    for (x1, y1, _), (x2, y2, _) in zip(contour, contour[1:] + contour[:1]):
        s += x1 * y2 - x2 * y1
    return s / 2


def clockwise(contours):
    """Wind a shape's contours so its outermost one runs clockwise (y up).

    TrueType wants outer contours clockwise. The relative winding of the rest
    is kept, which is what decides whether an inner contour is a hole.
    """
    if not contours:
        return contours
    outer = max(contours, key=lambda c: abs(signed_area(c)))
    if signed_area(outer) > 0:
        return [list(reversed(c)) for c in contours]
    return contours


# --------------------------------------------------------------------------
# SVG -> glyph
# --------------------------------------------------------------------------

def style_of(el, inherited):
    style = dict(inherited)
    for part in (el.get("style") or "").split(";"):
        if ":" in part:
            k, v = part.split(":", 1)
            style[k.strip()] = v.strip()
    for key in ("fill", "stroke", "stroke-width", "fill-rule", "display", "visibility"):
        if el.get(key) is not None:
            style[key] = el.get(key)
    return style


def svg_glyph(path: str, warn):
    root = ET.parse(path).getroot()
    vb = [float(v) for v in re.split(r"[\s,]+", (root.get("viewBox") or "").strip()) if v]
    if len(vb) != 4:
        w = float(re.sub(r"[^\d.]", "", root.get("width", "64")) or 64)
        h = float(re.sub(r"[^\d.]", "", root.get("height", "64")) or 64)
        vb = [0.0, 0.0, w, h]
    vx, vy, vw, vh = vb
    span = max(vw, vh)
    s = ICON_SIZE / span
    # Centre the view box in the icon square, flip y (fonts grow upwards).
    ox = SIDE_BEARING + (ICON_SIZE - vw * s) / 2
    top = ICON_BOTTOM + ICON_SIZE - (ICON_SIZE - vh * s) / 2
    base = (s, 0.0, 0.0, -s, ox - vx * s, top + vy * s)

    contours = []

    def walk(el, m, style):
        tag = el.tag.split("}")[-1]
        if tag in ("defs", "clipPath", "mask", "title", "desc", "metadata", "style", "symbol"):
            return
        style = style_of(el, style)
        if style.get("display") == "none" or style.get("visibility") == "hidden":
            return
        m = mat_mul(m, parse_transform(el.get("transform")))
        d = shape_to_path(el)
        if d is None:
            if tag not in ("svg", "g", "a"):
                warn(f"{os.path.basename(path)}: <{tag}> is not supported and was left out")
            for child in el:
                walk(child, m, style)
            return
        if not d:
            return
        subpaths = parse_path(d)
        fill = style.get("fill", "black")
        stroke = style.get("stroke", "none")
        if fill != "none" and tag != "line":
            if style.get("fill-rule") == "evenodd":
                warn(f"{os.path.basename(path)}: fill-rule evenodd is drawn as nonzero")
            contours.extend(clockwise(fill_contours(subpaths, m)))
        if stroke != "none":
            width = float(re.sub(r"[^\d.]", "", style.get("stroke-width", "1")) or 1)
            contours.extend(clockwise([c])[0] for c in stroke_contours(subpaths, m, width))

    walk(root, base, {})
    return contours


# --------------------------------------------------------------------------
# TrueType
# --------------------------------------------------------------------------

def rounded(contours):
    out = []
    for c in contours:
        pts = []
        for x, y, on in c:
            p = (int(round(x)), int(round(y)), on)
            if pts and pts[-1] == p:
                continue
            pts.append(p)
        while len(pts) > 1 and pts[-1] == pts[0]:
            pts.pop()
        if len(pts) >= 3:
            out.append(pts)
    return out


def encode_glyph(contours):
    if not contours:
        return b"", (0, 0, 0, 0), 0
    xs = [p[0] for c in contours for p in c]
    ys = [p[1] for c in contours for p in c]
    bbox = (min(xs), min(ys), max(xs), max(ys))
    ends, n = [], 0
    for c in contours:
        n += len(c)
        ends.append(n - 1)
    flags, xb, yb = bytearray(), bytearray(), bytearray()
    px = py = 0
    for c in contours:
        for x, y, on in c:
            f = 0x01 if on else 0
            dx, dy = x - px, y - py
            px, py = x, y
            if dx == 0:
                f |= 0x10
            elif -255 <= dx <= 255:
                f |= 0x02 | (0x10 if dx > 0 else 0)
                xb.append(abs(dx))
            else:
                xb += struct.pack(">h", dx)
            if dy == 0:
                f |= 0x20
            elif -255 <= dy <= 255:
                f |= 0x04 | (0x20 if dy > 0 else 0)
                yb.append(abs(dy))
            else:
                yb += struct.pack(">h", dy)
            flags.append(f)
    data = struct.pack(">h4h", len(contours), *bbox)
    data += struct.pack(f">{len(ends)}H", *ends)
    data += struct.pack(">H", 0)      # no instructions
    data += bytes(flags) + bytes(xb) + bytes(yb)
    data += b"\0" * (-len(data) % 4)
    return data, bbox, n


def notdef_contours():
    x0, x1, y0, y1, t = SIDE_BEARING, ADVANCE - SIDE_BEARING, ICON_BOTTOM, ICON_BOTTOM + ICON_SIZE, 60
    outer = [(x0, y0, True), (x0, y1, True), (x1, y1, True), (x1, y0, True)]
    inner = [(x0 + t, y0 + t, True), (x1 - t, y0 + t, True), (x1 - t, y1 - t, True), (x0 + t, y1 - t, True)]
    return [outer, inner]


def checksum(data: bytes) -> int:
    data += b"\0" * (-len(data) % 4)
    return sum(struct.unpack(f">{len(data) // 4}I", data)) & 0xFFFFFFFF


def cmap_table(mapping):
    """Format 4, one segment per code point: icon sets are small and sparse."""
    segs = sorted(mapping.items()) + [(0xFFFF, 0)]
    n = len(segs)
    search = 2 ** int(math.log2(n)) * 2
    sub = struct.pack(">HHHHHHH", 4, 0, 0, n * 2, search, int(math.log2(search // 2)), n * 2 - search)
    sub += b"".join(struct.pack(">H", cp) for cp, _ in segs)
    sub += struct.pack(">H", 0)
    sub += b"".join(struct.pack(">H", cp) for cp, _ in segs)
    sub += b"".join(struct.pack(">H", (gid - cp) % 0x10000 if cp != 0xFFFF else 1) for cp, gid in segs)
    sub += struct.pack(f">{n}H", *([0] * n))
    sub = sub[:2] + struct.pack(">H", len(sub)) + sub[4:]
    head = struct.pack(">HH", 0, 2)
    head += struct.pack(">HHI", 0, 3, 4 + 16)      # Unicode BMP
    head += struct.pack(">HHI", 3, 1, 4 + 16)      # Windows Unicode BMP
    return head + sub


# A font-specific name record (IDs 256 and up are the font's own) listing the
# icons that have been taken out, with the code points they had. Nothing draws
# them any more, but no new icon may take their points: a card that still holds
# one must show an empty box, not some other icon. Written only when there is
# something to list, so a font with nothing retired is unchanged by it.
RETIRED_NAME_ID = 256


def name_table(retired=None):
    records = {
        1: FAMILY,
        2: "Regular",
        3: f"{FAMILY} Regular {VERSION}",
        4: FAMILY,
        5: f"Version {VERSION}",
        6: FAMILY.replace(" ", "") + "-Regular",
    }
    if retired:
        records[RETIRED_NAME_ID] = "retired " + " ".join(
            f"{name}=U+{cp:04X}" for name, cp in sorted(retired.items(), key=lambda kv: kv[1]))
    strings, recs, offset = b"", b"", 0
    for nid, text in records.items():
        raw = text.encode("utf-16-be")
        recs += struct.pack(">HHHHHH", 3, 1, 0x409, nid, len(raw), offset)
        strings += raw
        offset += len(raw)
    return struct.pack(">HHH", 0, len(records), 6 + len(recs)) + recs + strings


def post_table(names):
    # Format 2 carries the glyph names, and the names are what make these
    # glyphs icons: the editor reads them to know what {gem} means.
    head = struct.pack(">IIhhIIIII", 0x00020000, 0, -100, 50, 0, 0, 0, 0, 0)
    indices, strings = [], b""
    custom = 0
    for name in names:
        if name == ".notdef":
            indices.append(0)
        elif name == "space":
            indices.append(3)
        else:
            indices.append(258 + custom)
            custom += 1
            raw = name.encode("ascii")
            strings += bytes([len(raw)]) + raw
    return head + struct.pack(f">H{len(indices)}H", len(indices), *indices) + strings


def build_font(glyphs, retired=None):
    """glyphs: list of (name, code point or None, contours, advance).
    retired: name -> code point of icons no longer in the font."""
    glyf, loca, hmtx = b"", [], b""
    bboxes, rsbs, max_pts, max_cont = [], [], 0, 0
    for _, _, contours, advance in glyphs:
        data, bbox, npts = encode_glyph(rounded(contours))
        loca.append(len(glyf))
        glyf += data
        if data:
            bboxes.append(bbox)
            rsbs.append(advance - bbox[2])
            max_pts = max(max_pts, npts)
            max_cont = max(max_cont, struct.unpack(">h", data[:2])[0])
        hmtx += struct.pack(">Hh", advance, bbox[0] if data else 0)
    loca.append(len(glyf))
    num = len(glyphs)
    x_min = min(b[0] for b in bboxes)
    y_min = min(b[1] for b in bboxes)
    x_max = max(b[2] for b in bboxes)
    y_max = max(b[3] for b in bboxes)
    adv_max = max(g[3] for g in glyphs)
    mapping = {cp: gid for gid, (_, cp, _, _) in enumerate(glyphs) if cp is not None}
    cps = sorted(mapping)

    head = struct.pack(">IIIIHHqqhhhhHHhhh",
                       0x00010000, 0x00010000, 0, 0x5F0F3CF5, 0x0003, UPM,
                       # Created / modified: a fixed date, so a rebuild is
                       # byte-identical and the font can be checked in CI.
                       FONT_DATE, FONT_DATE,
                       x_min, y_min, x_max, y_max, 0, 8, 2, 1, 0)
    hhea = struct.pack(">IhhhHhhhhhhhhhhhH",
                       0x00010000, ASCENT, -DESCENT, 0, adv_max,
                       min(b[0] for b in bboxes), min(rsbs), x_max, 1, 0, 0, 0, 0, 0, 0, 0, num)
    maxp = struct.pack(">IHHHHHHHHHHHHHH", 0x00010000, num, max_pts, max_cont,
                       0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0)
    avg = round(sum(g[3] for g in glyphs if g[3]) / max(1, sum(1 for g in glyphs if g[3])))
    os2 = struct.pack(">HhHHHhhhhhhhhhhh", 4, avg, 400, 5, 0,
                      650, 600, 0, 75, 650, 600, 0, 350, 50, 300, 0)
    os2 += bytes(10)                                   # panose
    os2 += struct.pack(">IIII", 1, 1 << 28, 0, 0)      # Basic Latin, Private Use Area
    os2 += b"TCGF"
    os2 += struct.pack(">HHHhhhHHIIhhHHH", 0x0040, min(cps), min(max(cps), 0xFFFF),
                       ASCENT, -DESCENT, 0, max(ASCENT, y_max), max(DESCENT, -y_min),
                       1, 0, 500, 700, 0, 32, 0)
    tables = {
        b"OS/2": os2,
        b"cmap": cmap_table(mapping),
        b"glyf": glyf,
        b"head": head,
        b"hhea": hhea,
        b"hmtx": hmtx,
        b"loca": struct.pack(f">{len(loca)}I", *loca),
        b"maxp": maxp,
        b"name": name_table(retired),
        b"post": post_table([g[0] for g in glyphs]),
    }
    n = len(tables)
    search = 2 ** int(math.log2(n)) * 16
    out = struct.pack(">IHHHH", 0x00010000, n, search, int(math.log2(search // 16)), n * 16 - search)
    offset = 12 + 16 * n
    directory, body = b"", b""
    for tag in sorted(tables):
        data = tables[tag]
        directory += struct.pack(">4sIII", tag, checksum(data), offset + len(body), len(data))
        body += data + b"\0" * (-len(data) % 4)
    font = bytearray(out + directory + body)
    head_at = offset + sum(len(tables[t]) + (-len(tables[t]) % 4) for t in sorted(tables) if t < b"head")
    adjust = (0xB1B0AFBA - checksum(bytes(font))) & 0xFFFFFFFF
    font[head_at + 8:head_at + 12] = struct.pack(">I", adjust)
    return bytes(font)


# --------------------------------------------------------------------------
# reading a font back, for stable code points
# --------------------------------------------------------------------------

def read_icon_names(data: bytes) -> dict:
    """name -> code point for every named Private Use Area glyph in a font."""
    num_tables = struct.unpack_from(">H", data, 4)[0]
    tables = {}
    for k in range(num_tables):
        tag, _, off, length = struct.unpack_from(">4sIII", data, 12 + 16 * k)
        tables[tag] = (off, length)
    if b"cmap" not in tables or b"post" not in tables:
        return {}
    cmap_at = tables[b"cmap"][0]
    gid_of = {}
    for k in range(struct.unpack_from(">H", data, cmap_at + 2)[0]):
        pid, eid, off = struct.unpack_from(">HHI", data, cmap_at + 4 + 8 * k)
        sub = cmap_at + off
        if struct.unpack_from(">H", data, sub)[0] != 4:
            continue
        segx2 = struct.unpack_from(">H", data, sub + 6)[0]
        ends_at = sub + 14
        starts_at = ends_at + segx2 + 2
        deltas_at = starts_at + segx2
        ranges_at = deltas_at + segx2
        for s in range(segx2 // 2):
            end, start = (struct.unpack_from(">H", data, a + 2 * s)[0] for a in (ends_at, starts_at))
            delta = struct.unpack_from(">h", data, deltas_at + 2 * s)[0]
            ro = struct.unpack_from(">H", data, ranges_at + 2 * s)[0]
            for cp in range(max(start, PUA_START), min(end, PUA_END) + 1):
                if ro:
                    g = struct.unpack_from(">H", data, ranges_at + 2 * s + ro + 2 * (cp - start))[0]
                    gid_of[cp] = (g + delta) % 0x10000 if g else 0
                else:
                    gid_of[cp] = (cp + delta) % 0x10000
        break
    post_at = tables[b"post"][0]
    if struct.unpack_from(">I", data, post_at)[0] != 0x00020000:
        return {}
    count = struct.unpack_from(">H", data, post_at + 32)[0]
    idx = struct.unpack_from(f">{count}H", data, post_at + 34)
    pos = post_at + 34 + 2 * count
    strings = []
    end = post_at + tables[b"post"][1]
    while pos < end:
        ln = data[pos]
        strings.append(data[pos + 1:pos + 1 + ln].decode("latin-1"))
        pos += 1 + ln
    names = {}
    for cp, gid in gid_of.items():
        if 0 < gid < count and idx[gid] >= 258 and idx[gid] - 258 < len(strings):
            names[strings[idx[gid] - 258]] = cp
    return names


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------

def read_retired(data: bytes) -> dict:
    """name -> code point of the icons an earlier build took out."""
    num_tables = struct.unpack_from(">H", data, 4)[0]
    for k in range(num_tables):
        tag, _, at, _ = struct.unpack_from(">4sIII", data, 12 + 16 * k)
        if tag != b"name":
            continue
        count, strings_at = struct.unpack_from(">HH", data, at + 2)
        for r in range(count):
            pid, _, _, nid, length, off = struct.unpack_from(">HHHHHH", data, at + 6 + 12 * r)
            if nid != RETIRED_NAME_ID or pid != 3:
                continue
            raw = data[at + strings_at + off:at + strings_at + off + length]
            text = raw.decode("utf-16-be", "replace")
            if not text.startswith("retired "):
                continue
            out = {}
            for item in text[len("retired "):].split():
                name, _, cp = item.partition("=U+")
                try:
                    out[name] = int(cp, 16)
                except ValueError:
                    continue
            return out
    return {}


def sibling_code_points(out_path: str) -> set:
    """Private Use Area points claimed by the other fonts beside the output.

    Most icon fonts start at U+E000, and when two fonts in the library map one
    code point the canvas draws whichever comes first — {rune} would come out
    as {element-air}. A new font therefore starts after its neighbours."""
    folder = os.path.dirname(os.path.abspath(out_path))
    taken = set()
    if not os.path.isdir(folder):
        return taken
    for fn in sorted(os.listdir(folder)):
        full = os.path.join(folder, fn)
        if not fn.lower().endswith((".ttf", ".otf")) or os.path.abspath(full) == os.path.abspath(out_path):
            continue
        try:
            with open(full, "rb") as fh:
                data = fh.read()
            taken.update(read_icon_names(data).values())
            taken.update(read_retired(data).values())
        except (OSError, struct.error, IndexError, KeyError):
            continue  # not a font this reader understands; it claims nothing
    return taken


def icon_name(filename: str) -> str:
    stem = os.path.splitext(os.path.basename(filename))[0].lower()
    return re.sub(r"[^a-z0-9]+", "-", stem).strip("-")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build an icon font from a folder of SVGs.")
    parser.add_argument("--icons", default=DEFAULT_ICONS, help="folder of .svg icons")
    parser.add_argument("--out", default=DEFAULT_OUT, help="the .ttf to write")
    parser.add_argument("--list", action="store_true",
                        help="print the name -> code point table of --out and stop")
    args = parser.parse_args(argv)

    previous, retired = {}, {}
    if os.path.isfile(args.out):
        with open(args.out, "rb") as fh:
            data = fh.read()
        previous = read_icon_names(data)
        retired = read_retired(data)
    if args.list:
        for name, cp in sorted(previous.items(), key=lambda kv: kv[1]):
            print(f"U+{cp:04X}  {{{name}}}")
        return 0

    files = sorted(f for f in os.listdir(args.icons) if f.lower().endswith(".svg"))
    warnings = []
    glyphs = [(".notdef", None, notdef_contours(), ADVANCE), ("space", 0x20, [], SPACE_ADVANCE)]
    # A code point is handed out once, ever: never one an icon still holds,
    # one an icon that was taken out held, or one another font here uses.
    taken = set(previous.values()) | set(retired.values()) | sibling_code_points(args.out)
    next_cp = max(taken, default=PUA_START - 1) + 1
    seen = set()
    for fn in files:
        name = icon_name(fn)
        if not name or name in seen:
            warnings.append(f"{fn}: name '{name}' is empty or already used — skipped")
            continue
        seen.add(name)
        try:
            contours = svg_glyph(os.path.join(args.icons, fn), warnings.append)
        except (ET.ParseError, ValueError, IndexError) as exc:
            warnings.append(f"{fn}: could not be read ({exc}) — skipped")
            continue
        if not contours:
            warnings.append(f"{fn}: nothing drawable — skipped")
            continue
        cp = previous.get(name, retired.get(name))
        if cp is None:
            if next_cp > PUA_END:
                warnings.append(f"{fn}: the Private Use Area is full — skipped")
                continue
            cp = next_cp
            next_cp += 1
        glyphs.append((name, cp, contours, ADVANCE))

    if len(glyphs) == 2:
        print("No icons to build.", file=sys.stderr)
        return 1
    built = {g[0] for g in glyphs[2:]}
    gone = {name: cp for name, cp in {**retired, **previous}.items() if name not in built}
    for name in sorted(set(previous) - built):
        warnings.append(f"{{{name}}} is no longer in the font; U+{previous[name]:04X} stays reserved for it")
    font = build_font(glyphs, gone)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "wb") as fh:
        fh.write(font)
    for w in warnings:
        print(f"  warning: {w}", file=sys.stderr)
    print(f"  {os.path.relpath(args.out, ROOT) if args.out.startswith(ROOT) else args.out}: "
          f"{len(glyphs) - 2} icons, {len(font)} bytes")
    for name, cp, _, _ in glyphs[2:]:
        print(f"    U+{cp:04X}  {{{name}}}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
