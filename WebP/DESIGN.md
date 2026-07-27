# Segment Player — Design

A single-page, client-only web app (`index.html` + `style.css` + `app.js`, no
build step, no backend) that takes an ordered list of video segment links or
local filenames, downloads/reads each segment to memory, and plays them
back-to-back as if they were one video.

## Data model

Each line of input becomes a segment object:

```js
{ raw, resolved, driveId, isLocal, isEncrypted, state, blobUrl, error }
```

- `raw` — the link/filename exactly as pasted.
- `resolved` — `raw` with Google Drive share-link forms rewritten to
  `drive.google.com/uc?export=download&id=...` (used only for anonymous/public
  fetches); equal to `raw` for local segments.
- `driveId` — the extracted Drive file ID, or `null` for non-Drive/local lines.
- `isLocal` — `true` when `raw` doesn't parse as an `http(s)` URL, meaning
  it's treated as a filename/relative path to resolve against an opened local
  folder rather than something to fetch over the network.
- `isEncrypted` — `true` when `raw` ends in `.gpg`/`.pgp`/`.asc` (ignoring any
  query string), meaning the fetched/matched bytes must be PGP-decrypted in
  memory before playback.
- `state` — `pending → queued → downloading → decrypting → ready → playing →
  played`, or `error`. Local segments skip `queued`/`downloading`; unencrypted
  segments skip `decrypting`.
- `blobUrl` — an `Object URL` for the final playable blob (downloaded and/or
  decrypted), once `ready`.

## Fetch pipeline

- A small concurrency-limited queue (`MAX_CONCURRENT_FETCHES = 3`) downloads
  segments as whole blobs via `fetch()` — nothing streams; a segment is either
  fully in memory or not yet fetched.
- A sliding prefetch window (`PREFETCH_WINDOW = 2`) keeps the current segment
  plus the next two downloading ahead of playback.
- If a segment has a `driveId` **and** the user is signed in to Google, the
  fetch goes to the authenticated Drive API media endpoint
  (`drive/v3/files/{id}?alt=media` with a `Bearer` token) instead of the
  anonymous URL — this is what makes private-folder playback possible.
- Finished segments are dropped (`URL.revokeObjectURL`) once played, so memory
  use stays bounded to roughly the prefetch window regardless of playlist
  length.
- Local segments (see below) bypass this queue entirely — resolution is
  synchronous, so `ensureFetched` branches to `resolveLocalSegment` instead of
  enqueueing a network fetch.

## Local file support

Lines in the playlist that don't parse as an `http(s)` URL (`isHttpUrl`) are
treated as local: either a bare filename (`segment3.mp4`) or a path relative
to a folder the user opens in-browser (`clips/segment3.mp4`).

- **Opening a folder** uses a hidden `<input type="file" webkitdirectory
  multiple>` triggered by an "Open Local Folder" button. The resulting
  `FileList` carries each file's `webkitRelativePath` (rooted at the picked
  folder's own name).
- Two lookup maps are built from that list: by relative path (with the
  picked-folder's name stripped, plus the unstripped path as a fallback key)
  and by bare basename. A playlist line with a `/` is matched by path first;
  a bare filename is matched by basename, but only if exactly one file shares
  that name — multiple matches surface as an explicit "ambiguous" error
  rather than silently picking one.
- Resolution is essentially free (`URL.createObjectURL(file)` on an
  already-local `File` handle, no data copy), so local segments are resolved
  **eagerly for the whole playlist** at build time, not gated by the
  network prefetch window.
- If a folder hasn't been opened yet, unresolved local segments show a
  distinct error ("Open the local folder containing this file") rather than
  the generic "not found" message, so the user knows to open a folder rather
  than fix a typo.
- Opening a folder re-resolves any local segments already in the list
  (`refreshLocalSegments(true)`), so the user can paste filenames first and
  pick the matching folder afterward, in either order.

## PGP-encrypted segments

Any segment — local or remote, Drive or plain URL — whose filename ends in
`.gpg`, `.pgp`, or `.asc` is treated as PGP-encrypted (`looksEncrypted`,
extension-based, same style as `isLocal`/`driveId` detection). Decryption
uses [openpgp.js](https://openpgpjs.org), vendored locally at
`vendor/openpgp.min.js` rather than loaded from a CDN at runtime — unlike the
Google Identity Services script, this code handles private key material, so
it isn't fetched from a third party on every load.

- **Key loading**: the user either picks a private key file or pastes the
  key as base64 text, and enters a passphrase. Either input is read as raw
  bytes and sniffed for the `-----BEGIN PGP PRIVATE KEY BLOCK-----` marker
  to decide whether to call `openpgp.readPrivateKey` with `armoredKey` or
  `binaryKey` (`bytesToKeyMaterial`) — so both an armored file/paste and a
  raw binary key/paste work without the user having to say which. `openpgp.
  decryptKey` then unlocks it into `pgpDecryptionKey`, a module-level
  variable — never written to `localStorage`, never sent anywhere. "Clear
  Key" nulls it out immediately (and clears the passphrase and base64
  textarea too). Reloading the page also clears it, by construction
  (nothing persists it).
- **Decryption point**: happens in memory, right after the raw bytes are
  obtained and right before the segment is marked `ready` — in `runFetch`
  (network path) and `resolveLocalSegment` (local path) — both funnel
  through the same `decryptPgpBlob(blob, mimeGuess)` helper, so there's one
  code path regardless of where the ciphertext came from.
- **Format detection**: `decryptPgpBlob` sniffs the first bytes for the
  `-----BEGIN PGP MESSAGE-----` armor header; otherwise assumes binary
  OpenPGP packet format. Both are read via `openpgp.readMessage` and
  decrypted with `format: 'binary'`, producing a `Uint8Array` that's wrapped
  in a new `Blob` — this is the only representation of the decrypted video
  that ever exists, and it only exists as an in-memory object URL like any
  other segment's `blobUrl`.
- **MIME guessing**: since the "real" extension is hidden behind `.gpg` (e.g.
  `clip.mp4.gpg`), the encrypted extension is stripped and the remainder is
  looked up in a small extension→MIME table (`MIME_BY_EXT`), defaulting to
  `video/mp4` if unrecognized.
- **Missing key handling**: if a segment is encrypted and no key is loaded,
  both fetch paths short-circuit into an `error` state ("Encrypted — load
  your PGP private key…") without even downloading the ciphertext over the
  network. Loading a key afterward (`refreshEncryptedSegments`) resets any
  such errors back to `pending` and re-triggers `prefetchAround` from the
  current playhead — respecting the same network prefetch window as any
  other remote segment, since an actual download (not just cheap
  object-URL wrapping) is still involved.

## Gapless playback

Two `<video>` elements are stacked in the same box (`videoA` / `videoB`).
One is `active` (visible, playing); the other is the standby, preloaded with
the next ready segment.

- On `timeupdate`, once the active video is within `SWAP_LEAD_SECONDS` (0.15s)
  of its own duration, playback swaps to the standby element immediately
  (rather than waiting for the `ended` event), so the visible transition has
  no perceptible gap as long as the next segment was already buffered.
- `ended` is kept only as a fallback trigger, in case `timeupdate` granularity
  missed the lead window.
- If the next segment *isn't* ready in time, the app falls back to a visible
  "Buffering…" pause rather than glitching — an honest degradation, not a
  silent one.

This is a **practical near-gapless** technique, not frame-accurate MSE
stitching. True zero-gap playback would require Media Source Extensions with
a single `SourceBuffer`, which in turn requires all segments to share
compatible codec/container parameters — not something we can guarantee for
arbitrary user-supplied clips, so it was ruled out (see DECISIONS.md).

## Playlists

Pasted link lists can be saved/loaded/deleted by name under
`localStorage['segplayer:playlists']`. This is separate from the live segment
list built by "Load into Player" — saving/loading only touches the raw text,
so the user can freely edit order before building.

## Offline preprocessing script

`scripts/encrypt_segments.py` is a separate, standalone Python tool — it
doesn't run in the browser and isn't part of the client-only app itself. It
prepares a directory of source videos so the web app's local-file + PGP
features (above) have something to open: split into short chunks and
pre-encrypted, with a matching `playlist.txt` already sitting next to them.

- **Splitting**: for each video longer than `--seconds` (default 5), ffmpeg
  re-encodes `--seconds`-sized chunks via `-ss`/`-t` in a loop (rather than
  ffmpeg's segment-muxer with stream copy), because stream-copy splitting
  snaps cuts to the nearest keyframe and could produce a segment *longer*
  than the requested limit — re-encoding guarantees every chunk is exactly
  `--seconds` or less (verified: a 12s test clip split into 5s + 5s + 2s
  exactly). Videos already short enough are encrypted as-is, no re-encode.
- **Encryption**: each chunk (or whole short file) is PGP-encrypted with
  `pgpy`, producing binary (not armored) OpenPGP output, then written as
  `<name>.gpg` — matching the extension the web app's `looksEncrypted`
  check looks for.
- **Naming and ordering**: multi-part files get a zero-padded
  `_partNN` suffix (e.g. `clip_part01.mp4.gpg`, `clip_part02.mp4.gpg`);
  single-part files just get `.gpg` appended. This means a plain
  alphabetical sort of a directory's `.gpg` files already produces the
  correct playback order — no separate ordering metadata is needed, which
  is what lets `playlist.txt` just be `sorted(produced_filenames)`.
- **One playlist per directory**: the script walks the whole tree
  (`Path.rglob`), and any directory that directly contains video files gets
  its own `playlist.txt` listing only that directory's own `.gpg` files
  (bare filenames — the playlist and the segments it references always sit
  side by side). A subfolder's videos never appear in its parent's
  playlist, and vice versa.
- **Originals are kept by default** (`--delete-originals` opts into
  removing them) — deleting the user's only copy of source footage isn't
  something to default to.
- **Key input**: `pubkey` accepts a file path or the key as base64 text
  directly (`load_key_material`), covering both base64-of-armored and
  base64-of-raw-binary — `pgpy.PGPKey.from_blob` auto-detects which, once
  base64-decoded, so the script itself doesn't need to sniff for an armor
  header the way the web app does. Also `./install.sh` sets up ffmpeg and a
  `scripts/.venv` virtualenv for the Python deps on Ubuntu/Debian, since
  current releases block plain `pip install` outside a venv (PEP 668).

Verified end-to-end (not just self-consistency): a PGPy-encrypted `.gpg`
segment produced by this script was decrypted in an actual browser session
using the web app's `openpgp.js` pipeline, and the decrypted bytes'
SHA-256 matched the original source file exactly — confirming the two
independent OpenPGP implementations (Python/pgpy encrypting, JS/openpgp.js
decrypting) actually interoperate, not just that each round-trips with
itself.

## First-run setup

Two more scripts round out the offline tooling:

- **`scripts/generate_keys.py`** — generates the RSA key pair itself
  (`pgpy.PGPKey.new` + `.protect(passphrase, ...)`), prompting interactively
  for a passphrase (`getpass`, never a CLI flag — passphrases on the
  command line end up in shell history and process listings). Writes
  `public.asc`/`private.asc` into `scripts/keys/` by default, and refuses
  to overwrite either file if it already exists — regenerating a key pair
  on top of an existing one would silently strand anything already
  encrypted with the old key.
- **`scripts/first_run.sh`** — the actual "first run" entry point: calls
  `install.sh` (ffmpeg + venv), then runs `generate_keys.py` through that
  venv's Python, then prints the exact `encrypt_segments.py` invocation to
  use next. Both steps it calls are individually idempotent, so re-running
  `first_run.sh` on an already-set-up checkout is safe — it just stops at
  whichever step already has something in place.
- **`.gitignore`** at the project root excludes `scripts/keys/` and
  `scripts/.venv/` — added specifically because `generate_keys.py`'s
  default output location is inside the repo tree, and this project may
  end up pushed to GitHub (see Hosting, below); a private key landing in
  `scripts/keys/` must never get swept up by a `git add .`.

Tested: key generation, the overwrite-refusal guard, and the resulting key
pair's compatibility with `encrypt_segments.py` were all verified directly
(the interactive `getpass` prompt itself could not be driven the same way
in this sandboxed session — Windows' `getpass` reads straight from the
console and ignores piped stdin, unlike Linux, where it falls back to
stdin — so that specific UX is unverified on the user's actual Ubuntu
target, though it's standard library behavior).

## Google Drive integration

Two independent capabilities, both client-side only:

1. **Playback of a Drive link** — works anonymously for files shared "Anyone
   with the link" via the `uc?export=download` URL form. Fails with a clear
   CORS/HTML-response error for private files unless signed in (see below).
2. **Importing a folder's contents** — requires Google sign-in. Uses Google
   Identity Services' token client (`google.accounts.oauth2.initTokenClient`)
   to obtain a short-lived OAuth access token entirely in the browser (no
   backend, no refresh token, token kept in a JS variable only — never
   persisted). The Drive API `files.list` is queried for
   `'<folderId>' in parents and mimeType contains 'video/'`, paginated via
   `nextPageToken`, sorted with a natural (numeric-aware) filename comparator,
   and appended to the textarea as canonical `file/d/<id>/view` links.

Both capabilities share the same `driveId` extraction logic, so a signed-in
user gets authenticated fetches for *any* Drive link in the list, whether it
was pasted manually or imported from a folder.

## Hosting

Static files only — deployable as-is to GitHub Pages or any static host. The
one hosting-relevant gotcha: the OAuth Client ID's **Authorized JavaScript
origins** (Google Cloud Console) must include the exact origin the app is
served from, or sign-in will fail with an origin-mismatch error.
