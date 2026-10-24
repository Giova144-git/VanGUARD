"""Convierte el nombre «VANGUARD» a trazos (Geist 300 + 650) y lo guarda en wordmark.json.

Así los logos con nombre no dependen de tener la fuente instalada. Solo hace falta volver
a ejecutarlo si cambia el nombre, el peso o el espaciado; build-mark.py lee wordmark.json.

Requiere fonttools y brotli, y el woff2 variable de Geist (el mismo paquete que usa apps/web):
  python3 -m venv /tmp/vg && /tmp/vg/bin/pip install fonttools brotli
  npm pack @fontsource-variable/geist@5.3.0 && tar xzf fontsource-variable-geist-5.3.0.tgz
  /tmp/vg/bin/python brand/build-wordmark.py package/files/geist-latin-wght-normal.woff2
"""
import json
import sys
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

# (texto, peso). «VAN» ligero y «GUARD» pesado, como se escribe el nombre: VanGUARD.
RUNS = [("VAN", 300), ("GUARD", 650)]
SIZE = 100        # tamaño de fuente de referencia; el logo lo escala
TRACKING = .42    # espaciado entre letras, en em


def outline_runs(path):
    x, out, cap = 0.0, [], None
    for text, wght in RUNS:
        font = instantiateVariableFont(TTFont(path), {"wght": wght})
        scale = SIZE / font["head"].unitsPerEm
        cap = font["OS/2"].sCapHeight * scale
        glyphs, cmap, hmtx = font.getGlyphSet(), font.getBestCmap(), font["hmtx"]
        pen = SVGPathPen(glyphs, ntos=lambda v: "%g" % round(v, 2))
        for ch in text:
            name = cmap[ord(ch)]
            glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x, 0)))
            x += hmtx[name][0] * scale + TRACKING * SIZE
        out.append(pen.getCommands())
    # La última letra no lleva espaciado detrás.
    return {"size": SIZE, "capHeight": round(cap, 2), "width": round(x - TRACKING * SIZE, 2),
            "van": out[0], "guard": out[1]}


if __name__ == "__main__":
    data = outline_runs(sys.argv[1])
    (Path(__file__).parent / "wordmark.json").write_text(json.dumps(data) + "\n")
    print("ok", data["width"], data["capHeight"])
