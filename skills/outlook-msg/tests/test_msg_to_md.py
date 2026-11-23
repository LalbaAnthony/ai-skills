"""Tests for the image handling of scripts/msg_to_md.py.

Run from the repository root:
    python -m unittest discover -s skills/outlook-msg/tests

extract-msg cannot write .msg files, so messages and attachments are faked with
plain objects exposing the attributes the converter reads. Skipped when
extract-msg is not installed, since the converter imports it at load time.
"""

from __future__ import annotations

import importlib.util
import struct
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "msg_to_md.py"

try:
    from extract_msg.enums import AttachmentType
except ImportError:
    AttachmentType = None


def load_converter():
    spec = importlib.util.spec_from_file_location("msg_to_md", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


m = load_converter() if AttachmentType is not None else None


# Minimal image headers: enough bytes for format and size detection.

def png(width: int, height: int) -> bytes:
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + struct.pack(">I", len(ihdr)) + b"IHDR" + ihdr + b"\x00" * 4


def gif(width: int, height: int) -> bytes:
    return b"GIF89a" + struct.pack("<HH", width, height) + b"\x00\x00\x00"


def jpeg(width: int, height: int) -> bytes:
    app0 = b"\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    sof0 = b"\xff\xc0" + struct.pack(">HBHHB", 11, 8, height, width, 1) + b"\x01\x11\x00"
    return b"\xff\xd8" + app0 + sof0 + b"\xff\xd9"


def bmp(width: int, height: int) -> bytes:
    header = struct.pack("<IiiHH", 40, width, -height, 1, 24) + b"\x00" * 24
    return b"BM" + struct.pack("<IHHI", 14 + len(header), 0, 0, 54) + header


def emf() -> bytes:
    return struct.pack("<II", 1, 108) + b"\x00" * 32 + b" EMF" + b"\x00" * 64


def attachment(name: str, data: bytes, cid: str | None = None, hidden: bool = False):
    return SimpleNamespace(
        longFilename=name, shortFilename=None, displayName=None,
        contentId=cid, hidden=hidden, type=AttachmentType.DATA, data=data,
    )


def options(**overrides):
    values = {"skip_inline": False, "max_depth": 5, "prefer": "plain", "strip_quotes": False}
    values.update(overrides)
    return SimpleNamespace(**values)


def new_manifest() -> dict:
    return {"attachments": [], "warnings": []}


@unittest.skipIf(m is None, "extract-msg is not installed")
class ImageFormatTest(unittest.TestCase):
    def test_detects_formats_from_signature(self):
        self.assertEqual(m.image_format(png(1, 1), "a.bin"), "PNG")
        self.assertEqual(m.image_format(jpeg(1, 1), "a.bin"), "JPEG")
        self.assertEqual(m.image_format(gif(1, 1), "a.bin"), "GIF")
        self.assertEqual(m.image_format(b"RIFF\x00\x00\x00\x00WEBPVP8 ", "a.bin"), "WEBP")
        self.assertEqual(m.image_format(b"II*\x00" + b"\x00" * 8, "a.bin"), "TIFF")
        self.assertEqual(m.image_format(emf(), "a.bin"), "EMF")
        self.assertEqual(m.image_format(b"\xd7\xcd\xc6\x9a" + b"\x00" * 18, "a.bin"), "WMF")

    def test_signature_wins_over_extension(self):
        self.assertEqual(m.image_format(png(1, 1), "renamed.jpg"), "PNG")

    def test_falls_back_to_extension(self):
        self.assertEqual(m.image_format(b"\x1f\x8b\x08\x00", "image001.EMZ"), "EMZ")
        self.assertEqual(m.image_format(bmp(1, 1), "scan.bmp"), "BMP")

    def test_non_image_is_none(self):
        self.assertIsNone(m.image_format(b"%PDF-1.7\n", "report.pdf"))
        self.assertIsNone(m.image_format(b"", "attachment_1"))


@unittest.skipIf(m is None, "extract-msg is not installed")
class ImageSizeTest(unittest.TestCase):
    def test_reads_header_sizes(self):
        self.assertEqual(m.image_size(png(1280, 720), "PNG"), (1280, 720))
        self.assertEqual(m.image_size(gif(16, 16), "GIF"), (16, 16))
        self.assertEqual(m.image_size(jpeg(640, 480), "JPEG"), (640, 480))
        self.assertEqual(m.image_size(bmp(200, 100), "BMP"), (200, 100))

    def test_unknown_or_truncated_is_none(self):
        self.assertIsNone(m.image_size(emf(), "EMF"))
        self.assertIsNone(m.image_size(png(10, 10)[:18], "PNG"))
        self.assertIsNone(m.image_size(jpeg(10, 10)[:12], "JPEG"))
        self.assertIsNone(m.image_size(b"\xff\xd8\x00\x00\x00", "JPEG"))

    def test_decorative_bounds(self):
        self.assertTrue(m.is_decorative((300, 150)))
        self.assertFalse(m.is_decorative((301, 150)))
        self.assertFalse(m.is_decorative((300, 151)))
        self.assertFalse(m.is_decorative(None))


@unittest.skipIf(m is None, "extract-msg is not installed")
class HtmlImagePlaceholderTest(unittest.TestCase):
    def test_cid_images_keep_their_position(self):
        text = m.html_to_text('<p>See below</p><img src="cid:image001.png@01DA" alt=" Error  dialog "><p>Thanks</p>')
        self.assertIn('See below\n[cid:image001.png@01DA alt="Error dialog"]\nThanks', text)

    def test_remote_images_need_alt_text(self):
        text = m.html_to_text('<img src="https://t.example/p.gif"><img src="https://cdn.example/l.png" alt="Logo">')
        self.assertEqual(text, '[image alt="Logo"]')

    def test_word_vml_fallback_is_ignored(self):
        html = (
            '<!--[if gte vml 1]><v:imagedata src="cid:image001.emz@01DA"/><![endif]-->'
            '<![if !vml]><img src="cid:image002.png@01DA"><![endif]>'
        )
        text = m.html_to_text(html)
        self.assertIn("[cid:image002.png@01DA]", text)
        self.assertNotIn("image001.emz", text)


@unittest.skipIf(m is None, "extract-msg is not installed")
class InlineDetectionTest(unittest.TestCase):
    def test_referenced_content_id_is_inline(self):
        att = attachment("image001.png", png(1, 1), cid="<Image001.png@01DA>")
        self.assertTrue(m.is_inline(att, "see [cid:image001.png@01da]"))

    def test_unreferenced_content_id_is_not_inline(self):
        att = attachment("photo.jpg", jpeg(1, 1), cid="photo.jpg@apple")
        self.assertFalse(m.is_inline(att, "please find the photo attached"))

    def test_content_id_trusted_without_body(self):
        att = attachment("image001.png", png(1, 1), cid="image001.png@01DA")
        self.assertTrue(m.is_inline(att, None))

    def test_hidden_is_inline(self):
        self.assertTrue(m.is_inline(attachment("oledata.mso", b"\x00", hidden=True), "body"))


@unittest.skipIf(m is None, "extract-msg is not installed")
class RenderAttachmentTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.body = "see [cid:shot.png@1] and [cid:logo.png@1]"

    def tearDown(self):
        self._tmp.cleanup()

    def render(self, att, manifest, **opts):
        return "\n".join(m.render_attachment(att, 1, options(**opts), self.dir, 0, manifest, self.body))

    def test_screenshot_is_tagged_as_content(self):
        manifest = new_manifest()
        line = self.render(attachment("shot.png", png(1280, 720), cid="shot.png@1"), manifest)
        self.assertIn("inline image, PNG 1280x720 px, `cid:shot.png@1`", line)
        self.assertNotIn("likely logo", line)
        self.assertEqual(manifest["warnings"], [])
        self.assertTrue((self.dir / "shot.png").is_file())

    def test_small_inline_image_is_tagged_as_logo(self):
        line = self.render(attachment("logo.png", png(120, 40), cid="logo.png@1"), new_manifest())
        self.assertIn("inline image, likely logo or signature, PNG 120x40 px", line)

    def test_small_regular_attachment_is_not_a_logo(self):
        line = self.render(attachment("icon.png", png(32, 32)), new_manifest())
        self.assertIn("_(image, PNG 32x32 px)_", line)

    def test_skip_inline_keeps_screenshots(self):
        manifest = new_manifest()
        logo = self.render(attachment("logo.png", png(120, 40), cid="logo.png@1"), manifest, skip_inline=True)
        shot = self.render(attachment("shot.png", png(1280, 720), cid="shot.png@1"), manifest, skip_inline=True)
        hidden = self.render(attachment("oledata.mso", b"\x00" * 8, hidden=True), manifest, skip_inline=True)
        self.assertIn("logo or signature image, skipped", logo)
        self.assertIn("hidden attachment, skipped", hidden)
        self.assertIn("inline image, PNG 1280x720 px", shot)
        self.assertEqual(manifest["attachments"], [str(self.dir / "shot.png")])

    def test_skip_inline_keeps_images_of_unknown_size(self):
        manifest = new_manifest()
        line = self.render(attachment("image001.emz", b"\x1f\x8b\x08\x00", hidden=True), manifest, skip_inline=True)
        self.assertNotIn("skipped", line)
        self.assertEqual(len(manifest["attachments"]), 1)

    def test_unviewable_format_is_flagged(self):
        manifest = new_manifest()
        line = self.render(attachment("chart.emf", emf()), manifest)
        self.assertIn("image, EMF, format not viewable by most vision models", line)
        self.assertEqual(len(manifest["warnings"]), 1)
        self.assertIn("EMF", manifest["warnings"][0])

    def test_non_image_attachment_has_no_tags(self):
        line = self.render(attachment("report.pdf", b"%PDF-1.7\n"), new_manifest())
        self.assertRegex(line, r"^- 1\. `report\.pdf` \(0\.0 KB\) → ")


@unittest.skipIf(m is None, "extract-msg is not installed")
class RenderMessageTest(unittest.TestCase):
    def test_body_references_drive_inline_detection(self):
        msg = SimpleNamespace(
            subject="Bug report",
            body="The error is below.\n[cid:image001.png@01DA]\n",
            htmlBody=None,
            rtfBody=None,
            attachments=[
                attachment("image001.png", png(1280, 720), cid="image001.png@01DA"),
                attachment("photo.jpg", jpeg(800, 600), cid="photo.jpg@apple"),
            ],
        )
        with tempfile.TemporaryDirectory() as tmp:
            md = m.render_message(msg, options(), Path(tmp), 0, new_manifest())
        self.assertIn("[cid:image001.png@01DA]", md)
        self.assertIn("`image001.png` (0.0 KB) _(inline image, PNG 1280x720 px, `cid:image001.png@01DA`)_", md)
        self.assertIn("`photo.jpg` (0.0 KB) _(image, JPEG 800x600 px)_", md)


if __name__ == "__main__":
    unittest.main()
