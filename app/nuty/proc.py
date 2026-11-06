"""Running external programs (Audiveris, oemer, uv, msiexec) with output streamed into the log."""
import os
import subprocess
import sys
import threading

CREATE_NO_WINDOW = 0x08000000   # Windows: bez migającego okna konsoli


class Runner:
    def __init__(self):
        self._lock = threading.Lock()
        self._proc = None
        self.cancelled = False

    def cancel(self):
        self.cancelled = True
        with self._lock:
            p = self._proc
        if p and p.poll() is None:
            try:
                p.terminate()
            except OSError:
                pass

    def run(self, cmd, cwd=None, env_extra=None, on_line=None) -> tuple:
        env = dict(os.environ)
        env["PYTHONUNBUFFERED"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        if env_extra:
            env.update(env_extra)
        kwargs = {}
        if sys.platform == "win32":
            kwargs["creationflags"] = CREATE_NO_WINDOW
        p = subprocess.Popen([str(c) for c in cmd], cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **kwargs)
        with self._lock:
            self._proc = p
        out = []
        buf = b""
        while True:
            chunk = p.stdout.read1(4096) if hasattr(p.stdout, "read1") else p.stdout.read(4096)
            if not chunk:
                break
            buf += chunk.replace(b"\r", b"\n")
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                text = _decode(line).rstrip()
                if text:
                    out.append(text)
                    if len(out) > 4000:
                        del out[:2000]
                    if on_line:
                        on_line(text)
        if buf.strip():
            text = _decode(buf).rstrip()
            out.append(text)
            if on_line:
                on_line(text)
        code = p.wait()
        with self._lock:
            self._proc = None
        return code, "\n".join(out)


def _decode(b: bytes) -> str:
    try:
        return b.decode("utf-8")
    except UnicodeDecodeError:
        return b.decode("cp1250" if sys.platform == "win32" else "latin-1", "replace")
