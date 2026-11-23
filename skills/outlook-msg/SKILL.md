---
name: outlook-msg
description: Read, convert and analyze Outlook .msg files (emails, email threads, meeting invites, embedded/forwarded messages and their attachments). Use this skill whenever a .msg file is uploaded or mentioned, whenever the user wants to summarize, search, triage, translate or answer questions about Outlook emails exported as .msg, or wants to extract attachments from them — even if they don't say "convert". A .msg is a binary OLE container, not text, so never cat it or guess its content; run the bundled converter first.
---

# Outlook .msg reader

A `.msg` file is an Outlook binary container (OLE2/MAPI). Its text is not directly readable, and its attachments, inline images and forwarded emails are nested inside it. This skill turns each `.msg` into a clean Markdown file plus a folder of real attachment files, then works from those.

## Workflow

### 1. Install the dependency (once per session)

```bash
pip install extract-msg --break-system-packages -q
```

If installation fails because of the network, read `references/troubleshooting.md` before trying anything else.

### 2. Convert

```bash
python /path/to/outlook-msg/scripts/msg_to_md.py <file.msg | directory> [...] -o /home/claude/msg_out
```

The script accepts several files or directories (it searches `*.msg` recursively). It prints a JSON manifest on stdout listing, for each source file, the generated `.md`, every extracted attachment path, its size in characters and any warnings or errors. Use this manifest to decide what to read next. Do not list directories by hand.

Options, in order of usefulness:

| Option | When to use it |
|---|---|
| `--strip-quotes` | Long reply chains where only the latest message matters, or many emails from the same thread. It cuts the body at the first `From:/Sent:`, `De :/Envoyé :`, `On … wrote:`, `Le … a écrit :` or `Original Message` separator. Do not use it when the user wants the whole history. |
| `--prefer html` | The email contains tables, a layout or lists that the plain-text body flattens badly. |
| `--skip-inline` | Many emails with logos and signature images that only add noise. |
| `--max-depth N` | Limits recursion into forwarded messages attached as `.msg` (default 5). |

### 3. Read the output

- Read the generated `.md` files with `view`. Each one contains a list of headers (From, To, Cc, Bcc, Date, Subject, plus Start, End and Location for meeting items), the body, then an `## Attachments` section.
- Forwarded emails attached as `.msg` are rendered inline under `### Embedded message N`, recursively. Their own attachments go in `embedded_N/` subfolders.
- Attachments are real files on disk. Open them with the matching skill: PDF → pdf-reading, DOCX → docx, XLSX/CSV → xlsx, images → `view`. Read an attachment when the user's question may depend on it, and say which ones you did not open.
- Items marked `_(inline)_` are usually signature images or logos. Ignore them unless the question concerns visual content.
- Cloud attachments (OneDrive or SharePoint links) only contain a URL. The file itself is not inside the `.msg`. Say so explicitly.

### 4. Answer

Base answers on the converted content. Cite the sender, date and subject when you summarize several emails. With many emails, use the `chars` values from the manifest to plan: summarize each file before you synthesize rather than loading everything at once.

## Edge cases

- **Error `not an OLE2 structured storage file`**: the file is not a real `.msg` file. It is often an `.eml` file renamed, which is plain text, so read it directly. It can also be a truncated upload. Check it with `file <path>` and `head -c 200 <path>`.
- **Empty body**: the script already falls back from plain text to HTML, then to RTF. If the body is still empty, the content may be in an attachment only, or the message may be encrypted (S/MIME or IRM). Report that the message is encrypted. Content protected by IRM cannot be recovered without the key.
- **Signed emails (S/MIME)**: extract-msg unwraps them. The real attachments appear as usual.
- **Contacts, tasks and other non-email items**: when the item has no body, the script dumps its structured fields as JSON in the `.md` file.
- **Encoding problems** (garbled accents): run the conversion again with `--prefer html`. The HTML body usually declares its charset correctly.

## Scripts and references

- `scripts/msg_to_md.py`: the converter. It uses only the standard library plus `extract-msg`. If `striprtf` is installed, it uses it for RTF-only bodies.
- `references/troubleshooting.md`: offline installation, manual fallback without `extract-msg`, and conversion done on the user's side (Outlook, msgconvert).
