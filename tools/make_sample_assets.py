#!/usr/bin/env python3
"""
Generate the sample asset pack that ships with TCG Forge.

Everything is written as plain SVG so the repository stays small and the files
are easy to open and edit. Run it again at any time to restore the defaults:

    python tools/make_sample_assets.py
"""

import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "workspace", "assets")

W, H = 750, 1050


def write(category, name, svg):
    folder = os.path.join(ASSETS, category)
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, f"{name}.svg")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(svg.strip() + "\n")
    print(f"  {os.path.relpath(path, ROOT)}")


def frame_ornate(accent="#c8a44a", inner="#171310"):
    return f"""
<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
  <defs>
    <linearGradient id="metal" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{accent}" stop-opacity="1"/>
      <stop offset="0.45" stop-color="#8a6f2c"/>
      <stop offset="0.55" stop-color="{accent}"/>
      <stop offset="1" stop-color="#6d5622"/>
    </linearGradient>
  </defs>
  <!-- border band only: the middle stays transparent so backgrounds show through -->
  <rect x="14" y="14" width="{W-28}" height="{H-28}" rx="26" fill="none" stroke="url(#metal)" stroke-width="28"/>
  <rect x="30" y="30" width="{W-60}" height="{H-60}" rx="18" fill="none" stroke="{accent}" stroke-width="2" opacity="0.75"/>
  <rect x="42" y="42" width="{W-84}" height="{H-84}" rx="12" fill="none" stroke="{inner}" stroke-width="2" opacity="0.5"/>
  <rect x="52" y="96" width="{W-104}" height="430" rx="10" fill="none" stroke="{accent}" stroke-width="4"/>
  <rect x="52" y="566" width="{W-104}" height="300" rx="10" fill="none" stroke="{accent}" stroke-width="3" opacity="0.85"/>
  <path d="M60 40 L110 40 L60 90 Z" fill="{accent}" opacity="0.55"/>
  <path d="M{W-60} 40 L{W-110} 40 L{W-60} 90 Z" fill="{accent}" opacity="0.55"/>
  <path d="M60 {H-40} L110 {H-40} L60 {H-90} Z" fill="{accent}" opacity="0.55"/>
  <path d="M{W-60} {H-40} L{W-110} {H-40} L{W-60} {H-90} Z" fill="{accent}" opacity="0.55"/>
</svg>
"""


def frame_minimal(accent="#e8ecf5"):
    return f"""
<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
  <rect x="0" y="0" width="{W}" height="{H}" rx="36" fill="none" stroke="{accent}" stroke-width="10" opacity="0.9"/>
  <rect x="34" y="34" width="{W-68}" height="{H-68}" rx="20" fill="none" stroke="{accent}" stroke-width="2" opacity="0.45"/>
  <line x1="34" y1="150" x2="{W-34}" y2="150" stroke="{accent}" stroke-width="2" opacity="0.5"/>
  <line x1="34" y1="640" x2="{W-34}" y2="640" stroke="{accent}" stroke-width="2" opacity="0.5"/>
</svg>
"""


def frame_tech():
    return f"""
<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
  <defs>
    <linearGradient id="edge" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4de3ff"/>
      <stop offset="0.5" stop-color="#2a6cf6"/>
      <stop offset="1" stop-color="#7b3ff2"/>
    </linearGradient>
  </defs>
  <path d="M0 40 L40 0 L{W-40} 0 L{W} 40 L{W} {H-40} L{W-40} {H} L40 {H} L0 {H-40} Z"
        fill="none" stroke="url(#edge)" stroke-width="9"/>
  <path d="M26 60 L60 26 L{W-60} 26 L{W-26} 60 L{W-26} {H-60} L{W-60} {H-26} L60 {H-26} L26 {H-60} Z"
        fill="none" stroke="#4de3ff" stroke-width="2" opacity="0.5"/>
  <rect x="60" y="120" width="{W-120}" height="400" fill="none" stroke="#4de3ff" stroke-width="3" opacity="0.85"/>
  <rect x="60" y="120" width="90" height="6" fill="#4de3ff"/>
  <rect x="{W-150}" y="514" width="90" height="6" fill="#7b3ff2"/>
</svg>
"""


def background_gradient(name_stops):
    stops = "".join(
        f'<stop offset="{o}" stop-color="{c}"/>' for o, c in name_stops
    )
    return f"""
<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0.4" y2="1">{stops}</linearGradient></defs>
  <rect width="{W}" height="{H}" fill="url(#g)"/>
</svg>
"""


def background_starfield():
    import random

    random.seed(7)
    stars = []
    for _ in range(260):
        x = random.randint(0, W)
        y = random.randint(0, H)
        r = random.choice([0.8, 1.1, 1.4, 2.0])
        o = round(random.uniform(0.25, 0.95), 2)
        stars.append(f'<circle cx="{x}" cy="{y}" r="{r}" fill="#ffffff" opacity="{o}"/>')
    return f"""
<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
  <defs><radialGradient id="neb" cx="0.3" cy="0.25" r="0.85">
    <stop offset="0" stop-color="#3b2a6b"/><stop offset="0.6" stop-color="#141029"/>
    <stop offset="1" stop-color="#05060d"/></radialGradient></defs>
  <rect width="{W}" height="{H}" fill="url(#neb)"/>
  {''.join(stars)}
</svg>
"""


def texture_hatch(color="#ffffff"):
    return f"""
<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
  <defs>
    <pattern id="p" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
      <line x1="0" y1="0" x2="0" y2="14" stroke="{color}" stroke-width="2" opacity="0.18"/>
    </pattern>
  </defs>
  <rect width="{W}" height="{H}" fill="url(#p)"/>
</svg>
"""


ICONS = {
    "element-fire": ('#ff6b35', 'M32 4c6 12 18 16 18 30a18 18 0 11-36 0C14 22 26 18 32 4z'),
    "element-water": ('#3aa0ff', 'M32 5c10 14 19 22 19 32a19 19 0 11-38 0C13 27 22 19 32 5z'),
    "element-earth": ('#8bc34a', 'M8 44l14-26 10 16 8-12 16 22z'),
    "element-air": ('#c9e6ff', 'M6 24h32a8 8 0 10-8-8M6 36h40a8 8 0 11-8 8'),
    "element-dark": ('#8b5cf6', 'M32 6a26 26 0 1020 42A22 22 0 0132 6z'),
    "element-light": ('#ffd166', 'M32 8v12M32 44v12M8 32h12M44 32h12M15 15l9 9M40 40l9 9M49 15l-9 9M24 40l-9 9'),
    "star": ('#ffd166', 'M32 6l7.6 17.2L58 25.6 44.6 38.4 48 57 32 47.8 16 57l3.4-18.6L6 25.6l18.4-2.4z'),
    "sword": ('#d7dce6', 'M46 6l12 0 0 12L30 46l-8 4-4-4 4-8z'),
    "shield": ('#7aa2ff', 'M32 6l22 8v18c0 14-9 22-22 26-13-4-22-12-22-26V14z'),
    "heart": ('#ff5c7a', 'M32 56C14 44 6 34 6 24A13 13 0 0132 17 13 13 0 0158 24c0 10-8 20-26 32z'),
    "gem": ('#5be3c0', 'M20 8h24l12 16-24 32L8 24z'),
    "skull": ('#e8ecf5', 'M32 6a22 22 0 00-14 39v9h28v-9A22 22 0 0032 6zM24 30a5 5 0 110-10 5 5 0 010 10zm16 0a5 5 0 110-10 5 5 0 010 10z'),
}


def icon(color, path, filled=True):
    style = f'fill="{color}"' if filled else f'fill="none" stroke="{color}" stroke-width="4" stroke-linecap="round"'
    return f"""
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 64 64">
  <path d="{path}" {style}/>
</svg>
"""


def main():
    print("Writing sample assets into workspace/assets …")

    write("frames", "ornate-gold", frame_ornate())
    write("frames", "ornate-silver", frame_ornate("#cdd6e3", "#101418"))
    write("frames", "minimal-light", frame_minimal())
    write("frames", "tech-neon", frame_tech())

    write("backgrounds", "parchment", background_gradient([(0, "#f3e3c3"), (0.55, "#e2c89b"), (1, "#c9a877")]))
    write("backgrounds", "ember", background_gradient([(0, "#3a0d0d"), (0.5, "#7c1f14"), (1, "#1a0708")]))
    write("backgrounds", "abyss", background_gradient([(0, "#0d1b2a"), (0.6, "#12324d"), (1, "#04080f")]))
    write("backgrounds", "starfield", background_starfield())

    write("textures", "hatch-light", texture_hatch("#ffffff"))
    write("textures", "hatch-dark", texture_hatch("#000000"))

    for name, (color, path) in ICONS.items():
        filled = name not in ("element-air", "element-light")
        write("icons", name, icon(color, path, filled))

    print("Done.")


if __name__ == "__main__":
    main()
