# Decision log

Chronological record of the non-obvious choices made while building the
segment player, and why. See [DESIGN.md](DESIGN.md) for how the current
system actually works.

## 1. Client-side only, no backend

The app is plain HTML/CSS/JS with no build step and no server component.
This was the starting constraint from the initial request ("runs completely
on the client side"), and it shapes every later decision below — most
notably that Drive folder listing had to use a browser-only OAuth flow
instead of a server-held API key or refresh token.

## 2. Gapless playback via dual `<video>` swap, not MSE

**Decision:** use two alternating `<video>` elements, preload the next
segment fully, and swap ~0.15s before the current one ends.

**Why:** true frame-accurate gapless playback via Media Source Extensions
needs every segment to share compatible codec/container parameters
(effectively, fragments of the same encode). Since segments can come from
arbitrary user-supplied sources with no guaranteed encoding consistency, MSE
would be fragile or outright fail for many real playlists. The dual-buffer
swap works with segments as independent, fully-decoded files and only
degrades to a visible "Buffering…" pause (rather than corrupting playback)
if a segment isn't ready in time.

**Trade-off accepted:** not literally zero-gap, just imperceptibly close in
the common case where prefetch keeps up.

## 3. Whole-blob downloads, not streaming playback

**Decision:** every segment is fetched in full via `fetch()` into memory as
a blob before it's eligible to play, rather than setting `<video src>`
directly to the remote URL and letting the browser stream it.

**Why:** streaming remote `src` directly is what "simple sequential"
playback would look like, but it doesn't support the private-Drive-folder
case at all (an authenticated `fetch` with a Bearer token is required to
even read the bytes), and it also can't give the standby video a
fully-buffered file to swap to instantly for gapless transitions.

**Trade-off accepted:** the whole segment must download before it can
start playing — acceptable per the user's own framing that segments are
short (5–30s).

## 4. Google Drive: attempt in-memory download, not iframe/src embedding

**Decision:** when the question of Drive support came up, we did not fall
back to embedding Drive's own preview `<iframe>` or pointing `<video src>`
at Drive URLs directly. We fetch the bytes client-side instead.

**Why:** the user confirmed segments are short (5–30s), making in-memory
fetch feasible size-wise, and iframe/src embedding doesn't compose with the
gapless dual-buffer technique (decision #2) or give control over
prefetching.

**Known limitation:** Drive's `uc?export=download` endpoint doesn't always
send CORS headers, and returns an HTML interstitial (not the file) for
large files or restricted sharing. Both cases are caught and surfaced as a
per-segment error rather than failing silently.

## 5. Private folder import: OAuth sign-in, not a bare API key

**Decision:** Drive folder listing uses Google Identity Services'
browser-only OAuth token client (`initTokenClient`), not a static Google
Cloud API key.

**Why:** an API key alone only grants read access to files that are
*already* publicly shared; the user confirmed the folder is private to
their account, which requires the app to act as the signed-in user. OAuth
via GIS keeps this fully client-side (no backend token exchange needed)
at the cost of requiring the user to create their own OAuth Client ID
and add their hosting origin to Authorized JavaScript origins.

**Trade-off accepted:** access tokens are short-lived (~1hr) and kept in a
JS variable only — not persisted — so re-signing in is needed each session.
This was chosen over persisting a refresh token, which isn't obtainable
from a pure browser flow without a backend anyway.

## 6. Signed-in state upgrades *all* Drive fetches, not just folder imports

**Decision:** once signed in, any segment with a `driveId` — whether typed
in manually or imported from a folder — is fetched via the authenticated
Drive API media endpoint instead of the anonymous `uc?export=download` URL.

**Why:** this was a natural consequence of storing `driveId` on every
segment rather than only on folder-imported ones; it also means manually
pasted private-file links work once the user signs in, with no separate
code path.

## 7. Natural (numeric-aware) sort for folder-imported files

**Decision:** files listed from a Drive folder are sorted with
`localeCompare(..., { numeric: true })` rather than plain lexicographic
order.

**Why:** segment filenames like `segment2.mp4` / `segment10.mp4` would
otherwise sort as `segment10` before `segment2` under default string
ordering, silently scrambling playback order for double-digit-or-higher
playlists.

## 8. Playlist save/load stores raw links only, not fetched state

**Decision:** `localStorage`-backed saved playlists store the pasted text
lines, not the built segment objects (blob URLs, fetch state, etc.).

**Why:** blob URLs are only valid for the lifetime of the page/tab that
created them, so persisting them across sessions would be meaningless.
Keeping saved playlists as plain text also lets the user freely edit order
between loading a saved list and building it into the player.

## 9. Local files: plain filename detection, not a separate input mode

**Decision:** whether a playlist line is "local" or "remote" is inferred
purely from whether it parses as an `http(s)` URL (`isHttpUrl`), rather than
requiring a distinct syntax (e.g. a `file:` prefix) or a separate UI list.
Local lines are matched against whatever folder the user opens via a
`webkitdirectory` file input.

**Why:** the request was specifically that a playlist "just" containing
filenames or relative paths should work — reusing the same textarea and
build step for both sources avoids a second parallel UI/data path, and
`isHttpUrl` is an unambiguous test (Drive/CDN/etc. links always parse as
`http(s)`, filenames never do).

**Trade-off accepted:** `webkitdirectory` (not the newer File System Access
API's `showDirectoryPicker`) was chosen for broader cross-browser support
(Chromium and Firefox; Safari support is inconsistent) at the cost of a
one-shot snapshot — if files change on disk after the folder is opened, the
user has to reopen it. This was judged acceptable since segments are short,
static clips, not files being edited during a session.

## 10. Local segments resolve eagerly, ahead of the network prefetch window

**Decision:** all local segments are resolved immediately when the
playlist is built (or when a folder is opened), regardless of the
`PREFETCH_WINDOW` that gates network fetches.

**Why:** resolving a local segment is just wrapping an already-in-memory
`File` handle in an object URL — no data is copied or transferred, so
there's no cost to doing it for the whole playlist at once, unlike a real
network fetch where the window exists specifically to bound concurrent
downloads.

## 11. Ambiguous filename matches fail loudly, not silently

**Decision:** if a bare filename (no `/`) matches more than one file in the
opened folder (same name in different subfolders), the segment is marked
`error` with an explicit "multiple files found" message rather than
picking the first match.

**Why:** silently picking one match could play the wrong clip with no
indication anything was wrong. Forcing the user to disambiguate with a
relative path (`sub/segment1.mp4` instead of `segment1.mp4`) surfaces the
problem instead of hiding it.

## 12. PGP support: vendor the crypto library locally, not from a CDN

**Decision:** `openpgp.js` is downloaded once and committed to
`vendor/openpgp.min.js`, loaded via a local `<script>` tag — unlike Google
Identity Services, which is still loaded live from `accounts.google.com`.

**Why:** this library handles private key material and decrypts the user's
content. Fetching it from a public CDN on every page load means trusting
that CDN, on every load, not to have served a tampered build — an
unnecessary supply-chain exposure for code specifically chosen to touch
key material, even though the same risk was accepted for the (non-crypto)
Google sign-in script. Vendoring pins an exact, inspectable version.

**Trade-off accepted:** the library must be manually re-vendored to pick up
upstream updates/fixes, rather than always tracking latest.

## 13. Encrypted-file detection: same extension-based pattern as local/Drive

**Decision:** a segment is treated as PGP-encrypted purely because its
filename ends in `.gpg`, `.pgp`, or `.asc` — no separate playlist syntax,
no per-line metadata.

**Why:** consistent with how `isLocal` (URL-parseability) and `driveId`
(Drive URL shape) are already inferred from the raw line rather than
requiring the user to annotate anything. It also means the *same* line can
be simultaneously local-or-remote and encrypted-or-not — all four
combinations share one code path, rather than encryption being a special
case bolted onto only one source type.

## 14. Decryption is a shared step between the network and local paths

**Decision:** `runFetch` (network/Drive) and `resolveLocalSegment` (local
folder) both call the same `decryptPgpBlob(blob, mimeGuess)` helper right
before marking a segment `ready`, rather than each having its own
decrypt logic.

**Why:** decryption only cares about "here are ciphertext bytes, here is an
unlocked key" — it has no reason to know or care whether those bytes came
from `fetch()` or a local `File`. Sharing the step means a bug fix or
format-detection improvement (e.g. armored vs. binary sniffing) applies
everywhere at once.

## 15. Missing key fails fast, before spending network bandwidth

**Decision:** `runFetch` checks for a loaded decryption key *before*
issuing the `fetch()` for an encrypted segment, not after downloading the
(possibly large-ish) ciphertext.

**Why:** there's no point downloading bytes the app can't yet decrypt.
This mirrors decision #4/#5's general principle of failing with a clear,
specific per-segment message ("load your PGP private key…") rather than
doing wasted work first. When the user does load a key,
`refreshEncryptedSegments` resets those errors and resumes prefetching
from the current playhead, so nothing requires a full playlist rebuild.

## 16. Preprocessing script: PGPy (pure Python), not the gpg CLI

**Decision:** `scripts/encrypt_segments.py` encrypts with the `pgpy`
package rather than shelling out to the `gpg` binary.

**Why:** explicitly chosen over shelling out to `gpg` to avoid requiring a
separately-installed external binary (e.g. Gpg4win on Windows) — `pip
install pgpy` is enough. The trade-off, accepted going in, is that PGPy is
lightly maintained and works most reliably with plain RSA keys rather than
newer ECC formats.

**Concrete gotcha found during testing:** PGPy imports the stdlib
`imghdr` module, which Python removed in 3.13. On Python 3.13+ (this
project was tested on 3.14), `import pgpy` fails outright unless a
backport is installed first: `pip install standard-imghdr`. Both packages
are listed in `scripts/requirements.txt` with a comment explaining why the
second one is there — otherwise it looks like a random unrelated
dependency.

## 17. Re-encode every segment cut, don't stream-copy

**Decision:** splitting uses `ffmpeg -ss <start> -i <in> -t <seconds>`
with re-encoding (`libx264`/`aac`), not ffmpeg's segment muxer with
`-c copy`.

**Why:** stream-copy splitting can only cut on keyframe boundaries, so a
`-c copy` segment can run longer than the requested length whenever the
source's keyframe interval exceeds it — silently breaking the "5 seconds
or less" guarantee for some inputs and not others, depending on how the
source was encoded. Re-encoding cuts exactly where asked, at the cost of
CPU time. This was verified directly: a 12-second synthetic test clip
split into 5s + 5s + 2s chunks, not e.g. 6s + 6s.

## 18. Segment ordering is encoded entirely in filenames, not a manifest

**Decision:** multi-part output filenames get a zero-padded `_partNN`
suffix specifically so that sorting the directory's `.gpg` filenames
alphabetically reproduces the correct playback order — `playlist.txt` is
generated as nothing more than `sorted(produced_filenames)`.

**Why:** matches the user's own stated rule ("playlist order is the
alphabetic order of files in the directory") literally, and avoids needing
any separate bookkeeping (e.g. a JSON manifest mapping original files to
their parts) to reconstruct order later — the filenames alone are
sufficient, and the sort is the same sort the web app's Drive-folder
import already uses conceptually (see decision #7), just simpler here
since these filenames are entirely under the script's own control.

## 19. One playlist per directory, not one playlist for the whole tree

**Decision:** `encrypt_segments.py` walks the full directory tree and
writes a separate `playlist.txt` into *every* directory that directly
contains video files, scoped to that directory's own files only —
matching the user's stated rule that each subfolder is its own playlist.

**Why:** keeping each playlist's file list scoped to files that live
alongside it (same directory) means the web app can treat every
`playlist.txt` as self-contained — bare filenames resolve against
whatever folder was opened, with no need to encode or reconstruct
cross-directory relative paths.

## 20. Interop was verified across implementations, not just round-tripped

**Decision:** before considering this done, a segment encrypted by the
Python script (`pgpy`) was decrypted using the actual web app in a real
browser (`openpgp.js`), and the output's SHA-256 was compared against the
original source file — not just decrypted again with `pgpy` itself.

**Why:** two different OpenPGP implementations agreeing with themselves
proves nothing about whether they agree with *each other*; the entire
point of this script is to produce files the browser-side code can open.
A self-consistency check (encrypt and decrypt both with pgpy) would have
missed a real interop bug — e.g. a cipher/format choice pgpy supports but
openpgp.js doesn't, or vice versa.

## 21. install.sh creates a venv, doesn't `pip install` system-wide

**Decision:** `scripts/install.sh` (targeting Ubuntu, per the user's
deployment target) creates a dedicated virtualenv at `scripts/.venv` and
installs `pgpy`/`standard-imghdr` into it, rather than running `pip
install` against the system Python.

**Why:** current Ubuntu releases mark the system Python as an
"externally-managed-environment" (PEP 668) and refuse plain `pip install`
outside a virtualenv. A venv sidesteps that entirely, needs no
`--break-system-packages` override, and keeps this script's dependencies
from ever touching system-wide packages. The trade-off is that running
the script means invoking `scripts/.venv/bin/python
scripts/encrypt_segments.py ...` rather than a bare `python3
encrypt_segments.py`, which `install.sh` prints at the end so it isn't a
guessing game.

**Testing note:** the apt-get/ffmpeg portion of this script could not be
executed in this (Windows) session and is unverified on real Ubuntu; the
venv-creation and `pip install -r requirements.txt` portion was tested in
isolation and confirmed to produce a working `pgpy` import.

## 22. Keys accept a file path or raw base64 text, on both sides

**Decision:** both the web app's private-key input and the script's
`pubkey` argument now accept either a path/file upload (as before) or the
key given directly as a base64 string — and on both sides, either base64
convention works (base64 of the armored ASCII text, or base64 of the raw
binary key packets), auto-detected with no flag or mode switch needed.

**Why:** requested so a key can be passed around as a one-line secret
(e.g. `base64 -w0 key.asc`, or an env var/secrets-manager value) without
needing a file on disk. Auto-detecting the convention rather than asking
the user to specify it matches the project's established pattern of
inferring shape from the value itself (`isLocal`, `driveId`,
`isEncrypted` all work the same way) instead of adding an explicit mode
flag.

**How it's detected, concretely:** on the Python side, `pgpy.PGPKey.
from_blob()` already auto-detects armored-vs-binary once base64-decoded —
verified directly (same fingerprint from both forms of the same key), so
no extra logic was needed there. `openpgp.js` is stricter and needs to be
told `armoredKey` vs `binaryKey` explicitly, so the web app decodes the
base64 (or reads the file as bytes) and checks for the
`-----BEGIN PGP PRIVATE KEY BLOCK-----` marker itself before calling
`readPrivateKey`.

**Verified:** all three private-key input paths (file upload, pasted
base64-of-armored, pasted base64-of-binary) were tested against the real
app in a browser and produced an unlocked key; a full decrypt-and-play
pass afterward still matched the original file's SHA-256 exactly,
confirming the refactor didn't regress the existing file-upload path.
Correspondingly, all three forms of the `pubkey` argument (file path,
base64-of-armored, base64-of-binary) were run through the actual script
and produced identical `.gpg` output.

## 23. Key generation prompts for a passphrase, never accepts one as a flag

**Decision:** `generate_keys.py` only ever reads the passphrase via
`getpass.getpass()` (with confirmation), and there is no `--passphrase`
CLI flag, not even for scripting convenience.

**Why:** a passphrase passed as a command-line argument ends up in shell
history and in `ps`/process-listing output on any shared machine — a
straightforward information leak. Prompting interactively is the only
option that doesn't have that failure mode. This does mean the script
can't be driven fully non-interactively without stubbing the prompt
function, which is exactly what testing here had to do (see below).

## 24. generate_keys.py refuses to overwrite an existing key pair

**Decision:** if `public.asc` or `private.asc` already exist at the
target `--out-dir`, the script exits with an error rather than
regenerating and overwriting them.

**Why:** silently replacing an existing key pair would strand every
`.gpg` file already encrypted with the old public key — there would be
no way to recover them without the original private key, which the
overwrite just destroyed. Forcing the user to explicitly remove the old
files (or pick a different `--out-dir`) turns a potentially catastrophic
silent mistake into a deliberate, visible one.

## 25. first_run.sh composes install.sh + generate_keys.py, both idempotent

**Decision:** `first_run.sh` doesn't duplicate any setup logic — it just
calls `install.sh`, then runs `generate_keys.py` through the venv
`install.sh` created, then prints the next command to run. Both steps it
depends on are individually safe to re-run (install.sh skips apt-get if
ffmpeg/python3 are already present; generate_keys.py refuses to overwrite
existing keys per decision #24), so `first_run.sh` itself needs no
first-run/already-run tracking of its own.

**Why:** a single script that's actually three concerns (system deps,
Python deps, key generation) glued together is easier to reason about,
and to re-run safely, if each concern stays a separate, independently
idempotent script rather than one script with its own bespoke "have I
already run" state.

**Testing note:** key generation, the overwrite guard, and the resulting
key pair's compatibility with `encrypt_segments.py` were all verified
directly by stubbing `prompt_passphrase()` in-process. The interactive
`getpass` prompt itself hit a Windows-specific snag in this session —
`getpass.getpass()` reads straight from the console via `msvcrt` on
Windows and ignores piped stdin entirely, so a `printf ... | python3
generate_keys.py` test hung indefinitely and had to be killed. This
doesn't reflect how `getpass` behaves on Linux (it falls back to reading
from `/dev/tty`, then stdin, when there's no real terminal), so it's not
expected to reproduce on the user's actual Ubuntu target — but the
interactive prompt's real-terminal UX specifically is unverified here.
