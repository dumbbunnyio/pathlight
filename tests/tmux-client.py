import fcntl
import os
import pty
import struct
import subprocess
import sys
import termios

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
child = subprocess.Popen(["tmux", "-S", sys.argv[1], "attach-session", "-t", "viewer-test"],
                         stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
try:
    while True:
        try:
            if not os.read(master, 65536):
                break
        except OSError:
            break
    child.wait(timeout=5)
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)
