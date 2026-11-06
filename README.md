<div align="center">

# ⚡ ULTRONCHAT

### **Next-Gen Ephemeral Peer-to-Peer File Transfer & Encrypted Real-Time Chat**

[![License: MIT](https://img.shields.io/badge/License-MIT-CEFF00.svg?style=for-the-badge&logoColor=050505&labelColor=111418)](LICENSE)
[![Vercel Deployment](https://img.shields.io/badge/Deployed%20on-Vercel-CEFF00.svg?style=for-the-badge&logo=vercel&logoColor=050505&labelColor=111418)](https://ultronchat.vercel.app)
[![Database: Neon Serverless](https://img.shields.io/badge/Registry-Neon%20Postgres-CEFF00.svg?style=for-the-badge&logo=postgresql&logoColor=050505&labelColor=111418)](https://neon.tech)
[![Node.js](https://img.shields.io/badge/Node.js-18+-CEFF00.svg?style=for-the-badge&logo=nodedotjs&logoColor=050505&labelColor=111418)](https://nodejs.org)
[![Python](https://img.shields.io/badge/Python-3.8+-CEFF00.svg?style=for-the-badge&logo=python&logoColor=050505&labelColor=111418)](https://python.org)

<p align="center">
  <a href="https://ultronchat.vercel.app"><b>🌐 Live Web App</b></a> •
  <a href="#-quick-install-terminal-1-liner"><b>⚡ Terminal 1-Liner</b></a> •
  <a href="#-developer-cli-ultron"><b>💻 CLI Reference</b></a> •
  <a href="#-programmatic-sdk-python--node"><b>📦 SDK Usage</b></a> •
  <a href="#-architecture--topology"><b>📐 Architecture</b></a>
</p>

---

</div>

## 🌌 Overview

**UltronChat** is a cross-platform, zero-footprint peer-to-peer file transfer and real-time communication system. It bridges web browsers, mobile devices, terminal CLI tools, and automated developer scripts into an encrypted transfer mesh.

Files move directly between devices over WebRTC DataChannels and raw TCP/TLS streams at line speed. Servers **never** touch, buffer, or inspect file bytes.

```text
 ┌────────────────┐       Direct WebRTC DataChannel (P2P)       ┌────────────────┐
 │  Host Machine  │ <=========================================> │  Peer Machine  │
 │  (Terminal/Web)│         Zero Server Intermediation          │  (Terminal/Web)│
 └───────┬────────┘                                             └────────┬───────┘
         │               Transient Signaling Handshake                   │
         └─────────────► ┌───────────────────────────┐ ◄─────────────────┘
                         │   Neon Postgres Registry  │
                         │    (TTL = 90s Ephemeral)  │
                         └───────────────────────────┘
```

---

## ✨ Key Features

- **⚡ Blazing Line-Speed Transfers**: Moves gigabytes directly over memory-efficient WebRTC chunks with dynamic windowing and real-time backpressure.
- **🔒 Zero Server Storage**: Files flow directly device-to-device. Your data never touches intermediate disks or cloud buckets.
- **🛡️ Auto-Download to `./ultron`**: In developer CLI/SDK mode, incoming files are automatically streamed, checksum-verified, and saved into your project's `./ultron/` folder without manual clicking.
- **🔑 Web-Matching 6-Char Alphanumeric Rooms**: No confusing numbers. Rooms use clean codes like `C4GQA5` with one-click share links (`https://ultronchat.vercel.app?room=C4GQA5`).
- **🛡️ Automated `.gitignore` Protection**: Running Ultron in any Git repository automatically protects `ultron.json` and the `./ultron/` folder from accidental commits.
- **📱 True Cross-Device Parity**: Seamlessly pair laptops, phones, headless servers, and terminal sessions via room codes, QR codes, or URLs.
- **🎨 Dark Cyber / Neon Aesthetic**: Immersive deep-space palette (`#050505`, `#CEFF00` neon lime, glassmorphism) responsive across mobile, tablet, and widescreen.

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
> - Checks for your preferred environment (Node.js or Python).
> - Downloads the self-contained standalone executable into `~/.ultron/bin`.
> - Adds `ultron` to your persistent `PATH` and configures it immediately in your active session.

---

## 💻 Developer CLI (`ultron`)

### 1. Create a Room (Host)
Room codes are **always auto-generated** by the system to avoid collisions:
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
  • Save Dir  : ./ultron (incoming files auto-saved here)
=======================================================
Share this room code or link with your friend to connect!
```

### 2. Join a Room (Peer)
Join using the 6-character code **or** by pasting the share link directly:
```bash
# Using the 6-character room code:
ultron join C4GQA5

# Or paste the full web share link:
ultron join https://ultronchat.vercel.app?room=C4GQA5

# With an optional password/auth key:
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
 Save Dir   : /workspace/ultron
============================================================
Commands:
  send <path>   - Stream a file to all connected peers
  chat <msg>    - Send a real-time message
  peers         - List all peers currently connected
  clear         - Clear terminal screen
  exit / quit   - Leave room and disconnect
------------------------------------------------------------
ultron> send ./dataset-final.tar.gz
[Ultron] Uploading 'dataset-final.tar.gz' (42.8 MB)...
[Ultron] [████████████████████████████████] 100% | 42.8 MB | Complete!
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

# Disconnect and delete local ultron.json:
ultron reset
```

---

## ⚙️ Configuration (`ultron.json`)

When you create or join a room, Ultron stores your room session in a local `ultron.json` file and automatically safeguards it in `.gitignore`:

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
  "autoDownload": true,
  "createdAt": "2026-11-06T18:00:00.000Z",
  "lastConnectedAt": "2026-11-06T18:05:00.000Z"
}
```

---

## 📦 Programmatic SDK (Python & Node.js)

Embed Ultron direct file streaming into your backend workers, machine-learning training pipelines, or automation scripts.

### 🐍 Python SDK (`ultron.py`)
*Zero third-party pip dependencies. Uses Python standard library only.*

```python
from ultron import UltronClient

# Initialize client
client = UltronClient(
    room_code="C4GQA5",
    peer_name="ML-Worker-01",
    save_dir="./ultron"
)

# Connect to room (incoming files automatically save to ./ultron)
client.connect()

# Stream a file to peers
client.send_file("checkpoint_epoch_20.pt")

# Send status message
client.send_chat("Model training complete. Weights dispatched.")
```

### 🟨 JavaScript / Node.js SDK (`ultron.mjs`)
*Uses native Node.js built-ins (`node:crypto`, `node:events`, `node:fs`).*

```javascript
import { UltronClient } from './ultron.mjs';

const client = new UltronClient({
  roomCode: 'C4GQA5',
  peerName: 'Build-Server',
  saveDir: './ultron'
});

await client.connect();

// Send build artifact
await client.sendFile('./dist.zip');

// Listen for incoming files
client.on('file_received', ({ fileName, savedTo, sizeBytes }) => {
  console.log(`Received ${fileName} (${sizeBytes} bytes) -> saved to ${savedTo}`);
});
```

---

## 📐 Architecture & Topology

```mermaid
flowchart TD
    subgraph Web_Client["🌐 Web Browser (Mobile / Desktop)"]
        UI["React 19 + Tailwind 4 UI"]
        RTC_W["WebRTC PeerConnection"]
        UI --- RTC_W
    end

    subgraph CLI_Client["💻 Terminal Client (Node / Python)"]
        CLI["Ultron CLI / REPL"]
        FS["Auto-Downloader (./ultron/)"]
        CLI --- FS
    end

    subgraph Signaling_Infrastructure["☁️ Ephemeral Signaling Infrastructure"]
        VercelEdge["Vercel Serverless API (/api/signal/registry)"]
        NeonDB[("Neon Serverless Postgres\n• ultronchat_rooms\n• ultronchat_room_peers\n• ultronchat_room_events")]
        VercelEdge --- NeonDB
    end

    subgraph Direct_P2P_Mesh["⚡ Encrypted Direct P2P Channel"]
        DataChannel["Direct WebRTC DataChannel / Memory-Stream"]
    end

    RTC_W <..>|"Handshake (Offer / Answer / ICE)"| VercelEdge
    CLI <..>|"Heartbeat & Polling"| VercelEdge
    RTC_W <===>|"Direct End-to-End Encrypted Chunks"| DataChannel
    CLI <===>|"Direct File Streaming"| DataChannel
```

### Signaling Lifecycle
1. **Host Generation**: Room OTP is cryptographically generated (`C4GQA5`) and registered in Neon Postgres with an ephemeral TTL (90 seconds renewed via heartbeat).
2. **Peer Rendezvous**: The connecting peer polls or exchanges SDP Offer/Answer candidates through the registry endpoint.
3. **P2P Promotion**: Once ICE candidates resolve through Google/Cloudflare STUN, WebRTC DataChannels open.
4. **Zero-Trace Disconnect**: When peers disconnect or leave, room entries self-purge from the database within seconds.

---

## 🛠️ Local Development & Contributing

### Prerequisites
- **Node.js**: v18.0.0 or later
- **npm**: v9.0.0 or later
- **Python**: 3.8+ (for testing `ultron.py`)

### Setup
```bash
# Clone the repository
git clone https://github.com/itsjustayush/UltronChat.git
cd UltronChat

# Install dependencies
npm install

# Start development server with Hot Module Replacement
npm run dev
```

### Build & Lint
```bash
# Run type checks
npm run lint

# Compile production bundle and serverless handler
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

