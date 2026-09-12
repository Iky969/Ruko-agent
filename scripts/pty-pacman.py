#!/usr/bin/env python3
"""PTY verification harness for Pac-Man thinking animation (feedback.txt).

Checks:
1. Left-aligned: "Thinking..." starts at column 0 (no center alignment).
2. Pac-Man / ghosts animation frames render while waiting for LLM.
3. Clean erase: once LLM answers, ZERO leftover animation rows in scrollback or live screen.
4. Multiple consecutive turns: no stacking bug across multiple messages.
5. Toggle: /anim off disables Pac-Man and falls back to plain spinner.

Usage:
  python3 scripts/pty-pacman.py
"""
import os
import pty
import re
import select
import subprocess
import sys
import time

try:
    from pyte import HistoryScreen, Stream
except ImportError:
    sys.stderr.write("needs pyte: pip install pyte\n")
    sys.exit(2)

PACMAN_LINE = re.compile(r"Thinking\.\.\..*([>O]|\(oo\)|\(OO\))")
SPINNER_LINE = re.compile(r"\u25b8\s*Thinking")


class RecordingHistory(HistoryScreen):
    def __init__(self, columns, lines):
        super().__init__(columns, lines, history=10000)


def start_server():
    env = os.environ.copy()
    env["FAKE_LLM_SLOW"] = "1"
    proc = subprocess.Popen(["node", "scripts/fake-llm-server.mjs"], env=env)
    time.sleep(0.5)
    return proc


def run_pacman_check():
    cols, rows = 80, 24
    pid, fd = pty.fork()
    if pid == 0:  # child
        os.environ["TERM"] = "xterm-256color"
        os.environ["RUKO_CONFIG"] = ".ruko/config-pty-pacman.json"
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

    def live_lines():
        return [
            "".join(screen.buffer[y][x].data for x in range(screen.columns)).rstrip()
            for y in range(screen.lines)
        ]

    drain(2.0)  # wait for splash & prompt

    # Create config with funAnimations: true
    print("Test 1: Kirim pesan dengan Pac-Man animation aktif...")
    os.write(fd, b"halo pertama\r")

    # While waiting, sample frames
    saw_pacman = False
    saw_left_aligned = False
    samples = []
    for _ in range(25):
        drain(0.08)
        lines = live_lines()
        for l in lines:
            if PACMAN_LINE.search(l) or "Thinking..." in l:
                samples.append(l)
                saw_pacman = True
                if l.startswith("Thinking..."):
                    saw_left_aligned = True

    # Wait for turn to finish (approval / answer)
    drain(3.0)
    # If approval asks y/N:
    for l in live_lines():
        if "Jalankan? [y/N]" in l or "echo halo-dari-tool" in l:
            os.write(fd, b"y\r")
            drain(2.5)
    for _ in range(30):
        if not any("⏳ AI bekerja" in l for l in live_lines()):
            break
        drain(0.3)

    print(f"  Saw Pac-Man animation frames: {saw_pacman} (samples: {len(samples)})")
    print(f"  Saw Left-Aligned (starts at col 0): {saw_left_aligned}")
    if samples:
        print(f"  Contoh frame: {repr(samples[0])}")

    # Check live screen & history for dead animation rows
    all_history = [
        "".join(buf[x].data for x in range(screen.columns)).rstrip()
        for buf in list(screen.history.top) + list(screen.history.bottom)
    ]
    dead_hist = [l for l in all_history if "Thinking..." in l]
    dead_live = [l for l in live_lines() if "Thinking..." in l]
    print(f"  Dead animation rows in scrollback: {len(dead_hist)} (must be 0)")
    print(f"  Dead animation rows on live screen: {len(dead_live)} (must be 0)")

    # Send second message
    print("\nTest 2: Kirim pesan kedua (cek tidak numpuk)...")
    os.write(fd, b"halo kedua\r")
    drain(1.0)
    for _ in range(30):
        if not any("⏳ AI bekerja" in l for l in live_lines()):
            break
        drain(0.5)
    drain(0.5)

    all_history2 = [
        "".join(buf[x].data for x in range(screen.columns)).rstrip()
        for buf in list(screen.history.top) + list(screen.history.bottom)
    ]
    dead_hist2 = [l for l in all_history2 if "Thinking..." in l]
    dead_live2 = [l for l in live_lines() if "Thinking..." in l]
    print(f"  Dead animation rows after 2nd turn: {len(dead_hist2)} (must be 0)")
    print(f"  Dead animation rows on live screen: {len(dead_live2)} (must be 0)")
    if dead_live2:
        print(f"  Live rows with Thinking...: {dead_live2}")
        print("  Full live screen dump:")
        for idx, row in enumerate(live_lines()):
            if row.strip():
                print(f"    [{idx}] {repr(row)}")

    # Test toggle: /anim off
    print("\nTest 3: Toggle /anim off...")
    os.write(fd, b"/anim off\r")
    drain(1.0)
    all_lines = live_lines() + [
        "".join(buf[x].data for x in range(screen.columns)).rstrip()
        for buf in list(screen.history.top) + list(screen.history.bottom)
    ]
    assert any("DIMATIKAN" in l for l in all_lines), f"Expected confirmation DIMATIKAN, got: {live_lines()[-5:]}"
    print("  /anim off berhasil dikonfirmasi")

    print("\nTest 4: Kirim pesan setelah /anim off (harus pakai dot spinner polos)...")
    os.write(fd, b"halo ketiga\r")
    saw_plain = False
    for _ in range(15):
        drain(0.08)
        lines = live_lines()
        for l in lines:
            if SPINNER_LINE.search(l):
                saw_plain = True
    drain(3.0)
    print(f"  Saw plain dot spinner: {saw_plain}")

    # Clean exit
    try:
        os.write(fd, b"/exit\r")
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

    assert saw_pacman, "Pac-Man animation was not observed"
    assert saw_left_aligned, "Pac-Man animation was not left-aligned at column 0"
    assert len(dead_hist) == 0, f"{len(dead_hist)} dead animation rows in scrollback!"
    assert len(dead_live) == 0, f"{len(dead_live)} dead animation rows on live screen!"
    assert len(dead_hist2) == 0, f"{len(dead_hist2)} dead animation rows after 2nd turn!"
    assert len(dead_live2) == 0, f"{len(dead_live2)} dead animation rows on live screen after 2nd turn!"
    assert saw_plain, "Plain spinner was not observed after /anim off"
    print("\n=== SEMUA VERIFIKASI PTY BERHASIL (100% OK) ===")


def main():
    # Setup test config
    cfg_path = ".ruko/config-pty-pacman.json"
    import json
    with open(cfg_path, "w") as f:
        json.dump({
            "maxContextChars": 30000,
            "maxLogChars": 1000,
            "execTimeoutMs": 30000,
            "approvalEnabled": true if False else False,
            "approvalAllowlist": [],
            "model": "fake-big",
            "mode": "beginner",
            "funAnimations": True,
            "apiKey": "sk-test",
            "baseUrl": "http://127.0.0.1:8931/v1"
        }, f)

    server = start_server()
    try:
        run_pacman_check()
    finally:
        server.terminate()
        server.wait()
        if os.path.exists(cfg_path):
            os.remove(cfg_path)


if __name__ == "__main__":
    main()
