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

Requires: extract-msg  (pip install extract-msg --break-system-packages)
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

try:
    import extract_msg
    from extract_msg.enums import AttachmentType
except ImportError:
    sys.stderr.write(
        "extract-msg is not installed. Run:\n"
        "    pip install extract-msg --break-system-packages\n"
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
    for index, att in enumerate(attachments, 1):
        out.extend(render_attachment(att, index, args, att_dir, depth, manifest))

    return "\n".join(out)


def render_attachment(att, index, args, att_dir: Path, depth: int, manifest: dict) -> list[str]:
    lines: list[str] = []
    name = safe_name(
        getattr(att, "longFilename", None) or getattr(att, "shortFilename", None)
        or getattr(att, "displayName", None),
        f"attachment_{index}",
    )
    inline = bool(getattr(att, "hidden", False) or getattr(att, "contentId", None))
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

    if inline and args.skip_inline:
        lines.append(f"- {index}. {name} _(inline image, skipped)_")
        return lines

    data = getattr(att, "data", None)
    if isinstance(data, (bytes, bytearray)):
        att_dir.mkdir(parents=True, exist_ok=True)
        target = unique_path(att_dir, name)
        target.write_bytes(data)
        manifest["attachments"].append(str(target))
        size_kb = len(data) / 1024
        tag = " _(inline)_" if inline else ""
        lines.append(f"- {index}. `{target.name}` ({size_kb:.1f} KB){tag} → `{target}`")
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
    parser.add_argument("--skip-inline", action="store_true", help="do not save inline images (logos, signatures)")
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
