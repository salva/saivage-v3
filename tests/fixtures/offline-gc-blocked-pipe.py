"""Real foreground PTY and a one-page, deliberately undrained stdout pipe."""

import array
import errno
import fcntl
import os
import pty
import select
import signal
import sys
import termios
import time
from pathlib import Path


lock_path, expected_path, *command = sys.argv[1:]
expected = Path(expected_path).read_bytes()
first_line = expected.split(b"\n", 1)[0] + b"\n"
reader, writer = os.pipe()
capacity = fcntl.fcntl(writer, fcntl.F_SETPIPE_SZ, os.sysconf("SC_PAGESIZE"))
assert len(first_line) == capacity and len(expected) > 4 * capacity
pid, terminal = pty.fork()
if pid == 0:
    os.close(reader)
    os.dup2(writer, 1)
    os.close(writer)
    os.execv(command[0], command)
os.close(writer)

deadline = time.monotonic() + 20
transcript = bytearray()
terminal_open = True


def read_terminal():
    global terminal_open
    try:
        chunk = os.read(terminal, 8192)
    except OSError as error:
        if error.errno != errno.EIO:
            raise
        chunk = b""
    terminal_open = bool(chunk)
    transcript.extend(chunk)


def ready(extra=()):
    assert time.monotonic() < deadline, "foreground GC witness timed out"
    watching = ([terminal] if terminal_open else []) + list(extra)
    readable, _, _ = select.select(watching, [], [], 0.01)
    if terminal in readable:
        read_terminal()
    return readable


def status_now():
    global pid
    waited, status = os.waitpid(pid, os.WNOHANG)
    if waited:
        pid = None
        return status
    return None


try:
    while b"to confirm:" not in transcript:
        ready()
        assert terminal_open, "foreground CLI closed before acknowledgement"
    os.write(terminal, f"GC OFFLINE QUIESCENT {os.getcwd()}\n".encode())

    received = bytearray()
    while len(received) < len(first_line):
        if reader in ready([reader]):
            chunk = os.read(reader, len(first_line) - len(received))
            assert chunk, "foreground CLI closed before the first list line"
            received.extend(chunk)
    assert received == first_line
    assert not os.path.lexists(lock_path), "list started before lock release"

    queued = array.array("i", [0])
    while True:
        assert status_now() is None, "foreground CLI exited before interruption"
        fcntl.ioctl(reader, termios.FIONREAD, queued, True)
        if queued[0] == capacity:
            break
        ready()
    assert len(expected) - len(received) > queued[0]
    os.write(terminal, b"\x03")

    # No reads of the stdout pipe are permitted until actual CLI termination.
    status = status_now()
    while status is None:
        ready()
        status = status_now()
    assert os.WIFSIGNALED(status) and os.WTERMSIG(status) == signal.SIGINT, status
    with os.fdopen(reader, "rb", closefd=False) as pipe:
        received.extend(pipe.read())
    while terminal_open:
        ready()
    sys.stdout.buffer.write(received)
finally:
    if pid is not None:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    sys.stderr.buffer.write(transcript)
    os.close(terminal)
    os.close(reader)
