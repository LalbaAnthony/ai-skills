#!/usr/bin/env python3
"""
Convert Outlook .msg files into LLM-friendly Markdown + extracted attachments.

Usage:
    python msg_to_md.py INPUT [INPUT ...] [-o OUT_DIR] [--strip-quotes]
                        [--prefer {plain,html}] [--skip-inline] [--max-depth N]

INPUT can be .msg files or directories (searched recursively for *.msg).

For each message `name.msg`, produces:
    OUT_DIR/name.md                 headers + body + attachment list
    OUT_DIR/name_attachments/       attachment files (embedded .msg are
                                    rendered inline in the .md AND saved)

A JSON manifest of everything produced is printed to stdout, so the caller
knows exactly which files to read next.

Images are tagged in the attachment list with their format, pixel size and,
for inline images, their Content-ID and whether they look like a logo or
signature. Image formats that vision models generally cannot open (EMF, WMF,
TIFF, ...) are also reported as manifest warnings.

Requires: extract-msg  (python -m pip install extract-msg)
"""

from __future__ import annotations

import argparse
import html
import json
import re
import struct
import sys
from html.parser import HTMLParser
from pathlib import Path

try:
    import extract_msg
    from extract_msg.enums import AttachmentType
except ImportError:
    sys.stderr.write(
        "extract-msg is not installed. Run:\n"
        "    python -m pip install extract-msg\n"
        "(add --break-system-packages if pip reports an externally-managed-environment)\n"
    )
    sys.exit(2)


# ---------------------------------------------------------------------------
# Text helpers
# ---------------------------------------------------------------------------

class _HTMLToText(HTMLParser):
    """Minimal HTML -> readable text converter (stdlib only)."""

    BLOCK = {"p", "div", "br", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6",
             "blockquote", "table", "ul", "ol", "hr", "pre"}
    SKIP = {"script", "style", "head", "title", "xml"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip_depth += 1
        elif tag == "img":
            if not self.skip_depth:
                self.parts.append(self._image_placeholder(dict(attrs)))
        elif tag == "li":
            self.parts.append("\n- ")
        elif tag in ("td", "th"):
            self.parts.append(" | ")
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.skip_depth:
            self.skip_depth -= 1
        elif tag in self.BLOCK and tag != "li":
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skip_depth:
            self.parts.append(data)

    @staticmethod
    def _image_placeholder(attrs: dict) -> str:
        # Same [cid:...] form as the markers Outlook writes in plain-text bodies,
        # so an image position can be matched to its attachment line either way.
        src = (attrs.get("src") or "").strip()
        alt = " ".join((attrs.get("alt") or "").split())
        alt_part = f' alt="{alt}"' if alt else ""
        if src.lower().startswith("cid:"):
            return f"[cid:{src[4:]}{alt_part}]"
        if alt:
            return f"[image{alt_part}]"
        # Remote or data: images without alt text are mostly tracking pixels and spacers.
        return ""

    def text(self) -> str:
        raw = "".join(self.parts).replace("\xa0", " ")
        raw = re.sub(r"[ \t]+", " ", raw)
        raw = re.sub(r" *\n *", "\n", raw)
        return re.sub(r"\n{3,}", "\n\n", raw).strip()


def html_to_text(data: bytes | str) -> str:
    if isinstance(data, bytes):
        data = decode_bytes(data)
    parser = _HTMLToText()
    try:
        parser.feed(data)
        parser.close()
        return parser.text()
    except Exception:
        # Last-resort fallback: strip tags crudely
        return html.unescape(re.sub(r"<[^>]+>", " ", data)).strip()


def rtf_to_text(data: bytes) -> str:
    text = decode_bytes(data)
    try:
        from striprtf.striprtf import rtf_to_text as _strip  # optional dependency
        return _strip(text).strip()
    except ImportError:
        text = re.sub(r"\\par[d]?", "\n", text)
        text = re.sub(r"\{\\\*[^{}]*\}", "", text)
        text = re.sub(r"\\[a-zA-Z]+-?\d* ?", "", text)
        return re.sub(r"[{}]", "", text).strip()


def decode_bytes(data: bytes) -> str:
    # Honour a declared charset if present, then try common Outlook encodings
    m = re.search(rb'charset=["\']?([\w-]+)', data[:2000], re.I)
    candidates = ([m.group(1).decode("ascii", "ignore")] if m else []) + ["utf-8", "cp1252", "latin-1"]
    for enc in candidates:
        try:
            return data.decode(enc)
        except (LookupError, UnicodeDecodeError):
            continue
    return data.decode("utf-8", errors="replace")


# Reply/forward separators in English and French (extend as needed)
QUOTE_MARKERS = [
    r"^-{2,}\s*Original Message\s*-{2,}",
    r"^-{2,}\s*Message d'origine\s*-{2,}",
    r"^-{2,}\s*Forwarded message\s*-{2,}",
    r"^-{2,}\s*Message transféré\s*-{2,}",
    r"^_{10,}\s*$",
    r"^From:\s.*\n(?:.*\n){0,3}?Sent:\s",
    r"^De\s?:\s.*\n(?:.*\n){0,3}?Envoyé\s?:\s",
    r"^On .{5,200} wrote:\s*$",
    r"^Le .{5,200} a écrit\s?:\s*$",
]
_QUOTE_RE = re.compile("|".join(f"(?:{p})" for p in QUOTE_MARKERS), re.M | re.I)


def strip_quoted(body: str) -> tuple[str, bool]:
    """Cut the body at the first reply/forward separator after some content."""
    for match in _QUOTE_RE.finditer(body):
        if body[: match.start()].strip():  # ignore markers at the very top (pure forwards)
            return body[: match.start()].rstrip() + "\n\n[... quoted history removed ...]", True
    return body, False


def safe_name(name: str, fallback: str) -> str:
    name = (name or "").strip() or fallback
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", name)
    return name[:150]


def unique_path(directory: Path, name: str) -> Path:
    candidate = directory / name
    stem, suffix = candidate.stem, candidate.suffix
    i = 1
    while candidate.exists():
        candidate = directory / f"{stem}_{i}{suffix}"
        i += 1
    return candidate


# ---------------------------------------------------------------------------
# Image helpers
# ---------------------------------------------------------------------------

# Formats that vision-capable models generally accept. Other image formats are
# still extracted, but flagged so the reader knows they need a conversion first.
VIEWABLE_IMAGE_FORMATS = {"PNG", "JPEG", "GIF", "WEBP"}

# Used when the file signature is not recognised.
IMAGE_EXTENSIONS = {
    ".png": "PNG", ".jpg": "JPEG", ".jpeg": "JPEG", ".jfif": "JPEG", ".gif": "GIF",
    ".webp": "WEBP", ".bmp": "BMP", ".dib": "BMP", ".tif": "TIFF", ".tiff": "TIFF",
    ".emf": "EMF", ".wmf": "WMF", ".emz": "EMZ", ".wmz": "WMZ",
    ".heic": "HEIC", ".heif": "HEIF", ".ico": "ICO",
}

# Inline images within these bounds are tagged as likely logos or signature art.
# Mislabelling a logo as content costs one extra image read; mislabelling a
# screenshot as a logo hides it, so the bounds are kept small.
DECORATIVE_MAX_WIDTH = 300
DECORATIVE_MAX_HEIGHT = 150


def image_format(data: bytes, name: str) -> str | None:
    """Identify an image from its file signature, then from its extension."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "PNG"
    if data.startswith(b"\xff\xd8\xff"):
        return "JPEG"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "GIF"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "WEBP"
    if data[:4] in (b"II*\x00", b"MM\x00*"):
        return "TIFF"
    if data[40:44] == b" EMF":
        return "EMF"
    if data[:4] == b"\xd7\xcd\xc6\x9a":  # placeable WMF
        return "WMF"
    return IMAGE_EXTENSIONS.get(Path(name).suffix.lower())


def image_size(data: bytes, fmt: str) -> tuple[int, int] | None:
    """Return (width, height) in pixels read from the image header, or None."""
    try:
        if fmt == "PNG" and data[12:16] == b"IHDR":
            return struct.unpack(">II", data[16:24])
        if fmt == "GIF":
            return struct.unpack("<HH", data[6:10])
        if fmt == "BMP" and data[:2] == b"BM":
            (header_size,) = struct.unpack("<I", data[14:18])
            if header_size == 12:  # OS/2 BITMAPCOREHEADER
                return struct.unpack("<HH", data[18:22])
            width, height = struct.unpack("<ii", data[18:26])
            return width, abs(height)  # negative height means a top-down bitmap
        if fmt == "JPEG":
            return _jpeg_size(data)
    except struct.error:  # truncated header
        return None
    return None


def _jpeg_size(data: bytes) -> tuple[int, int] | None:
    # Walk the marker segments up to the first start-of-frame (SOFn), which holds the size.
    i = 2
    while i + 4 <= len(data):
        if data[i] != 0xFF:
            return None
        marker = data[i + 1]
        if marker == 0xFF:  # fill byte
            i += 1
            continue
        if marker == 0x01 or 0xD0 <= marker <= 0xD9:  # standalone markers carry no length
            i += 2
            continue
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            height, width = struct.unpack(">HH", data[i + 5:i + 9])
            return width, height
        (length,) = struct.unpack(">H", data[i + 2:i + 4])
        i += 2 + length
    return None


def is_decorative(size: tuple[int, int] | None) -> bool:
    """True for images small enough to be a logo, icon or signature graphic."""
    return size is not None and size[0] <= DECORATIVE_MAX_WIDTH and size[1] <= DECORATIVE_MAX_HEIGHT


def content_id(att) -> str:
    return (getattr(att, "contentId", None) or "").strip().strip("<>").strip()


def body_references(msg) -> str | None:
    """Lower-cased raw HTML and plain bodies, searched for cid: references.

    Returns None when the message has neither, in which case Content-IDs
    cannot be checked against the body.
    """
    parts = []
    html_body = getattr(msg, "htmlBody", None)
    if html_body:
        parts.append(decode_bytes(html_body) if isinstance(html_body, bytes) else html_body)
    plain = getattr(msg, "body", None)
    if plain:
        parts.append(plain)
    return "\n".join(parts).lower() if parts else None


def is_inline(att, body_refs: str | None) -> bool:
    """Hidden attachments, and attachments whose Content-ID the body displays.

    Some clients (Apple Mail among them) give every attachment a Content-ID, so
    a Content-ID alone does not make an attachment inline. It is only taken at
    face value when there is no HTML or plain body to check it against.
    """
    if getattr(att, "hidden", False):
        return True
    cid = content_id(att)
    if not cid:
        return False
    if body_refs is None:
        return True
    return f"cid:{cid.lower()}" in body_refs


def attachment_tags(fmt: str | None, size, inline: bool, decorative: bool, cid: str) -> str:
    parts = []
    if fmt:
        parts.append("inline image" if inline else "image")
        if decorative:
            parts.append("likely logo or signature")
        parts.append(f"{fmt} {size[0]}x{size[1]} px" if size else fmt)
        if fmt not in VIEWABLE_IMAGE_FORMATS:
            parts.append("format not viewable by most vision models")
    elif inline:
        parts.append("inline")
    if inline and cid:
        parts.append(f"`cid:{cid}`")
    return f" _({', '.join(parts)})_" if parts else ""


# ---------------------------------------------------------------------------
# Message rendering
# ---------------------------------------------------------------------------

def get_body(msg, prefer: str) -> tuple[str, str]:
    """Return (text, source) where source is plain|html|rtf|none."""
    plain = (getattr(msg, "body", None) or "").strip()
    html_body = getattr(msg, "htmlBody", None)
    html_text = html_to_text(html_body) if html_body else ""

    if prefer == "html" and html_text:
        return html_text, "html"
    if plain:
        return plain, "plain"
    if html_text:
        return html_text, "html"
    rtf = getattr(msg, "rtfBody", None)
    if rtf:
        return rtf_to_text(rtf), "rtf"
    return "", "none"


def header_lines(msg) -> list[str]:
    fields = [
        ("From", "sender"), ("To", "to"), ("Cc", "cc"), ("Bcc", "bcc"),
        ("Date", "date"), ("Subject", "subject"),
        # Calendar items
        ("Start", "startDate"), ("End", "endDate"), ("Location", "location"),
    ]
    lines = []
    for label, attr in fields:
        try:
            value = getattr(msg, attr, None)
        except Exception:
            value = None
        if value not in (None, "", []):
            lines.append(f"- **{label}:** {value}")
    return lines


def render_message(msg, args, att_dir: Path, depth: int, manifest: dict) -> str:
    out: list[str] = []
    out.extend(header_lines(msg))
    out.append(f"- **Item type:** {type(msg).__name__}")

    body, source = get_body(msg, args.prefer)
    body = re.sub(r"\n{3,}", "\n\n", body.replace("\r\n", "\n").replace("\r", "\n"))
    if args.strip_quotes and body:
        body, stripped = strip_quoted(body)
        if stripped:
            manifest["quotes_stripped"] = True
    manifest.setdefault("body_sources", []).append(source)

    out.append("")
    if body:
        out.append(body)
    elif not hasattr(msg, "body") and hasattr(msg, "getJson"):
        # Non-email item (e.g. contact): dump structured fields
        out.append("```json\n" + msg.getJson() + "\n```")
    else:
        out.append("_(empty body)_")

    attachments = list(getattr(msg, "attachments", []) or [])
    if attachments:
        out.append("")
        out.append("## Attachments")
        body_refs = body_references(msg)
        for index, att in enumerate(attachments, 1):
            out.extend(render_attachment(att, index, args, att_dir, depth, manifest, body_refs))

    return "\n".join(out)


def render_attachment(att, index, args, att_dir: Path, depth: int, manifest: dict,
                      body_refs: str | None) -> list[str]:
    lines: list[str] = []
    name = safe_name(
        getattr(att, "longFilename", None) or getattr(att, "shortFilename", None)
        or getattr(att, "displayName", None),
        f"attachment_{index}",
    )
    att_type = getattr(att, "type", None)

    # Embedded message: render recursively and also keep the raw .msg
    if att_type in (AttachmentType.MSG, AttachmentType.SIGNED_EMBEDDED) and depth < args.max_depth:
        inner = att.data
        title = getattr(inner, "subject", None) or name
        lines.append(f"- {index}. **Embedded message:** {title}")
        lines.append("")
        lines.append(f"### Embedded message {index}: {title}")
        nested_dir = att_dir / f"embedded_{index}"
        lines.append(render_message(inner, args, nested_dir, depth + 1, manifest))
        lines.append(f"### End of embedded message {index}")
        lines.append("")
        return lines

    data = getattr(att, "data", None)
    if isinstance(data, (bytes, bytearray)):
        data = bytes(data)
        inline = is_inline(att, body_refs)
        fmt = image_format(data, name)
        size = image_size(data, fmt) if fmt else None
        decorative = inline and fmt is not None and is_decorative(size)

        # --skip-inline drops logos, signature art and hidden non-image items,
        # but keeps inline images that may be pasted screenshots.
        if inline and args.skip_inline and (fmt is None or decorative):
            what = "logo or signature image" if fmt else "hidden attachment"
            lines.append(f"- {index}. {name} _(inline {what}, skipped)_")
            return lines

        att_dir.mkdir(parents=True, exist_ok=True)
        target = unique_path(att_dir, name)
        target.write_bytes(data)
        manifest["attachments"].append(str(target))
        size_kb = len(data) / 1024
        tags = attachment_tags(fmt, size, inline, decorative, content_id(att))
        lines.append(f"- {index}. `{target.name}` ({size_kb:.1f} KB){tags} → `{target}`")
        if fmt and fmt not in VIEWABLE_IMAGE_FORMATS:
            manifest["warnings"].append(
                f"Image {str(target)!r} is {fmt}, which most vision models cannot open: "
                "look for a PNG or JPEG copy in the same message, or convert it before viewing"
            )
    elif att_type == AttachmentType.WEB:
        url = getattr(att, "url", None) or getattr(att, "attachLongPathname", None)
        lines.append(f"- {index}. {name} _(cloud link)_ {url or ''}")
    else:
        lines.append(f"- {index}. {name} _(could not extract: {att_type})_")
        manifest["warnings"].append(f"Attachment {name!r} not extracted ({att_type})")
    return lines


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

def collect_inputs(paths: list[str]) -> list[Path]:
    files: list[Path] = []
    for p in map(Path, paths):
        if p.is_dir():
            files.extend(sorted(x for x in p.rglob("*") if x.suffix.lower() == ".msg"))
        elif p.is_file():
            files.append(p)
        else:
            sys.stderr.write(f"Not found: {p}\n")
    return files


def convert_one(path: Path, args) -> dict:
    manifest = {"source": str(path), "markdown": None, "attachments": [], "warnings": []}
    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = safe_name(path.stem, "message")
    att_dir = out_dir / f"{stem}_attachments"

    msg = extract_msg.openMsg(str(path), strict=False)
    try:
        title = getattr(msg, "subject", None) or path.name
        md = f"# {title}\n\n" + render_message(msg, args, att_dir, 0, manifest) + "\n"
    finally:
        msg.close()

    md_path = unique_path(out_dir, f"{stem}.md") if not args.overwrite else out_dir / f"{stem}.md"
    md_path.write_text(md, encoding="utf-8")
    manifest["markdown"] = str(md_path)
    manifest["chars"] = len(md)
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("inputs", nargs="+", help=".msg files or directories")
    parser.add_argument("-o", "--output", default="msg_converted", help="output directory")
    parser.add_argument("--strip-quotes", action="store_true", help="cut quoted reply/forward history")
    parser.add_argument("--prefer", choices=["plain", "html"], default="plain",
                        help="body source when both exist (html keeps tables better)")
    parser.add_argument("--skip-inline", action="store_true",
                        help="do not save inline logos, signature images and hidden attachments "
                             "(larger inline images such as screenshots are kept)")
    parser.add_argument("--max-depth", type=int, default=5, help="max depth for embedded .msg recursion")
    parser.add_argument("--overwrite", action="store_true", help="overwrite existing .md instead of suffixing")
    args = parser.parse_args()

    files = collect_inputs(args.inputs)
    if not files:
        sys.stderr.write("No .msg files found.\n")
        return 1

    results = []
    for path in files:
        try:
            results.append(convert_one(path, args))
        except Exception as exc:  # keep going on batch errors
            results.append({"source": str(path), "error": f"{type(exc).__name__}: {exc}"})

    print(json.dumps(results, indent=2, ensure_ascii=False))
    return 0 if all("error" not in r for r in results) else 3


if __name__ == "__main__":
    sys.exit(main())
