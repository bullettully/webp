#!/usr/bin/env python3
"""
Generate an RSA PGP key pair for use with this project: the public key goes
to encrypt_segments.py, the private key goes into the Segment Player web
app's "Load Key" panel (as a file or base64 text).

Writes two armored files into --out-dir (default: a `keys/` folder next to
this script): public.asc and private.asc. Refuses to overwrite either file
if it already exists, so re-running this never silently replaces a key
pair you might already be using to decrypt existing content.

RSA (not ECC) is used deliberately for maximum compatibility with pgpy on
the encrypt side and openpgp.js on the decrypt side.
"""
import argparse
import getpass
import sys
from pathlib import Path

try:
    import pgpy
    from pgpy.constants import (
        CompressionAlgorithm, HashAlgorithm, KeyFlags, PubKeyAlgorithm, SymmetricKeyAlgorithm,
    )
except ImportError:
    sys.exit(
        "error: the `pgpy` package is required.\n"
        "  pip install pgpy\n"
        "On Python 3.13+ you'll also need: pip install standard-imghdr\n"
        "(or just run ./install.sh, which sets both up in a virtualenv)"
    )

DEFAULT_OUT_DIR = Path(__file__).resolve().parent / "keys"


def prompt_passphrase() -> str:
    while True:
        passphrase = getpass.getpass("Passphrase to protect the private key: ")
        if not passphrase:
            print("error: an empty passphrase isn't allowed. Try again.", file=sys.stderr)
            continue
        confirm = getpass.getpass("Confirm passphrase: ")
        if passphrase != confirm:
            print("error: passphrases did not match. Try again.", file=sys.stderr)
            continue
        return passphrase


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--name", default="Segment Player", help="key owner name (default: 'Segment Player')")
    parser.add_argument("--email", default="segments@example.local", help="key owner email (default: segments@example.local)")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR, help=f"where to write public.asc/private.asc (default: {DEFAULT_OUT_DIR})")
    parser.add_argument("--bits", type=int, default=2048, help="RSA key size (default: 2048)")
    args = parser.parse_args()

    pub_path = args.out_dir / "public.asc"
    priv_path = args.out_dir / "private.asc"
    if pub_path.exists() or priv_path.exists():
        sys.exit(
            f"error: {pub_path} or {priv_path} already exists — refusing to overwrite "
            "(you'd lose the ability to decrypt anything encrypted with the existing key). "
            "Remove them first or pass a different --out-dir."
        )

    passphrase = prompt_passphrase()

    print(f"Generating a {args.bits}-bit RSA key pair (this can take a few seconds)...")
    key = pgpy.PGPKey.new(PubKeyAlgorithm.RSAEncryptOrSign, args.bits)
    uid = pgpy.PGPUID.new(args.name, email=args.email)
    key.add_uid(
        uid,
        usage={KeyFlags.EncryptCommunications, KeyFlags.EncryptStorage},
        hashes=[HashAlgorithm.SHA256],
        ciphers=[SymmetricKeyAlgorithm.AES256],
        compression=[CompressionAlgorithm.Uncompressed],
    )
    key.protect(passphrase, SymmetricKeyAlgorithm.AES256, HashAlgorithm.SHA256)

    args.out_dir.mkdir(parents=True, exist_ok=True)
    pub_path.write_text(str(key.pubkey), encoding="utf-8")
    priv_path.write_text(str(key), encoding="utf-8")
    try:
        priv_path.chmod(0o600)
    except NotImplementedError:
        pass  # chmod isn't meaningful on some platforms; best-effort only

    print()
    print(f"Wrote {pub_path}")
    print(f"Wrote {priv_path} (permissions restricted to owner-only where supported)")
    print()
    print("Next steps:")
    print(f"  Encrypt videos:  python3 encrypt_segments.py <video_dir> {pub_path}")
    print(f"  Decrypt in the web app: upload {priv_path} in the 'Load Key' panel,")
    print(f"    or paste it as one line:  base64 -w0 {priv_path}")


if __name__ == "__main__":
    main()
