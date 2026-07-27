#!/usr/bin/env bash
# One-shot setup for a new machine/checkout: installs ffmpeg + the Python
# dependencies (via install.sh), then generates a fresh PGP key pair to use
# with encrypt_segments.py (public key) and the Segment Player web app's
# PGP decryption feature (private key).
#
# Safe to re-run: install.sh is idempotent, and generate_keys.py refuses to
# overwrite an existing key pair rather than silently replacing it.
#
# Any extra arguments are passed through to generate_keys.py, e.g.:
#   ./first_run.sh --name "Jane Doe" --email jane@example.com
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== Step 1/2: installing dependencies =="
"$SCRIPT_DIR/install.sh"

echo
echo "== Step 2/2: generating a PGP key pair =="
"$SCRIPT_DIR/.venv/bin/python" "$SCRIPT_DIR/generate_keys.py" "$@"

echo
echo "Setup complete. To encrypt a directory of videos:"
echo "  $SCRIPT_DIR/.venv/bin/python $SCRIPT_DIR/encrypt_segments.py <video_dir> $SCRIPT_DIR/keys/public.asc"
