"""Genera el logo de VanGUARD a partir de trazos caligráficos (grosor variable).

Cada trazo es una curva cúbica (su eje) más un perfil de grosor a lo largo de ella.
Salidas en brand/logo/ (ver brand/README.md):
  vanguard-mark*.svg          símbolo (ojo VG)
  vanguard-mark-compact*.svg  símbolo con más peso, para menos de 64 px
  vanguard-logo*.svg          símbolo + nombre, horizontal
  favicon-*.svg               símbolo compacto sobre un cuadrado
  Sufijos: sin sufijo = currentColor · -on-dark = claro para fondos oscuros · -on-light = oscuro
Y brand/mark-data.js con contornos, ejes y cuadros del parpadeo para la página animada.
Uso: python3 brand/build-mark.py   (el nombre en trazos sale de wordmark.json, ver build-wordmark.py)
"""
import json
import re
import math
from pathlib import Path

OUT = Path(__file__).parent
VIEW = (0, -6, 200, 118)

# (id, eje cúbico [p0, c1, c2, p1], perfil [(t, grosor), ...], corte de los remates (inicio, fin))
# El corte inclina el remate a lo largo del eje: 0 es recto, ±1 es un bisel de 45°.
STROKES = [
    ("lid-top",  [(8, 64), (40, 30), (80, 12), (126, 11)],   [(0, 0), (.5, 12), (1, 6)],     (0, 0)),
    ("wing",     [(126, 11), (152, 12), (175, 27), (193, 51)], [(0, 6), (.35, 9), (1, 3)],    (0, 1.1)),
    ("lid-low",  [(8, 64), (52, 104), (142, 100), (189, 61)], [(0, 0), (.45, 11), (1, 3.5)], (0, 0)),
    ("bar",      [(189, 61), (168, 64), (148, 66), (124, 67)], [(0, 3.5), (.22, 9), (1, 0)], (0, 0)),
    ("iris-l",   [(74, -2), (83, 38), (95, 82), (104, 108)],  [(0, 7.5), (.35, 8.5), (1, 0)], (-.9, 0)),
    ("iris-r",   [(134, -2), (125, 38), (113, 82), (104, 108)], [(0, 7.5), (.35, 8.5), (1, 0)], (.9, 0)),
]
IRIS = {"iris-l", "iris-r"}



def bez(p, t):
    u = 1 - t
    return tuple(u**3 * p[0][i] + 3 * u * u * t * p[1][i] + 3 * u * t * t * p[2][i] + t**3 * p[3][i] for i in (0, 1))


def dbez(p, t):
    u = 1 - t
    return tuple(3 * u * u * (p[1][i] - p[0][i]) + 6 * u * t * (p[2][i] - p[1][i]) + 3 * t * t * (p[3][i] - p[2][i]) for i in (0, 1))


def width(profile, t):
    for (t0, w0), (t1, w1) in zip(profile, profile[1:]):
        if t0 <= t <= t1:
            k = (t - t0) / (t1 - t0)
            k = k * k * (3 - 2 * k)  # suavizado
            return w0 + (w1 - w0) * k
    return profile[-1][1]


def smooth(pts):
    """Catmull-Rom → cúbicas, para que el contorno no se vea facetado."""
    out = []
    for i in range(len(pts) - 1):
        p0 = pts[max(i - 1, 0)]
        p1, p2 = pts[i], pts[i + 1]
        p3 = pts[min(i + 2, len(pts) - 1)]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        out.append("C%s %s %s" % (fmt(c1), fmt(c2), fmt(p2)))
    return " ".join(out)


def fmt(p):
    return "%g %g" % (round(p[0], 2), round(p[1], 2))


def outline(axis, profile, cuts=(0, 0), n=32):
    left, right = [], []
    for i in range(n + 1):
        t = i / n
        x, y = bez(axis, t)
        dx, dy = dbez(axis, t)
        m = math.hypot(dx, dy) or 1
        tx, ty = dx / m, dy / m
        nx, ny = -ty, tx
        h = width(profile, t) / 2
        # Bisel: desplaza cada borde a lo largo del eje, solo cerca de los remates.
        k = cuts[0] * max(0, 1 - t / .1) + cuts[1] * max(0, 1 - (1 - t) / .1)
        sx, sy = tx * k * h, ty * k * h
        left.append((x + nx * h + sx, y + ny * h + sy))
        right.append((x - nx * h - sx, y - ny * h - sy))
    right.reverse()
    return "M%s %s L%s %s Z" % (fmt(left[0]), smooth(left), fmt(right[0]), smooth(right))


def axis_d(a):
    return "M%s C%s %s %s" % (fmt(a[0]), fmt(a[1]), fmt(a[2]), fmt(a[3]))


def build(weight=1.0, drop=()):
    return [
        {"id": sid, "d": outline(a, [(t, w * weight) for t, w in prof], cuts),
         "axis": axis_d(a), "iris": sid in IRIS}
        for sid, a, prof, cuts in STROKES if sid not in drop
    ]


shapes = build()
compact = build(weight=1.3)

# La V va por encima de la G: donde se cruzan, la G se abre un hueco del ancho GAP
# alrededor de la V, como un entrelazado.
GAP = 3.4

# ---------------------------------------------------------------------------
# Parpadeo
# En vez de interpolar entre "abierto" y "cerrado" (el párpado se aplana y parece una
# tarjeta), se modela el movimiento y se muestrea a 45 fps (el navegador interpola entre cuadros):
#  - Cada párpado tiene tres poses (abierto, a medias, cerrado) y la forma intermedia
#    pasa por la de "a medias", así el párpado conserva su arco mientras baja.
#  - Baja acelerando, se posa un instante y sube frenando, con un rebote mínimo.
#  - El ala llega un poco después (inercia) y el párpado inferior sube menos y antes.
#  - La pupila se esconde bajo el borde del párpado, no bajo una línea recta.
BLINK_DUR = .78
BLINK_FPS = 45
POSES = {
    "lid-top": [(8, 64), (38, 45), (80, 33), (126, 34)],
    "wing":    [(126, 34), (151, 36), (176, 46), (193, 56)],
    "lid-low": [(8, 64), (52, 101), (142, 97.5), (189, 61)],
}
CLOSED = {
    "lid-top": [(8, 64), (44, 84), (90, 90), (126, 86)],
    "wing":    [(126, 86), (151, 85), (177, 74), (194, 60)],
    "lid-low": [(8, 64), (52, 97), (142, 94), (189, 61)],
}


def cubic_ease(x1, y1, x2, y2):
    """Curva de aceleración como cubic-bezier() de CSS."""
    def f(x):
        lo, hi = 0.0, 1.0
        for _ in range(40):
            t = (lo + hi) / 2
            bx = 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t * t * x2 + t ** 3
            lo, hi = (t, hi) if bx < x else (lo, t)
        return 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t * t * y2 + t ** 3
    return f


CLOSE = cubic_ease(.5, 0, .8, .75)   # acelera y frena justo al tocar
OPEN = cubic_ease(.3, .1, .25, 1)    # arranca suave, frena largo


def lid_p(t):
    """Cierre del párpado en el instante t: 0 abierto, 1 cerrado, <0 rebote."""
    t_close, t_hold = .18, .26
    if t <= 0:
        return 0.0
    if t < t_close:
        return CLOSE(t / t_close)
    if t < t_hold:
        return 1.0
    u = min(1.0, (t - t_hold) / (BLINK_DUR - t_hold))
    e = OPEN(u)
    return 1 - e - .035 * math.sin(math.pi * e) ** 2 * e   # se pasa un pelo y se asienta


def pose(sid, axis, p):
    # Interpolación cuadrática por las tres poses (p = 0, .5, 1).
    l0, l1, l2 = 2 * (p - .5) * (p - 1), -4 * p * (p - 1), 2 * p * (p - .5)
    return [tuple(l0 * a[i] + l1 * b[i] + l2 * c[i] for i in (0, 1))
            for a, b, c in zip(axis, POSES[sid], CLOSED[sid])]


def edge(axis, profile, side, n=48):
    """Borde de un trazo: side=+1 lado de la normal (abajo si va a la derecha)."""
    pts = []
    for i in range(n + 1):
        t = i / n
        x, y = bez(axis, t)
        dx, dy = dbez(axis, t)
        m = math.hypot(dx, dy) or 1
        h = width(profile, t) / 2 * side
        pts.append((x - dy / m * h, y + dx / m * h))
    return pts


def y_at(pts, x):
    if x <= pts[0][0]:
        return pts[0][1]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if x0 <= x <= x1:
            return y0 + (y1 - y0) * (x - x0) / ((x1 - x0) or 1)
    return pts[-1][1]


SPEC = {sid: (a, prof, cuts) for sid, a, prof, cuts in STROKES}
XS = [-10 + 220 * i / 22 for i in range(23)]


def lite(d):
    """Un decimal basta para los cuadros del parpadeo."""
    return re.sub(r"-?\d+\.\d+", lambda m: "%g" % round(float(m.group()), 1), d)


def blink_frames():
    n = round(BLINK_DUR * BLINK_FPS)
    lags = {"lid-top": 0, "wing": .022, "lid-low": .008}
    reach = {"lid-top": 1, "wing": 1, "lid-low": .85}
    lids = {sid: [] for sid in lags}
    clip = []
    for i in range(n + 1):
        t = BLINK_DUR * i / n
        ps = {sid: lid_p(t - lags[sid]) * reach[sid] for sid in lags}
        axes = {}
        for sid in lags:
            a, prof, cuts = SPEC[sid]
            axes[sid] = pose(sid, a, ps[sid])
            lids[sid].append(lite(outline(axes[sid], prof, cuts, n=16)))
        # Pupila visible entre el borde inferior del párpado de arriba y el superior del de
        # abajo. En reposo los límites se alejan para dejarla entera (asoma sobre el párpado).
        p = max(0.0, ps["lid-top"])
        top_e = edge(axes["lid-top"], SPEC["lid-top"][1], +1)
        low_e = edge(axes["lid-low"], SPEC["lid-low"][1], -1)
        off_t, off_b = 28 * (1 - p) ** 2, 40 * (1 - p) ** 2
        top = [(x, y_at(top_e, x) - off_t) for x in XS]
        bot = [(x, max(y_at(low_e, x) + off_b, ty)) for x, (_, ty) in zip(XS, top)]
        bot.reverse()
        clip.append(lite("M%s %s L%s %s Z" % (fmt(top[0]), smooth(top), fmt(bot[0]), smooth(bot))))
    return {"dur": BLINK_DUR, "lids": lids, "clip": clip}


blink = blink_frames()

vb = " ".join(map(str, VIEW))


# Colores de la marca: monocromo, sin acentos.
INK = "#0A0A0A"     # tinta: fondo oscuro y logo sobre fondos claros
BONE = "#EDEDEA"    # hueso: logo sobre fondos oscuros
PAPER = "#F7F7F5"   # papel: fondo claro
COLORS = {"": "currentColor", "-on-dark": BONE, "-on-light": INK}

WORD = json.loads((OUT / "wordmark.json").read_text())
# Logo horizontal: el nombre con mayúsculas de 36 u (≈ 30 % del alto del símbolo), centradas
# en la línea de las esquinas del ojo, y separado del símbolo por ~0,46 veces su ancho.
WORD_CAP, WORD_GAP, EYE_LINE = 36, 92, 60
word_k = WORD_CAP / WORD["capHeight"]
word_x = VIEW[0] + VIEW[2] + WORD_GAP
LOGO_VIEW = (VIEW[0], VIEW[1], round(word_x + WORD["width"] * word_k, 1), VIEW[3])


def mark_body(shs, gap, fill):
    g = "\n".join('    <path d="%s"/>' % x["d"] for x in shs if not x["iris"])
    v = "\n".join('    <path d="%s"/>' % x["d"] for x in shs if x["iris"])
    # La V va por encima de la G: la máscara abre en la G un hueco del ancho de GAP.
    return f"""  <defs>
    <mask id="vg-over" maskUnits="userSpaceOnUse" x="-20" y="-20" width="240" height="160">
      <rect x="-20" y="-20" width="240" height="160" fill="#fff"/>
      <g fill="#000" stroke="#000" stroke-width="{gap}" stroke-linejoin="round">
{v}
      </g>
    </mask>
  </defs>
  <g fill="{fill}">
  <g mask="url(#vg-over)">
{g}
  </g>
{v}
  </g>"""


def doc(view, inner, label="VanGUARD"):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{" ".join(map(str, view))}" '
            f'role="img" aria-label="{label}">\n{inner}\n</svg>\n')


def word(fill):
    base = EYE_LINE + WORD_CAP / 2
    return (f'  <g fill="{fill}" transform="translate({word_x} {base}) scale({round(word_k, 5)})">\n'
            f'    <path d="{WORD["van"]}"/>\n    <path d="{WORD["guard"]}"/>\n  </g>')


LOGO = OUT / "logo"
LOGO.mkdir(exist_ok=True)
for suffix, fill in COLORS.items():
    (LOGO / f"vanguard-mark{suffix}.svg").write_text(doc(VIEW, mark_body(shapes, GAP, fill)))
    (LOGO / f"vanguard-mark-compact{suffix}.svg").write_text(doc(VIEW, mark_body(compact, GAP * 1.3, fill)))
    (LOGO / f"vanguard-logo{suffix}.svg").write_text(doc(LOGO_VIEW, mark_body(shapes, GAP, fill) + "\n" + word(fill)))

# Favicon: símbolo compacto centrado en un cuadrado redondeado.
side = 232
fav_view = (-16, 53 - side / 2, side, side)
for name, bg, fg in (("favicon-dark", INK, BONE), ("favicon-light", PAPER, INK)):
    rect = f'  <rect x="{fav_view[0]}" y="{fav_view[1]}" width="{side}" height="{side}" rx="44" fill="{bg}"/>'
    (LOGO / f"{name}.svg").write_text(doc(fav_view, rect + "\n" + mark_body(compact, GAP * 1.3, fg)))

(OUT / "mark-data.js").write_text(
    "// Generado por build-mark.py; no editar a mano.\nwindow.VG_MARK = "
    + json.dumps({"viewBox": vb, "gap": GAP, "blink": blink, "shapes": shapes, "compact": compact})
    + ";\n"
)
print("ok")
