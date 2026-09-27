"""把 logo/ 目录下的 .ico 转成真正的 PNG。

背景：从各家官网 /favicon.ico 取回的图标是 ICO 容器（魔数 00 00 01 00），
即使改名为 .png 也仍是 ICO。浏览器的 <img> 对 ICO 支持不一致，
且后端的 MIME 嗅探会把它判成 image/x-icon —— 与扩展名不符。

本脚本挑 ICO 中尺寸最大的一帧，转存为带 alpha 的 PNG。
已存在的 PNG 不动，可重复执行。
"""

import sys
from pathlib import Path

from PIL import Image

LOGO_DIR = Path(__file__).resolve().parent.parent / "资料分享模块素材" / "logo"


def is_ico(path: Path) -> bool:
    """按魔数判断，而不是看扩展名。"""
    with path.open("rb") as fh:
        return fh.read(4) == b"\x00\x00\x01\x00"


def convert(path: Path) -> str:
    with Image.open(path) as img:
        # ICO 内含多帧，取像素面积最大的那一帧。
        # 注意 Pillow 的 ico.sizes() 是**方法**而非属性。
        ico = getattr(img, "ico", None)
        best = None
        if ico is not None:
            try:
                candidates = [s for s in ico.sizes() if s[0] > 0 and s[1] > 0]
                best = max(candidates, key=lambda s: s[0] * s[1], default=None)
            except Exception:  # noqa: BLE001 - 取不到就用默认帧
                best = None
            if best:
                img = ico.getimage(candidates.index(best))

        rgba = img.convert("RGBA")
        target = path.with_suffix(".png")
        rgba.save(target, "PNG", optimize=True)
        warn = "  ⚠ 分辨率偏小，建议换官网高清 logo" if rgba.width < 128 else ""
        return f"{path.name} -> {target.name}  {rgba.width}x{rgba.height}{warn}"


def main() -> int:
    if not LOGO_DIR.is_dir():
        print(f"目录不存在：{LOGO_DIR}", file=sys.stderr)
        return 1

    converted = 0
    for path in sorted(LOGO_DIR.iterdir()):
        if not path.is_file():
            continue
        if path.suffix.lower() not in {".png", ".jpg", ".jpeg", ".ico", ".webp"}:
            continue
        if not is_ico(path):
            continue
        try:
            print("  " + convert(path))
            converted += 1
        except Exception as exc:  # noqa: BLE001 - CLI 工具，打印原因即可
            print(f"  跳过 {path.name}：{exc}", file=sys.stderr)

    print(f"完成：转换 {converted} 个 ICO 文件")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
