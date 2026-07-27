#!/usr/bin/env bash
# Sets up everything encrypt_segments.py needs on Ubuntu/Debian: ffmpeg,
# and the Python dependencies in a dedicated virtualenv (so `pip install`
# doesn't fight with Ubuntu's "externally-managed-environment" restriction
# on newer releases, and doesn't touch system Python packages at all).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
fi

if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
  echo "Installing system packages (ffmpeg, python3-venv, python3-pip)..."
  $SUDO apt-get update
  $SUDO apt-get install -y ffmpeg python3-venv python3-pip
else
  echo "ffmpeg and python3 already present, skipping apt-get."
fi

echo "Creating virtual environment at $VENV_DIR ..."
python3 -m venv "$VENV_DIR"

echo "Installing Python dependencies (pgpy, standard-imghdr) ..."
"$VENV_DIR/bin/pip" install --upgrade pip >/dev/null
"$VENV_DIR/bin/pip" install -r "$SCRIPT_DIR/requirements.txt"

echo
echo "Done. Run the script with:"
echo "  $VENV_DIR/bin/python $SCRIPT_DIR/encrypt_segments.py <directory> <pubkey.asc>"
