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
    const box = document.getElementById('toasts'); if (!box) return alert(msg);
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

  /**
   * Full uploader widget: existing thumbs + "Add photos" tile, uploads each selected file
   * sequentially with its own progress bar.
   *   new Uploader(container, {fields:{kind,date,sr_id}, images:[...], editable, max, onChange(images),
   *                            onBusyChange(busy), emptyText})
   *   onBusyChange fires when uploads start (true) and when the whole batch has finished (false).
   *   emptyText is shown when the widget is read-only and has no images.
   */
  window.Uploader = class {
    constructor(el, o) {
      this.el = el; this.o = Object.assign({ max: 6, editable: true, label: 'Add photos' }, o); this.images = (o.images || []).slice();
      this.pending = 0; this.render();
    }
    get busy() { return this.pending > 0; }
    _busyChanged() { const b = this.busy; if (b !== this._lastBusy) { this._lastBusy = b; this.o.onBusyChange && this.o.onBusyChange(b); } }
    render() {
      const el = this.el; el.classList.add('thumbs'); el.innerHTML = '';
      if (!this.o.editable && !this.images.length && this.o.emptyText) {
        el.innerHTML = `<span class="muted small">${esc(this.o.emptyText)}</span>`; return;
      }
      const strip = document.createElement('div'); strip.className = 'thumbs';
      renderThumbs(strip, this.images, { canDelete: this.o.editable, onDelete: (img) => this.remove(img) });
      Array.from(strip.children).forEach(c => el.appendChild(c));
      this.queueEl = document.createElement('div'); this.queueEl.className = 'thumbs'; this.queueEl.style.display = 'contents'; el.appendChild(this.queueEl);
      if (this.o.editable && this.images.length < this.o.max) {
        const add = document.createElement('label'); add.className = 'add-tile';
        add.innerHTML = `<span>＋<br>${esc(this.o.label)}</span><input type="file" accept="image/*" multiple>`;
        add.querySelector('input').onchange = (e) => { const files = Array.from(e.target.files || []); e.target.value = ''; this.addFiles(files); };
        el.appendChild(add); this.addTile = add;
      }
    }
    async addFiles(files) {
      const room = this.o.max - this.images.length - this.pending;
      if (files.length > room) { toast(`You can add ${Math.max(room, 0)} more photo(s) here (max ${this.o.max}).`, 'bad'); files = files.slice(0, Math.max(room, 0)); }
      const jobs = files.map(f => {
        const t = document.createElement('div'); t.className = 'thumb uploading';
        const url = URL.createObjectURL(f);
        t.innerHTML = `<img src="${url}" alt=""><div class="pct">0%</div><div class="prog"><i></i></div>`;
        this.queueEl.appendChild(t); this.pending++;
        return { f, t, url };
      });
      this._busyChanged();
      for (const j of jobs) {  // sequential: clearer progress + kinder to mobile networks
        const bar = j.t.querySelector('.prog > i'), pct = j.t.querySelector('.pct');
        try {
          const img = await uploadImage(j.f, this.o.fields, (p, phase) => {
            bar.style.width = p + '%';
            pct.textContent = phase === 'preparing' ? 'Preparing…' : phase === 'processing' ? 'Saving…' : p + '%';
          });
          this.images.push(img); j.t.remove();
          if (img.duplicate) toast('Warning: this photo was already uploaded before (re-used photo).', 'bad');
          else if (img.old_photo) toast(`Warning: photo appears to be old (taken ${img.taken_at}).`, 'bad');
        } catch (e) {
          j.t.classList.add('failed'); pct.textContent = 'Failed'; bar.style.width = '100%'; bar.style.background = 'var(--bad)';
          j.t.title = e.message; toast(e.message, 'bad');
          const retry = document.createElement('button'); retry.className = 'del'; retry.type = 'button'; retry.textContent = '×'; retry.title = 'Dismiss';
          retry.onclick = () => j.t.remove(); j.t.appendChild(retry);
        } finally { this.pending--; URL.revokeObjectURL(j.url); }
      }
      const failed = Array.from(this.queueEl.querySelectorAll('.thumb.failed'));
      this.render(); failed.forEach(f => this.queueEl.appendChild(f));
      this.o.onChange && this.o.onChange(this.images);
      this._busyChanged();
    }
    async remove(img) {
      if (!confirm('Remove this photo?')) return;
      try { await api.del('/api/images/' + img.id); this.images = this.images.filter(i => i.id !== img.id); this.render(); this.o.onChange && this.o.onChange(this.images); }
      catch (e) { toast(e.message, 'bad'); }
    }
  };
})();
