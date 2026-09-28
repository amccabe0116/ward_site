#!/usr/bin/env python3
"""
Turn the weekly "Northpoint YSA Ward Weekly Announcements" email into announcements.json
(+ images in img/) for the site.

Usage:
  publish_announcements.py --raw message.eml   [--out DIR] [--sent-at ISO] [--subject S] [--message-id ID]
  publish_announcements.py --text body.txt     [--out DIR] ...

--raw   the RAW (RFC 822 / MIME) message as returned by Gmail's RAW format
        (either the bare base64url string Gmail gives back, or an already-decoded .eml)
--text  a plain-text body when only the text is available

Writes <out>/announcements.json and <out>/img/ann-<date>-N.<ext> and prints a summary.
"""
import argparse, base64, email, email.policy, hashlib, html, json, os, re, sys
from datetime import datetime, timezone

def load_raw(path):
    data = open(path, 'rb').read()
    s = data.strip()
    # Gmail's RAW format is base64url of the RFC822 message; an .eml starts with headers.
    if not re.match(rb'^[A-Za-z]+(-[A-Za-z]+)*:\s', s[:200]):
        try:
            if re.fullmatch(rb'[A-Za-z0-9_\-=\r\n]+', s):
                pad = b'=' * (-len(s) % 4)
                data = base64.urlsafe_b64decode(s + pad)
        except Exception:
            pass
    return email.message_from_bytes(data, policy=email.policy.default)

def html_to_text(h):
    h = re.sub(r'(?is)<(script|style).*?</\1>', '', h)
    h = re.sub(r'(?i)<br\s*/?>', '\n', h)
    h = re.sub(r'(?i)</(p|div|li|tr|h[1-6]|blockquote)>', '\n', h)
    h = re.sub(r'(?i)<li[^>]*>', '• ', h)
    h = re.sub(r'(?is)<a [^>]*href="([^"]+)"[^>]*>(.*?)</a>', lambda m: (m.group(2) if m.group(1).strip() in m.group(2) else f'{m.group(2)} ({m.group(1)})'), h)
    h = re.sub(r'(?s)<[^>]+>', '', h)
    t = html.unescape(h)
    t = t.replace('\xa0', ' ')
    t = re.sub(r'[ \t]+\n', '\n', t)
    t = re.sub(r'\n{3,}', '\n\n', t)
    return t.strip()

FOOTER_RE = re.compile(r'\n-{5,}\s*\nYou received this email because.*$', re.S)
HEADER_RE = re.compile(r'^(The Church of Jesus Christ of Latter-day Saints\s*\n+)?(North ?Point YSA Ward\s*\n+)?', re.I)

def clean_text(t):
    t = FOOTER_RE.sub('', t)
    t = re.sub(r'\nYou received this email because.*$', '', t, flags=re.S)
    t = HEADER_RE.sub('', t.strip())
    return t.strip()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--raw'); ap.add_argument('--text')
    ap.add_argument('--out', default='.')
    ap.add_argument('--sent-at'); ap.add_argument('--subject'); ap.add_argument('--message-id')
    a = ap.parse_args()
    if not a.raw and not a.text:
        ap.error('need --raw or --text')

    out_dir = a.out; img_dir = os.path.join(out_dir, 'img'); os.makedirs(img_dir, exist_ok=True)
    sent_at = a.sent_at; subject = a.subject; text = ''; images = []

    if a.raw:
        msg = load_raw(a.raw)
        subject = subject or msg.get('subject', '')
        if not sent_at and msg.get('date'):
            try: sent_at = email.utils.parsedate_to_datetime(msg['date']).astimezone(timezone.utc).isoformat()
            except Exception: pass
        body_txt = msg.get_body(preferencelist=('plain',))
        body_html = msg.get_body(preferencelist=('html',))
        if body_html:
            text = html_to_text(body_html.get_content())
        elif body_txt:
            text = body_txt.get_content()
        stamp = (sent_at or datetime.now(timezone.utc).isoformat())[:10]
        n = 0
        for part in msg.walk():
            ct = part.get_content_type()
            if not ct.startswith('image/'): continue
            payload = part.get_payload(decode=True)
            if not payload or len(payload) < 5000: continue   # skip tracking pixels / signatures
            ext = {'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp'}.get(ct, 'bin')
            n += 1
            name = f'ann-{stamp}-{n}.{ext}'
            open(os.path.join(img_dir, name), 'wb').write(payload)
            images.append('img/' + name)
    else:
        text = open(a.text, encoding='utf-8').read()

    text = clean_text(text)
    # remove the old flyers so the folder doesn't grow forever
    for f in os.listdir(img_dir):
        if f.startswith('ann-') and ('img/' + f) not in images:
            os.remove(os.path.join(img_dir, f))

    data = {
        'subject': subject or 'Weekly Announcements',
        'sent_at': sent_at or datetime.now(timezone.utc).isoformat(),
        'updated_at': datetime.now(timezone.utc).isoformat(),
        'message_id': a.message_id,
        'text': text,
        'images': images,
    }
    with open(os.path.join(out_dir, 'announcements.json'), 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(json.dumps({'subject': data['subject'], 'sent_at': data['sent_at'], 'chars': len(text), 'images': images}, indent=2))

if __name__ == '__main__':
    main()
