#!/usr/bin/env python3
"""PTY regression harness: LIVE INPUT while the AI works (feedback v0.7).

Modes:
  queue      : send msg1, WHILE the AI is still streaming type msg2 + Enter,
               answer the modal with "2" (queue). msg2 must then be processed
               automatically right after msg1's turn ends — exactly once,
               no duplication, no loss.
  interrupt  : same, but answer "1" — the running turn must stop cleanly and
               msg2 must be processed as the next turn.
  typing     : while the AI works, the input region must still be alive:
               type text, assert it echoes, assert the region survives
               streamed output (no corruption / no stacking).

Requires: fake LLM server in slow mode + test config:
  FAKE_LLM_SLOW=1 node scripts/fake-llm-server.mjs &

Usage:
  python3 scripts/pty-liveinput.py [--mode queue|interrupt|typing] [--cols 100] [--rows 24]

Exit: 0 = behavior correct, 1 = REPRO, 2 = harness error.
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

MODAL = re.compile(r"Pesan disiapkan")
STATUS_BAR = re.compile(r"\u26a1\s*\[")


class RecordingHistory(HistoryScreen):
    def __init__(self, columns, lines):
        super().__init__(columns, lines, history=10000)


def run(cols, rows, script, settle):
    """script: list of (delay_seconds, keys_to_send) tuples."""
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
    frames = []  # (label, live-dump) snapshots taken at script points

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
    for label, wait, keys in script:
        time.sleep(wait)
        if keys:
            os.write(fd, keys.encode())
        drain(settle)
        if label:
            frames.append((label, dump(screen)))
    final = dump(screen)
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
    return screen, history, final, frames


def dump(screen):
    return "\n".join(
        "|" + "".join(screen.buffer[y][x].data for x in range(screen.columns)).rstrip()
        for y in range(screen.lines)
    )


def rows_of(dump_text):
    return [l[1:] for l in dump_text.splitlines()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["queue", "interrupt", "typing"], default="queue")
    ap.add_argument("--cols", type=int, default=100)
    ap.add_argument("--rows", type=int, default=24)
    ap.add_argument("--settle", type=float, default=0.4)
    ap.add_argument("--dump", action="store_true")
    args = ap.parse_args()

    answer = "2" if args.mode == "queue" else "1"
    # each item: (label_or_None, wait_seconds, keys)
    script = [
        # msg1 starts a slow turn (tool loop ~15s total in FAKE_LLM_SLOW=1)
        (None, 0.0, "pesan satu\r"),
        ("ketik", 1.5, "pesan dua"),      # type msg2 into the LIVE ambient input
        ("live", 0.3, ""),                # snapshot: buffer visible while busy?
        ("enter", 0.2, "\r"),              # modal should appear
        ("modal", 0.3, ""),                # snapshot: modal visible?
        ("pilih", 0.2, answer),            # queue or interrupt
        # wait for msg1's slow turn to finish + msg2 to be processed fully
        # (slow stream: turn1 ~15s + turn2 ~15s + tool round-trip)
        ("selesai", 40.0, ""),
    ]
    if args.mode == "typing":
        script = [
            (None, 0.0, "pesan satu\r"),
            ("ketik", 1.5, "sambil ngetik ini"),
            ("live", 0.5, ""),
        ]

    screen, history, final, frames = run(args.cols, args.rows, script, args.settle)
    if args.dump:
        for label, snap in frames:
            print(f"=== FRAME {label} ===\n{snap}")
        print("=== FINAL ===")
        print(final)

    frame = dict(frames)
    bad = []

    if args.mode == "typing":
        if "sambil ngetik ini" not in frame.get("live", ""):
            bad.append("typed text NOT visible while AI busy (input region dead?)")
        if not STATUS_BAR.search(frame.get("live", "")):
            bad.append("status bar missing from live region while AI busy")
        # region must survive streamed output: after settle, still typable state
        if "⏳ AI bekerja" not in frame.get("live", ""):
            bad.append("busy indicator missing in status bar")

    if args.mode in ("queue", "interrupt"):
        live = frame.get("live", "")
        if "pesan dua" not in live:
            bad.append("msg2 not typed into the live region while AI busy")
        if not MODAL.search(frame.get("modal", "")):
            bad.append("queue modal did not appear after Enter while busy")
        # After the answer, msg2 must be processed exactly once.
        whole = "\n".join(history + rows_of(final))
        echoes = re.findall(r"[>\u203a]\s*pesan dua", whole)
        if len(echoes) != 1:
            bad.append(f"expected exactly 1 committed echo of 'pesan dua', got {len(echoes)}")
        # Its turn must have run: the fake server answers 'Semua baik...' per turn.
        if "pesan dua" not in whole:
            bad.append("msg2 vanished entirely")
        # No stale status bars piled up (v0.6.2 invariant must hold).
        hist_bars = [l for l in history if STATUS_BAR.search(l)]
        live_bars = [l for l in rows_of(final) if STATUS_BAR.search(l)]
        if hist_bars:
            bad.append(f"{len(hist_bars)} status-bar rows settled in scrollback")
        if len(live_bars) > 1:
            bad.append(f"{len(live_bars)} status bars alive at once")

    if bad:
        for b in bad:
            print("REPRO:", b)
        sys.exit(1)
    print(f"OK: live input behaves correctly (mode={args.mode})")


if __name__ == "__main__":
    main()
