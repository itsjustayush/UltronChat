#!/usr/bin/env python3
"""
UltronChat Developer CLI & SDK (Python)
Cross-platform peer-to-peer streaming and file transfer.
Automatically receives and saves files to the local './ultron' directory.

Usage:
  python ultron.py create 4567 [--key secret] [--server http://localhost:3000]
  python ultron.py join 4567 [--key secret] [--server http://localhost:3000]
  python ultron.py (interactive prompt)
"""

import sys
import os
import time
import json
import base64
import hashlib
import argparse
import threading
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

DEFAULT_SERVER = os.environ.get("ULTRON_SERVER_URL", "http://localhost:3000")
DEFAULT_SAVE_DIR = os.environ.get("ULTRON_SAVE_DIR", "./ultron")
CHUNK_SIZE_BYTES = 24 * 1024  # 24 KB chunk size for reliable JSON framing


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
            file_name = os.path.basename(file_info.get("name", "downloaded_file"))
            file_size = int(file_info.get("size", 0))
            expected_sha256 = file_info.get("sha256", "")

            with self.lock:
                self.incoming_transfers[token] = {
                    "name": file_name,
                    "size": file_size,
                    "totalChunks": total_chunks,
                    "expectedSha256": expected_sha256,
                    "chunks": [None] * total_chunks,
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
                if transfer["chunks"][index] is None:
                    raw_chunk = base64.b64decode(payload_b64)
                    transfer["chunks"][index] = raw_chunk
                    transfer["receivedChunks"] += 1
                    transfer["receivedBytes"] += len(raw_chunk)

                    # Print progress
                    pct = int((transfer["receivedChunks"] / transfer["totalChunks"]) * 100)
                    sys.stdout.write(f"\r[Ultron] 📥 Receiving '{transfer['name']}': {pct}% ({self._format_bytes(transfer['receivedBytes'])} / {self._format_bytes(transfer['size'])})")
                    sys.stdout.flush()

        elif event_type == "file_end":
            token = data.get("transferToken") or data.get("fileId")
            with self.lock:
                transfer = self.incoming_transfers.pop(token, None)

            if not transfer:
                return

            # Verify complete
            if transfer["receivedChunks"] != transfer["totalChunks"] or any(c is None for c in transfer["chunks"]):
                print(f"\n[Ultron] ❌ File transfer for '{transfer['name']}' ended incomplete.")
                return

            # Reassemble
            file_bytes = b"".join(transfer["chunks"])
            actual_sha256 = hashlib.sha256(file_bytes).hexdigest()
            expected_sha256 = transfer.get("expectedSha256", "")

            if expected_sha256 and actual_sha256.lower() != expected_sha256.lower():
                print(f"\n[Ultron] ❌ Checksum mismatch for '{transfer['name']}'! File discarded.")
                return

            # Save automatically into ./ultron folder
            save_path = os.path.join(self.save_dir, transfer["name"])
            base, ext = os.path.splitext(transfer["name"])
            counter = 1
            while os.path.exists(save_path):
                save_path = os.path.join(self.save_dir, f"{base}_{counter}{ext}")
                counter += 1

            with open(save_path, "wb") as f:
                f.write(file_bytes)

            print(f"\n[Ultron] ✅ File saved successfully!")
            print(f"       📂 Destination: {save_path}")
            print(f"       📦 Size: {self._format_bytes(len(file_bytes))}")
            print(f"       🔒 SHA-256: {actual_sha256}\n")

            if self.on_file_received:
                self.on_file_received(transfer["name"], save_path, len(file_bytes))

    def send_file(self, file_path: str, target_peer_id: str = None) -> bool:
        """Stream a file to peer(s) in chunk packets."""
        if not os.path.isfile(file_path):
            print(f"[Ultron] Error: File '{file_path}' does not exist.")
            return False

        file_size = os.path.getsize(file_path)
        file_name = os.path.basename(file_path)
        transfer_token = f"TOK{os.urandom(3).hex().upper()}"
        file_id = f"file-{int(time.time())}-{os.urandom(2).hex()}"

        print(f"[Ultron] 📤 Preparing to send '{file_name}' ({self._format_bytes(file_size)})...")

        # Read and compute SHA-256
        hasher = hashlib.sha256()
        total_chunks = (file_size + CHUNK_SIZE_BYTES - 1) // CHUNK_SIZE_BYTES if file_size > 0 else 1

        with open(file_path, "rb") as f:
            while chunk := f.read(64 * 1024):
                hasher.update(chunk)
        file_sha256 = hasher.hexdigest()

        # Send FILE_START
        start_payload = {
            "type": "file_start",
            "roomCode": self.room_code,
            "peerId": self.peer_id,
            "targetPeerId": target_peer_id,
            "data": {
                "file": {
                    "id": file_id,
                    "transferToken": transfer_token,
                    "name": file_name,
                    "size": file_size,
                    "totalChunks": total_chunks,
                    "sha256": file_sha256,
                    "uploaderId": self.peer_id,
                }
            },
        }
        self._call_registry("signal", start_payload)

        # Stream Chunks
        with open(file_path, "rb") as f:
            for idx in range(total_chunks):
                raw_chunk = f.read(CHUNK_SIZE_BYTES)
                b64_payload = base64.b64encode(raw_chunk).decode("ascii")

                chunk_payload = {
                    "type": "file_chunk",
                    "roomCode": self.room_code,
                    "peerId": self.peer_id,
                    "targetPeerId": target_peer_id,
                    "data": {
                        "transferToken": transfer_token,
                        "fileId": file_id,
                        "index": idx,
                        "payload": b64_payload,
                    },
                }
                self._call_registry("signal", chunk_payload)

                pct = int(((idx + 1) / total_chunks) * 100)
                sys.stdout.write(f"\r[Ultron] 📤 Sending: {pct}% (Chunk {idx+1}/{total_chunks})")
                sys.stdout.flush()

        # Send FILE_END
        end_payload = {
            "type": "file_end",
            "roomCode": self.room_code,
            "peerId": self.peer_id,
            "targetPeerId": target_peer_id,
            "data": {
                "transferToken": transfer_token,
                "fileId": file_id,
            },
        }
        self._call_registry("signal", end_payload)

        print(f"\n[Ultron] ✅ Transfer of '{file_name}' complete! (SHA-256: {file_sha256[:12]}...)")
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

    # 'create' command
    create_parser = subparsers.add_parser("create", help="Create a new transfer room")
    create_parser.add_argument("room_code", help="Room code (e.g. 4567)")
    create_parser.add_argument("--key", default=None, help="Optional auth key / password")
    create_parser.add_argument("--server", default=DEFAULT_SERVER, help="Server URL")
    create_parser.add_argument("--dir", default=DEFAULT_SAVE_DIR, help="Directory to save received files")
    create_parser.add_argument("--name", default=None, help="Your developer display name")

    # 'join' command
    join_parser = subparsers.add_parser("join", help="Join an existing room")
    join_parser.add_argument("room_code", help="Room code (e.g. 4567)")
    join_parser.add_argument("--key", default=None, help="Optional auth key / password")
    join_parser.add_argument("--server", default=DEFAULT_SERVER, help="Server URL")
    join_parser.add_argument("--dir", default=DEFAULT_SAVE_DIR, help="Directory to save received files")
    join_parser.add_argument("--name", default=None, help="Your developer display name")

    # 'send' quick command
    send_parser = subparsers.add_parser("send", help="Quickly send a file into a room")
    send_parser.add_argument("file_path", help="Path to file to send")
    send_parser.add_argument("--room", required=True, help="Room code (e.g. 4567)")
    send_parser.add_argument("--key", default=None, help="Optional auth key / password")
    send_parser.add_argument("--server", default=DEFAULT_SERVER, help="Server URL")

    args = parser.parse_args()

    # If no command provided, show interactive prompt
    if not args.command:
        print("=" * 55)
        print(" ⚡ UltronChat Developer Setup")
        print("=" * 55)
        choice = input("Do you want to (1) Create a room or (2) Join a room? [1/2]: ").strip()
        is_host = choice == "1"
        code = input("Enter Room Code (e.g. 4567): ").strip().upper()
        if not code:
            print("Error: Room code is required.")
            sys.exit(1)
        auth = input("Enter Auth Key (optional, press Enter to skip): ").strip() or None
        name = input("Enter your Dev Name (optional): ").strip() or None
        save_folder = input("Save received files to [default: ./ultron]: ").strip() or DEFAULT_SAVE_DIR

        client = UltronClient(
            room_code=code,
            is_host=is_host,
            auth_key=auth,
            peer_name=name,
            server_url=DEFAULT_SERVER,
            save_dir=save_folder,
        )
        try:
            client.connect()
            run_interactive_repl(client)
        except Exception as e:
            print(f"\n[Ultron] Connection Error: {e}")
            sys.exit(1)
        return

    if args.command == "create":
        client = UltronClient(
            room_code=args.room_code,
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

    elif args.command == "join":
        client = UltronClient(
            room_code=args.room_code,
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

    elif args.command == "send":
        client = UltronClient(
            room_code=args.room,
            is_host=False,
            auth_key=args.key,
            server_url=args.server,
        )
        try:
            client.connect()
            time.sleep(1)
            client.send_file(args.file_path)
            time.sleep(1)
            client.leave()
        except Exception as e:
            print(f"\n[Ultron] Error: {e}")
            sys.exit(1)


if __name__ == "__main__":
    main()

