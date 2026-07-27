(() => {
  const STORAGE_KEY = 'segplayer:playlists';
  const CLIENT_ID_KEY = 'segplayer:driveClientId';
  const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
  const PREFETCH_WINDOW = 2; // fetch current + this many ahead
  const MAX_CONCURRENT_FETCHES = 3;
  const SWAP_LEAD_SECONDS = 0.15; // start swap slightly before natural end

  const linksInput = document.getElementById('linksInput');
  const playlistName = document.getElementById('playlistName');
  const savedSelect = document.getElementById('savedSelect');
  const saveBtn = document.getElementById('saveBtn');
  const loadBtn = document.getElementById('loadBtn');
  const deleteBtn = document.getElementById('deleteBtn');
  const buildBtn = document.getElementById('buildBtn');
  const playBtn = document.getElementById('playBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const stopBtn = document.getElementById('stopBtn');
  const progressLabel = document.getElementById('progressLabel');
  const segmentListEl = document.getElementById('segmentList');
  const stageOverlay = document.getElementById('stageOverlay');
  const videoA = document.getElementById('videoA');
  const videoB = document.getElementById('videoB');
  const clientIdInput = document.getElementById('clientIdInput');
  const signInBtn = document.getElementById('signInBtn');
  const authStatus = document.getElementById('authStatus');
  const folderInput = document.getElementById('folderInput');
  const importFolderBtn = document.getElementById('importFolderBtn');
  const importStatus = document.getElementById('importStatus');
  const chooseFolderBtn = document.getElementById('chooseFolderBtn');
  const folderPicker = document.getElementById('folderPicker');
  const localFolderStatus = document.getElementById('localFolderStatus');
  const pgpKeyFileInput = document.getElementById('pgpKeyFile');
  const pgpKeyB64Input = document.getElementById('pgpKeyB64');
  const pgpPassphraseInput = document.getElementById('pgpPassphrase');
  const pgpLoadKeyBtn = document.getElementById('pgpLoadKeyBtn');
  const pgpClearKeyBtn = document.getElementById('pgpClearKeyBtn');
  const pgpKeyStatus = document.getElementById('pgpKeyStatus');

  /** @type {Array<{raw:string, resolved:string, driveId:?string, isLocal:boolean, isEncrypted:boolean, state:string, blobUrl:?string, error:?string}>} */
  let segments = [];
  let activeEl = videoA;
  let standbyEl = videoB;
  let playIndex = -1;
  let swapArmed = false;
  let fetchQueue = [];
  let activeFetches = 0;
  let tokenClient = null;
  let accessToken = null;
  let localByPath = new Map(); // lowercase relative path -> File
  let localByName = new Map(); // lowercase basename -> File[]
  let pgpDecryptionKey = null; // unlocked openpgp private key, memory-only
  let localFolderChosen = false;

  // ---------- Local folder matching ----------
  function isHttpUrl(raw) {
    try {
      const u = new URL(raw.trim());
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }

  chooseFolderBtn.addEventListener('click', () => folderPicker.click());

  folderPicker.addEventListener('change', () => {
    const files = Array.from(folderPicker.files || []);
    localByPath = new Map();
    localByName = new Map();
    files.forEach(f => {
      const rel = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
      const stripped = rel.includes('/') ? rel.slice(rel.indexOf('/') + 1) : rel;
      localByPath.set(stripped.toLowerCase(), f);
      localByPath.set(rel.toLowerCase(), f);
      const base = f.name.toLowerCase();
      if (!localByName.has(base)) localByName.set(base, []);
      localByName.get(base).push(f);
    });
    localFolderChosen = files.length > 0;
    localFolderStatus.textContent = files.length
      ? `${files.length} file(s) loaded from folder`
      : 'No local folder selected';
    refreshLocalSegments(true);
  });

  function resolveLocalFile(raw) {
    const cleaned = raw.trim().replace(/^\.\//, '').replace(/\\/g, '/');
    if (cleaned.includes('/')) {
      const hit = localByPath.get(cleaned.toLowerCase());
      if (hit) return hit;
    }
    const base = cleaned.split('/').pop().toLowerCase();
    const matches = localByName.get(base);
    if (matches && matches.length === 1) return matches[0];
    if (matches && matches.length > 1) return { ambiguous: true, count: matches.length };
    return null;
  }

  function refreshLocalSegments(force) {
    segments.forEach((seg, i) => {
      if (!seg.isLocal) return;
      if (seg.state === 'playing' || seg.state === 'played') return;
      if (force) {
        seg.state = 'pending';
        seg.error = null;
      }
      ensureFetched(i);
    });
  }

  // ---------- PGP decryption ----------
  const PGP_EXT_RE = /\.(gpg|pgp|asc)$/i;
  const MIME_BY_EXT = {
    mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime',
    webm: 'video/webm', ogg: 'video/ogg', ogv: 'video/ogg', mkv: 'video/x-matroska',
  };

  function looksEncrypted(raw) {
    return PGP_EXT_RE.test(raw.trim().split(/[?#]/)[0]);
  }

  function guessDecryptedMime(raw) {
    const clean = raw.trim().split(/[?#]/)[0].replace(PGP_EXT_RE, '');
    const ext = clean.split('.').pop().toLowerCase();
    return MIME_BY_EXT[ext] || 'video/mp4';
  }

  async function decryptPgpBlob(blob, mimeGuess) {
    if (!pgpDecryptionKey) throw new Error('PGP key not loaded');
    const buf = new Uint8Array(await blob.arrayBuffer());
    const head = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, 40));
    const message = head.includes('-----BEGIN PGP MESSAGE-----')
      ? await openpgp.readMessage({ armoredMessage: new TextDecoder().decode(buf) })
      : await openpgp.readMessage({ binaryMessage: buf });
    const { data } = await openpgp.decrypt({
      message,
      decryptionKeys: pgpDecryptionKey,
      format: 'binary',
    });
    return new Blob([data], { type: mimeGuess });
  }

  function updatePgpStatus(text) {
    pgpKeyStatus.textContent = text;
  }

  // Detects whether a byte buffer is armored ASCII text or a raw binary
  // OpenPGP key, since openpgp.js (unlike pgpy on the script side) needs
  // to be told which one it's reading.
  function bytesToKeyMaterial(bytes) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (text.includes('-----BEGIN PGP PRIVATE KEY BLOCK-----')) {
      return { armoredKey: text };
    }
    return { binaryKey: bytes };
  }

  async function readKeyMaterial() {
    const b64 = pgpKeyB64Input.value.trim();
    if (b64) {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      return bytesToKeyMaterial(bytes);
    }
    const file = pgpKeyFileInput.files[0];
    if (file) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      return bytesToKeyMaterial(bytes);
    }
    return null;
  }

  pgpLoadKeyBtn.addEventListener('click', async () => {
    const passphrase = pgpPassphraseInput.value;
    updatePgpStatus('Loading key…');
    try {
      const material = await readKeyMaterial();
      if (!material) throw new Error('Choose a private key file or paste a base64-encoded key first.');
      const privateKey = await openpgp.readPrivateKey(material);
      pgpDecryptionKey = await openpgp.decryptKey({ privateKey, passphrase });
      updatePgpStatus('Key loaded and unlocked.');
      pgpPassphraseInput.value = '';
      pgpKeyB64Input.value = '';
      refreshEncryptedSegments();
    } catch (err) {
      pgpDecryptionKey = null;
      updatePgpStatus('Failed to load key: ' + (err.message || err));
    }
  });

  pgpClearKeyBtn.addEventListener('click', () => {
    pgpDecryptionKey = null;
    pgpPassphraseInput.value = '';
    pgpKeyB64Input.value = '';
    updatePgpStatus('No key loaded');
  });

  function refreshEncryptedSegments() {
    segments.forEach(seg => {
      if (!seg.isEncrypted) return;
      if (seg.state === 'playing' || seg.state === 'played') return;
      if (seg.state === 'error') {
        seg.state = 'pending';
        seg.error = null;
      }
    });
    prefetchAround(Math.max(playIndex, 0));
  }

  // ---------- Google Drive URL resolution ----------
  function extractDriveId(raw) {
    const url = (raw || '').trim();
    if (!url) return null;
    try {
      const u = new URL(url);
      if (!u.hostname.includes('drive.google.com')) return null;
      const fileMatch = u.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
      if (fileMatch) return fileMatch[1];
      const idParam = u.searchParams.get('id');
      if (idParam) return idParam;
    } catch {
      // not a valid absolute URL
    }
    return null;
  }

  function resolveUrl(raw) {
    const url = raw.trim();
    if (!url) return url;
    const id = extractDriveId(url);
    if (id) return `https://drive.google.com/uc?export=download&id=${id}`;
    return url;
  }

  // ---------- Playlist persistence ----------
  function loadAllPlaylists() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch {
      return {};
    }
  }

  function refreshSavedSelect() {
    const all = loadAllPlaylists();
    savedSelect.innerHTML = '<option value="">Saved playlists…</option>';
    Object.keys(all).sort().forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      savedSelect.appendChild(opt);
    });
  }

  saveBtn.addEventListener('click', () => {
    const name = playlistName.value.trim();
    if (!name) { alert('Enter a playlist name first.'); return; }
    const lines = linksInput.value.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) { alert('Paste at least one link first.'); return; }
    const all = loadAllPlaylists();
    all[name] = lines;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    refreshSavedSelect();
    savedSelect.value = name;
  });

  loadBtn.addEventListener('click', () => {
    const name = savedSelect.value;
    if (!name) { alert('Choose a saved playlist first.'); return; }
    const all = loadAllPlaylists();
    linksInput.value = (all[name] || []).join('\n');
    playlistName.value = name;
  });

  deleteBtn.addEventListener('click', () => {
    const name = savedSelect.value;
    if (!name) { alert('Choose a saved playlist first.'); return; }
    if (!confirm(`Delete saved playlist "${name}"?`)) return;
    const all = loadAllPlaylists();
    delete all[name];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    refreshSavedSelect();
  });

  // ---------- Building the segment list ----------
  buildBtn.addEventListener('click', () => {
    resetPlayback();
    const lines = linksInput.value.split('\n').map(l => l.trim()).filter(Boolean);
    segments = lines.map(raw => {
      const isLocal = !isHttpUrl(raw);
      return {
        raw,
        resolved: isLocal ? raw : resolveUrl(raw),
        driveId: isLocal ? null : extractDriveId(raw),
        isLocal,
        isEncrypted: looksEncrypted(raw),
        state: 'pending',
        blobUrl: null,
        error: null,
      };
    });
    renderSegmentList();
    playBtn.disabled = segments.length === 0;
    stageOverlay.textContent = segments.length ? 'Ready to play' : 'No playlist loaded';
    stageOverlay.classList.remove('hidden');
    if (segments.length) {
      refreshLocalSegments(false);
      prefetchAround(0);
    }
  });

  function renderSegmentList() {
    segmentListEl.innerHTML = '';
    segments.forEach((seg, i) => {
      const li = document.createElement('li');
      li.className = 'segment-item' + (i === playIndex ? ' current' : '');
      li.dataset.index = String(i);

      const idx = document.createElement('span');
      idx.className = 'segment-index';
      idx.textContent = String(i + 1);

      const urlSpan = document.createElement('span');
      urlSpan.className = 'segment-url';
      urlSpan.textContent = seg.raw;
      urlSpan.title = seg.raw;

      const badge = document.createElement('span');
      badge.className = 'badge badge-' + seg.state;
      badge.textContent = seg.state;

      li.appendChild(idx);
      li.appendChild(urlSpan);
      li.appendChild(badge);

      if (seg.state === 'error' && seg.error) {
        const err = document.createElement('span');
        err.className = 'error-msg';
        err.textContent = seg.error;
        li.appendChild(err);
      }

      li.addEventListener('click', () => jumpTo(i));
      segmentListEl.appendChild(li);
    });
    progressLabel.textContent = segments.length
      ? `Segment ${playIndex >= 0 ? playIndex + 1 : '-'} / ${segments.length}`
      : '';
  }

  function setSegState(i, state, extra = {}) {
    if (!segments[i]) return;
    Object.assign(segments[i], { state }, extra);
    renderSegmentList();
  }

  // ---------- Fetching segments to memory ----------
  const BUSY_STATES = ['ready', 'downloading', 'decrypting', 'playing', 'played'];

  function ensureFetched(i) {
    const seg = segments[i];
    if (!seg || BUSY_STATES.includes(seg.state)) return;
    if (seg.state === 'error') return; // don't auto-retry failed segments
    if (seg.isLocal) {
      resolveLocalSegment(i);
      return;
    }
    seg.state = 'queued';
    fetchQueue.push(i);
    pumpFetchQueue();
  }

  async function resolveLocalSegment(i) {
    const seg = segments[i];
    const result = resolveLocalFile(seg.raw);
    if (!result) {
      setSegState(i, 'error', {
        error: localFolderChosen
          ? 'File not found in the selected folder'
          : 'Open the local folder containing this file',
      });
      return;
    }
    if (result.ambiguous) {
      setSegState(i, 'error', {
        error: `Multiple files named "${seg.raw.split('/').pop()}" found in the folder — use a relative path to disambiguate`,
      });
      return;
    }
    if (!seg.isEncrypted) {
      seg.blobUrl = URL.createObjectURL(result);
      setSegState(i, 'ready');
      return;
    }
    if (!pgpDecryptionKey) {
      setSegState(i, 'error', { error: 'Encrypted — load your PGP private key to play this segment' });
      return;
    }
    setSegState(i, 'decrypting');
    try {
      const finalBlob = await decryptPgpBlob(result, guessDecryptedMime(seg.raw));
      seg.blobUrl = URL.createObjectURL(finalBlob);
      setSegState(i, 'ready');
    } catch (err) {
      setSegState(i, 'error', { error: 'Decryption failed: ' + (err.message || err) });
    }
  }

  function pumpFetchQueue() {
    while (activeFetches < MAX_CONCURRENT_FETCHES && fetchQueue.length) {
      const i = fetchQueue.shift();
      runFetch(i);
    }
  }

  async function runFetch(i) {
    const seg = segments[i];
    if (!seg) return;
    if (seg.isEncrypted && !pgpDecryptionKey) {
      setSegState(i, 'error', { error: 'Encrypted — load your PGP private key to play this segment' });
      return;
    }
    activeFetches++;
    setSegState(i, 'downloading');
    try {
      const useAuth = seg.driveId && accessToken;
      const url = useAuth
        ? `https://www.googleapis.com/drive/v3/files/${seg.driveId}?alt=media`
        : seg.resolved;
      const res = await fetch(url, {
        mode: 'cors',
        headers: useAuth ? { Authorization: `Bearer ${accessToken}` } : undefined,
      });
      if (!res.ok) {
        if (res.status === 401) {
          accessToken = null;
          updateAuthUi();
        }
        throw new Error(`HTTP ${res.status}`);
      }
      let blob = await res.blob();
      if (!seg.isEncrypted && blob.size < 2048 && /text|html/.test(blob.type)) {
        throw new Error('Response looks like an HTML page, not a video (Drive warning/permission page, or sign-in required for a private file)');
      }
      if (seg.isEncrypted) {
        setSegState(i, 'decrypting');
        blob = await decryptPgpBlob(blob, guessDecryptedMime(seg.raw));
      }
      seg.blobUrl = URL.createObjectURL(blob);
      setSegState(i, 'ready');
    } catch (err) {
      setSegState(i, 'error', { error: describeFetchError(err) });
    } finally {
      activeFetches--;
      pumpFetchQueue();
    }
  }

  function describeFetchError(err) {
    const msg = err && err.message ? err.message : String(err);
    if (msg.toLowerCase().includes('failed to fetch')) {
      return 'Blocked by CORS or network — the host must allow cross-origin requests to be readable client-side.';
    }
    if (msg.includes('401')) {
      return 'Google sign-in expired or lacks access — sign in again.';
    }
    return msg;
  }

  function prefetchAround(i) {
    for (let k = i; k <= i + PREFETCH_WINDOW && k < segments.length; k++) {
      ensureFetched(k);
    }
  }

  // ---------- Playback ----------
  function waitUntilReady(i) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const seg = segments[i];
        if (!seg) return reject(new Error('Segment missing'));
        if (seg.state === 'ready' || seg.state === 'playing' || seg.state === 'played') return resolve();
        if (seg.state === 'error') return reject(new Error(seg.error || 'Fetch failed'));
        setTimeout(check, 100);
      };
      check();
    });
  }

  async function jumpTo(i) {
    if (i < 0 || i >= segments.length) return;
    stopPlaybackInternal(false);
    playIndex = i;
    prefetchAround(i);
    stageOverlay.textContent = 'Buffering…';
    stageOverlay.classList.remove('hidden');
    try {
      await waitUntilReady(i);
      assignAndPlay(activeEl, i);
      stageOverlay.classList.add('hidden');
      pauseBtn.disabled = false;
      stopBtn.disabled = false;
      prepareStandby();
    } catch (err) {
      stageOverlay.textContent = 'Failed to load segment ' + (i + 1);
      stageOverlay.classList.remove('hidden');
    }
  }

  function assignAndPlay(el, i) {
    const seg = segments[i];
    el.src = seg.blobUrl;
    el.currentTime = 0;
    el.classList.add('active');
    (el === activeEl ? standbyEl : activeEl).classList.remove('active');
    setSegState(i, 'playing');
    const p = el.play();
    if (p && p.catch) {
      p.catch(() => {
        stageOverlay.textContent = 'Click Play to start (autoplay blocked)';
        stageOverlay.classList.remove('hidden');
      });
    }
  }

  function prepareStandby() {
    swapArmed = false;
    const nextIndex = playIndex + 1;
    if (nextIndex >= segments.length) return;
    prefetchAround(nextIndex);
    waitUntilReady(nextIndex).then(() => {
      if (playIndex + 1 !== nextIndex) return; // playhead moved on (e.g. user jumped)
      standbyEl.src = segments[nextIndex].blobUrl;
      standbyEl.load();
    }).catch(() => {
      // will surface as an error badge; onTimeUpdate fallback below handles the stall
    });
  }

  function onTimeUpdate() {
    if (playIndex < 0 || swapArmed) return;
    const el = activeEl;
    if (!el.duration || !isFinite(el.duration)) return;
    if (el.duration - el.currentTime <= SWAP_LEAD_SECONDS) {
      swapArmed = true;
      advance();
    }
  }

  function onEnded() {
    if (!swapArmed) advance();
  }

  function advance() {
    const finishedIndex = playIndex;
    const nextIndex = playIndex + 1;
    setSegState(finishedIndex, 'played');

    if (nextIndex >= segments.length) {
      progressLabel.textContent = `Segment ${segments.length} / ${segments.length} — done`;
      return;
    }

    const nextSeg = segments[nextIndex];
    if (nextSeg.state !== 'ready' || !standbyEl.src) {
      // next clip not buffered in time; fall back to a short buffering pause
      stageOverlay.textContent = 'Buffering…';
      stageOverlay.classList.remove('hidden');
      waitUntilReady(nextIndex).then(() => {
        playIndex = nextIndex;
        assignAndPlay(activeEl.classList.contains('active') ? activeEl : standbyEl, nextIndex);
        stageOverlay.classList.add('hidden');
        prepareStandby();
      }).catch(() => {
        stageOverlay.textContent = 'Failed to load segment ' + (nextIndex + 1);
      });
      return;
    }

    // swap active/standby
    const oldActive = activeEl;
    activeEl = standbyEl;
    standbyEl = oldActive;

    playIndex = nextIndex;
    setSegState(nextIndex, 'playing');
    activeEl.classList.add('active');
    standbyEl.classList.remove('active');
    activeEl.currentTime = 0;
    const p = activeEl.play();
    if (p && p.catch) p.catch(() => {});

    // release the memory for the segment we just left, then prep the one after next
    const oldUrl = segments[finishedIndex]?.blobUrl;
    if (oldUrl) URL.revokeObjectURL(oldUrl);

    prepareStandby();
    renderSegmentList();
  }

  playBtn.addEventListener('click', () => {
    if (!segments.length) return;
    if (playIndex === -1) {
      jumpTo(0);
    } else {
      const p = activeEl.play();
      if (p && p.catch) p.catch(() => {});
      pauseBtn.disabled = false;
    }
  });

  pauseBtn.addEventListener('click', () => {
    activeEl.pause();
  });

  stopBtn.addEventListener('click', () => stopPlaybackInternal(true));

  function stopPlaybackInternal(resetStatuses) {
    videoA.pause();
    videoB.pause();
    videoA.removeAttribute('src');
    videoB.removeAttribute('src');
    videoA.classList.remove('active');
    videoB.classList.remove('active');
    playIndex = -1;
    swapArmed = false;
    pauseBtn.disabled = true;
    if (resetStatuses) {
      segments.forEach(seg => {
        if (seg.blobUrl) URL.revokeObjectURL(seg.blobUrl);
        seg.blobUrl = null;
        seg.state = 'pending';
        seg.error = null;
      });
      fetchQueue = [];
      stopBtn.disabled = true;
      stageOverlay.textContent = 'Ready to play';
      stageOverlay.classList.remove('hidden');
      renderSegmentList();
      if (segments.length) {
        refreshLocalSegments(false);
        prefetchAround(0);
      }
    }
  }

  function resetPlayback() {
    stopPlaybackInternal(true);
    segments = [];
    playIndex = -1;
  }

  videoA.addEventListener('timeupdate', () => { if (activeEl === videoA) onTimeUpdate(); });
  videoB.addEventListener('timeupdate', () => { if (activeEl === videoB) onTimeUpdate(); });
  videoA.addEventListener('ended', () => { if (activeEl === videoA) onEnded(); });
  videoB.addEventListener('ended', () => { if (activeEl === videoB) onEnded(); });

  // ---------- Google sign-in (Drive folder import) ----------
  function updateAuthUi() {
    authStatus.textContent = accessToken ? 'Signed in' : 'Not signed in';
    importFolderBtn.disabled = !accessToken;
  }

  clientIdInput.value = localStorage.getItem(CLIENT_ID_KEY) || '';

  function getTokenClient() {
    const clientId = clientIdInput.value.trim();
    if (!clientId) { alert('Enter your Google OAuth Client ID first.'); return null; }
    localStorage.setItem(CLIENT_ID_KEY, clientId);
    if (!window.google || !google.accounts || !google.accounts.oauth2) {
      alert('Google Identity Services failed to load (check your network connection).');
      return null;
    }
    if (!tokenClient || tokenClient.__clientId !== clientId) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: DRIVE_SCOPE,
        callback: (resp) => {
          if (resp.error) {
            alert('Google sign-in failed: ' + resp.error);
            return;
          }
          accessToken = resp.access_token;
          updateAuthUi();
        },
      });
      tokenClient.__clientId = clientId;
    }
    return tokenClient;
  }

  signInBtn.addEventListener('click', () => {
    const tc = getTokenClient();
    if (!tc) return;
    tc.requestAccessToken({ prompt: accessToken ? '' : 'consent' });
  });

  // ---------- Import segments from a Drive folder ----------
  function extractFolderId(raw) {
    const val = (raw || '').trim();
    if (!val) return null;
    try {
      const u = new URL(val);
      const folderMatch = u.pathname.match(/\/folders\/([a-zA-Z0-9_-]+)/);
      if (folderMatch) return folderMatch[1];
      const idParam = u.searchParams.get('id');
      if (idParam) return idParam;
      return null;
    } catch {
      // not a URL — treat the raw input as a bare folder ID
      return /^[a-zA-Z0-9_-]+$/.test(val) ? val : null;
    }
  }

  function naturalCompare(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  }

  async function listDriveFolder(folderId) {
    const files = [];
    let pageToken = '';
    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false and mimeType contains 'video/'`);
    do {
      const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=nextPageToken,files(id,name,mimeType)&pageSize=1000&orderBy=name` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
      const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message || `HTTP ${res.status}`);
      }
      const data = await res.json();
      files.push(...(data.files || []));
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    return files;
  }

  importFolderBtn.addEventListener('click', async () => {
    if (!accessToken) { alert('Sign in with Google first.'); return; }
    const folderId = extractFolderId(folderInput.value);
    if (!folderId) { alert('Enter a valid Drive folder link or ID.'); return; }
    importStatus.textContent = 'Listing folder…';
    importFolderBtn.disabled = true;
    try {
      const files = await listDriveFolder(folderId);
      if (!files.length) {
        importStatus.textContent = 'No video files found in that folder.';
        return;
      }
      files.sort((a, b) => naturalCompare(a.name, b.name));
      const links = files.map(f => `https://drive.google.com/file/d/${f.id}/view`);
      const existing = linksInput.value.split('\n').map(l => l.trim()).filter(Boolean);
      linksInput.value = existing.concat(links).join('\n');
      importStatus.textContent = `Added ${files.length} file(s), sorted by name. Review order below, then Load into Player.`;
    } catch (err) {
      importStatus.textContent = 'Import failed: ' + (err.message || err);
    } finally {
      importFolderBtn.disabled = !accessToken;
    }
  });

  updateAuthUi();
  refreshSavedSelect();
})();
