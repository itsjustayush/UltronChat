#!/usr/bin/env python3
"""
UltronChat Developer CLI & SDK (Python)
Cross-platform peer-to-peer streaming and file transfer.
Automatically receives and saves files to the local './ultron' directory.

Usage:
  python ultron.py create [--key secret] [--server https://ultronchat.vercel.app]
  python ultron.py join <room_code> [--key secret] [--server https://ultronchat.vercel.app]
  python ultron.py (interactive prompt)
"""

import sys
import os

# Ensure safe UTF-8 output on Windows consoles
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
if hasattr(sys.stderr, "reconfigure"):
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

import time
import json
import base64
import hashlib
import argparse
import threading
import subprocess
import secrets
import re
import socket
import http.server
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

CONFIG_FILE_NAME = "ultron.json"
DEFAULT_SERVER = os.environ.get("ULTRON_SERVER_URL", "https://ultronchat.vercel.app")
DEFAULT_SAVE_DIR = os.environ.get("ULTRON_SAVE_DIR", "./ultron")
CHUNK_SIZE_BYTES = 24 * 1024  # 24 KB chunk size for reliable JSON framing


def ensure_gitignore(config_name: str = CONFIG_FILE_NAME, save_dir: str = DEFAULT_SAVE_DIR) -> bool:
    """Checks if current directory or ancestor is a Git repo. If so, ensures ultron.json and save_dir are in .gitignore."""
    try:
        is_git = False
        git_root = None

        curr = os.getcwd()
        while curr:
            if os.path.isdir(os.path.join(curr, ".git")):
                is_git = True
                git_root = curr
                break
            parent = os.path.dirname(curr)
            if parent == curr:
                break
            curr = parent

        if not is_git:
            try:
                out = subprocess.check_output(
                    ["git", "rev-parse", "--show-toplevel"],
                    stderr=subprocess.DEVNULL,
                    text=True,
                ).strip()
                if out:
                    is_git = True
                    git_root = out
            except Exception:
                return False

        if not is_git or not git_root:
            return False

        gitignore_path = os.path.join(git_root, ".gitignore")
        content = ""
        if os.path.isfile(gitignore_path):
            with open(gitignore_path, "r", encoding="utf-8") as f:
                content = f.read()

        rel_save = os.path.relpath(os.path.abspath(save_dir), git_root).replace("\\", "/")
        save_pattern = rel_save if rel_save.endswith("/") else f"{rel_save}/"

        to_add = []
        if config_name not in content:
            to_add.append(config_name)
        if save_pattern not in content and "ultron/" not in content:
            to_add.append(save_pattern)

        if to_add:
            prefix = "\n" if (content and not content.endswith("\n")) else ""
            addition = f"{prefix}\n# UltronChat transient P2P room config & downloaded files\n" + "\n".join(to_add) + "\n"
            with open(gitignore_path, "a", encoding="utf-8") as f:
                f.write(addition)
            print(f"[Ultron] Protected: Added {', '.join(to_add)} to .gitignore")
            return True
        return False
    except Exception:
        return False


def find_ultron_config(custom_path: str = None) -> dict | None:
    """Locate existing ultron.json in current directory or parent directories."""
    if custom_path:
        resolved = os.path.abspath(custom_path)
        if os.path.isfile(resolved):
            try:
                with open(resolved, "r", encoding="utf-8") as f:
                    return {"path": resolved, "config": json.load(f)}
            except Exception as e:
                print(f"[Ultron] Warning: Could not parse {resolved}: {e}")
                return None
        return None

    curr = os.getcwd()
    while curr:
        candidate = os.path.join(curr, CONFIG_FILE_NAME)
        if os.path.isfile(candidate):
            try:
                with open(candidate, "r", encoding="utf-8") as f:
                    return {"path": candidate, "config": json.load(f)}
            except Exception as e:
                print(f"[Ultron] Warning: Could not parse {candidate}: {e}")
        parent = os.path.dirname(curr)
        if parent == curr:
            break
        curr = parent
    return None


def save_ultron_config(config: dict, file_path: str = CONFIG_FILE_NAME) -> dict:
    """Save configuration to ultron.json and ensure .gitignore protection."""
    resolved = os.path.abspath(file_path)
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    data = {
        "$schema": "https://ultronchat.vercel.app/schemas/ultron.json",
        "roomCode": str(config.get("roomCode") or config.get("room_code", "")).strip().upper(),
        "role": "host" if config.get("isHost") or config.get("is_host") else "peer",
        "isHost": bool(config.get("isHost") or config.get("is_host")),
        "serverUrl": config.get("serverUrl") or config.get("server_url") or DEFAULT_SERVER,
        "saveDir": config.get("saveDir") or config.get("save_dir") or DEFAULT_SAVE_DIR,
        "authKey": (config.get("authKey") or config.get("auth_key") or "").strip() or None,
        "peerName": config.get("peerName") or config.get("peer_name") or None,
        "autoDownload": config.get("autoDownload", True),
        "createdAt": config.get("createdAt") or now_iso,
        "lastConnectedAt": now_iso,
    }
    with open(resolved, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    ensure_gitignore(CONFIG_FILE_NAME, data["saveDir"])
    return {"path": resolved, "config": data}


def remove_ultron_config(file_path: str = CONFIG_FILE_NAME) -> bool:
    """Remove local ultron.json config."""
    resolved = os.path.abspath(file_path)
    if os.path.isfile(resolved):
        os.remove(resolved)
        return True
    return False


def generate_room_otp() -> str:
    """
    Automatically generates a 6-character room OTP code (e.g. C4GQA5).
    Hosts NEVER choose custom codes; codes are cryptographically generated.
    """
    chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(chars) for _ in range(6))


def format_room_otp_display(otp: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "", str(otp or "")).upper()


def parse_room_code(input_str: str) -> str:
    """
    Normalizes input which can be:
    - A 6-char alphanumeric room code (e.g. "C4GQA5")
    - A full share link (e.g. "https://ultronchat.vercel.app?room=C4GQA5")
    """
    if not input_str:
        return ""
    s = str(input_str).strip()
    match = re.search(r"[?&]room=([A-Za-z0-9_-]+)", s, re.IGNORECASE)
    if match:
        return re.sub(r"[^A-Za-z0-9]", "", match.group(1)).upper()
    return re.sub(r"[^A-Za-z0-9]", "", s).upper()


class UltronClient:
    def __init__(
        self,
        room_code: str,
        is_host: bool = False,
        auth_key: str = None,
        peer_name: str = None,
        server_url: str = DEFAULT_SERVER,
        save_dir: str = DEFAULT_SAVE_DIR,
    ):
        self.room_code = room_code.strip().upper()
        self.is_host = is_host
        self.auth_key = auth_key.strip() if auth_key else None
        self.server_url = server_url.rstrip("/")
        self.save_dir = os.path.abspath(save_dir)
        self.peer_id = f"dev-py-{int(time.time()) % 100000}-{os.urandom(2).hex()}"
        self.peer_name = peer_name or f"PyDev-{self.peer_id[-4:]}"

        self.running = False
        self.connected = False
        self.peers = []
        self.last_event_id = 0
        self.incoming_transfers = {}  # token -> { meta, chunks, received_bytes, total_bytes }
        self.lock = threading.Lock()

        # Callbacks
        self.on_file_received = None  # callback(filename, filepath, size_bytes)
        self.on_chat_message = None  # callback(sender, text)
        self.on_peer_joined = None  # callback(peer_id, peer_name)
        self.on_peer_left = None  # callback(peer_id)

        # Ensure save directory exists
        os.makedirs(self.save_dir, exist_ok=True)

    def _call_registry(self, action: str, payload: dict) -> dict:
        url = f"{self.server_url}/api/signal/registry"
        data = json.dumps({"action": action, **payload}).encode("utf-8")
        req = Request(
            url,
            data=data,
            headers={
                "Content-Type": "application/json",
                "User-Agent": "Ultron-Python-Client/1.0",
            },
        )
        try:
            with urlopen(req, timeout=10) as resp:
                res_body = resp.read().decode("utf-8")
                return json.loads(res_body)
        except HTTPError as e:
            err_body = e.read().decode("utf-8") if e.fp else ""
            try:
                parsed = json.loads(err_body)
                msg = parsed.get("error", f"HTTP {e.code}")
            except Exception:
                msg = err_body or f"HTTP {e.code}"
            raise RuntimeError(f"Server error ({e.code}): {msg}")
        except URLError as e:
            raise RuntimeError(f"Connection failed to {url}: {e.reason}")

    def connect(self) -> dict:
        """Create or join the room."""
        action = "create" if self.is_host else "join"
        payload = {
            "roomCode": self.room_code,
            "peerId": self.peer_id,
            "peerName": self.peer_name,
        }
        if self.auth_key:
            payload["authKey"] = self.auth_key

        res = self._call_registry(action, payload)
        self.connected = True
        self.running = True

        with self.lock:
            self.peers = [
                p["peer_id"] for p in res.get("peers", []) if p["peer_id"] != self.peer_id
            ]

        # Start heartbeat and poll daemon threads
        self.heartbeat_thread = threading.Thread(target=self._heartbeat_loop, daemon=True)
        self.heartbeat_thread.start()

        self.poll_thread = threading.Thread(target=self._poll_loop, daemon=True)
        self.poll_thread.start()

        return res

    def _heartbeat_loop(self):
        while self.running:
            time.sleep(15)
            if not self.running:
                break
            try:
                self._call_registry(
                    "heartbeat",
                    {"roomCode": self.room_code, "peerId": self.peer_id},
                )
            except Exception:
                pass

    def _poll_loop(self):
        while self.running:
            try:
                res = self._call_registry(
                    "poll",
                    {
                        "roomCode": self.room_code,
                        "peerId": self.peer_id,
                        "sinceId": self.last_event_id,
                    },
                )
                messages = res.get("messages", [])
                for msg in messages:
                    event_id = msg.get("id", 0)
                    if event_id > self.last_event_id:
                        self.last_event_id = event_id
                    self._handle_incoming_event(msg)
            except Exception:
                pass
            time.sleep(0.5)

    def _handle_incoming_event(self, event: dict):
        event_type = event.get("type")
        sender = event.get("peerId")
        data = event.get("data", {})

        if event_type == "room_state":
            sub_event = data.get("event")
            if sub_event == "peer_joined":
                new_peer = data.get("peerId")
                name = data.get("peerName", new_peer)
                with self.lock:
                    if new_peer and new_peer not in self.peers:
                        self.peers.append(new_peer)
                if self.on_peer_joined:
                    self.on_peer_joined(new_peer, name)
            elif sub_event == "peer_left":
                left_peer = data.get("peerId")
                with self.lock:
                    if left_peer in self.peers:
                        self.peers.remove(left_peer)
                if self.on_peer_left:
                    self.on_peer_left(left_peer)

        elif event_type == "chat":
            text = data.get("text", "")
            if self.on_chat_message:
                self.on_chat_message(sender, text)

        elif event_type == "file_start":
            file_info = data.get("file", {})
            token = file_info.get("transferToken") or file_info.get("id")
            total_chunks = int(file_info.get("totalChunks", 0))
            raw_file_name = file_info.get("name", "downloaded_file")
            file_name = os.path.basename(raw_file_name)
            file_size = int(file_info.get("size", 0))
            expected_sha256 = file_info.get("sha256", "")

            save_path = os.path.join(self.save_dir, file_name)
            base, ext = os.path.splitext(file_name)
            counter = 1
            while os.path.exists(save_path):
                save_path = os.path.join(self.save_dir, f"{base}_{counter}{ext}")
                counter += 1

            part_path = f"{save_path}.part-{int(time.time() * 1000)}"
            part_file = open(part_path, "wb")
            hasher = hashlib.sha256()

            with self.lock:
                self.incoming_transfers[token] = {
                    "name": file_name,
                    "save_path": save_path,
                    "part_path": part_path,
                    "part_file": part_file,
                    "hasher": hasher,
                    "size": file_size,
                    "totalChunks": total_chunks,
                    "expectedSha256": expected_sha256,
                    "receivedChunks": 0,
                    "receivedBytes": 0,
                    "sender": sender,
                    "startedAt": time.time(),
                }
            print(f"\n[Ultron] 📥 Incoming file '{file_name}' ({self._format_bytes(file_size)}) in {total_chunks} chunks from {sender}...")

        elif event_type == "file_chunk":
            token = data.get("transferToken") or data.get("fileId")
            index = data.get("index")
            payload_b64 = data.get("payload")

            if not token or index is None or not payload_b64:
                return

            with self.lock:
                transfer = self.incoming_transfers.get(token)
                if not transfer or index >= transfer["totalChunks"]:
                    return
                raw_chunk = base64.b64decode(payload_b64)
                transfer["part_file"].write(raw_chunk)
                transfer["hasher"].update(raw_chunk)
                transfer["receivedChunks"] += 1
                transfer["receivedBytes"] += len(raw_chunk)

                # Print progress
                pct = int((transfer["receivedChunks"] / transfer["totalChunks"]) * 100) if transfer["totalChunks"] else 100
                sys.stdout.write(f"\r[Ultron] 📥 Receiving '{transfer['name']}': {pct}% ({self._format_bytes(transfer['receivedBytes'])} / {self._format_bytes(transfer['size'])})")
                sys.stdout.flush()

        elif event_type == "file_end":
            token = data.get("transferToken") or data.get("fileId")
            with self.lock:
                transfer = self.incoming_transfers.pop(token, None)

            if not transfer:
                return

            transfer["part_file"].close()

            # Verify complete
            if transfer["receivedChunks"] != transfer["totalChunks"]:
                try:
                    os.remove(transfer["part_path"])
                except Exception:
                    pass
                print(f"\n[Ultron] ❌ File transfer for '{transfer['name']}' ended incomplete.")
                return

            actual_sha256 = transfer["hasher"].hexdigest()
            expected_sha256 = transfer.get("expectedSha256", "")

            if expected_sha256 and actual_sha256.lower() != expected_sha256.lower():
                try:
                    os.remove(transfer["part_path"])
                except Exception:
                    pass
                print(f"\n[Ultron] ❌ Checksum mismatch for '{transfer['name']}'! File discarded.")
                return

            # Atomic move
            try:
                os.replace(transfer["part_path"], transfer["save_path"])
            except Exception as e:
                print(f"\n[Ultron] ❌ Failed to move .part file: {e}")
                return

            print(f"\n[Ultron] ✅ File saved successfully!")
            print(f"       📂 Destination: {transfer['save_path']}")
            print(f"       📦 Size: {self._format_bytes(transfer['receivedBytes'])}")
            print(f"       🔒 SHA-256: {actual_sha256}\n")

            if self.on_file_received:
                self.on_file_received(transfer["name"], transfer["save_path"], transfer["receivedBytes"])

    def send_file(self, file_path: str, target_peer_id: str = None) -> bool:
        """Stream a file directly to peer(s) via ephemeral P2P HTTP transfer."""
        if not os.path.isfile(file_path):
            print(f"[Ultron] Error: File '{file_path}' does not exist.")
            return False

        file_size = os.path.getsize(file_path)
        file_name = os.path.basename(file_path)
        transfer_token = f"TOK{os.urandom(4).hex().upper()}"

        print(f"[Ultron] 📤 Preparing direct P2P stream for '{file_name}' ({self._format_bytes(file_size)})...")

        # Read and compute SHA-256 via streaming
        hasher = hashlib.sha256()
        with open(file_path, "rb") as f:
            while chunk := f.read(64 * 1024):
                hasher.update(chunk)
        file_sha256 = hasher.hexdigest()

        # Ephemeral direct HTTP transfer server
        class DirectFileHandler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == f"/download/{transfer_token}":
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Content-Length", str(file_size))
                    self.send_header("Content-Disposition", f'attachment; filename="{file_name}"')
                    self.send_header("X-SHA256", file_sha256)
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    sent_bytes = 0
                    with open(file_path, "rb") as f:
                        while chunk := f.read(64 * 1024):
                            self.wfile.write(chunk)
                            sent_bytes += len(chunk)
                            pct = int((sent_bytes / file_size) * 100) if file_size else 100
                            sys.stdout.write(f"\r[Ultron] 📤 Sending: {pct}%")
                            sys.stdout.flush()
                else:
                    self.send_response(404)
                    self.end_headers()

            def log_message(self, format, *args):
                pass

        httpd = http.server.HTTPServer(("0.0.0.0", 0), DirectFileHandler)
        port = httpd.server_port
        server_thread = threading.Thread(target=httpd.handle_request, daemon=True)
        server_thread.start()

        local_ip = "127.0.0.1"
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            local_ip = s.getsockname()[0]
            s.close()
        except Exception:
            pass

        direct_url = f"http://{local_ip}:{port}/download/{transfer_token}"

        # Send direct P2P offer via signaling
        self.send_chat(
            f"[Direct P2P File] {file_name} ({self._format_bytes(file_size)})\nSHA-256: {file_sha256}\nDirect Stream: {direct_url}",
            target_peer_id=target_peer_id,
        )

        print(f"\n[Ultron] 📡 Direct stream listening on {direct_url}")
        print(f"[Ultron] ✅ File offer broadcast to room peers! (SHA-256: {file_sha256[:12]}...)")
        return True

    def send_chat(self, text: str, target_peer_id: str = None):
        """Send a chat message to peers."""
        payload = {
            "type": "chat",
            "roomCode": self.room_code,
            "peerId": self.peer_id,
            "targetPeerId": target_peer_id,
            "data": {
                "text": text,
                "senderName": self.peer_name,
                "timestamp": int(time.time() * 1000),
            },
        }
        self._call_registry("signal", payload)

    def leave(self):
        """Cleanly leave the room."""
        if not self.running:
            return
        self.running = False
        try:
            self._call_registry(
                "leave",
                {"roomCode": self.room_code, "peerId": self.peer_id},
            )
        except Exception:
            pass

    @staticmethod
    def _format_bytes(bytes_count: int) -> str:
        for unit in ["B", "KB", "MB", "GB"]:
            if bytes_count < 1024.0:
                return f"{bytes_count:.1f} {unit}"
            bytes_count /= 1024.0
        return f"{bytes_count:.1f} TB"


def run_interactive_repl(client: UltronClient):
    print("\n" + "=" * 60)
    print(" ⚡ ULTRON DEVELOPER P2P FILE STREAM ACTIVE")
    print(f" Room Code  : {client.room_code}")
    print(f" Role       : {'HOST' if client.is_host else 'GUEST'}")
    print(f" Peer ID    : {client.peer_id} ({client.peer_name})")
    print(f" Save Dir   : {client.save_dir}")
    print("=" * 60)
    print("Commands:")
    print("  send <path>   - Send a file to connected peer(s)")
    print("  chat <msg>    - Send a text message")
    print("  peers         - List connected peers")
    print("  clear         - Clear terminal screen")
    print("  exit / quit   - Leave room and disconnect")
    print("-" * 60 + "\n")

    def on_chat(sender, text):
        print(f"\n💬 [{sender}]: {text}\nultron> ", end="", flush=True)

    def on_joined(peer_id, peer_name):
        print(f"\n🔔 Peer joined: {peer_name} ({peer_id})\nultron> ", end="", flush=True)

    def on_left(peer_id):
        print(f"\n🚪 Peer left: {peer_id}\nultron> ", end="", flush=True)

    client.on_chat_message = on_chat
    client.on_peer_joined = on_joined
    client.on_peer_left = on_left

    while client.running:
        try:
            cmd = input("ultron> ").strip()
            if not cmd:
                continue

            parts = cmd.split(maxsplit=1)
            action = parts[0].lower()
            arg = parts[1] if len(parts) > 1 else ""

            if action in ["exit", "quit", "q"]:
                print("[Ultron] Disconnecting...")
                client.leave()
                break
            elif action == "send":
                if not arg:
                    print("Usage: send <file_path>")
                else:
                    path = arg.strip('\'"')
                    client.send_file(path)
            elif action == "chat":
                if not arg:
                    print("Usage: chat <message>")
                else:
                    client.send_chat(arg)
            elif action == "peers":
                with client.lock:
                    if client.peers:
                        print(f"[Ultron] Active peers: {', '.join(client.peers)}")
                    else:
                        print("[Ultron] No other peers currently in room. Waiting for friend to join...")
            elif action == "clear":
                os.system("cls" if os.name == "nt" else "clear")
            else:
                print(f"Unknown command: '{action}'. Available: send, chat, peers, clear, exit")
        except (KeyboardInterrupt, EOFError):
            print("\n[Ultron] Leaving room...")
            client.leave()
            break


def main():
    parser = argparse.ArgumentParser(description="Ultron Developer P2P File Transfer CLI")
    subparsers = parser.add_subparsers(dest="command")

    # 'create' command (auto-generates room code)
    create_parser = subparsers.add_parser("create", help="Create a new transfer room (auto-generates room code)")
    create_parser.add_argument("--key", default=None, help="Optional auth key / password")
    create_parser.add_argument("--server", default=DEFAULT_SERVER, help="Server URL")
    create_parser.add_argument("--dir", default=DEFAULT_SAVE_DIR, help="Directory to save received files")
    create_parser.add_argument("--name", default=None, help="Your developer display name")
    create_parser.add_argument("--no-save", action="store_true", help="Do not persist to ultron.json")

    # 'join' command
    join_parser = subparsers.add_parser("join", help="Join an existing room with code or share link")
    join_parser.add_argument("room_code", help="Room code or share URL (e.g. C4GQA5 or https://ultronchat.vercel.app?room=C4GQA5)")
    join_parser.add_argument("--key", default=None, help="Optional auth key / password")
    join_parser.add_argument("--server", default=DEFAULT_SERVER, help="Server URL")
    join_parser.add_argument("--dir", default=DEFAULT_SAVE_DIR, help="Directory to save received files")
    join_parser.add_argument("--name", default=None, help="Your developer display name")
    join_parser.add_argument("--no-save", action="store_true", help="Do not persist to ultron.json")

    # 'send' quick command
    send_parser = subparsers.add_parser("send", help="Quickly send a file into a room")
    send_parser.add_argument("file_path", help="Path to file to send")
    send_parser.add_argument("--room", default=None, help="Room code or share URL (e.g. C4GQA5, defaults to ultron.json)")
    send_parser.add_argument("--key", default=None, help="Optional auth key / password")
    send_parser.add_argument("--server", default=DEFAULT_SERVER, help="Server URL")

    # 'status' command
    subparsers.add_parser("status", help="Show active ultron.json configuration and status")

    # 'reset' command
    subparsers.add_parser("reset", help="Remove local ultron.json configuration")

    args = parser.parse_args()

    # Command: reset
    if args.command in ("reset", "clean"):
        if remove_ultron_config():
            print("[Ultron] Successfully removed local ultron.json.")
        else:
            print("[Ultron] No ultron.json found in current directory.")
        sys.exit(0)

    # Command: status
    if args.command in ("status", "config"):
        existing = find_ultron_config()
        if not existing:
            print("[Ultron] No ultron.json found in current directory or ancestors.")
            print("Run 'python ultron.py' or 'python ultron.py create' to configure a room.")
            sys.exit(1)
        print("\n" + "=" * 55)
        print(f" ⚡ UltronChat Config ({existing['path']})")
        print("=" * 55)
        print(json.dumps(existing["config"], indent=2))
        server = existing["config"].get("serverUrl", DEFAULT_SERVER)
        code = existing["config"].get("roomCode", "")
        try:
            req = Request(
                f"{server}/api/signal/registry",
                data=json.dumps({"action": "lookup", "roomCode": code}).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                status_str = "🟢 ACTIVE" if data.get("active") else "⚪ IDLE / EXPIRED"
                peer_cnt = len(data.get("peers", []))
                print(f"\n[Ultron] Room Status: {status_str} ({peer_cnt} peers online)")
        except HTTPError as he:
            if he.code == 404:
                print(f"\n[Ultron] Room Status: ⚪ IDLE / NOT CREATED YET (0 peers online)")
            else:
                print(f"\n[Ultron] Server returned HTTP {he.code}")
        except Exception as e:
            print(f"\n[Ultron] Server check failed: {e}")
        sys.exit(0)

    # Command: send
    if args.command == "send":
        existing = find_ultron_config()
        room_code = parse_room_code(args.room or (existing and existing["config"].get("roomCode")))
        if not room_code:
            print("Error: No active room. Pass --room <code_or_url> or configure ultron.json first.")
            sys.exit(1)
        if not os.path.isfile(args.file_path):
            print(f"Error: File not found: {args.file_path}")
            sys.exit(1)

        server_url = args.server or (existing and existing["config"].get("serverUrl")) or DEFAULT_SERVER
        auth_key = args.key or (existing and existing["config"].get("authKey")) or None

        client = UltronClient(
            room_code=room_code,
            is_host=False,
            auth_key=auth_key,
            server_url=server_url,
        )
        try:
            print(f"[Ultron] Connecting to room {room_code}...")
            client.connect()
            time.sleep(1.5)
            client.send_file(args.file_path)
            time.sleep(2)
            client.leave()
            print("[Ultron] File sent successfully.")
            sys.exit(0)
        except Exception as e:
            print(f"\n[Ultron] Send Error: {e}")
            sys.exit(1)

    # Command: create (auto-generates room code)
    if args.command == "create":
        room_code = generate_room_otp()
        print("=" * 55)
        print(" ⚡ UltronChat Room Created")
        print("=" * 55)
        print(f"  • Room Code : {room_code}")
        print(f"  • Share Link: https://ultronchat.vercel.app?room={room_code}")
        print(f"  • Role      : HOST (Room Host)")
        print(f"  • Save Dir  : {args.dir} (incoming files auto-saved here)")
        print("=" * 55)
        print(f"Share this room code or link with your friend to connect!\n")

        if not getattr(args, "no_save", False):
            save_ultron_config({
                "roomCode": room_code,
                "isHost": True,
                "authKey": args.key,
                "peerName": args.name,
                "serverUrl": args.server,
                "saveDir": args.dir,
            })
            print(f"[Ultron] Saved configuration to ultron.json.")

        client = UltronClient(
            room_code=room_code,
            is_host=True,
            auth_key=args.key,
            peer_name=args.name,
            server_url=args.server,
            save_dir=args.dir,
        )
        try:
            client.connect()
            run_interactive_repl(client)
        except Exception as e:
            print(f"\n[Ultron] Error: {e}")
            sys.exit(1)
        return

    # Command: join
    if args.command == "join":
        clean_code = parse_room_code(args.room_code)
        if not clean_code:
            print("Error: Valid room code or share link is required.")
            sys.exit(1)
        if not getattr(args, "no_save", False):
            save_ultron_config({
                "roomCode": clean_code,
                "isHost": False,
                "authKey": args.key,
                "peerName": args.name,
                "serverUrl": args.server,
                "saveDir": args.dir,
            })
            print(f"[Ultron] Saved configuration to ultron.json.")

        client = UltronClient(
            room_code=clean_code,
            is_host=False,
            auth_key=args.key,
            peer_name=args.name,
            server_url=args.server,
            save_dir=args.dir,
        )
        try:
            client.connect()
            run_interactive_repl(client)
        except Exception as e:
            print(f"\n[Ultron] Error: {e}")
            sys.exit(1)
        return

    # Default: Interactive mode. First, look for ultron.json!
    existing = find_ultron_config()
    if existing:
        cfg = existing["config"]
        print("=" * 55)
        print(" ⚡ UltronChat Developer CLI (Python)")
        print("=" * 55)
        print(f"[Ultron] Found config: {existing['path']}")
        print(f"  • Room Code : {cfg.get('roomCode')}")
        print(f"  • Role      : {cfg.get('role', 'peer').upper()}")
        print(f"  • Server    : {cfg.get('serverUrl', DEFAULT_SERVER)}")
        print(f"  • Save Dir  : {cfg.get('saveDir', DEFAULT_SAVE_DIR)} (files auto-saved here)")
        print(f"  • Dev Name  : {cfg.get('peerName') or 'Default'}")

        ensure_gitignore(CONFIG_FILE_NAME, cfg.get("saveDir", DEFAULT_SAVE_DIR))

        try:
            ans = input("\nConnect to this room now? [Y/n] (or type 'new' to reconfigure): ").strip().lower()
        except (KeyboardInterrupt, EOFError):
            print("\nExiting.")
            sys.exit(0)

        if ans in ("n", "no"):
            print("[Ultron] Session cancelled.")
            sys.exit(0)
        elif ans != "new":
            client = UltronClient(
                room_code=cfg.get("roomCode"),
                is_host=bool(cfg.get("isHost")),
                auth_key=cfg.get("authKey"),
                peer_name=cfg.get("peerName"),
                server_url=cfg.get("serverUrl", DEFAULT_SERVER),
                save_dir=cfg.get("saveDir", DEFAULT_SAVE_DIR),
            )
            try:
                client.connect()
                run_interactive_repl(client)
            except Exception as e:
                print(f"\n[Ultron] Connection Error: {e}")
                sys.exit(1)
            return

    # No ultron.json found (or user typed 'new'): Run Setup Wizard
    print("=" * 55)
    print(" ⚡ UltronChat Developer Setup (Python)")
    print("=" * 55)
    print("[Ultron] No ultron.json configuration found.")
    print("Let's configure your P2P room session.\n")

    try:
        choice = input("Do you want to (1) Create a room or (2) Join a room? [1/2]: ").strip()
    except (KeyboardInterrupt, EOFError):
        print("\nExiting.")
        sys.exit(0)

    is_host = choice != "2"
    if is_host:
        # Hosts NEVER choose custom codes; codes are cryptographically generated
        code = generate_room_otp()
        print("\n[Ultron] Room created successfully!")
        print(f"  • Room Code : {code}")
        print(f"  • Share Link: https://ultronchat.vercel.app?room={code}")
        print("Share this code or link with your friend to connect!\n")
    else:
        try:
            raw_input = input("Enter Room Code or Share URL from host (e.g. C4GQA5 or https://ultronchat.vercel.app?room=C4GQA5): ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nExiting.")
            sys.exit(0)
        code = parse_room_code(raw_input)
        if not code:
            print("Error: Room code or share link is required to join.")
            sys.exit(1)

    try:
        auth = input("Enter Auth Key / Password (optional, press Enter to skip): ").strip() or None
        name = input(f"Enter your Dev Name (optional, default: PyDev-{code[-4:]}): ").strip() or None
        save_folder = input("Save received files to [default: ./ultron]: ").strip() or DEFAULT_SAVE_DIR
        server_val = input(f"Signaling server [default: {DEFAULT_SERVER}]: ").strip() or DEFAULT_SERVER
    except (KeyboardInterrupt, EOFError):
        print("\nExiting.")
        sys.exit(0)

    # Save ultron.json and ensure .gitignore
    saved = save_ultron_config({
        "roomCode": code,
        "isHost": is_host,
        "authKey": auth,
        "peerName": name,
        "serverUrl": server_val,
        "saveDir": save_folder,
    })
    print(f"\n[Ultron] Created {saved['path']}")

    client = UltronClient(
        room_code=code,
        is_host=is_host,
        auth_key=auth,
        peer_name=name,
        server_url=server_val,
        save_dir=save_folder,
    )
    try:
        client.connect()
        run_interactive_repl(client)
    except Exception as e:
        print(f"\n[Ultron] Connection Error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()

