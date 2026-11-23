# Troubleshooting

## extract-msg cannot be installed (network blocked or proxy issues)

1. Check whether the package is already present: `python -c "import extract_msg"`.
2. If only `olefile` is available, read the main streams directly. These are the standard MAPI property streams, where `001F` means a UTF-16LE string:

```python
import olefile

ole = olefile.OleFileIO("file.msg")

def read(stream):
    # MAPI string properties (type 001F) are UTF-16LE
    if ole.exists(stream):
        return ole.openstream(stream).read().decode("utf-16-le", errors="replace").rstrip("\x00")
    return ""

print("Subject:", read("__substg1.0_0037001F"))
print("From:", read("__substg1.0_0C1A001F"))
print("To:", read("__substg1.0_0E04001F"))
print("Cc:", read("__substg1.0_0E03001F"))
print(read("__substg1.0_1000001F"))  # plain-text body
# Attachments live in __attach_version1.0_#XXXXXXXX storages:
#   filename -> __substg1.0_3707001F, data -> __substg1.0_37010102
```

3. Last-resort fallback, with no Python library: `strings -el file.msg | less`. This extracts the UTF-16LE text, including the body and headers, mixed with noise. It is enough to answer simple questions. It cannot recover attachments.

If none of these works, tell the user that an organization owner must allow `pypi.org` in the network settings, or ask them to convert the file on their side (see below).

## Conversion on the user's side (when the environment cannot process the file)

- **Outlook (Windows/Mac)**: open the email, then File > Save As > Text Only (.txt) or HTML. For a PDF, use File > Print > "Microsoft Print to PDF". Save attachments separately.
- **Linux**: `sudo apt install libemail-outlook-message-perl`, then `msgconvert file.msg` produces `file.eml`. The `.eml` format is plain MIME text that can be read directly.
- **Any OS with Python**: `pip install extract-msg`, then `python -m extract_msg --out ./out file.msg`.

## Choosing a format for LLM consumption

- Text-only emails → Markdown or `.txt`. This is the cheapest format in tokens and the cleanest.
- Emails where the layout carries meaning (complex tables, annotated screenshots) → PDF.
- Attachments → always in their native format, provided separately.
- Long threads → keep the most recent message and remove the quoted history (`--strip-quotes`).
