/* AMO portal: daily pre-plan meeting report + SR outlet-plan photos (docs/SPEC.md section A). */
(function () {
  'use strict';

  const S = { data: null, date: null, meetingUp: null, srUps: new Map(), srSavers: new Map(), meetingSaver: null, submitting: false };

  /* ---------------- auto-save helper ---------------- */
  class AutoSaver {
    constructor(fn, ind, ms) { this.fn = fn; this.ind = ind; this.ms = ms || 700; this.timer = null; this.dirty = false; this.chain = Promise.resolve(); }
    setInd(text, cls) { if (!this.ind) return; this.ind.textContent = text; this.ind.className = 'save-ind' + (cls ? ' ' + cls : ''); }
    schedule() { this.dirty = true; clearTimeout(this.timer); this.setInd('Editing…'); this.timer = setTimeout(() => this.flush().catch(() => { }), this.ms); }
    flush() {
      clearTimeout(this.timer);
      if (!this.dirty) return this.chain.catch(() => { });
      this.dirty = false; this.setInd('Saving…');
      this.chain = this.chain.catch(() => { }).then(() => this.fn()).then(() => {
        if (!this.dirty) this.setInd('Saved ✓', 'ok');
      }, (e) => { this.dirty = true; this.setInd('Not saved: ' + e.message, 'bad'); throw e; });
      return this.chain;
    }
    get pending() { return this.dirty; }
  }

  /* ---------------- formatting ---------------- */
  function dateLabel(iso, i) {
    const d = new Date(iso + 'T00:00:00');
    const s = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    return i === 0 ? 'Today · ' + s : i === 1 ? 'Yesterday · ' + s : s;
  }
  const STATUS = {
    not_started: ['badge', 'Not started'], draft: ['badge badge-warn', 'Draft'],
    submitted: ['badge badge-info', 'Submitted to TSO'], returned: ['badge badge-bad', 'Returned by TSO'],
  };
  const srLocked = () => !S.data.can_edit;
  const hasRemark = (sr) => !!(sr.entry.amo_remarks || '').trim();
  const showTso = () => S.data.territory_status === 'submitted' || ['submitted', 'returned'].includes(S.data.report.status);

  /* ---------------- load & render ---------------- */
  async function load(date) {
    qs('#loadState').classList.remove('hidden'); qs('#loadState').textContent = 'Loading your report…';
    qs('#main').classList.add('hidden');
    try {
      S.data = await api.get('/api/amo/report' + (date ? '?date=' + encodeURIComponent(date) : ''));
    } catch (e) {
      qs('#loadState').innerHTML = `<span class="error">${esc(e.message)}</span> <button class="btn btn-sm" type="button" id="retryLoad">Retry</button>`;
      qs('#retryLoad').onclick = () => load(date);
      return;
    }
    S.date = S.data.date;
    const u = new URL(location.href);
    if (S.date === S.data.editable_dates[0]) u.searchParams.delete('date'); else u.searchParams.set('date', S.date);
    history.replaceState(null, '', u);
    render();
    qs('#loadState').classList.add('hidden'); qs('#main').classList.remove('hidden');
  }

  function render() {
    const d = S.data;
    qs('#amoApp').classList.toggle('locked', srLocked());
    qs('#zoneName').textContent = d.zone.name;
    qs('#zoneMeta').textContent = `Zone ${d.zone.code} · Territory ${d.territory.name} (${d.territory.code}) · ${d.territory.division} · ${d.territory.wing}`;
    renderDates(); renderStatus(); renderMeeting(); renderSRs(); updateProgress(); clearErrors(); refreshSubmit();
  }

  function renderDates() {
    const sel = qs('#dateSel'), dates = S.data.editable_dates.slice();
    sel.innerHTML = dates.map((x, i) => `<option value="${esc(x)}">${esc(dateLabel(x, i))}</option>`).join('');
    if (!dates.includes(S.date)) sel.insertAdjacentHTML('beforeend', `<option value="${esc(S.date)}">${esc(dateLabel(S.date, -1))} (closed)</option>`);
    sel.value = S.date;
  }

  function renderStatus() {
    const d = S.data, r = d.report;
    let [cls, txt] = STATUS[r.status] || ['badge', r.status];
    if (d.territory_status === 'submitted') { cls = 'badge badge-ok'; txt = 'Territory submitted'; }
    qs('#statusBadge').className = cls; qs('#statusBadge').textContent = txt;

    const b = qs('#lockBanner'); let html = '', kind = '';
    if (d.territory_status === 'submitted') {
      kind = 'banner-ok'; html = '<strong>Final:</strong> your TSO has submitted the territory for this date. This report is read-only.';
    } else if (r.status === 'submitted') {
      kind = 'banner-ok'; html = `<strong>Submitted to TSO</strong>${r.submitted_at ? ' on ' + esc(fmtDateTime(r.submitted_at)) : ''}. Read-only while your TSO reviews it.`;
    } else if (!d.can_edit) {
      kind = 'banner-warn'; html = esc(d.lock_reason || 'This report is read-only.');
    } else if (r.status === 'returned') {
      kind = 'banner-bad'; html = '<strong>Returned by your TSO.</strong> Please fix and submit again.' + (r.returned_remarks ? `<div style="margin-top:4px;white-space:pre-wrap">TSO note: ${esc(r.returned_remarks)}</div>` : '');
    }
    b.className = 'banner ' + kind + (html ? '' : ' hidden'); b.innerHTML = html;
  }

  /* ---------------- meeting card ---------------- */
  function meetingPayload() {
    const f = qs('#meetingForm'); const held = f.querySelector('input[name=meeting_held]:checked');
    const cnt = f.sr_present_count.value.trim(); const n = cnt === '' ? null : parseInt(cnt, 10);
    return {
      date: S.date, location: f.location.value, meeting_held: held ? held.value === 'yes' : null,
      meeting_time: f.meeting_time.value, not_held_reason: f.not_held_reason.value,
      sr_present_count: Number.isFinite(n) ? n : null, vacancy_remarks: f.vacancy_remarks.value,
    };
  }

  function applyHeldVisibility() {
    const f = qs('#meetingForm'); const held = f.querySelector('input[name=meeting_held]:checked');
    const v = held ? held.value : null; const nPhotos = S.meetingUp ? S.meetingUp.images.length : S.data.meeting_images.length;
    qsa('.held-only', f).forEach(el => el.classList.toggle('hidden', v !== 'yes'));
    qsa('.notheld-only', f).forEach(el => el.classList.toggle('hidden', v !== 'no'));
    qsa('.held-photos', f).forEach(el => el.classList.toggle('hidden', v !== 'yes' && nPhotos === 0));
  }

  function renderMeeting() {
    const d = S.data, r = d.report, f = qs('#meetingForm'), ro = srLocked();
    f.location.value = r.location || (ro ? '' : d.territory.name);
    qsa('input[name=meeting_held]', f).forEach(x => { x.checked = r.meeting_held === null ? false : (x.value === 'yes') === r.meeting_held; });
    f.meeting_time.value = r.meeting_time || '';
    f.not_held_reason.value = r.not_held_reason || '';
    f.sr_present_count.value = r.sr_present_count ?? '';
    f.sr_present_count.placeholder = `of ${d.summary.total_srs} SRs`;
    f.vacancy_remarks.value = r.vacancy_remarks || '';
    qsa('input, textarea, select', f).forEach(el => { el.disabled = ro; });

    S.meetingSaver = new AutoSaver(async () => {
      const res = await api.put('/api/amo/report', meetingPayload());
      S.data.report = Object.assign(S.data.report, res.report); renderStatus();
    }, qs('#meetingSaved'));
    qs('#meetingSaved').textContent = '';
    f.oninput = f.onchange = (e) => {
      if (ro || !e.target.name) return;
      if (e.target.name === 'meeting_held') applyHeldVisibility();
      qs('#meetingCard').classList.remove('missing');
      S.meetingSaver.schedule();
    };

    const box = qs('#meetingUploader');
    if (ro && !d.meeting_images.length) { box.className = ''; box.innerHTML = '<span class="muted small">No meeting photo uploaded.</span>'; S.meetingUp = null; }
    else {
      S.meetingUp = trackBusy(new Uploader(box, {
        fields: { kind: 'meeting', date: S.date }, images: d.meeting_images, editable: !ro, max: 4, label: 'Add meeting photo',
        onChange: (imgs) => { S.data.meeting_images = imgs; markStarted(); if (imgs.length) qs('#meetingCard').classList.remove('missing'); applyHeldVisibility(); },
      }));
    }
    applyHeldVisibility();
  }

  /* ---------------- SR cards ---------------- */
  function srCard(sr) {
    const ro = srLocked();
    const el = document.createElement('article'); el.className = 'card sr-card'; el.dataset.sr = sr.sr_id;
    el.innerHTML = `
      <div class="card-head" style="margin-bottom:2px;align-items:flex-start">
        <div style="min-width:0"><div class="sr-title">${esc(sr.sr_name)}</div><div class="sr-id">SR ${esc(sr.sr_id)}</div></div>
        <div class="badges"></div>
      </div>
      <div class="routes muted small">${sr.route_names ? 'Routes: ' + esc(sr.route_names) : ''}${sr.route_codes ? ` <span class="nowrap">(${esc(sr.route_codes)})</span>` : ''}</div>
      <div class="up"></div>
      <div class="remark-label">Remarks${ro ? '' : ' <span class="hint">(required if no photo)</span>'}</div>
      <div class="remark-slot"></div>
      <div class="row" style="justify-content:space-between;margin-top:4px"><span class="need">Add at least one photo, or a remark explaining why there is none.</span><span class="spacer"></span><span class="save-ind"></span></div>
      <div class="tso-slot"></div>`;
    const slot = el.querySelector('.remark-slot');
    if (ro) {
      slot.innerHTML = sr.entry.amo_remarks ? `<div class="remark-ro">${esc(sr.entry.amo_remarks)}</div>` : '<div class="muted small">No remarks.</div>';
    } else {
      const ta = document.createElement('textarea'); ta.maxLength = 2000; ta.rows = 2; ta.value = sr.entry.amo_remarks || '';
      ta.placeholder = 'e.g. SR absent today / route vacant / plan shared verbally';
      ta.setAttribute('aria-label', 'Remarks for ' + sr.sr_name);
      slot.appendChild(ta);
      const saver = new AutoSaver(async () => {
        const v = ta.value;
        await api.put('/api/amo/sr/' + encodeURIComponent(sr.sr_id), { date: S.date, amo_remarks: v });
        sr.entry.amo_remarks = v.trim(); markStarted();
      }, el.querySelector('.save-ind'));
      ta.addEventListener('input', () => { sr.entry.amo_remarks = ta.value; updateSR(sr); saver.schedule(); });
      ta.addEventListener('blur', () => saver.flush().catch(() => { }));
      S.srSavers.set(sr.sr_id, saver);
    }
    const up = el.querySelector('.up');
    if (ro && !sr.images.length) up.innerHTML = '<span class="muted small">No plan photo uploaded.</span>';
    else {
      S.srUps.set(sr.sr_id, trackBusy(new Uploader(up, {
        fields: { kind: 'sr', date: S.date, sr_id: sr.sr_id }, images: sr.images, editable: !ro, max: 6, label: 'Add plan photos',
        onChange: (imgs) => { sr.images = imgs; sr.entry.tso_status = 'pending'; markStarted(); updateSR(sr); updateProgress(); applyFilter(); },
      })));
    }
    sr._el = el; updateSR(sr);
    return el;
  }

  function updateSR(sr) {
    const el = sr._el; if (!el) return;
    const n = sr.images.length, b = [];
    if (n) b.push(`<span class="badge badge-ok">${n} photo${n > 1 ? 's' : ''}</span>`);
    else b.push(hasRemark(sr) ? '<span class="badge badge-info">No photo · remark given</span>' : '<span class="badge badge-warn">No photo</span>');
    if (sr.images.some(i => i.duplicate)) b.push('<span class="badge badge-bad" title="A photo was uploaded before">Re-used photo</span>');
    if (showTso()) b.push(sr.entry.tso_status === 'approved' ? '<span class="badge badge-ok">TSO approved ✓</span>' : '<span class="badge">TSO pending</span>');
    el.querySelector('.badges').innerHTML = b.join('');
    el.querySelector('.tso-slot').innerHTML = sr.entry.tso_remarks ? `<div class="tso-note"><strong>TSO remark:</strong> ${esc(sr.entry.tso_remarks)}</div>` : '';
    if (n || hasRemark(sr)) el.classList.remove('missing');
  }

  function renderSRs() {
    S.srUps.clear(); S.srSavers.clear();
    const list = qs('#srList'); list.innerHTML = '';
    if (!S.data.srs.length) { list.innerHTML = '<div class="card muted empty-filter">No SRs are assigned to your zone.</div>'; return; }
    const frag = document.createDocumentFragment();
    S.data.srs.forEach(sr => frag.appendChild(srCard(sr)));
    list.appendChild(frag);
    applyFilter();
  }

  function updateProgress() {
    const srs = S.data.srs, total = srs.length, withImg = srs.filter(s => s.images.length).length;
    const imgs = srs.reduce((a, s) => a + s.images.length, 0), pct = total ? Math.round(withImg / total * 100) : 0;
    qs('#progCount').textContent = `${withImg} of ${total} SRs have photos`;
    qs('#progImages').textContent = `${imgs} plan photo${imgs === 1 ? '' : 's'} · ${pct}%`;
    qs('#progBar > i').style.width = pct + '%';
    qs('#progBar').classList.toggle('done', total > 0 && withImg === total);
  }

  function applyFilter() {
    const q = qs('#srSearch').value.trim().toLowerCase(), only = qs('#onlyMissing').checked;
    let shown = 0;
    S.data.srs.forEach(sr => {
      const hay = (sr.sr_name + ' ' + sr.sr_id + ' ' + sr.route_names + ' ' + sr.route_codes).toLowerCase();
      const vis = (!q || hay.includes(q)) && (!only || !sr.images.length);
      sr._el && sr._el.classList.toggle('hidden', !vis); if (vis) shown++;
    });
    qs('#srEmpty').classList.toggle('hidden', shown > 0 || !S.data.srs.length);
  }

  function markStarted() {
    if (S.data.report.status === 'not_started') { S.data.report.status = 'draft'; renderStatus(); }
  }

  /* ---------------- busy tracking / submit ---------------- */
  function trackBusy(up) {
    const orig = up.addFiles.bind(up);
    up.addFiles = async (files) => { const p = orig(files); refreshSubmit(); try { await p; } finally { refreshSubmit(); } };
    return up;
  }
  const anyBusy = () => (S.meetingUp && S.meetingUp.busy) || Array.from(S.srUps.values()).some(u => u.busy);

  function refreshSubmit() {
    const d = S.data; if (!d) return;
    const area = qs('#submitArea'), btn = qs('#btnSubmit'), hint = qs('#submitHint');
    area.classList.toggle('hidden', !d.can_edit);
    if (!d.can_edit) return;
    const busy = anyBusy();
    btn.disabled = busy || S.submitting;
    btn.textContent = S.submitting ? 'Submitting…' : d.report.status === 'returned' ? 'Re-submit to TSO' : 'Submit to TSO';
    const missing = d.srs.filter(s => !s.images.length && !hasRemark(s)).length;
    hint.textContent = busy ? 'Please wait — photos are still uploading…'
      : missing ? `${missing} SR(s) still need a photo or a remark.` : 'All SRs covered. Ready to submit.';
  }

  function localErrors() {
    const p = meetingPayload(), errors = [];
    const meetingPhotos = S.meetingUp ? S.meetingUp.images.length : 0;
    if (p.meeting_held === null) errors.push('Select whether the pre-plan meeting was held');
    else if (p.meeting_held) {
      if (!p.meeting_time) errors.push('Enter the meeting time');
      if (!meetingPhotos) errors.push('Upload at least one meeting photo');
    } else if (!p.not_held_reason.trim()) errors.push('Enter the reason the meeting was not held');
    const missing = S.data.srs.filter(s => !s.images.length && !hasRemark(s)).map(s => s.sr_id);
    return { errors, missing };
  }

  function clearErrors() {
    qs('#errBox').classList.add('hidden'); qs('#errBox').innerHTML = '';
    qsa('.sr-card.missing, #meetingCard.missing').forEach(x => x.classList.remove('missing'));
  }

  function showErrors(meetingErrs, missing) {
    clearErrors();
    const byId = new Map(S.data.srs.map(s => [s.sr_id, s]));
    const items = meetingErrs.map(e => `<li>${esc(e)}</li>`);
    if (missing.length) {
      const names = missing.slice(0, 12).map(id => { const s = byId.get(id); return esc(s ? `${s.sr_name} (${id})` : id); });
      items.push(`<li>${missing.length} SR(s) need a photo or a remark: ${names.join(', ')}${missing.length > 12 ? ', …' : ''}</li>`);
    }
    const box = qs('#errBox');
    box.innerHTML = `<strong>Cannot submit yet:</strong><ul>${items.join('')}</ul>`; box.classList.remove('hidden');

    if (meetingErrs.length) qs('#meetingCard').classList.add('missing');
    if (missing.length) {   // make sure the offending SRs are visible
      qs('#srSearch').value = ''; qs('#onlyMissing').checked = false; applyFilter();
      missing.forEach(id => { const s = byId.get(id); s && s._el && s._el.classList.add('missing'); });
    }
    const first = meetingErrs.length ? qs('#meetingCard') : (byId.get(missing[0]) || {})._el;
    if (first) {
      first.scrollIntoView({ behavior: 'smooth', block: 'start' });
      first.classList.remove('flash'); void first.offsetWidth; first.classList.add('flash');
    }
  }

  async function flushAll(forceMeeting) {
    const savers = [S.meetingSaver, ...S.srSavers.values()].filter(Boolean);
    if (forceMeeting && S.data.can_edit) S.meetingSaver.dirty = true;  // persist the (possibly pre-filled) meeting form
    await Promise.all(savers.map(s => s.flush()));
  }

  function confirmSubmit() {
    const d = S.data, withImg = d.srs.filter(s => s.images.length).length;
    qs('#confirmText').textContent = `${withImg} of ${d.srs.length} SRs have plan photos; the rest have remarks. Send this report to your TSO?`;
    const dlg = qs('#confirmDlg');
    return new Promise(res => { dlg.onclose = () => res(dlg.returnValue === 'ok'); dlg.returnValue = ''; dlg.showModal(); });
  }

  async function submit() {
    if (anyBusy() || S.submitting) return;
    try { await flushAll(true); } catch (e) { toast('Could not save your changes: ' + e.message, 'bad'); return; }
    const { errors, missing } = localErrors();
    if (errors.length || missing.length) { showErrors(errors, missing); toast('Please complete the highlighted items', 'bad'); return; }
    if (!(await confirmSubmit())) return;
    S.submitting = true; refreshSubmit();
    try {
      await api.post('/api/amo/submit', { date: S.date });
      toast('Report submitted to TSO', 'ok');
      S.submitting = false;
      await load(S.date);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      S.submitting = false; refreshSubmit();
      if (e.status === 400 && e.data && Array.isArray(e.data.meeting_errors)) showErrors(e.data.meeting_errors, e.data.missing_srs || []);
      else toast(e.message, 'bad');
    }
  }

  /* ---------------- wiring ---------------- */
  function hasUnsaved() { return anyBusy() || (S.meetingSaver && S.meetingSaver.pending) || Array.from(S.srSavers.values()).some(s => s.pending); }

  document.addEventListener('DOMContentLoaded', () => {
    qs('#btnSubmit').onclick = submit;
    qs('#srSearch').addEventListener('input', debounce(applyFilter, 120));
    qs('#onlyMissing').addEventListener('change', applyFilter);
    qs('#dateSel').addEventListener('change', async (e) => {
      const to = e.target.value;
      if (hasUnsaved()) {
        if (anyBusy()) { toast('Wait for uploads to finish first', 'bad'); e.target.value = S.date; return; }
        try { await flushAll(); } catch (err) { toast('Could not save: ' + err.message, 'bad'); e.target.value = S.date; return; }
      }
      load(to);
    });
    window.addEventListener('beforeunload', (e) => { if (hasUnsaved()) { e.preventDefault(); e.returnValue = ''; } });
    load(new URLSearchParams(location.search).get('date'));
  });
})();
