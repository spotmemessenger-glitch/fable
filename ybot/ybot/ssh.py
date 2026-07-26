"""SSH hand: a persistent remote shell ybot drives command-by-command.

The long-lived process is `ssh -T user@host`, a NON-interactive remote bash
reading commands from stdin — no PS1 prompt noise, no input echo. After each
command we write a marker echoing a unique token + the remote exit code
(`echo __YBOT_DONE__<tok> $?`) and read until we see it. Remote shell state
(cwd, env) persists because it is one bash session.

Connection details come from the environment (never hard-coded):
  SSH_HOST   required   e.g. 13.234.x.x  or  ec2-...compute.amazonaws.com
  SSH_USER   default ubuntu   (AWS Ubuntu = ubuntu; Hostinger is often root)
  SSH_KEY    path to the private key (.pem)  -> ssh -i
  SSH_PORT   default 22
  SSH_PASSWORD  optional; used via sshpass if key auth isn't available
"""
from __future__ import annotations

import os
import queue
import shutil
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass


@dataclass(frozen=True)
class RemoteResult:
    output: str
    exit_code: int | None
    timed_out: bool = False

    def summary(self) -> str:
        if self.timed_out:
            head = "[timed out]"
        elif self.exit_code is None:
            head = "[no exit code / connection closed]"
        else:
            head = f"exit={self.exit_code}"
        body = self.output.strip()
        return f"{head}\n{body}" if body else head


class SSHShell:
    _MARKER = "__YBOT_DONE__"

    def __init__(
        self,
        host: str,
        user: str = "ubuntu",
        key: str | None = None,
        port: int = 22,
        password: str | None = None,
    ) -> None:
        self.host = host
        base = [
            "ssh", "-T",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "ServerAliveInterval=15",
            "-p", str(port),
        ]
        if password and shutil.which("sshpass"):
            argv = ["sshpass", "-e"] + base + [f"{user}@{host}"]
            env = dict(os.environ, SSHPASS=password)
        else:
            base += ["-o", "BatchMode=yes"]  # key-only: fail fast, never hang on a prompt
            if key:
                base += ["-i", key]
            argv = base + [f"{user}@{host}"]
            env = dict(os.environ)

        self.proc = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            env=env,
        )
        self._lines: "queue.Queue[str | None]" = queue.Queue()
        threading.Thread(target=self._reader, daemon=True).start()
        self._run_raw("", timeout=30.0)  # swallow login banner / MOTD

    def _reader(self) -> None:
        out = self.proc.stdout
        assert out is not None
        for line in out:
            self._lines.put(line)
        self._lines.put(None)

    def _run_raw(self, command: str, timeout: float) -> RemoteResult:
        if self.proc.poll() is not None:
            return RemoteResult("(ssh session has closed)", None)
        token = uuid.uuid4().hex[:8]
        marker = f"{self._MARKER}{token}"
        stdin = self.proc.stdin
        assert stdin is not None
        try:
            if command:
                stdin.write(command + "\n")
            stdin.write(f"echo {marker} $?\n")
            stdin.flush()
        except (BrokenPipeError, OSError):
            return RemoteResult("(ssh session closed while sending command)", None)

        collected: list[str] = []
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return RemoteResult("".join(collected).strip(), None, timed_out=True)
            try:
                raw = self._lines.get(timeout=remaining)
            except queue.Empty:
                return RemoteResult("".join(collected).strip(), None, timed_out=True)
            if raw is None:
                return RemoteResult("".join(collected).strip(), None)
            if marker in raw:
                tail = raw.split(marker, 1)[1].strip()
                try:
                    code = int(tail.split()[0]) if tail.split() else None
                except ValueError:
                    code = None
                return RemoteResult("".join(collected).strip(), code)
            collected.append(raw)

    def run(self, command: str, timeout: float = 300.0) -> RemoteResult:
        return self._run_raw(command, timeout)

    def close(self) -> None:
        try:
            if self.proc.stdin:
                self.proc.stdin.write("exit\n")
                self.proc.stdin.flush()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()

    @classmethod
    def from_env(cls) -> "SSHShell | None":
        host = os.environ.get("SSH_HOST", "").strip()
        if not host:
            return None
        return cls(
            host=host,
            user=os.environ.get("SSH_USER", "ubuntu").strip() or "ubuntu",
            key=os.environ.get("SSH_KEY", "").strip() or None,
            port=int(os.environ.get("SSH_PORT", "22") or "22"),
            password=os.environ.get("SSH_PASSWORD", "").strip() or None,
        )


SSH_RUN_TOOL = {
    "name": "ssh_run",
    "description": (
        "Run a single command on the REMOTE server over the persistent SSH session and "
        "get its combined stdout/stderr and exit code. Remote shell state (cwd, env) "
        "persists across calls. Use this for all server-side work; use run_command for "
        "LOCAL commands on the user's PC. Destructive commands pause for approval."
    ),
    "input_schema": {
        "type": "object",
        "properties": {"command": {"type": "string", "description": "The command to run on the server."}},
        "required": ["command"],
    },
}
