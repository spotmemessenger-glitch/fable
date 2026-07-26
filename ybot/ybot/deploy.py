"""ybot — Server Engineer mode.

A senior DevOps/SRE brain that sets up a Linux server and deploys the app end to
end, autonomously, over SSH. It drives two shells: the REMOTE server (ssh_run)
and, when needed, your LOCAL PC (run_command, e.g. to upload files). Every command
passes the guard first: destructive or firewall/SSH-lockout commands pause for a
one-key approval; everything else runs.

You never use the command line yourself — fill in deploy-config.txt and launch
`Deploy-Server.bat`. Connection details are read from the environment:
  SSH_HOST / SSH_USER / SSH_KEY (or SSH_PASSWORD) / SSH_PORT
and the task from GOAL (or the first command-line argument).
"""
from __future__ import annotations

import os
import subprocess
import sys

from anthropic import Anthropic

from .config import SETTINGS
from .guard import gate_command
from .killswitch import KillSwitch
from .ssh import SSH_RUN_TOOL, SSHShell

SERVER_ENGINEER = (
    "You are ybot, a senior DevOps / Site Reliability Engineer with 15+ years "
    "provisioning and running production Linux servers. You are deploying the user's "
    "app end to end, autonomously, over SSH — the user does not touch the server. "
    "You are expert in: AWS (EC2, security groups, EBS, Elastic IP, Route 53), Ubuntu/"
    "Debian administration, nginx as a reverse proxy, systemd and PM2 process "
    "management, Node.js and Next.js deployment, Let's Encrypt/certbot TLS, the ufw "
    "firewall, SSH hardening, and DNS on registrars like Namecheap and GoDaddy.\n\n"

    "HOW YOU WORK:\n"
    "- ssh_run runs a command on the REMOTE server; run_command runs on the user's "
    "LOCAL PC (uploads, packaging). Say which machine each step is on.\n"
    "- ONE command per call. Read its exit code and output before the next step. "
    "exit=0 is success; anything else means diagnose and adapt, never plough ahead.\n"
    "- Be idempotent: check before you change (does the package/user/file exist?). "
    "Re-running your steps must be safe.\n"
    "- Verify everything: after installing a service run `systemctl status`/`--version`; "
    "after an nginx change run `nginx -t` BEFORE reload; after deploy `curl -I "
    "http://localhost:PORT` then the public URL.\n\n"

    "NEVER LOCK YOURSELF OR THE USER OUT (cardinal rule):\n"
    "- Before enabling ufw, ALWAYS `ufw allow OpenSSH` (port 22) first, then 80/443, "
    "then enable. Confirm the SSH rule is present before `ufw enable`.\n"
    "- Never change the SSH port/sshd_config/firewall in a way that could drop your "
    "session without first proving the new path works. Back up configs before editing "
    "(cp file file.bak-ybot).\n\n"

    "DEPLOYING THE NEXT.JS APP (ysnap): get the code onto the server (git clone the "
    "repo if a URL is given, else the user will provide it), install Node LTS "
    "(NodeSource or nvm), `npm ci`, `npm run build`, run with PM2 "
    "(`pm2 start npm --name ysnap -- start`) or a systemd unit, and put nginx in front "
    "as a reverse proxy to the Next port (3000) on 80/443. Add certbot for HTTPS once "
    "DNS resolves to the server. Enable pm2 startup/systemd so it survives reboots. "
    "Prefer a non-root deploy user.\n\n"

    "SAFETY (hard limits):\n"
    "- You CANNOT make purchases or buy servers/domains — tell the user to do it.\n"
    "- You CANNOT type the user's passwords or pass 2FA. If a step needs a registrar/"
    "cloud-console login, stop and hand the user exact instructions.\n"
    "- Destructive or firewall/SSH commands pause for the user's approval — explain "
    "what and why first. Never echo private keys or .env contents to the log.\n\n"

    "Narrate briefly in plain language: what you're doing, on which machine, what you "
    "saw. When the app is live, give the URL and a short summary of what you set up "
    "(services, ports, firewall, TLS, restart-on-boot). If DNS isn't pointed yet, tell "
    "the user the exact A-record to add at their registrar."
)

MAX_ROUNDS = int(os.environ.get("YBOT_MAX_ROUNDS", "80"))


def _console_approver(prompt: str) -> bool:
    ans = input(f"\n[APPROVAL NEEDED] {prompt}\n  Allow? [y/N] ").strip().lower()
    return ans in ("y", "yes")


def _local_run(command: str, timeout: float = 300.0) -> str:
    try:
        p = subprocess.run(
            command, shell=True, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return "[timed out]"
    out = (p.stdout or "") + (p.stderr or "")
    return f"exit={p.returncode}\n{out.strip()}"


LOCAL_RUN_TOOL = {
    "name": "run_command",
    "description": (
        "Run a single command on the user's LOCAL PC (Windows) and get its output and "
        "exit code. Use for uploading files to the server (scp) or packaging. For work "
        "ON the server use ssh_run instead."
    ),
    "input_schema": {
        "type": "object",
        "properties": {"command": {"type": "string"}},
        "required": ["command"],
    },
}


class DeployBrain:
    def __init__(self, ssh: SSHShell, independent: bool = True) -> None:
        SETTINGS.validate()
        self.client = Anthropic(api_key=SETTINGS.api_key)
        self.ssh = ssh
        self.independent = independent
        self.kill = KillSwitch(SETTINGS.kill_hotkey)
        self.kill.arm()
        self.messages: list[dict] = []

    def run(self, goal: str) -> str:
        self.messages.append({"role": "user", "content": goal})
        for _ in range(MAX_ROUNDS):
            self.kill.check()
            resp = self.client.messages.create(
                model=SETTINGS.model,
                max_tokens=SETTINGS.max_tokens,
                system=SERVER_ENGINEER,
                tools=[SSH_RUN_TOOL, LOCAL_RUN_TOOL],
                messages=self.messages,
                timeout=180,
            )
            self.messages.append({"role": "assistant", "content": [b.model_dump() for b in resp.content]})
            for b in resp.content:
                if b.type == "text" and b.text.strip():
                    print(f"\n[ybot] {b.text.strip()}")

            tool_uses = [b for b in resp.content if b.type == "tool_use"]
            if resp.stop_reason != "tool_use" or not tool_uses:
                return " ".join(b.text for b in resp.content if b.type == "text").strip() or "(done)"

            results = [self._handle(tu) for tu in tool_uses]
            self.messages.append({"role": "user", "content": results})
        return "(stopped: reached max rounds)"

    def _handle(self, tu) -> dict:
        self.kill.check()
        args = tu.input or {}
        command = str(args.get("command", ""))
        remote = tu.name == "ssh_run"
        decision = gate_command(command, self.independent, remote=remote)
        if decision.needs_approval and not _console_approver(
            f"{'REMOTE' if remote else 'LOCAL'}: {command}\n  {decision.reason}"
        ):
            return _result(tu.id, "User declined this command.")
        if remote:
            print(f"  $ (server) {command}")
            return _result(tu.id, self.ssh.run(command, 600).summary())
        print(f"  $ (local) {command}")
        return _result(tu.id, _local_run(command))

    def close(self) -> None:
        self.ssh.close()


def _result(tool_use_id: str, text: str) -> dict:
    return {"type": "tool_result", "tool_use_id": tool_use_id, "content": [{"type": "text", "text": text}]}


def main() -> None:
    ssh = SSHShell.from_env()
    if ssh is None:
        print("No SSH_HOST set. Fill in deploy-config.txt (server IP, user, key) and relaunch.")
        return
    probe = ssh.run("whoami && hostname && (lsb_release -ds 2>/dev/null || uname -a)", timeout=30)
    if probe.exit_code != 0:
        print(f"Could not reach the server over SSH:\n{probe.summary()}")
        print("Check the IP / user / key, and that the server's firewall allows port 22.")
        ssh.close()
        return
    print("=" * 60)
    print(f" ybot Server Engineer — connected to {ssh.host}")
    print(f" {probe.output}")
    print(f" Kill switch: {SETTINGS.kill_hotkey}. Destructive steps ask first.")
    print("=" * 60)

    brain = DeployBrain(ssh, independent=True)
    try:
        goal = " ".join(sys.argv[1:]).strip() or os.environ.get("GOAL", "").strip()
        if not goal:
            goal = input("\nWhat should I set up / deploy?\n> ").strip()
        if not goal:
            print("No goal given. Exiting.")
            return
        print(f"\n=== RESULT ===\n{brain.run(goal)}")
    except KeyboardInterrupt:
        print("\n[stopped by kill switch]")
    finally:
        brain.close()


if __name__ == "__main__":
    main()
