/* Shared front-end helpers for all portals. Exposes window.api, toast, esc, lightbox, Uploader. */
(function () {
  'use strict';

  async function request(method, url, body) {
    const opts = { method, headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await fetch(url, opts);
    if (r.status === 401 && !url.endsWith('/api/login')) { location.href = '/login'; throw new Error('Session expired'); }
    let data = null;
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) data = await r.json(); else data = await r.text();
    if (!r.ok) {
      let msg = (data && data.detail) || r.statusText || 'Request failed';
      if (Array.isArray(msg)) msg = msg.map(d => d.msg || JSON.stringify(d)).join('; ');
      const e = new Error(msg); e.status = r.status; e.data = data; throw e;
    }
    return data;
  }
  window.api = {
    get: (u) => request('GET', u), post: (u, b) => request('POST', u, b ?? {}),
    put: (u, b) => request('PUT', u, b ?? {}), del: (u) => request('DELETE', u),
  };

  window.esc = function (s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  };
  window.qs = (sel, root) => (root || document).querySelector(sel);
  window.qsa = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  window.fmtDateTime = (iso) => { if (!iso) return ''; const d = new Date(iso); return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); };
  window.debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  window.toast = function (msg, kind) {
    const cam = document.querySelector('dialog.camera-dlg[open]');  // the modal camera sits in the top layer
    const box = (cam && cam.querySelector('.toasts')) || document.getElementById('toasts'); if (!box) return alert(msg);
    const el = document.createElement('div'); el.className = 'toast ' + (kind || ''); el.textContent = msg;
    box.appendChild(el); setTimeout(() => el.remove(), kind === 'bad' ? 6000 : 3000);
  };

  /* ---------- lightbox: lightbox.open([{url, caption}], index) ---------- */
  const lb = { items: [], i: 0 };
  function lbShow() {
    const d = document.getElementById('lightbox'); const it = lb.items[lb.i]; if (!d || !it) return;
    d.querySelector('img').src = it.url; d.querySelector('.lb-cap').textContent = (it.caption || '') + (lb.items.length > 1 ? `  (${lb.i + 1}/${lb.items.length})` : '');
    d.querySelector('.lb-prev').style.display = d.querySelector('.lb-next').style.display = lb.items.length > 1 ? '' : 'none';
  }
  window.lightbox = {
    open(items, index) { const d = document.getElementById('lightbox'); lb.items = items; lb.i = index || 0; lbShow(); if (!d.open) d.showModal(); },
  };
  document.addEventListener('DOMContentLoaded', () => {
    const d = document.getElementById('lightbox');
    if (d) {
      d.querySelector('.lb-close').onclick = () => d.close();
      d.querySelector('.lb-prev').onclick = (e) => { e.stopPropagation(); lb.i = (lb.i - 1 + lb.items.length) % lb.items.length; lbShow(); };
      d.querySelector('.lb-next').onclick = (e) => { e.stopPropagation(); lb.i = (lb.i + 1) % lb.items.length; lbShow(); };
      d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
      d.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') d.querySelector('.lb-prev').click(); if (e.key === 'ArrowRight') d.querySelector('.lb-next').click(); });
    }
    const lo = document.getElementById('btnLogout');
    if (lo) lo.onclick = async () => { try { await api.post('/api/logout'); } finally { location.href = '/login'; } };
    const cp = document.getElementById('btnChangePw'), pd = document.getElementById('pwDialog');
    if (cp && pd) {
      cp.onclick = () => { pd.querySelector('form').reset(); pd.showModal(); };
      document.getElementById('pwSave').onclick = async () => {
        const f = document.getElementById('pwForm');
        if (!f.reportValidity()) return;
        try { await api.post('/api/change-password', { current_password: f.current_password.value, new_password: f.new_password.value }); pd.close(); toast('Password changed', 'ok'); }
        catch (e) { toast(e.message, 'bad'); }
      };
    }
  });

  /* ---------- image helpers ---------- */
  async function sha256Hex(buf) {
    try { if (!crypto.subtle) return ''; const h = await crypto.subtle.digest('SHA-256', buf); return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join(''); }
    catch (_) { return ''; }
  }
  // Minimal EXIF DateTimeOriginal reader for JPEG -> "YYYY-MM-DD HH:MM:SS" or ''
  function exifDate(buf) {
    try {
      const v = new DataView(buf); if (v.getUint16(0) !== 0xFFD8) return '';
      let off = 2;
      while (off < v.byteLength - 4) {
        const marker = v.getUint16(off); const len = v.getUint16(off + 2);
        if (marker === 0xFFE1 && v.getUint32(off + 4) === 0x45786966) {
          const t = off + 10; const le = v.getUint16(t) === 0x4949;
          const u16 = (o) => v.getUint16(o, le), u32 = (o) => v.getUint32(o, le);
          const readStr = (o, n) => { let s = ''; for (let i = 0; i < n - 1; i++) s += String.fromCharCode(v.getUint8(o + i)); return s; };
          const scan = (ifd, wantTag) => {
            const n = u16(ifd);
            for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (u16(e) === wantTag) return e; }
            return -1;
          };
          const ifd0 = t + u32(t + 4); let dt = '';
          const exifPtr = scan(ifd0, 0x8769);
          if (exifPtr >= 0) { const sub = t + u32(exifPtr + 8); const e = scan(sub, 0x9003); if (e >= 0) dt = readStr(t + u32(e + 8), 20); }
          if (!dt) { const e = scan(ifd0, 0x0132); if (e >= 0) dt = readStr(t + u32(e + 8), 20); }
          if (!/^\d{4}:\d\d:\d\d \d\d:\d\d:\d\d/.test(dt)) return '';
          return dt.slice(0, 10).replace(/:/g, '-') + dt.slice(10, 19);
        }
        if ((marker & 0xFF00) !== 0xFF00) break;
        off += 2 + len;
      }
    } catch (_) { }
    return '';
  }
  // Downscale large photos in the browser so uploads are fast on mobile data.
  async function compress(file) {
    const MAX = 1920;
    if (file.size < 1.2 * 1024 * 1024 && /jpe?g$/i.test(file.type)) return file;
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
      if (!blob) return file;
      return new File([blob], (file.name || 'photo').replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
    } catch (_) { return file; }
  }

  /**
   * Upload one image with progress.
   *   uploadImage(file, {kind, date, sr_id}, onProgress(pct, phase)) -> Promise<imageJson>
   * phase: 'preparing' | 'uploading' | 'processing'
   */
  window.uploadImage = async function (file, fields, onProgress) {
    onProgress && onProgress(0, 'preparing');
    const buf = await file.arrayBuffer();
    const [hash, taken] = [await sha256Hex(buf), exifDate(buf)];
    const toSend = await compress(file);
    const fd = new FormData();
    fd.append('file', toSend, toSend.name || 'photo.jpg');
    Object.entries(fields || {}).forEach(([k, v]) => { if (v !== undefined && v !== null) fd.append(k, v); });
    fd.append('orig_sha256', hash); fd.append('taken_at', taken);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/images');
      xhr.setRequestHeader('X-Requested-With', 'fetch');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(Math.round(e.loaded / e.total * 100), e.loaded >= e.total ? 'processing' : 'uploading'); };
      xhr.onload = () => {
        let data = null; try { data = JSON.parse(xhr.responseText); } catch (_) { }
        if (xhr.status >= 200 && xhr.status < 300) { onProgress && onProgress(100, 'done'); resolve(data); }
        else { if (xhr.status === 401) location.href = '/login'; reject(new Error((data && data.detail) || ('Upload failed (' + xhr.status + ')'))); }
      };
      xhr.onerror = () => reject(new Error('Network error — check your connection and retry'));
      xhr.ontimeout = () => reject(new Error('Upload timed out'));
      xhr.timeout = 5 * 60 * 1000;
      xhr.send(fd);
    });
  };

  function flagHtml(img) {
    if (img.duplicate) return '<span class="flag" title="This exact photo was uploaded before">REUSED</span>';
    if (img.old_photo) return `<span class="flag" title="Photo taken ${esc(img.taken_at)}">OLD</span>`;
    return '';
  }

  /** Render a read-only/editable thumbnail strip.
   *  renderThumbs(container, images, {canDelete, onDelete(img), caption(img)}) */
  window.renderThumbs = function (container, images, opts) {
    opts = opts || {};
    container.innerHTML = '';
    const items = images.map(img => ({ url: img.url, caption: opts.caption ? opts.caption(img) : (img.original_name || '') }));
    images.forEach((img, i) => {
      const t = document.createElement('div'); t.className = 'thumb';
      t.innerHTML = `<img loading="lazy" src="${esc(img.thumb_url)}" alt="photo">${flagHtml(img)}` + (opts.canDelete ? '<button class="del" type="button" title="Remove">×</button>' : '');
      t.querySelector('img').onclick = () => lightbox.open(items, i);
      if (opts.canDelete) t.querySelector('.del').onclick = (e) => { e.stopPropagation(); opts.onDelete && opts.onDelete(img); };
      container.appendChild(t);
    });
  };

  /* ---------- live camera capture ---------- */
  // Photos are taken live with the device camera — there is deliberately NO gallery picker.
  // Preferred path: in-page camera (getUserMedia). Fallback (only when getUserMedia is unavailable, e.g. very old
  // browsers or a non-HTTPS origin): <input type=file accept=image/* capture=environment>, which on Android Chrome
  // opens the camera app directly. Every upload is tagged source=camera|capture_input (server enforces CAMERA_ONLY).
  const CAM_MAX_PX = 1920, CAM_QUALITY = 0.85;
  window.cameraSupported = function () {
    return !!(window.isSecureContext !== false && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function');
  };
  const CAM_HELP_BLOCKED = 'Camera access is blocked for this site. To allow it in Chrome: tap the icon to the left of the web address ' +
    '(lock / settings icon) → Permissions (or "Site settings") → Camera → Allow. Then tap "Try again". ' +
    'If Chrome itself has no camera permission: Android Settings → Apps → Chrome → Permissions → Camera → Allow.';
  function camErrorText(e) {
    const n = (e && e.name) || '';
    if (n === 'NotAllowedError' || n === 'PermissionDeniedError' || n === 'SecurityError') return CAM_HELP_BLOCKED;
    if (n === 'NotFoundError' || n === 'DevicesNotFoundError' || n === 'OverconstrainedError') return 'No camera was found on this device. Photos must be taken with a phone camera.';
    if (n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError') return 'The camera is busy or could not start. Close other apps that use the camera (e.g. WhatsApp, Camera) and tap "Try again".';
    return 'Could not open the camera' + (e && e.message ? ' (' + e.message + ')' : '') + '. ' + CAM_HELP_BLOCKED;
  }

  const Cam = {
    dlg: null, stream: null, uploader: null, devices: [], deviceId: '', taken: 0, starting: null, urls: [],
    build() {
      if (this.dlg) return this.dlg;
      const d = document.createElement('dialog'); d.className = 'camera-dlg'; d.id = 'cameraDlg';
      d.setAttribute('aria-label', 'Camera');
      d.innerHTML = `
        <div class="cam-top"><div class="cam-title"></div><div class="cam-count" aria-live="polite"></div>
          <button class="cam-x" type="button" aria-label="Close camera">×</button></div>
        <div class="cam-view"><video playsinline muted autoplay></video><div class="cam-flash"></div>
          <div class="cam-msg hidden" role="alert"><div class="cam-msg-text"></div><button class="btn btn-primary cam-retry" type="button">Try again</button></div></div>
        <div class="cam-strip"></div>
        <div class="cam-bar">
          <button class="cam-switch" type="button" aria-label="Switch camera" title="Switch camera">⟲</button>
          <button class="cam-shutter" type="button" aria-label="Take photo"><span></span></button>
          <button class="cam-done btn btn-primary" type="button">Done</button></div>
        <div class="toasts" aria-live="polite"></div>`;
      document.body.appendChild(d);
      this.dlg = d; this.video = d.querySelector('video');
      d.querySelector('.cam-x').onclick = () => this.close();
      d.querySelector('.cam-done').onclick = () => this.close();
      d.querySelector('.cam-retry').onclick = () => this.start();
      d.querySelector('.cam-shutter').onclick = () => this.shoot();
      d.querySelector('.cam-switch').onclick = () => this.switchCam();
      d.addEventListener('cancel', () => this.stop());  // Esc / Android back button: stop the camera right away
      d.addEventListener('close', () => this.stop());
      document.addEventListener('visibilitychange', () => {
        if (!this.dlg.open) return;
        if (document.hidden) this.stop(); else if (!this.stream) this.start();
      });
      return d;
    },
    open(uploader) {
      this.build(); this.uploader = uploader; this.taken = 0;
      this.dlg.querySelector('.cam-title').textContent = uploader.o.label;
      this.dlg.querySelector('.cam-strip').innerHTML = '';
      this.urls.splice(0).forEach(u => URL.revokeObjectURL(u));
      if (!this.dlg.open) this.dlg.showModal();
      this.update();
      this.start();
    },
    msg(text) {
      const m = this.dlg.querySelector('.cam-msg');
      m.classList.toggle('hidden', !text); m.querySelector('.cam-msg-text').textContent = text || '';
      this.update();
    },
    async start(deviceId) {
      this.stop(); this.msg('');
      const video = { width: { ideal: 1920 }, height: { ideal: 1440 } };
      if (deviceId) video.deviceId = { exact: deviceId }; else video.facingMode = { ideal: 'environment' };
      const p = this.starting = navigator.mediaDevices.getUserMedia({ video, audio: false });
      try {
        const stream = await p;
        if (this.starting !== p || !this.dlg.open) { stream.getTracks().forEach(t => t.stop()); return; }
        this.stream = stream; this.video.srcObject = stream;
        try { await this.video.play(); } catch (_) { }
        const tr = stream.getVideoTracks()[0];
        this.deviceId = (tr && tr.getSettings && tr.getSettings().deviceId) || deviceId || '';
        try { this.devices = (await navigator.mediaDevices.enumerateDevices()).filter(x => x.kind === 'videoinput'); } catch (_) { this.devices = []; }
      } catch (e) {
        if (this.starting === p) this.msg(camErrorText(e));
      } finally { if (this.starting === p) this.starting = null; this.update(); }
    },
    stop() {
      this.starting = null;
      if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
      if (this.video) this.video.srcObject = null;
    },
    close() { this.stop(); if (this.dlg && this.dlg.open) this.dlg.close(); },
    switchCam() {
      if (this.devices.length < 2) return;
      const i = this.devices.findIndex(x => x.deviceId === this.deviceId);
      this.start(this.devices[(i + 1) % this.devices.length].deviceId);
    },
    capturing: 0,  // shots between shutter tap and hand-off to the uploader (slot already reserved)
    room() { return this.uploader ? Math.max(0, this.uploader.room - this.capturing) : 0; },
    update() {
      if (!this.dlg || !this.uploader) return;
      const left = this.room(), ready = !!this.stream && this.video.videoWidth > 0;
      this.dlg.querySelector('.cam-count').textContent = `${this.taken} taken · ${left} left (max ${this.uploader.o.max})`;
      const sh = this.dlg.querySelector('.cam-shutter');
      sh.disabled = !this.stream || left <= 0;
      sh.title = left <= 0 ? `Maximum ${this.uploader.o.max} photos reached` : 'Take photo';
      this.dlg.querySelector('.cam-switch').classList.toggle('invisible', !(this.stream && this.devices.length > 1));
      this.dlg.classList.toggle('cam-full', left <= 0);
      if (!ready && this.stream) this.video.onloadedmetadata = () => this.update();
    },
    async shoot() {
      const v = this.video, u = this.uploader;
      if (!this.stream || !u || this.room() <= 0 || !v.videoWidth) return;
      this.capturing++; this.update();   // reserve the slot before any await, so rapid taps can't overshoot the max
      try { await this._capture(v, u); } finally { this.capturing--; this.update(); }
    },
    async _capture(v, u) {
      const scale = Math.min(1, CAM_MAX_PX / Math.max(v.videoWidth, v.videoHeight));
      const c = document.createElement('canvas'); c.width = Math.round(v.videoWidth * scale); c.height = Math.round(v.videoHeight * scale);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      const fl = this.dlg.querySelector('.cam-flash'); fl.classList.remove('go'); void fl.offsetWidth; fl.classList.add('go');
      if (navigator.vibrate) try { navigator.vibrate(30); } catch (_) { }
      const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', CAM_QUALITY));
      if (!blob) { toast('Could not capture the photo — please try again.', 'bad'); return; }
      const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
      const file = new File([blob], `camera_${ts}.jpg`, { type: 'image/jpeg' });
      if (this.uploader !== u || !this.dlg.open) return;   // camera closed / switched uploader meanwhile
      const mini = document.createElement('div'); mini.className = 'thumb uploading';
      this.dlg.querySelector('.cam-strip').appendChild(mini);
      mini.scrollIntoView && mini.scrollIntoView({ inline: 'end', block: 'nearest' });
      if (u.addFiles([file], 'camera', mini)) this.taken++;
    },
  };
  window.camera = Cam;

  /**
   * Full uploader widget: existing thumbs + a "Take photo" tile. Tapping the tile opens the live camera; every shot
   * is uploaded immediately (sequential queue) with its own progress bar, the camera stays open for the next shot.
   *   new Uploader(container, {fields:{kind,date,sr_id}, images:[...], editable, max, label, onChange(images),
   *                            onBusyChange(busy), emptyText})
   *   onChange fires after every successful upload / delete.
   *   onBusyChange fires when uploads start (true) and when the queue has drained (false).
   *   emptyText is shown when the widget is read-only and has no images.
   */
  window.Uploader = class {
    constructor(el, o) {
      this.el = el; this.o = Object.assign({ max: 6, editable: true, label: 'Take photo' }, o); this.images = (o.images || []).slice();
      this.pending = 0; this.queue = []; this.running = false; this.render();
    }
    get busy() { return this.pending > 0; }
    get room() { return Math.max(0, this.o.max - this.images.length - this.pending); }
    _busyChanged() { const b = this.busy; if (b !== this._lastBusy) { this._lastBusy = b; this.o.onBusyChange && this.o.onBusyChange(b); } }
    render() {
      const el = this.el; el.classList.add('thumbs');
      const keep = this.queueEl ? Array.from(this.queueEl.children) : [];  // in-flight / failed tiles survive re-renders
      el.innerHTML = '';
      if (!this.o.editable && !this.images.length && this.o.emptyText) {
        el.innerHTML = `<span class="muted small">${esc(this.o.emptyText)}</span>`; return;
      }
      const strip = document.createElement('div'); strip.className = 'thumbs';
      renderThumbs(strip, this.images, { canDelete: this.o.editable, onDelete: (img) => this.remove(img) });
      Array.from(strip.children).forEach(c => el.appendChild(c));
      this.queueEl = document.createElement('div'); this.queueEl.className = 'thumbs'; this.queueEl.style.display = 'contents'; el.appendChild(this.queueEl);
      keep.forEach(t => this.queueEl.appendChild(t));
      this.addTile = null;
      if (this.o.editable && this.images.length + this.pending < this.o.max) {
        const icon = '<svg class="cam-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l1.5 2H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.5L9 4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.6" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
        let add;
        if (cameraSupported()) {
          add = document.createElement('button'); add.type = 'button'; add.className = 'add-tile';
          add.innerHTML = `<span>${icon}<br>${esc(this.o.label)}</span>`;
          add.onclick = () => Cam.open(this);
        } else {
          // Fallback: camera-only file input (capture attr => Android opens the camera, not the gallery). Never 'multiple'.
          add = document.createElement('label'); add.className = 'add-tile';
          add.innerHTML = `<span>${icon}<br>${esc(this.o.label)}</span><input type="file" accept="image/*" capture="environment">`;
          add.querySelector('input').onchange = (e) => { const files = Array.from(e.target.files || []).slice(0, 1); e.target.value = ''; this.addFiles(files, 'capture_input'); };
        }
        add.title = 'Opens the camera — take the photo live';
        el.appendChild(add); this.addTile = add;
      }
      if (Cam.uploader === this) Cam.update();
    }
    /** Queue photos for upload. source: 'camera' | 'capture_input'. mini: optional extra progress tile (camera strip).
     *  Returns the number of files accepted (0 when the max is already reached). */
    addFiles(files, source, mini) {
      const room = this.room;
      if (files.length > room) {
        toast(`You can add ${room} more photo(s) here (max ${this.o.max}).`, 'bad'); files = files.slice(0, room);
        if (mini && !files.length) mini.remove();
      }
      files.forEach((f, k) => {
        const t = document.createElement('div'); t.className = 'thumb uploading';
        const url = URL.createObjectURL(f);
        const inner = `<img src="${url}" alt=""><div class="pct">0%</div><div class="prog"><i></i></div>`;
        t.innerHTML = inner;
        const tiles = [t];
        if (mini && k === 0) { mini.innerHTML = inner; tiles.push(mini); }
        this.queueEl.appendChild(t); this.pending++;
        this.queue.push({ f, tiles, url, source: source || 'camera' });
      });
      if (this.addTile && this.images.length + this.pending >= this.o.max) this.render();
      this._busyChanged();
      this._pump();
      return files.length;
    }
    async _pump() {
      if (this.running) return;
      this.running = true;
      while (this.queue.length) {  // sequential: clearer progress + kinder to mobile networks
        const j = this.queue.shift();
        const set = (w, txt) => j.tiles.forEach(t => { t.querySelector('.prog > i').style.width = w; t.querySelector('.pct').textContent = txt; });
        try {
          const img = await uploadImage(j.f, Object.assign({}, this.o.fields, { source: j.source }), (p, phase) => {
            set(p + '%', phase === 'preparing' ? 'Preparing…' : phase === 'processing' ? 'Saving…' : phase === 'done' ? '✓' : p + '%');
          });
          this.images.push(img); this.pending--;
          j.tiles[0].remove();
          if (j.tiles[1]) { j.tiles[1].classList.remove('uploading'); j.tiles[1].classList.add('done'); set('100%', '✓'); }
          if (img.duplicate) toast('Warning: this photo was already uploaded before (re-used photo).', 'bad');
          else if (img.old_photo) toast(`Warning: photo appears to be old (taken ${img.taken_at}).`, 'bad');
          this.render();
          this.o.onChange && this.o.onChange(this.images);
        } catch (e) {
          this.pending--;
          j.tiles.forEach(t => {
            t.classList.remove('uploading'); t.classList.add('failed'); t.title = e.message;
            t.querySelector('.pct').textContent = 'Failed'; const b = t.querySelector('.prog > i'); b.style.width = '100%'; b.style.background = 'var(--bad)';
          });
          toast(e.message, 'bad');
          const t = j.tiles[0];
          const retry = document.createElement('button'); retry.className = 'del'; retry.type = 'button'; retry.textContent = '×'; retry.title = 'Dismiss';
          retry.onclick = () => t.remove(); t.appendChild(retry);
          this.render();
        } finally { if (j.tiles[1]) Cam.urls.push(j.url); else URL.revokeObjectURL(j.url); }
      }
      this.running = false;
      this._busyChanged();
    }
    async remove(img) {
      if (!confirm('Remove this photo?')) return;
      try { await api.del('/api/images/' + img.id); this.images = this.images.filter(i => i.id !== img.id); this.render(); this.o.onChange && this.o.onChange(this.images); }
      catch (e) { toast(e.message, 'bad'); }
    }
  };
})();
