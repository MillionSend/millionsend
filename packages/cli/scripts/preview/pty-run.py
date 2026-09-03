#!/usr/bin/env python3
"""pty-run.py <cols> <rows> [--enter-on TEXT]... -- cmd args...

Runs cmd under a pty of the given size (TERM=xterm-256color), writes the raw
transcript to stdout and exits with the child's code. Each --enter-on TEXT
sends Enter to the child the first time TEXT shows up in its output, which is
how a prompt that waits for a keypress gets answered with its default.
macOS `script` needs a tty on its own stdin; this does not.
"""
import fcntl
import os
import pty
import struct
import sys
import termios

args = sys.argv[1:]
cols, rows = int(args[0]), int(args[1])
enter_on = []
i = 2
while args[i] != "--":
    if args[i] != "--enter-on":
        raise SystemExit(__doc__)
    enter_on.append(args[i + 1].encode())
    i += 2
cmd = args[i + 1:]

pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    os.environ["TERM"] = "xterm-256color"
    os.execvp(cmd[0], cmd)

out = sys.stdout.buffer
tail = b""
while True:
    try:
        data = os.read(fd, 65536)
    except OSError:  # EIO once the slave side is closed
        break
    if not data:
        break
    out.write(data)
    out.flush()
    tail = (tail + data)[-8192:]
    for marker in [m for m in enter_on if m in tail]:
        enter_on.remove(marker)
        os.write(fd, b"\r")

_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
