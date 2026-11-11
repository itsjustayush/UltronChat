<div align="center">

# ⚡ ULTRONCHAT

### **Real-Time, Ephemeral Peer-to-Peer File Transfer & Encrypted Mesh**
*What if we could share any size and type of file to one or more people at realtime using only code or the terminal only?*

[![License: MIT](https://img.shields.io/badge/License-MIT-CEFF00.svg?style=for-the-badge&logoColor=050505&labelColor=111418)](LICENSE)
[![Vercel Deployment](https://img.shields.io/badge/Deployed%20on-Vercel-CEFF00.svg?style=for-the-badge&logo=vercel&logoColor=050505&labelColor=111418)](https://ultronchat.vercel.app)
[![Transport: WebRTC DTLS 1.3](https://img.shields.io/badge/Transport-WebRTC%20DTLS%201.3-CEFF00.svg?style=for-the-badge&logo=webrtc&logoColor=050505&labelColor=111418)](#-security--cryptographic-integrity)
[![Registry: Neon Serverless](https://img.shields.io/badge/Registry-Neon%20Postgres-CEFF00.svg?style=for-the-badge&logo=postgresql&logoColor=050505&labelColor=111418)](https://neon.tech)
[![Node.js](https://img.shields.io/badge/Node.js-18+-CEFF00.svg?style=for-the-badge&logo=nodedotjs&logoColor=050505&labelColor=111418)](https://nodejs.org)
[![Python](https://img.shields.io/badge/Python-3.8+-CEFF00.svg?style=for-the-badge&logo=python&logoColor=050505&labelColor=111418)](https://python.org)

<p align="center">
  <a href="https://ultronchat.vercel.app"><b>🌐 Live Web App</b></a> •
  <a href="#-the-core-vision"><b>💡 The Core Vision</b></a> •
  <a href="#-quick-install-terminal-1-liner"><b>⚡ Terminal 1-Liner</b></a> •
  <a href="#-developer-cli-ultron"><b>💻 CLI Reference</b></a> •
  <a href="#-programmatic-sdk-python--node"><b>📦 SDK Usage</b></a> •
  <a href="#-architecture--topology"><b>📐 Architecture</b></a> •
  <a href="#-security--cryptographic-integrity"><b>🛡️ Security & Truth</b></a>
</p>

---

</div>

## 💡 The Core Vision

> *"What if we could share any size and type of file to one or more people at realtime using only code or the terminal only?"*

Most file sharing today relies on intermediaries: cloud storage buckets, file lockers, temporary server uploads, or chat attachments with aggressive size caps. Your private files are uploaded to someone else's server, scanned, stored, and then downloaded.

**UltronChat answers this question differently:**
- **Zero Intermediary Storage**: File bytes stream directly between device memory and network sockets. Servers **never** touch, inspect, or buffer file chunks.
- **Code & Terminal Native**: Connect instances, share gigabyte datasets, or pipe build artifacts using only a terminal command (`ultron send`) or a 4-line Python/Node script.
- **Browser & CLI Interoperability**: Seamlessly transfer files between headless Linux servers, developer terminals, desktop Chrome/Firefox, and mobile phones using 6-character room codes (`C4GQA5`).
- **Any File Size**: From tiny JSON configs to multi-gigabyte ISOs and machine-learning model weights, bounded memory streaming ensures zero out-of-memory crashes.

```text
 ┌────────────────┐       Direct WebRTC DataChannel (P2P)       ┌────────────────┐
 │  Host Machine  │ <=========================================> │  Peer Machine  │
 │  (Terminal/Web)│         Zero Server Storage / DTLS 1.3      │  (Terminal/Web)│
 └───────┬────────┘                                             └────────┬───────┘
         │               Transient Signaling Handshake                   │
         └─────────────► ┌───────────────────────────┐ ◄─────────────────┘
                         │   Neon Postgres Registry  │
                         │    (TTL = 90s Ephemeral)  │
                         └───────────────────────────┘
```

---

## ✨ Key Features

- **⚡ Direct Line-Speed P2P**: Bypasses cloud storage entirely. Transfers flow at local network or direct peer ISP line speeds using binary WebRTC DataChannels or ephemeral direct sockets.
- **🔒 True Zero-Server Storage**: The database rejects all file chunk payloads. PostgreSQL is strictly utilized as a transient, ephemeral rendezvous registry (SDP exchange, ICE signaling, room presence).
- **🛡️ Safe Disk Streaming & Atomic Commits**: Incoming CLI files stream directly to `.part` files on disk with real-time FIPS 180-4 chunked SHA-256 calculation. Files are atomically promoted only after 100% hash verification passes.
- **⚠️ Interactive Confirmation Prompts**: Prevents drive-by file transfers. The CLI explicitly asks `Accept incoming file 'weights.pt' (4.2 GB)? (y/n)` unless passed `--auto-accept` or `-y`.
- **🚫 Path Traversal Protection**: All received filenames are sanitized through base name extraction, neutralizing directory traversal attempts (`../../etc/passwd`).
- **🔑 Clean 6-Char Alphanumeric Rooms**: No awkward numeric ports or confusing hashes. Rooms use memorable codes like `C4GQA5` with one-click web links (`https://ultronchat.vercel.app?room=C4GQA5`).
- **🛡️ Automated `.gitignore` Integration**: Running Ultron in any Git repository automatically adds `ultron.json` and `./ultron/` to `.gitignore`.
- **🌐 W3C Perfect Negotiation Multi-Peer Mesh**: Deterministic polite/impolite glare resolution handles simultaneous connections and race conditions across multiple participants in the same room.
- **🎨 Cyberpunk Neon Aesthetic**: High-contrast, accessibility-aware dark interface (`#050505` deep space, `#CEFF00` neon lime, glassmorphism) responsive across mobile and desktop.

---

## ⚡ Quick Install (Terminal 1-Liner)

Install the global `ultron` CLI command on your computer with a single terminal command:

### 🍏 macOS / 🐧 Linux / 🪟 WSL (Bash & Zsh)
```bash
curl -fsSL https://ultronchat.vercel.app/install.sh | bash
```

### 🪟 Windows (PowerShell)
```powershell
irm https://ultronchat.vercel.app/install.ps1 | iex
```

> **What the installer does**:
> - Checks for your environment (`node` or `python3`).
> - Places the standalone executable into `~/.ultron/bin`.
> - Adds `ultron` to your persistent `PATH`.

---

## 💻 Developer CLI (`ultron`)

Ultron CLI is available in both Node.js (`ultron.mjs`) and Python (`ultron.py`). Both implementations feature 100% protocol parity.

```bash
# Run with npx directly (no install required):
npx ultron create
# Or with python:
python ultron.py create
```

### 1. Create a Room (Host)
Room codes are **auto-generated** cryptographically to avoid room collisions:
```bash
ultron create
```
```text
=======================================================
 ⚡ UltronChat Room Created
=======================================================
  • Room Code : C4GQA5
  • Share Link: https://ultronchat.vercel.app?room=C4GQA5
  • Role      : HOST (Room Host)
  • Save Dir  : ./ultron
=======================================================
Share this room code or link with your peers to connect!
```

### 2. Join a Room (Peer)
Join using either the 6-character code **or** by pasting the full web link:
```bash
# Using the 6-character room code:
ultron join C4GQA5

# Or paste the share link directly:
ultron join https://ultronchat.vercel.app?room=C4GQA5

# Headless / automation mode (auto-accept incoming transfers):
ultron join C4GQA5 --auto-accept
# (or with short flag):
ultron join C4GQA5 -y

# Optional room password:
ultron join C4GQA5 --key mysecret
```

### 3. Interactive Transfer REPL
Once connected, peers enter a live two-way transfer shell:
```text
============================================================
 ⚡ ULTRON DEVELOPER P2P FILE STREAM ACTIVE
 Room Code  : C4GQA5
 Role       : PEER
 Dev Name   : NodeDev-8a2b
 Save Dir   : ./ultron
 Auto-Accept: false
============================================================
Commands:
  send <path>   - Stream a file to all connected peers
  chat <msg>    - Send a real-time message
  peers         - List all peers currently connected
  clear         - Clear terminal screen
  exit / quit   - Leave room and disconnect
------------------------------------------------------------
ultron> send ./dataset-final.tar.gz
[Ultron] Hosting ephemeral direct stream on port 53421...
[Ultron] Uploading 'dataset-final.tar.gz' (42.8 MB)...
[Ultron] [████████████████████████████████] 100% | 42.8 MB | Verified SHA-256
```

### 4. Headless / Quick Send
Send a file immediately using your saved `ultron.json` session:
```bash
ultron send ./model_weights.bin
```

### 5. Check Room Status & Reset
```bash
# Inspect current room session and online peers:
ultron status

# Disconnect and delete local ultron.json session:
ultron reset
```

---

## ⚙️ Configuration (`ultron.json`)

When you create or join a room, Ultron stores your active room session in a local `ultron.json` file and automatically safeguards it in `.gitignore`:

```json
{
  "$schema": "https://ultronchat.vercel.app/schemas/ultron.json",
  "roomCode": "C4GQA5",
  "role": "host",
  "isHost": true,
  "serverUrl": "https://ultronchat.vercel.app",
  "saveDir": "./ultron",
  "authKey": null,
  "peerName": "DevNode-Alpha",
  "autoDownload": false,
  "createdAt": "2026-11-11T16:00:00.000Z",
  "lastConnectedAt": "2026-11-11T16:05:00.000Z"
}
```

---

## 📦 Programmatic SDK (Python & Node.js)

Embed Ultron direct file streaming into machine-learning training pipelines, CI/CD runners, or automated developer workflows.

### 🐍 Python SDK (`ultron.py`)
*Zero third-party pip dependencies. Uses Python standard library only (`urllib`, `http.server`, `hashlib`, `socket`).*

```python
from ultron import UltronClient

# Initialize client
client = UltronClient(
    room_code="C4GQA5",
    peer_name="ML-Worker-01",
    save_dir="./ultron",
    auto_download=True
)

# Connect to room (background signaling and file listening)
client.connect()

# Stream file directly to peers
client.send_file("checkpoint_epoch_20.pt")

# Send status message
client.send_chat("Model training complete. Checkpoint dispatched.")
```

### 🟨 JavaScript / Node.js SDK (`ultron.mjs`)
*Uses native Node.js built-ins (`node:crypto`, `node:events`, `node:fs`, `node:http`, `node:path`).*

```javascript
import { UltronClient } from './ultron.mjs';

const client = new UltronClient({
  roomCode: 'C4GQA5',
  peerName: 'Build-Server',
  saveDir: './ultron',
  autoDownload: true
});

await client.connect();

// Stream build artifact directly to peers
await client.sendFile('./dist.tar.gz');

// Listen for incoming files
client.on('file_received', ({ fileName, savedTo, sizeBytes, sha256 }) => {
  console.log(`Verified ${fileName} (${sizeBytes} bytes, SHA: ${sha256}) -> ${savedTo}`);
});
```

---

## 📐 Architecture & Topology

```mermaid
flowchart TD
    subgraph Web_Client["🌐 Web Browser (Mobile / Desktop)"]
        UI["React 19 + Tailwind 4 UI"]
        RTC_W["WebRTC PeerConnection (W3C Perfect Negotiation)"]
        UI --- RTC_W
    end

    subgraph CLI_Client["💻 Terminal Client (Node / Python)"]
        CLI["Ultron CLI / REPL Shell"]
        FS["Safe Disk Streamer (.part + atomic rename)"]
        CLI_SRV["Ephemeral Direct HTTP Stream Server"]
        CLI --- FS
        CLI --- CLI_SRV
    end

    subgraph Signaling_Infrastructure["☁️ Ephemeral Signaling Infrastructure"]
        VercelEdge["Vercel Serverless API (/api/signal/registry)"]
        NeonDB[("Neon Serverless Postgres\n• ultronchat_rooms\n• ultronchat_room_peers\n• ultronchat_room_events")]
        VercelEdge --- NeonDB
    end

    subgraph Direct_P2P_Mesh["⚡ Encrypted Direct P2P Channel"]
        DataChannel["WebRTC DataChannel (DTLS 1.3 / SCTP)"]
        DirectStream["Direct Ephemeral P2P TCP/TLS Socket"]
    end

    RTC_W <..>|"Handshake (Offer / Answer / ICE)"| VercelEdge
    CLI <..>|"Presence Heartbeat & Polling"| VercelEdge
    RTC_W <===>|"Direct DTLS Encrypted Chunks"| DataChannel
    CLI <===>|"Direct P2P Sockets"| DirectStream
```

### Signaling & Data Lifecycle
1. **Host Generation**: Room code is cryptographically generated (`C4GQA5`) and registered in Neon Postgres with an ephemeral TTL (90 seconds renewed via heartbeat).
2. **Peer Rendezvous**: The connecting peer exchanges SDP Offer/Answer candidates and ICE candidates through atomic PostgreSQL CTE queries (`WITH consumed AS (DELETE ... RETURNING ...)`).
3. **P2P Promotion**: WebRTC DataChannels open directly between browsers using DTLS 1.3 encryption. For CLI-to-CLI nodes, an ephemeral direct streaming socket handles the transfer.
4. **Data Isolation**: Database explicitly rejects file chunks (`file_start`, `file_chunk`, `file_end` return HTTP 400). File data **never** touches PostgreSQL.
5. **Zero-Trace Disconnect**: When peers leave or heartbeat expires, room records and pending signals self-purge from the database within seconds.

---

## 🛡️ Security & Cryptographic Integrity

### Truth in Advertising
We believe in full transparency regarding encryption and architectural boundaries:

| Security Domain | Implementation Details |
| :--- | :--- |
| **Transport Encryption** | **WebRTC DTLS 1.3 / SCTP**: WebRTC DataChannels are end-to-end encrypted at the transport layer with authenticated key exchange. Intermediaries and signaling servers cannot decrypt payload streams. |
| **Zero Server Storage** | **100% Enforced**: File data chunks are strictly forbidden from the signaling server. Any attempt to relay file chunks through the database fails with HTTP 400 Bad Request. |
| **Integrity Verification** | **Full-File Chunked Streaming SHA-256**: Uses a custom FIPS 180-4 compliant incremental SHA-256 engine. Files of any size (up to 2 GB tested) are hashed incrementally in 2 MB slices with zero full-buffer memory allocation. Sender and receiver hashes must match 100% or the file is discarded. |
| **Disk Safety** | **Atomic Renaming & Basepath Sanitization**: Inbound files are written to `.part` files on disk. Directory traversal attacks (`../../`) are stripped with `path.basename`. Files are only moved to final destinations after hash verification. |
| **Room Passwords** | **Scrypt Key Derivation**: Passwords are hashed with Node.js / Python `scrypt` using a cryptographic salt, preventing rainbow table attacks. |

---

## 🛠️ Local Development & Testing

### Prerequisites
- **Node.js**: v18.0.0 or later
- **npm**: v9.0.0 or later
- **Python**: 3.8+ (for testing `ultron.py`)
- **Neon Postgres**: Optional for local server testing (connection string in `.env`)

### Setup
```bash
# Clone the repository
git clone https://github.com/itsjustayush/UltronChat.git
cd UltronChat

# Install dependencies
npm install

# Start local Vite development server
npm run dev
```

### Running Tests
UltronChat includes unit tests for chunked SHA-256 streaming, memory framing, and registry operations:
```bash
# Run unit test suites
npm test

# Run TypeScript static analysis
npm run lint

# Compile production Vite bundle and Node server
npm run build
```

---

## 📄 License

Distributed under the **MIT License**. See [`LICENSE`](LICENSE) for details.

---

<div align="center">

**Built with ⚡ by developers, for developers.**  
*UltronChat — Zero servers between your files.*

</div>
