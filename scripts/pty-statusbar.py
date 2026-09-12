#!/usr/bin/env python3
"""PTY regression harness: the GREEN STATUS BAR must stay a single live row
(feedback v0.6.2 — third site of the render-loop bug).

Reproduction from feedback.txt: send several messages in a row. Before the
fix, every REPL iteration printed a FRESH status bar line, so the pre-response
version (ctx 0%) stayed stuck in scrollback while the post-response version
(ctx 1%, new token counts) printed as a new row below it — a growing pile of
duplicate bars.

The check inspects the FULL terminal history (scrolled-off lines + live
screen) via pyte HistoryScreen: across N message cycles there must be AT MOST
ONE status bar row alive on screen and ZERO bar rows in scrollback.

Usage:
  python3 scripts/pty-statusbar.py [--cols 100] [--rows 24] [--msgs 4]

Exit: 0 = clean (single live bar, no scrollback duplicates), 1 = REPRO,
2 = harness error. Requires the fake LLM server:
  node scripts/fake-llm-server.mjs &
"""
import argparse
import os
import pty
import re
import select
import sys
import time

try:
    from pyte import HistoryScreen, Stream
except ImportError:
    sys.stderr.write("needs pyte: pip install pyte\n")
    sys.exit(2)

# The dark-green bar as rendered by buildStatusBar: starts with the bolt.
STATUS_BAR = re.compile(r"\u26a1\s*\[")


class RecordingHistory(HistoryScreen):
    def __init__(self, columns, lines):
        super().__init__(columns, lines, history=10000)


def run(cols, rows, msgs, settle):
    pid, fd = pty.fork()
    if pid == 0:  # child
        os.environ["TERM"] = "xterm-256color"
        os.environ["RUKO_CONFIG"] = ".ruko/config-pty-test.json"
        repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        os.chdir(repo)
        os.execvp("node", ["node", "dist/index.js"])
    try:
        import fcntl, struct, termios
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except Exception:
        pass
    screen = RecordingHistory(cols, rows)
    stream = Stream(screen)

    def feed(data):
        stream.feed(data.decode("utf8", "replace"))

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
                feed(data)
        return True

    drain(2.0)  # splash + first prompt
    for i in range(msgs):
        os.write(fd, f"pesan {i+1}\r".encode())
        drain(settle)
    live = dump(screen)
    try:
        os.write(fd, b"\x03")
        drain(0.5)
    except OSError:
        pass
    try:
        os.close(fd)
    except OSError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    history = [
        "".join(buf[x].data for x in range(screen.columns)).rstrip()
        for buf in list(screen.history.top) + list(screen.history.bottom)
    ]
    return screen, history, live


def dump(screen):
    return "\n".join(
        "|" + "".join(screen.buffer[y][x].data for x in range(screen.columns)).rstrip()
        for y in range(screen.lines)
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cols", type=int, default=100)
    ap.add_argument("--rows", type=int, default=24)
    ap.add_argument("--msgs", type=int, default=4)
    ap.add_argument("--settle", type=float, default=2.5)
    ap.add_argument("--dump", action="store_true")
    args = ap.parse_args()

    screen, history, live = run(args.cols, args.rows, args.msgs, args.settle)
    live_rows = [l[1:] for l in live.splitlines()]
    print("=== LIVE SCREEN ===")
    print(live)
    if args.dump:
        print("=== SCROLLED-OFF HISTORY ===")
        for h in history:
            print("H|" + h)

    hist_bars = [l for l in history if STATUS_BAR.search(l)]
    live_bars = [l for l in live_rows if STATUS_BAR.search(l)]
    print(f"\nstatus bars: history={len(hist_bars)} live={len(live_bars)}")
    for l in hist_bars:
        print("  HIST " + repr(l[:80]))

    bad = []
    if hist_bars:
        bad.append(f"{len(hist_bars)} status-bar rows settled in SCROLLBACK (must be 0)")
    if len(live_bars) > 1:
        bad.append(f"{len(live_bars)} status-bar rows alive at once (must be <= 1)")

    if bad:
        for b in bad:
            print("REPRO:", b)
        sys.exit(1)
    print("OK: at most ONE live status bar, zero duplicates in scrollback")


if __name__ == "__main__":
    main()
