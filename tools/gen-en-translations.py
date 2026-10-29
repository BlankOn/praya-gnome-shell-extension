#!/usr/bin/env python3
"""Generate translations-en.js from po/en.po for the JS fallback."""
import json
import re


def unquote(value):
    value = value.strip()
    return json.loads(value) if value.startswith('"') else value


def read_po(path):
    text = open(path, encoding='utf-8').read()
    entries = {}
    for raw in re.split(r'\n[ \t]*\n', text.strip('\n')):
        if any(line.startswith('#~') for line in raw.splitlines()):
            continue
        msgid = None
        msgstr = None
        field = None
        for line in raw.splitlines():
            if line.startswith('#'):
                continue
            if line.startswith('msgid '):
                field = 'msgid'
                msgid = unquote(line[6:])
            elif line.startswith('msgstr '):
                field = 'msgstr'
                msgstr = unquote(line[7:])
            elif line.startswith('"'):
                value = unquote(line)
                if field == 'msgid':
                    msgid += value
                elif field == 'msgstr':
                    msgstr += value
        if msgid:
            entries[msgid] = msgstr
    return entries


def main():
    entries = read_po('po/en.po')
    lines = [
        '// Generated from po/en.po by tools/gen-en-translations.py — do not edit.',
        'export const EN = {',
    ]
    for key in sorted(entries):
        lines.append(f'    {json.dumps(key, ensure_ascii=False)}: '
                     f'{json.dumps(entries[key], ensure_ascii=False)},')
    lines.append('};')
    lines.append('')
    open('translations-en.js', 'w', encoding='utf-8').write('\n'.join(lines))


if __name__ == '__main__':
    main()
