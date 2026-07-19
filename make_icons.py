"""Vygeneruje ikony aplikace Kalorie. Spustí se jednou, výstup do icons/."""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(__file__), "icons")
os.makedirs(OUT, exist_ok=True)

GREEN = (47, 169, 110)
GREEN_D = (33, 140, 90)
WHITE = (255, 255, 255)


def rounded(size, radius_frac, bg):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = int(size * radius_frac)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=bg)
    return img, d


def draw_mark(base, d, size, bg=GREEN):
    """Nakreslí bílý list (natočená elipsa) se žilkou a stonkem — symbol zdravého jídla."""
    s = size
    SS = 4  # supersampling pro hladké hrany
    W = size * SS
    layer = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    cx = W / 2
    # Elipsa (list) — vysoká a úzká, vystředěná mírně nahoře
    ew, eh = W * 0.30, W * 0.46
    ecx, ecy = cx, W * 0.42
    ld.ellipse([ecx - ew / 2, ecy - eh / 2, ecx + ew / 2, ecy + eh / 2], fill=WHITE)
    # Žilka uprostřed v barvě pozadí
    vein_w = max(1, int(W * 0.018))
    ld.line([(ecx, ecy - eh / 2 + W * 0.03), (ecx, ecy + eh / 2 - W * 0.03)], fill=bg + (255,), width=vein_w)
    # Natočit list o 45°, aby měl špičku
    layer = layer.rotate(-40, resample=Image.BICUBIC, center=(cx, ecy))
    # Stonek (rovný, dolů od špičky listu)
    sd = ImageDraw.Draw(layer)
    stem_w = max(2, int(W * 0.026))
    sd.line([(cx, W * 0.55), (W * 0.60, W * 0.78)], fill=WHITE, width=stem_w)
    layer = layer.resize((size, size), Image.LANCZOS)
    base.paste(layer, (0, 0), layer)


def make(size, radius_frac=0.22, bg=GREEN, name=None):
    img, d = rounded(size, radius_frac, bg)
    draw_mark(img, d, size, bg)
    img.save(os.path.join(OUT, name))
    print("napsano", name)


# Standardní ikony (kulaté rohy pro apple-touch)
make(512, 0.22, GREEN, "icon-512.png")
make(192, 0.22, GREEN, "icon-192.png")
make(180, 0.22, GREEN, "apple-touch-icon.png")

# Maskable: plná zelená plocha (bez rohů), symbol v bezpečné zóně (menší)
mimg = Image.new("RGBA", (512, 512), GREEN)
tmp = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
td = ImageDraw.Draw(tmp)
draw_mark(tmp, td, 512, GREEN)
tmp = tmp.resize((350, 350), Image.LANCZOS)
mimg.paste(tmp, (81, 81), tmp)
mimg.save(os.path.join(OUT, "icon-512-maskable.png"))
print("napsano maskable")

# Favicon
make(64, 0.22, GREEN, "favicon-64.png")
print("hotovo")
