#!/usr/bin/env python3
"""PTY regression harness: FULL slash-menu cycles (feedback v0.6 #4).

Unlike pty-repro.py (progressive typing inside ONE open overlay), this drives
the complete open -> close -> reopen cycle reported in feedback.txt:
  mode a:  "/" Enter "/" Enter "/"        (open, close, open, close, open)
  mode b:  "/" "help" Enter "/"           (submit a command while menu shows)

The check inspects the terminal's FULL history (scrolled-off lines + live
screen) via a pyte HistoryScreen: a closed overlay must leave ZERO menu rows
and ZERO committed "› /" prompt echoes behind — only a real executed command's
output may persist.

Usage:
  python3 scripts/pty-cycle.py [--cols 100] [--rows 15] [--mode a|b]

Exit: 0 = clean, 1 = REPRO (stale blocks / duplicates), 2 = harness error.
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


class RecordingHistory(HistoryScreen):
    """HistoryScreen with unbounded history (default deque holds only ~70)."""

    def __init__(self, columns, lines):
        super().__init__(columns, lines, history=10000)


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

    drain(1.5)  # banner + first prompt
    for s in steps:
        if s:
            os.write(fd, s.encode())
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


# A slash-menu row as rendered by the overlay: "/name  help text".
MENU_ROW = re.compile(
    r"^/(help|exit|login|new|sessions|resume|clear|compact|plan|undo|role|mode|"
    r"profile|exec|history|context|usage|config|model)\b(\s|$)"
)
# A committed prompt echo: prompt glyph (or wrapped continuation) + "/...".
PROMPT_ECHO = re.compile(r"^[>\u203a\|]?\s*[>\u203a]\s*/")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cols", type=int, default=100)
    ap.add_argument("--rows", type=int, default=15)
    ap.add_argument("--mode", choices=["a", "b"], default="a",
                    help="a = open/close/open cycles; b = submit command with menu open")
    ap.add_argument("--settle", type=float, default=0.6)
    ap.add_argument("--dump", action="store_true", help="print full history too")
    args = ap.parse_args()

    if args.mode == "a":
        steps = ["/", "\r", "/", "\r", "/"]
    else:
        steps = ["/", "help", "\r", "/"]

    screen, history, live = run(args.cols, args.rows, steps, args.settle)
    live_rows = [l[1:] for l in live.splitlines()]
    print("=== LIVE SCREEN ===")
    print(live)
    if args.dump:
        print("=== SCROLLED-OFF HISTORY ===")
        for h in history:
            print("H|" + h)

    whole = history + live_rows
    menu_all = [l for l in whole if MENU_ROW.match(l)]
    echoes = [l for l in whole if PROMPT_ECHO.search(l)]
    menu_hist = [l for l in history if MENU_ROW.match(l)]
    menu_live = [l for l in live_rows if MENU_ROW.match(l)]
    echo_hist = [l for l in history if PROMPT_ECHO.search(l)]
    echo_live = [l for l in live_rows if PROMPT_ECHO.search(l)]

    print(f"\nmenu rows: total={len(menu_all)} history={len(menu_hist)} live={len(menu_live)}")
    print(f"prompt echoes: total={len(echoes)} history={len(echo_hist)} live={len(echo_live)}")
    for l in echoes:
        print("  ECHO " + repr(l))

    bad = []
    if args.mode == "a":
        # Three opens, two closes; final state = overlay OPEN. Nothing was ever
        # executed: no menu row and no "› /" echo may sit in scrollback.
        if menu_hist:
            bad.append(f"{len(menu_hist)} menu rows left in scrollback after overlay close")
        if echo_hist:
            bad.append(f"{len(echo_hist)} stale '› /' echo lines in scrollback (lone '/' must not commit)")
    else:
        # '/help' was executed -> its echo MAY settle in scrollback (feedback
        # #2: executed commands are the ONLY thing allowed to persist) — but
        # exactly one copy. The final "› /" is the NEW open overlay (live),
        # not a commit, so it must not appear in history.
        help_echoes = [l for l in whole if re.search(r"[>\u203a]\s*/help", l)]
        if len(help_echoes) != 1:
            bad.append(f"expected exactly 1 committed '/help' echo, got {len(help_echoes)}: {help_echoes}")
        lone_hist = [l for l in history if re.search(r"[>\u203a]\s*/\s*$", l)]
        if lone_hist:
            bad.append(f"stale lone-'› /' echo in scrollback: {lone_hist}")
        # The CLOSED overlay's menu rows must be gone; only the NEW open
        # overlay's block may show live — history must hold zero menu rows.
        if menu_hist:
            bad.append(f"{len(menu_hist)} menu rows from a closed overlay in scrollback")

    if bad:
        for b in bad:
            print("REPRO:", b)
        sys.exit(1)
    print("OK: overlay fully removed on close; scrollback free of stale menu blocks")


if __name__ == "__main__":
    main()
