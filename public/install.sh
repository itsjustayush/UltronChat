#!/usr/bin/env bash
# ==============================================================================
# UltronChat Terminal Installer for macOS, Linux, and WSL
# Run: curl -fsSL https://ultronchat.vercel.app/install.sh | bash
# ==============================================================================

set -e

INSTALL_DIR="${HOME}/.ultron"
BIN_DIR="${INSTALL_DIR}/bin"
TARGET_FILE="${BIN_DIR}/ultron"
SERVER_URL="https://ultronchat.vercel.app"

echo "======================================================="
echo " ⚡ UltronChat Terminal Installer"
echo "======================================================="
echo ""

# 1. Detect runtime: Node.js (preferred) or Python
RUNTIME=""
if command -v node >/dev/null 2>&1; then
    RUNTIME="node"
    DOWNLOAD_SOURCE="${SERVER_URL}/ultron.mjs"
    echo "✔ Detected Node.js ($(node -v))"
elif command -v python3 >/dev/null 2>&1; then
    RUNTIME="python3"
    DOWNLOAD_SOURCE="${SERVER_URL}/ultron.py"
    echo "✔ Detected Python 3 ($(python3 --version))"
elif command -v python >/dev/null 2>&1; then
    RUNTIME="python"
    DOWNLOAD_SOURCE="${SERVER_URL}/ultron.py"
    echo "✔ Detected Python ($(python --version))"
else
    echo "✖ Error: Neither Node.js (v18+) nor Python 3 was found on your system."
    echo "  Please install Node.js (https://nodejs.org) or Python (https://python.org) first."
    exit 1
fi

# 2. Create install directories
mkdir -p "${BIN_DIR}"

# 3. Download the standalone script
echo "⬇ Downloading Ultron CLI..."
if command -v curl >/dev/null 2>&1; then
    curl -fsSL "${DOWNLOAD_SOURCE}" -o "${TARGET_FILE}"
elif command -v wget >/dev/null 2>&1; then
    wget -qO "${TARGET_FILE}" "${DOWNLOAD_SOURCE}"
else
    echo "✖ Error: Neither curl nor wget is installed."
    exit 1
fi

chmod +x "${TARGET_FILE}"

# 4. Attempt symlink to /usr/local/bin for instant system-wide PATH
LINK_CREATED=false
if [ -w "/usr/local/bin" ]; then
    ln -sf "${TARGET_FILE}" /usr/local/bin/ultron
    LINK_CREATED=true
elif command -v sudo >/dev/null 2>&1 && [ -t 0 ]; then
    if sudo -n ln -sf "${TARGET_FILE}" /usr/local/bin/ultron 2>/dev/null; then
        LINK_CREATED=true
    fi
fi

# 5. If not symlinked in /usr/local/bin, append ~/.ultron/bin to shell profile
if [ "$LINK_CREATED" = false ]; then
    SHELL_PROFILE=""
    if [ -n "$ZSH_VERSION" ] || [ -f "${HOME}/.zshrc" ]; then
        SHELL_PROFILE="${HOME}/.zshrc"
    elif [ -f "${HOME}/.bashrc" ]; then
        SHELL_PROFILE="${HOME}/.bashrc"
    elif [ -f "${HOME}/.bash_profile" ]; then
        SHELL_PROFILE="${HOME}/.bash_profile"
    elif [ -f "${HOME}/.profile" ]; then
        SHELL_PROFILE="${HOME}/.profile"
    fi

    if [ -n "$SHELL_PROFILE" ]; then
        if ! grep -q '\.ultron/bin' "$SHELL_PROFILE" 2>/dev/null; then
            echo '' >> "$SHELL_PROFILE"
            echo '# UltronChat CLI' >> "$SHELL_PROFILE"
            echo 'export PATH="$HOME/.ultron/bin:$PATH"' >> "$SHELL_PROFILE"
        fi
    fi
fi

echo ""
echo "======================================================="
echo " 🎉 UltronChat CLI installed successfully!"
echo "======================================================="
echo ""
echo "  Location: ${TARGET_FILE}"
echo ""
echo "Usage Examples:"
echo "  ultron create                      # Create a room & get share link"
echo "  ultron join C4GQA5                 # Join room (files auto-saved to ./ultron)"
echo "  ultron join https://ultronchat.vercel.app?room=C4GQA5"
echo "  ultron send ./my-dataset.zip       # Send a file to connected peers"
echo "  ultron status                      # Check active room and peers"
echo "  ultron reset                       # Remove local ultron.json config"
echo ""
if [ "$LINK_CREATED" = false ]; then
    echo "Note: If 'ultron' command is not recognized, run:"
    echo "  export PATH=\"\$HOME/.ultron/bin:\$PATH\""
    echo "or restart your terminal."
fi
echo ""
