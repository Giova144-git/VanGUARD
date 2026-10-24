# Genera los recursos pesados de Rendimiento de la víctima (S10 10.11) en apps/victima/public/.
# Se corre una vez a mano y los ficheros se versionan (y se copian idénticos a demo/repo-vulnerable/public/):
#   python apps/victima/scripts/recursos.py
# Deterministas (semilla fija) para que dos corridas den los mismos bytes. Necesita Pillow; nada se ejecuta en el Worker.
import random
from pathlib import Path

from PIL import Image, ImageDraw

PUBLICO = Path(__file__).resolve().parent.parent / 'public'


def hero(ancho: int, alto: int, ruido: int, semilla: int) -> Image.Image:
    # Degradado café con grano: el ruido decide cuánto pesa el fichero.
    rnd = random.Random(semilla)
    img = Image.new('RGB', (ancho, alto))
    d = ImageDraw.Draw(img)
    for y in range(alto):
        t = y / alto
        d.line([(0, y), (ancho, y)], fill=(int(90 + 60 * t), int(55 + 35 * t), int(30 + 20 * t)))
    px = img.load()
    for _ in range(ancho * alto // 3):
        x, y = rnd.randrange(ancho), rnd.randrange(alto)
        r, g, b = px[x, y]
        k = rnd.randint(-ruido, ruido)
        px[x, y] = (max(0, min(255, r + k)), max(0, min(255, g + k)), max(0, min(255, b + k)))
    return img


def css_pesado(objetivo: int) -> str:
    # Tema «heredado»: miles de reglas que la página no usa (bloqueo_render).
    out, i = ['/* tema-pesado.css: regresión deliberada de la demo (v2-regresion) */\n'], 0
    while sum(len(s) for s in out) < objetivo:
        out.append(f'.tema-{i} .bloque-{i % 97}>.item-{i % 13}:hover{{color:#{(i * 2654435761) % 0xFFFFFF:06x};'
                   f'margin:{i % 7}px {i % 11}px;padding:{i % 5}px;border:1px solid #{(i * 40503) % 0xFFFFFF:06x}}}\n')
        i += 1
    return ''.join(out)


def polyfills(objetivo: int) -> str:
    # Polyfills de navegadores viejos que ningún navegador actual necesita (js_legado). Todos se saltan si ya existe el método.
    cabeza = ('/* polyfills-legacy.js: regresión deliberada de la demo (v2-regresion) */\n'
              'if(!Array.prototype.includes){Array.prototype.includes=function(v){return this.indexOf(v)!==-1;};}\n'
              'if(!Array.prototype.find){Object.defineProperty(Array.prototype,"find",{value:function(f){'
              'for(var i=0;i<this.length;i++){if(f(this[i],i,this))return this[i];}}});}\n'
              'if(!Object.assign){Object.assign=function(t){for(var i=1;i<arguments.length;i++){var s=arguments[i];'
              'for(var k in s){if(Object.prototype.hasOwnProperty.call(s,k))t[k]=s[k];}}return t;};}\n'
              'if(!String.prototype.startsWith){String.prototype.startsWith=function(s,p){p=p||0;return this.substr(p,s.length)===s;};}\n')
    out, i = [cabeza], 0
    while sum(len(s) for s in out) < objetivo:
        out.append(f'var _legado{i}=function(a,b){{var r=[];for(var j=0;j<(a||[]).length;j++){{'
                   f'r.push((a[j]*{i % 17 + 1}+(b||0))%{i % 89 + 7});}}return r;}};\n')
        i += 1
    return ''.join(out)


def main() -> None:
    (PUBLICO / 'img').mkdir(parents=True, exist_ok=True)
    (PUBLICO / 'css').mkdir(parents=True, exist_ok=True)
    (PUBLICO / 'js').mkdir(parents=True, exist_ok=True)
    hero(1200, 600, 19, 1).save(PUBLICO / 'img' / 'hero-1200.webp', 'WEBP', quality=72, method=6)        # ~60 KB
    hero(3600, 2400, 40, 2).save(PUBLICO / 'img' / 'hero-original.jpg', 'JPEG', quality=92)            # 3-4 MB
    (PUBLICO / 'css' / 'tema-pesado.css').write_text(css_pesado(150_000), encoding='utf-8', newline='\n')
    (PUBLICO / 'js' / 'polyfills-legacy.js').write_text(polyfills(120_000), encoding='utf-8', newline='\n')
    for f in sorted(PUBLICO.rglob('*')):
        if f.is_file():
            print(f'{f.relative_to(PUBLICO).as_posix():28} {f.stat().st_size:>10,} B')


if __name__ == '__main__':
    main()
