import fcntl
import os
import pty
import re
import select
import struct
import subprocess
import sys
import termios
import time

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
output = bytearray()


def until(pattern):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        match = re.search(pattern, output)
        if match:
            return match
        if select.select([master], [], [], 0.05)[0]:
            try:
                output.extend(os.read(master, 65536))
            except OSError:
                break
    raise AssertionError(f"Terminal never emitted {pattern!r}")


try:
    first = until(rb"a=p,U=1,i=(\d+),p=1,c=50,r=25,q=2")
    os.write(master, b"\x1b[4;900;1000t")
    until(rb"a=p,U=1,i=\d+,p=1,c=75,r=25,q=2")
    os.write(master, b"q")
    until(rb"a=d,d=I,i=" + first[1] + rb",q=2")
    child.wait(timeout=5)
    assert child.returncode == 0, f"Viewer exited {child.returncode}"
    print("Delayed pixel resolution changed fit without a keypress; quit deleted the image.")
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)
