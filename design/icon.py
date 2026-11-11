import math, sys, os
from playwright.sync_api import sync_playwright

RED, DARK = "#FD1D3F", "#20222F"

def teeth(n, r_in, r_out, w_in, w_out):
    out = []
    for i in range(n):
        a = 2*math.pi*i/n
        def p(r, da):
            return f"{512 + r*math.cos(a+da):.1f},{512 + r*math.sin(a+da):.1f}"
        d = f"M{p(r_in,-w_in)} L{p(r_out,-w_out)} L{p(r_out,w_out)} L{p(r_in,w_in)} Z"
        out.append(f'<path d="{d}"/>')
    return "".join(out)

GEAR = f'''
<g transform="translate(512 512) rotate(-32) scale(1 .74) translate(-512 -512)">
  <g fill="url(#steel)" stroke="#0f1018" stroke-opacity=".35" stroke-width="3">{teeth(22, 376, 456, .062, .046)}</g>
  <circle cx="512" cy="512" r="400" fill="none" stroke="url(#steel)" stroke-width="50"/>
  <circle cx="512" cy="512" r="330" fill="none" stroke="#8d93a8" stroke-opacity=".75" stroke-width="10"/>
</g>'''

BUBBLE = f'''
<g transform="translate(512 500) skewX(-9) translate(-512 -500)" filter="url(#sh)">
  <path d="M300 250 H724 A128 128 0 0 1 852 378 V570 A128 128 0 0 1 724 698 H520 L318 812 L372 698 H300 A128 128 0 0 1 172 570 V378 A128 128 0 0 1 300 250 Z" fill="url(#red)"/>
  <path d="M300 250 H724 A128 128 0 0 1 852 378 V400 C700 330 420 330 172 420 V378 A128 128 0 0 1 300 250 Z" fill="#fff" opacity=".08"/>
</g>
<!-- bold flowing stroke inside the bubble: echoes the swoosh of the original logo -->
<g transform="translate(512 500) skewX(-9) translate(-512 -500)" fill="none" stroke="#fff" stroke-width="64" stroke-linecap="round" stroke-linejoin="round">
  <path d="M300 590 L412 400 C452 334 520 336 540 396 C570 486 612 540 664 520 C706 504 716 440 742 396"/>
</g>'''

def svg(kind):
    defs = f'''<defs>
  <linearGradient id="steel" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f4f5f9"/><stop offset=".5" stop-color="#b9bdca"/><stop offset="1" stop-color="#6e7388"/></linearGradient>
  <linearGradient id="red" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FD1D3F"/><stop offset="1" stop-color="#D80F2E"/></linearGradient>
  <radialGradient id="bg" cx=".5" cy=".42" r=".75"><stop offset="0" stop-color="#2d3045"/><stop offset="1" stop-color="{DARK}"/></radialGradient>
  <filter id="sh" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="26" stdDeviation="26" flood-color="#000" flood-opacity=".45"/></filter>
</defs>'''
    if kind == "icon":   # full-bleed square (iOS rounds it, Android legacy)
        return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">{defs}<rect width="1024" height="1024" fill="url(#bg)"/><g>{GEAR}{BUBBLE}</g></svg>'
    if kind == "foreground":  # adaptive icon: keep artwork inside the 66% safe zone
        return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">{defs}<g transform="translate(512 512) scale(.64) translate(-512 -512)">{GEAR}{BUBBLE}</g></svg>'
    if kind == "background":
        return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">{defs}<rect width="1024" height="1024" fill="url(#bg)"/></svg>'
    if kind == "splash":
        return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">{defs}<g transform="translate(512 512) scale(.8) translate(-512 -512)">{GEAR}{BUBBLE}</g></svg>'
    if kind == "mono":    # Android status-bar icon: alpha-only silhouette, swoosh cut out
        return """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024"><rect width="1024" height="1024" fill="#000"/>
        <g transform="translate(512 500) skewX(-9) translate(-512 -500)"><path fill="#fff" d="M300 160 H724 A148 148 0 0 1 872 308 V570 A148 148 0 0 1 724 718 H540 L318 880 L372 718 H300 A148 148 0 0 1 152 570 V308 A148 148 0 0 1 300 160 Z"/>
        <path d="M300 540 L412 350 C452 284 520 286 540 346 C570 436 612 490 664 470 C706 454 716 390 742 346" fill="none" stroke="#000" stroke-width="72" stroke-linecap="round" stroke-linejoin="round"/></g></mask></defs>
        <rect width="1024" height="1024" fill="#fff" mask="url(#m)"/></svg>"""

def render(kind, name, size, transparent):
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
        pg = b.new_page(viewport={"width": size, "height": size})
        pg.set_content(f'<html><body style="margin:0;background:transparent">{svg(kind).replace("<svg ", f"<svg width=\"{size}\" height=\"{size}\" ", 1)}</body></html>')
        pg.screenshot(path=name, omit_background=transparent)
        b.close()

os.makedirs("out", exist_ok=True)
render("icon", "out/icon.png", 1024, False)
render("foreground", "out/adaptive-icon.png", 1024, True)
render("background", "out/adaptive-bg.png", 1024, False)
render("splash", "out/splash-icon.png", 1024, True)
render("mono", "out/notification-icon.png", 256, True)
