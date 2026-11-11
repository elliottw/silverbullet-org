"""Brings the Hugo site's posts and pages into the note library.

The site's content becomes Denote notes, after which SilverBullet is the
source of truth and `content/` is something the generator writes. That is a
one-way door, so this runs as a dry run unless told otherwise and never
overwrites a note it already made.

Each post keeps its date as its Denote identifier -- the date is the thing a
post is addressed by, and using it means a re-import recognises what it
already brought in.
"""

import os
import re
import shutil
import sys
import unicodedata

SITE = os.path.expanduser("~/code/elliottw.github.io/content")
ORG = os.path.expanduser("~/org")
SITE_KEYWORD = "elliottwgithubio"
APPLY = "--apply" in sys.argv

IMAGE = re.compile(r"\[\[(?:file:|\./)?([^\]/]+\.(?:png|jpe?g|gif|webp|svg))\]\]", re.I)


def sluggify(value):
    """Denote's own: lowercase, ASCII, hyphens, no runs."""
    value = unicodedata.normalize("NFKD", value)
    value = value.encode("ascii", "ignore").decode()
    value = re.sub(r"[^a-zA-Z0-9]+", "-", value).strip("-").lower()
    return re.sub(r"-{2,}", "-", value)


def split_front(text):
    """Hugo takes front matter in Org's `#+key:` or in TOML between `+++`.

    A third of this site uses the TOML form, which is invisible to a reader
    who only knows the Org one -- and a file whose title cannot be read is a
    file that gets silently skipped.
    """
    lines = text.split("\n")
    front = {}
    if lines and lines[0].strip() == "+++":
        i = 1
        while i < len(lines) and lines[i].strip() != "+++":
            m = re.match(r'^\s*(\w+)\s*=\s*(.*)$', lines[i])
            if m:
                value = m.group(2).strip()
                # `[ "Articles", "Points" ]` or `"A title"`.
                if value.startswith("["):
                    items = re.findall(r'"([^"]*)"', value)
                    value = ", ".join(items)
                else:
                    value = value.strip('"').strip("'")
                front[m.group(1).lower()] = value
            i += 1
        return front, "\n".join(lines[i + 1:]).strip()

    i = 0
    while i < len(lines) and (lines[i].startswith("#+") or not lines[i].strip()):
        m = re.match(r"^#\+(\w+):[ \t]*(.*)$", lines[i])
        if m:
            front[m.group(1).lower()] = m.group(2).strip()
        i += 1
    return front, "\n".join(lines[i:]).strip()


def existing_identifiers():
    out = set()
    for name in os.listdir(ORG):
        m = re.match(r"^(\d{8}T\d{6})", name)
        if m:
            out.add(m.group(1))
    return out


def main():
    taken = existing_identifiers()
    # A note already imported carries the site keyword and the post's title.
    already = {}
    for name in os.listdir(ORG):
        if SITE_KEYWORD in name and name.endswith(".org"):
            already[name] = True

    bundles = []
    for root, _, files in os.walk(SITE):
        for name in files:
            if name in ("index.org", "index.md", "_index.org", "_index.md"):
                bundles.append(os.path.join(root, name))
    bundles.sort()

    created = skipped = images = 0
    report = []
    for path in bundles:
        text = open(path, errors="replace").read()
        front, body = split_front(text)
        title = front.get("title", "").strip()
        if not title:
            skipped += 1
            continue

        # A page lives outside content/posts; a post lives in it. Explicit,
        # because a rule inferred from a missing date would surprise later.
        rel = os.path.relpath(path, SITE)
        kind = "post" if rel.split(os.sep)[0] == "posts" else "page"

        date = re.search(r"(\d{4})-(\d{2})-(\d{2})", front.get("date", ""))
        stamp = (
            f"{date.group(1)}{date.group(2)}{date.group(3)}T000000"
            if date
            else "00000000T000000"
        )
        while stamp in taken:
            # Same day, another post: step a second, as Denote does.
            head, tail = stamp.split("T")
            stamp = f"{head}T{int(tail) + 1:06d}"
        taken.add(stamp)

        categories = [
            sluggify(c)
            for c in re.split(r",", front.get("categories", ""))
            if c.strip()
        ]
        keywords = sorted({SITE_KEYWORD, kind, *filter(None, categories)})
        note = f"{stamp}--{sluggify(title)}__{'_'.join(keywords)}.org"

        if any(sluggify(title) in n for n in already):
            skipped += 1
            continue

        # Images travel with the post and are renamed the Denote way, so they
        # are addressable like every other attachment in the library.
        bundle = os.path.dirname(path)
        body_out = body
        copied = []
        for match in IMAGE.finditer(body):
            leaf = match.group(1)
            source = os.path.join(bundle, leaf)
            if not os.path.exists(source):
                continue
            ext = os.path.splitext(leaf)[1].lower()
            attach = f"{stamp[:-1]}{len(copied) + 1}--{sluggify(os.path.splitext(leaf)[0])}{ext}"
            body_out = body_out.replace(match.group(0), f"[[file:{attach}]]")
            copied.append((source, attach))

        front_out = [
            f"#+title:      {title}",
            f"#+date:       [{date.group(0)} 00:00]" if date else "#+date:",
            f"#+filetags:   :{':'.join(keywords)}:",
            f"#+identifier: {stamp}",
        ]
        if front.get("description"):
            front_out.append(f"#+description: {front['description']}")
        # Everything already on the site is published; a draft is a thing you
        # make here, not something imported.
        front_out.append("#+draft:      false")
        out = "\n".join(front_out) + "\n\n" + body_out.strip() + "\n"

        report.append(f"{kind:4s}  {note}" + (f"  (+{len(copied)} images)" if copied else ""))
        created += 1
        images += len(copied)
        if not APPLY:
            continue
        with open(os.path.join(ORG, note), "w") as f:
            f.write(out)
        for source, attach in copied:
            shutil.copy2(source, os.path.join(ORG, attach))

    print("\n".join(report[:20]))
    if len(report) > 20:
        print(f"... and {len(report) - 20} more")
    print(f"\n{created} notes, {images} images, {skipped} skipped")
    print("applied" if APPLY else "(dry run: nothing written)")


main()
