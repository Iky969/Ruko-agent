#!/usr/bin/env python3
"""PTY repro harness for Ruko slash-menu redraw (feedback: "> /e / > /ex / > /exit"
leaves stale scrollback lines).

Spawns `node dist/index.js` inside a real PTY (pyte-accurate screen replay),
types a progressive sequence into the slash menu — "/e", wait, then one char
at a time to reach "/ex", "/exit" — and dumps the final screen. The check:
after the sequence, exactly ONE visible "> /..." prompt line may remain; any
stale duplicate ("> /e", "> /ex" sitting above the live line) fails the test.

Usage:
  python3 scripts/pty-repro.py [--cols 40] [--steps "/e:x:it"] [--dump-raw out.log]

Exit codes: 0 = clean single live line; 1 = REPRO (stale lines present);
2 = harness error (e.g. missing pyte -> pip install pyte).
"""
import argparse
import os
import pty
import re
import select
import sys
import time

try:
    import pyte
except ImportError:
    sys.stderr.write("needs pyte: pip install pyte\n")
    sys.exit(2)


def run(cols, rows, steps, settle):
    pid, fd = pty.fork()
    if pid == 0:  # child
        os.environ["TERM"] = "xterm-256color"
        repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        os.chdir(repo)
        os.execvp("node", ["node", "dist/index.js"])
    try:
        import fcntl, struct, termios
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except Exception:
        pass
    screen = pyte.Screen(cols, rows)
    stream = pyte.Stream(screen)
    raw = []

    def drain(timeout=0.15):
        end = time.time() + timeout
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.05)
            if r:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    return False
                if not data:
                    return False
                text = data.decode("utf8", "replace")
                raw.append(text)
                stream.feed(text)
        return True

    drain(1.5)  # banner + first prompt
    for s in steps:
        if s:
            os.write(fd, s.encode())
        drain(settle)
    # Snapshot the LIVE screen — before any Ctrl+C cancel wipes the region.
    live_text = dump(screen)
    try:
        os.write(fd, b"\x03")  # Ctrl+C: exit the loop
        drain(0.5)
    except OSError:
        pass
    try:
        os.close(fd)
    except OSError:
        pass
    try:
        os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        pass
    return screen, "".join(raw), live_text


def dump(screen):
    out = []
    for y in range(screen.lines):
        line = "".join(screen.buffer[y][x].data for x in range(screen.columns)).rstrip()
        out.append("|" + line)
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cols", type=int, default=40)
    ap.add_argument("--rows", type=int, default=24)
    ap.add_argument("--steps", default="/e:x:it",
                    help="colon-separated chunks typed with a settle pause between them")
    ap.add_argument("--settle", type=float, default=0.6)
    ap.add_argument("--dump-raw", default=None)
    ap.add_argument("--pattern", default=r"[>\u203a]\s*/",
                    help="regex for a prompt line containing a slash command")
    args = ap.parse_args()

    screen, raw, live_text = run(args.cols, args.rows, args.steps.split(":"), args.settle)
    if args.dump_raw:
        with open(args.dump_raw, "w") as f:
            f.write(raw)
        print(f"raw output -> {args.dump_raw} ({len(raw)} bytes)")
    print("=== LIVE SCREEN after the sequence (before Ctrl+C) ===")
    print(live_text)
    text = live_text
    lines = [l[1:] for l in text.splitlines()]
    stale = [l for l in lines if re.search(args.pattern, l)]
    # "› /exit  Keluar" menu rows also match "/"; only count lines that are a
    # prompt echo: pattern itself (prompt glyph + /cmd) — menu rows lack the glyph.
    print(f"\nprompt lines matching {args.pattern!r}: {len(stale)}")
    for l in stale:
        print("  " + repr(l))
    if len(stale) > 1:
        print("REPRO: stale prompt lines — redraw leaves >1 line in scrollback")
        sys.exit(1)
    print("OK: single live prompt line")


if __name__ == "__main__":
    main()
