#!/usr/bin/env python3
import sys
from pathlib import Path

from PIL import Image, ImageDraw


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: generate-flatpak-icon.py <output.png>", file=sys.stderr)
        return 1

    output_path = Path(sys.argv[1])
    output_path.parent.mkdir(parents=True, exist_ok=True)

    size = 256
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    outer = (20, 20, 236, 236)
    inner = (42, 54, 214, 202)
    title = (42, 54, 214, 82)

    draw.rounded_rectangle(outer, radius=48, fill="#0a1118")
    draw.rounded_rectangle(inner, radius=20, fill="#122232", outline="#21384b", width=4)
    draw.rounded_rectangle(title, radius=20, fill="#1a2d3e")

    for cx, color in ((62, "#59d0a8"), (78, "#f0b54d"), (94, "#e6657a")):
        draw.ellipse((cx - 5, 68 - 5, cx + 5, 68 + 5), fill=color)

    accent_left = "#59d0a8"
    accent_right = "#37a3ff"
    mint = "#6de3be"
    slash = "#2a4d66"

    draw.line((95, 112, 69, 128), fill=accent_left, width=14, joint="curve")
    draw.line((69, 128, 95, 144), fill=accent_left, width=14, joint="curve")
    draw.line((161, 112, 187, 128), fill=accent_right, width=14, joint="curve")
    draw.line((187, 128, 161, 144), fill=accent_right, width=14, joint="curve")
    draw.line((152, 94, 109, 191), fill=slash, width=10)
    draw.line((103, 176, 153, 176), fill=mint, width=12)

    image.save(output_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
