"""PTY acceptance for the actual terminal/runtime connection; no external API calls."""
import fcntl
import glob
import json
import os
import pty
import select
import struct
import subprocess
import sys
import termios
import time

root, executable, entry = sys.argv[1:4]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 100, 0, 0))
command = [executable, '--no-env-file', entry, root] if entry != '--binary' else [executable]
child = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, cwd=os.path.join(root, 'workspace'), start_new_session=True)
os.close(slave)
output = bytearray()
# Optional VT screen verification; the behavioral acceptance test needs only stdlib.
try:
    import pyte
    screen = pyte.Screen(100, 32)
    stream = pyte.ByteStream(screen)
except ImportError:
    screen = stream = None

def events():
    files = glob.glob(os.path.join(root, 'workspace', '.tiness', 'tasks', '*.jsonl'))
    rows = []
    for path in files:
        with open(path, encoding='utf8') as handle:
            for line in handle:
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass  # An append can be in flight while the PTY reader polls.
    return rows

def pump():
    if select.select([master], [], [], 0.03)[0]:
        try:
            chunk = os.read(master, 65536)
            output.extend(chunk)
            if stream:
                stream.feed(chunk)
            del output[:-500000]
        except OSError:
            pass

def wait(predicate, label, seconds=8):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        pump()
        if predicate():
            return
        if child.poll() is not None:
            raise AssertionError(f'Process exited ({child.returncode}) while waiting for {label}')
    raise AssertionError(f'Timeout waiting for {label}')

try:
    wait(lambda: 'Enter 提交'.encode() in output, 'terminal ready')
    if entry != '--binary':
        os.write(master, b'LONG_A\r')
        wait(lambda: '需要你的授权'.encode() in output, 'shell approval')
        if screen:
            wait(lambda: '允许这一次' in '\n'.join(screen.display) and 'Enter确认' in '\n'.join(screen.display), 'fully rendered approval')
            visible = '\n'.join(screen.display)
            for label in ['需要你的授权', '允许这一次', '本请求内允许同类操作', '拒绝，不执行', 'sleep 30', 'Enter 提交']:
                assert label in visible, f'Missing visible control: {label}'
            print(visible)
        os.write(master, b'QUEUED_B\r')
        wait(lambda: len([e for e in events() if e['type'] == 'message_queued']) == 2, 'queued B')
        assert not any(e['type'] == 'tool_started' for e in events()), 'Normal Enter accidentally approved shell'
        os.write(master, b'\t\x1b[C\r')  # Explicit approval focus, once, confirm.
        wait(lambda: any(e['type'] == 'tool_started' for e in events()), 'shell started')
        os.write(master, b'\x1b')
        wait(lambda: len([e for e in events() if e['type'] == 'session_end']) == 2, 'cancel A then complete B')
        ended = [e for e in events() if e['type'] == 'session_end']
        assert [e['data']['status'] for e in ended] == ['cancelled', 'completed']
        assert ended[1]['data']['text'] == 'DONE_B'
        if screen:
            os.write(master, b'HISTORY\r')
            wait(lambda: len([e for e in events() if e['type'] == 'session_end']) == 3 and 'HISTORY_LINE_79' in '\n'.join(screen.display), 'long history rendered')
            os.write(master, b'\x1b[<64;20;10M' * 5)
            wait(lambda: '查看历史' in '\n'.join(screen.display) and 'HISTORY_LINE_79' not in '\n'.join(screen.display), 'mouse scroll in rendered screen')
            os.write(master, b'\x1b[F')
            wait(lambda: 'HISTORY_LINE_79' in '\n'.join(screen.display), 'End returns to latest')
    else:
        assert not any(e['type'] == 'model_request' for e in events())
    os.write(master, b'/quit\r')
    deadline = time.monotonic() + 5
    while child.poll() is None and time.monotonic() < deadline:
        pump()
    assert child.poll() == 0, f'Exit was not clean: {child.poll()}'
    assert any(e['type'] == 'task_end' for e in events())
    print('PTY acceptance passed')
finally:
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    os.close(master)
