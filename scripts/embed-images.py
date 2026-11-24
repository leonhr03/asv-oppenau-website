#!/usr/bin/env python3
"""
Bettet Bilder aus dem img-Ordner als Data-URL (Base64) in die JSON-Dateien ein.

Jeder Bildpfad wie "img/Rhein.jpeg" im Feld "image" wird durch
"data:image/jpeg;base64,…" ersetzt – genau so, wie das Admin-Panel neue Bilder speichert.
Die Bilder werden vorher verkleinert (längste Seite 1280 px, stark komprimiertes JPEG),
damit die JSON nicht unnötig groß wird. Der img-Ordner selbst wird nicht verändert.

Zum Verkleinern wird `sips` (macOS) oder ImageMagick (`magick`/`convert`, z. B. in
GitHub Actions) benutzt. Fehlt beides, wird das Bild unverändert eingebettet.

    python3 scripts/embed-images.py            umwandeln
    python3 scripts/embed-images.py --check    nur anzeigen, was umgewandelt würde
"""
import base64
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = ["news.json"]
FIELDS = ["image"]
MAX_EDGE = 1280
QUALITY = 70   # ImageMagick; sips nutzt die Stufe "low" (≈ gleiche Größe)
MIME = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif"}


def has_alpha(path: Path) -> bool:
    if path.suffix.lower() != ".png":
        return False
    if shutil.which("sips"):
        out = subprocess.run(["sips", "-g", "hasAlpha", str(path)], capture_output=True, text=True).stdout
        return "hasAlpha: yes" in out
    tool = shutil.which("magick") or shutil.which("identify")
    if tool:
        cmd = [tool, "identify"] if tool.endswith("magick") else [tool]
        out = subprocess.run(cmd + ["-format", "%A", str(path)], capture_output=True, text=True).stdout
        return out.strip().lower() in ("true", "blend")
    return True


def shrink(path: Path, tmp: Path):
    """Gibt (bytes, mime) des verkleinerten Bildes zurück."""
    suffix = path.suffix.lower()
    if suffix == ".gif":  # evtl. animiert – unverändert lassen
        return path.read_bytes(), MIME[suffix]
    keep_png = has_alpha(path)  # Transparenz erhalten
    target = tmp / ("out.png" if keep_png else "out.jpg")
    mime = "image/png" if keep_png else "image/jpeg"

    if shutil.which("sips"):
        cmd = ["sips", "-Z", str(MAX_EDGE), "-s", "format", "png" if keep_png else "jpeg"]
        if not keep_png:
            cmd += ["-s", "formatOptions", "low"]  # Zahlenwerte ignoriert sips weitgehend
        cmd += [str(path), "--out", str(target)]
    elif shutil.which("magick") or shutil.which("convert"):
        tool = shutil.which("magick") or shutil.which("convert")
        cmd = [tool, str(path), "-auto-orient", "-resize", f"{MAX_EDGE}x{MAX_EDGE}>", "-strip"]
        if not keep_png:
            cmd += ["-background", "white", "-flatten", "-quality", str(QUALITY)]
        cmd += [str(target)]
    else:
        return path.read_bytes(), MIME.get(suffix, "application/octet-stream")

    subprocess.run(cmd, check=True, capture_output=True)
    data = target.read_bytes()
    original = path.read_bytes()
    # Falls das Original schon kleiner ist (und das Format passt), das Original nehmen.
    if len(original) <= len(data) and MIME.get(suffix) == mime:
        return original, mime
    return data, mime


def to_data_url(src: str, tmp: Path, cache: dict) -> str:
    if src.startswith("data:") or "://" in src:
        return src
    path = ROOT / src
    if not path.is_file() or path.suffix.lower() not in MIME:
        print(f"  ! übersprungen (nicht gefunden oder kein Bild): {src}")
        return src
    if src not in cache:
        data, mime = shrink(path, tmp)
        cache[src] = f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"
        print(f"  {src}: {path.stat().st_size // 1024} KB -> {len(data) // 1024} KB")
    return cache[src]


def write_json(path: Path, items) -> None:
    text = json.dumps(items, indent=2, ensure_ascii=False) + "\n"
    path.write_text(text, encoding="utf-8")


def main() -> int:
    check = "--check" in sys.argv
    changed_any = False
    cache: dict = {}
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        for name in FILES:
            path = ROOT / name
            items = json.loads(path.read_text(encoding="utf-8"))
            changed = False
            print(f"{name}:")
            for item in items:
                for field in FIELDS:
                    value = item.get(field)
                    if value is None:
                        continue
                    values = value if isinstance(value, list) else [value]
                    pending = [v for v in values if not v.startswith("data:") and "://" not in v]
                    if not pending:
                        continue
                    if check:
                        for v in pending:
                            print(f"  würde einbetten: {v}")
                        changed = True
                        continue
                    new = [to_data_url(v, tmp, cache) for v in values]
                    if new != values:
                        item[field] = new if isinstance(value, list) else new[0]
                        changed = True
            if changed and not check:
                write_json(path, items)
                print(f"  -> {name} geschrieben ({path.stat().st_size // 1024} KB)")
            elif not changed:
                print("  nichts zu tun")
            changed_any |= changed
    return 0


if __name__ == "__main__":
    sys.exit(main())
