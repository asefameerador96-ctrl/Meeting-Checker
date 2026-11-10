/* TSO portal: review the AMO reports of the territory, approve SRs, upload TSO photos, final submit. */
(function () {
  'use strict';

  const S = { data: null, open: new Set(), uploader: null, date: null };
  const STATUS = {
    not_started: ['badge', 'Not started'], draft: ['badge badge-warn', 'AMO drafting'],
    submitted: ['badge badge-info', 'Submitted by AMO'], returned: ['badge badge-bad', 'Returned to AMO'],
  };
  const statusBadge = (s) => { const [c, t] = STATUS[s] || ['badge', s]; return `<span class="${c}">${esc(t)}</span>`; };
  const yesNo = (v) => v === true ? 'Yes' : v === false ? 'No' : '—';
  const dash = (v) => (v === null || v === undefined || v === '') ? '—' : esc(v);

  function zoneOf(code) { return S.data.zones.find(z => z.zone.code === code); }
  function srOf(z, srId) { return z.srs.find(s => s.sr_id === srId); }

  /* ---------------- loading ---------------- */
  async function load(date, keepScroll) {
    const y = window.scrollY;
    try {
      const d = await api.get('/api/tso/report' + (date ? '?date=' + encodeURIComponent(date) : ''));
      if (S.date !== d.date) {   // new date: open zones that need the TSO's attention
        S.open = new Set(d.zones.filter(z => z.report.status === 'submitted' && z.counts.approved < z.counts.total_srs).map(z => z.zone.code));
        if (!S.open.size && d.zones.length) S.open.add(d.zones[0].zone.code);
      }
      S.data = d; S.date = d.date;
      const url = new URL(location.href); url.searchParams.set('date', d.date); history.replaceState(null, '', url);
      renderAll();
      if (keepScroll) window.scrollTo(0, y);
    } catch (e) {
      if (date && (e.status === 400 || e.status === 410)) { toast(e.message + ' Showing today instead.', 'bad'); return load(null, keepScroll); }
      qs('#zones').innerHTML = `<div class="banner banner-bad">${esc(e.message)}</div>`;
    }
  }

  /* ---------------- derived totals (mirror of the server rules) ---------------- */
  function recompute() {
    const d = S.data, t = { zones: d.zones.length, zones_submitted: 0, zones_not_started: 0, zones_in_progress: 0,
      total_srs: 0, srs_with_images: 0, approved: 0, pending: 0 };
    const blockers = [], inProgress = [], notStarted = [];
    d.zones.forEach(z => {
      const st = z.report.status;
      z.counts = { total_srs: z.srs.length, with_images: z.srs.filter(s => s.images.length).length,
        approved: z.srs.filter(s => s.entry.tso_status === 'approved').length };
      t.total_srs += z.counts.total_srs; t.srs_with_images += z.counts.with_images; t.approved += z.counts.approved;
      if (st === 'submitted') { t.zones_submitted++; t.pending += z.counts.total_srs - z.counts.approved; }
      else if (st === 'draft' || st === 'returned') { t.zones_in_progress++; inProgress.push(z); }
      else { t.zones_not_started++; notStarted.push(z); }
    });
    d.totals = t;
    d.inProgress = inProgress; d.notStarted = notStarted;
    if (d.territory_report.status !== 'submitted') {
      if (!d.tso_images.length) blockers.push('Upload at least one TSO photo');
      if (t.pending) blockers.push(`Approve all SRs of submitted zones (${t.pending} pending)`);
      inProgress.forEach(z => blockers.push(`${z.zone.name} (${z.zone.code}) is ${z.report.status === 'returned' ? 'returned to the AMO' : 'still in draft'}: the AMO must submit it`));
      if (!d.can_edit) blockers.push('This date is closed for editing');
    }
    d.submit_blockers = blockers;
    d.can_submit = d.can_edit && !blockers.length;
  }

  /* ---------------- rendering ---------------- */
  function renderAll() {
    recompute();
    renderHeader();
    renderZones();
    renderFinal(true);
  }

  function renderHeader() {
    const d = S.data, t = d.territory, tr = d.territory_report;
    qs('#tName').textContent = `${t.name} (${t.code})`;
    qs('#tMeta').textContent = `${t.division} · ${t.wing}`;
    qs('#tStatus').innerHTML = tr.status === 'submitted' ? '<span class="badge badge-ok">Submitted ✓</span>' : '<span class="badge badge-warn">Open</span>';
    const sel = qs('#dateSel');
    const dates = d.editable_dates.includes(d.date) ? d.editable_dates : [d.date].concat(d.editable_dates);
    sel.innerHTML = dates.map(x => `<option value="${esc(x)}"${x === d.date ? ' selected' : ''}>${esc(fmtDate(x))}</option>`).join('');
    let banner = '';
    if (tr.status === 'submitted') banner = `<div class="banner banner-ok">Territory submitted${tr.submitted_by ? ' by ' + esc(tr.submitted_by) : ''} on ${esc(fmtDateTime(tr.submitted_at))}. Everything is locked and visible to the check-back team.</div>`;
    else if (!d.can_edit) banner = `<div class="banner banner-warn">${esc(d.lock_reason || 'This date is closed for editing')}. View only.</div>`;
    qs('#lockBanner').innerHTML = banner;
    renderStats();
  }

  function renderStats() {
    const t = S.data.totals;
    const pct = (a, b) => b ? Math.round(a / b * 100) : 0;
    const stat = (label, value, sub, p) => `<div class="stat"><div class="label">${esc(label)}</div><div class="value">${value}</div>` +
      (sub ? `<div class="sub">${esc(sub)}</div>` : '') + (p !== undefined ? `<div class="progressbar"><i style="width:${p}%"></i></div>` : '') + '</div>';
    qs('#stats').innerHTML =
      stat('AMOs submitted', `${t.zones_submitted}/${t.zones}`, t.zones_not_started ? `${t.zones_not_started} not started` : '', pct(t.zones_submitted, t.zones)) +
      stat('SRs with photos', `${t.srs_with_images}/${t.total_srs}`, `${pct(t.srs_with_images, t.total_srs)}%`, pct(t.srs_with_images, t.total_srs)) +
      stat('Approved', `${t.approved}`, `of ${t.total_srs} SRs`, pct(t.approved, t.total_srs)) +
      stat('Pending approval', `${t.pending}`, t.pending ? 'in submitted zones' : 'nothing waiting');
  }

  function fmtDate(iso) {
    const d = new Date(iso + 'T00:00:00');
    const today = S.data.editable_dates[0];
    const label = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    return iso === today ? `Today · ${label}` : label;
  }

  function renderZones() {
    const box = qs('#zones'); box.innerHTML = '';
    if (!S.data.zones.length) { box.innerHTML = '<div class="card skeleton">No AMO zones are mapped to this territory.</div>'; return; }
    S.data.zones.forEach(z => {
      const el = document.createElement('section');
      el.className = 'card zone' + (S.open.has(z.zone.code) ? ' open' : '');
      el.dataset.zone = z.zone.code;
      el.innerHTML = `<button type="button" class="zone-head" aria-expanded="${S.open.has(z.zone.code)}"></button><div class="zone-body"></div>`;
      box.appendChild(el);
      el.querySelector('.zone-head').onclick = () => toggleZone(z.zone.code);
      renderZoneHead(z); renderZoneBody(z);
    });
    applyFilter();
  }

  function zoneEl(code) { return qs(`.zone[data-zone="${code}"]`); }

  function renderZoneHead(z) {
    const el = zoneEl(z.zone.code); if (!el) return;
    const c = z.counts, st = z.report.status;
    const approvedBadge = st === 'submitted'
      ? `<span class="badge ${c.approved === c.total_srs ? 'badge-ok' : 'badge-warn'}">${c.approved}/${c.total_srs} approved</span>` : '';
    el.querySelector('.zone-head').innerHTML = `<span class="chev">▶</span>
      <span class="zone-title"><b>${esc(z.zone.name)}</b> <span class="muted small">Zone ${esc(z.zone.code)}${z.amo_username ? ' · ' + esc(z.amo_username) : ''}</span></span>
      <span class="zone-meta">${statusBadge(st)}<span class="badge">${c.with_images}/${c.total_srs} SRs with photos</span>${approvedBadge}</span>`;
  }

  function renderZoneBody(z) {
    const el = zoneEl(z.zone.code); if (!el) return;
    const body = el.querySelector('.zone-body'), r = z.report, st = r.status;
    const editable = S.data.can_edit && st === 'submitted';
    body.innerHTML = '';
    if (st === 'not_started') {
      body.innerHTML = `<div class="empty-zone">AMO has not submitted yet${z.srs.length ? ` · ${z.srs.length} SR(s) assigned` : ''}.</div>`;
      return;
    }
    if (st === 'draft') body.insertAdjacentHTML('beforeend', '<div class="banner banner-warn" style="margin:12px 0 0">The AMO is still preparing this report. You can review it once it is submitted.</div>');
    if (st === 'returned') body.insertAdjacentHTML('beforeend', `<div class="banner banner-bad" style="margin:12px 0 0"><b>Returned to AMO:</b> ${esc(r.returned_remarks)}</div>`);
    if (st === 'submitted' && r.submitted_at) body.insertAdjacentHTML('beforeend', `<div class="muted small" style="margin-top:10px">Submitted by AMO on ${esc(fmtDateTime(r.submitted_at))}</div>`);

    const held = r.meeting_held;
    const meet = document.createElement('div'); meet.className = 'meeting';
    meet.innerHTML = `
      <div><div class="k">Meeting held</div><div class="v">${held === true ? '<span class="badge badge-ok">Yes</span>' : held === false ? '<span class="badge badge-bad">No</span>' : '—'}</div></div>
      ${held === false ? `<div style="grid-column: span 2"><div class="k">Reason</div><div class="v">${dash(r.not_held_reason)}</div></div>`
        : `<div><div class="k">Time</div><div class="v">${dash(r.meeting_time)}</div></div>`}
      <div><div class="k">Location</div><div class="v">${dash(r.location)}</div></div>
      <div><div class="k">SRs present</div><div class="v">${r.sr_present_count === null || r.sr_present_count === undefined ? '—' : esc(r.sr_present_count)} / ${z.srs.length}</div></div>
      ${r.vacancy_remarks ? `<div style="grid-column: 1 / -1"><div class="k">Vacancy / remarks</div><div class="v">${esc(r.vacancy_remarks)}</div></div>` : ''}
      <div class="photos"><div class="k">Meeting photos (${z.meeting_images.length})</div><div class="thumbs mphotos" style="margin-top:4px"></div></div>`;
    body.appendChild(meet);
    const mp = meet.querySelector('.mphotos');
    if (z.meeting_images.length) renderThumbs(mp, z.meeting_images, { caption: () => `${z.zone.name} · meeting photo` });
    else mp.innerHTML = `<span class="${held === true ? 'no-photo' : 'muted small'}">No meeting photo</span>`;

    const list = document.createElement('div'); list.className = 'sr-list';
    z.srs.forEach(s => { const row = document.createElement('div'); row.dataset.sr = s.sr_id; list.appendChild(row); renderSR(z, s, row); });
    body.appendChild(list);

    if (editable) {
      const acts = document.createElement('div'); acts.className = 'zone-actions';
      acts.innerHTML = `<button class="btn btn-ghost" type="button" data-act="return">Return to AMO</button>
        <button class="btn btn-ok" type="button" data-act="all"${z.counts.approved === z.counts.total_srs ? ' disabled' : ''}>Approve all (${z.counts.total_srs - z.counts.approved})</button>`;
      acts.querySelector('[data-act=return]').style.color = 'var(--bad)';
      acts.querySelector('[data-act=return]').onclick = () => openReturn(z);
      acts.querySelector('[data-act=all]').onclick = (e) => approveAll(z, e.currentTarget);
      body.appendChild(acts);
    }
  }

  function renderSR(z, s, row) {
    row = row || qs(`.sr[data-sr="${CSS.escape(s.sr_id)}"]`, zoneEl(z.zone.code)); if (!row) return;
    const e = s.entry, approved = e.tso_status === 'approved';
    const editable = S.data.can_edit && z.report.status === 'submitted';
    const dup = s.images.some(i => i.duplicate), old = s.images.some(i => i.old_photo);
    row.className = 'sr' + (approved ? ' approved' : '');
    row.dataset.search = [s.sr_id, s.sr_name, s.route_names, s.route_codes, z.zone.name, z.zone.code, z.amo_username].join(' ').toLowerCase();
    row.innerHTML = `
      <div>
        <div><b>${esc(s.sr_name)}</b></div>
        <div class="sr-id">SR ${esc(s.sr_id)}</div>
        <div class="sr-routes" title="${esc(s.route_codes)}">${esc(s.route_names)}</div>
        <div class="sr-badges">
          <span class="badge ${s.images.length ? 'badge-info' : 'badge-bad'}">${s.images.length} photo${s.images.length === 1 ? '' : 's'}</span>
          ${dup ? '<span class="badge badge-bad" title="A photo was uploaded before">REUSED</span>' : ''}
          ${old ? '<span class="badge badge-warn" title="Photo taken long before the report date">OLD</span>' : ''}
          ${approved ? '<span class="badge badge-ok">Approved</span>' : z.report.status === 'submitted' ? '<span class="badge badge-warn">Pending</span>' : ''}
        </div>
      </div>
      <div><div class="lbl">Outlet plan photos</div><div class="thumbs photos"></div></div>
      <div>
        <div class="lbl">AMO remarks</div>
        <div class="amo-remark">${e.amo_remarks ? esc(e.amo_remarks) : '<span class="muted">—</span>'}</div>
        <div class="lbl">TSO remarks (optional)</div>
        ${editable ? `<textarea class="tso-rm" maxlength="2000" rows="1" placeholder="Add a remark…">${esc(e.tso_remarks)}</textarea><div class="saved"></div>`
          : `<div class="amo-remark">${e.tso_remarks ? esc(e.tso_remarks) : '<span class="muted">—</span>'}</div>`}
      </div>
      <div class="act"></div>`;
    const ph = row.querySelector('.photos');
    if (s.images.length) renderThumbs(ph, s.images, { caption: (img) => `${s.sr_name} (${s.sr_id})` + (img.duplicate ? ' · REUSED' : img.old_photo ? ' · OLD ' + img.taken_at : '') });
    else ph.innerHTML = '<span class="no-photo">No photo uploaded</span>';

    const act = row.querySelector('.act');
    if (editable) {
      if (approved) {
        act.innerHTML = `<button class="btn btn-ok" type="button" disabled>Approved ✓</button><button class="btn btn-ghost btn-sm undo" type="button">Undo</button>`;
        act.querySelector('.undo').onclick = (ev) => srAction(z, s, 'unapprove', ev.currentTarget);
      } else {
        act.innerHTML = `<button class="btn btn-primary" type="button">Approve</button>`;
        act.querySelector('.btn').onclick = (ev) => srAction(z, s, 'approve', ev.currentTarget);
      }
      const ta = row.querySelector('.tso-rm');
      const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, 160) + 'px'; };
      const save = debounce(() => saveSRRemark(z, s, ta, row.querySelector('.saved')), 900);
      ta.addEventListener('input', () => { autosize(); row.querySelector('.saved').textContent = ''; save(); });
      if (e.tso_remarks) requestAnimationFrame(autosize);
    } else if (approved) {
      act.innerHTML = `<span class="badge badge-ok">Approved ✓</span>`;
    }
  }

  function renderFinal(withUploader) {
    const d = S.data, locked = !d.can_edit;
    if (withUploader) {
      S.uploader = new Uploader(qs('#tsoUploader'), {
        fields: { kind: 'tso', date: d.date }, images: d.tso_images, editable: !locked, max: 10, label: 'Add TSO photo',
        onChange: (imgs) => { d.tso_images = imgs; recompute(); renderFinal(false); renderStats(); },
      });
      if (locked && !d.tso_images.length) qs('#tsoUploader').innerHTML = '<span class="muted small">No TSO photo.</span>';
      const ta = qs('#tsoRemarks'); ta.value = d.territory_report.tso_remarks || ''; ta.disabled = locked;
      ta.placeholder = locked ? 'No remarks' : 'Anything the check-back team should know about today';
      qs('#remarksSaved').textContent = '';
    }
    const t = d.totals, submitted = d.territory_report.status === 'submitted';
    qs('#finalBadge').innerHTML = submitted ? '<span class="badge badge-ok">Submitted ✓</span>' : d.can_submit ? '<span class="badge badge-ok">Ready</span>' : `<span class="badge badge-warn">${d.submit_blockers.length} item(s) left</span>`;
    const item = (cls, text) => `<li class="${cls}"><span class="ic">${cls === 'ok' ? '✓' : cls === 'warn' ? '!' : '✕'}</span><span>${text}</span></li>`;
    const items = [];
    items.push(item(d.tso_images.length ? 'ok' : 'todo', d.tso_images.length ? `TSO photo uploaded (${d.tso_images.length})` : 'Upload at least one TSO photo'));
    items.push(item(t.pending ? 'todo' : 'ok', t.pending ? `Approve all SRs of submitted zones — <b>${t.pending}</b> pending`
      : t.zones_submitted ? `All SRs of submitted zones approved (${t.approved})` : 'No submitted zones to approve yet'));
    if (d.inProgress.length) items.push(item('todo', `Waiting for AMO submission: ${d.inProgress.map(z => esc(z.zone.name) + (z.report.status === 'returned' ? ' (returned)' : ' (draft)')).join(', ')}`));
    else items.push(item('ok', 'No AMO report in draft or returned'));
    if (d.notStarted.length) items.push(item('warn', `${d.notStarted.length} AMO(s) have not started: ${d.notStarted.map(z => esc(z.zone.name)).join(', ')} — their SRs will be reported as <b>not uploaded</b>`));
    if (!d.can_edit && !submitted) items.push(item('todo', esc(d.lock_reason || 'This date is closed for editing')));
    qs('#checklistTitle').textContent = submitted ? 'Submission' : 'Before you submit';
    qs('#checklist').innerHTML = submitted
      ? item('ok', `Submitted by ${esc(d.territory_report.submitted_by || '')} on ${esc(fmtDateTime(d.territory_report.submitted_at))}`)
      : items.join('');
    const btn = qs('#btnSubmit');
    btn.classList.toggle('hidden', !d.can_submit);
    btn.disabled = !d.can_submit;
  }

  function applyFilter() {
    const q = qs('#search').value.trim().toLowerCase(), onlyPending = qs('#onlyPending').checked;
    qsa('.zone').forEach(zel => {
      const z = zoneOf(+zel.dataset.zone);
      let any = false;
      qsa('.sr', zel).forEach(row => {
        const s = srOf(z, row.dataset.sr);
        const show = (!q || row.dataset.search.includes(q)) && (!onlyPending || (z.report.status === 'submitted' && s.entry.tso_status !== 'approved'));
        row.classList.toggle('hidden', !show); any = any || show;
      });
      const zoneMatch = !q || [z.zone.name, z.zone.code, z.amo_username].join(' ').toLowerCase().includes(q);
      const hide = onlyPending ? !any : !(any || zoneMatch);
      zel.classList.toggle('hidden', hide);
      if (q && any && !zel.classList.contains('open')) zel.classList.add('open');
    });
  }

  function toggleZone(code, force) {
    const el = zoneEl(code); const open = force === undefined ? !el.classList.contains('open') : force;
    el.classList.toggle('open', open); el.querySelector('.zone-head').setAttribute('aria-expanded', open);
    if (open) S.open.add(code); else S.open.delete(code);
  }

  /* ---------------- actions ---------------- */
  function refreshZone(z, opts) {
    recompute(); renderZoneHead(z); renderStats(); renderFinal(false);
    if (opts && opts.body) renderZoneBody(z);
    applyFilter();
  }

  async function srAction(z, s, action, btn) {
    const row = btn.closest('.sr'), ta = row.querySelector('.tso-rm');
    btn.disabled = true;
    try {
      const r = await api.put('/api/tso/sr', { date: S.data.date, zone_code: z.zone.code, sr_id: s.sr_id, action,
        tso_remarks: ta ? ta.value : undefined });
      s.entry = r.entry;
      renderSR(z, s, row);
      const acts = qs('.zone-actions [data-act=all]', zoneEl(z.zone.code));
      refreshZone(z);
      if (acts) { const left = z.counts.total_srs - z.counts.approved; acts.disabled = !left; acts.textContent = `Approve all (${left})`; }
    } catch (e) { toast(e.message, 'bad'); btn.disabled = false; if (e.status === 409) load(S.date, true); }
  }

  async function saveSRRemark(z, s, ta, savedEl) {
    try {
      const r = await api.put('/api/tso/sr', { date: S.data.date, zone_code: z.zone.code, sr_id: s.sr_id, action: 'remarks', tso_remarks: ta.value });
      s.entry.tso_remarks = r.entry.tso_remarks;
      if (savedEl) savedEl.textContent = 'Saved ✓';
    } catch (e) { toast(e.message, 'bad'); }
  }

  async function approveAll(z, btn) {
    const left = z.counts.total_srs - z.counts.approved;
    const noPhoto = z.srs.filter(s => s.entry.tso_status !== 'approved' && !s.images.length).length;
    if (!confirm(`Approve all ${left} pending SR(s) of ${z.zone.name}?` + (noPhoto ? `\n\n${noPhoto} of them have no photo (AMO remark only).` : ''))) return;
    btn.disabled = true;
    try {
      // keep any unsaved TSO remarks typed in this zone
      await flushRemarks(z);
      const r = await api.post('/api/tso/zone/approve-all', { date: S.data.date, zone_code: z.zone.code });
      toast(`${r.approved} SR(s) approved`, 'ok');
      await load(S.date, true);
    } catch (e) { toast(e.message, 'bad'); btn.disabled = false; }
  }

  async function flushRemarks(z) {
    const zel = zoneEl(z.zone.code);
    for (const row of qsa('.sr', zel)) {
      const ta = row.querySelector('.tso-rm'); if (!ta) continue;
      const s = srOf(z, row.dataset.sr);
      if (ta.value.trim() !== (s.entry.tso_remarks || '')) await saveSRRemark(z, s, ta, null);
    }
  }

  let returnZone = null;
  function openReturn(z) {
    returnZone = z;
    const dlg = qs('#returnDialog'); qs('#returnForm').reset();
    qs('#returnWho').textContent = `${z.zone.name} (zone ${z.zone.code})${z.amo_username ? ' · ' + z.amo_username : ''}. The AMO will be able to edit and re-submit.`;
    dlg.showModal();
  }
  qs('#returnOk').onclick = async () => {
    const f = qs('#returnForm'); if (!f.reportValidity() || !returnZone) return;
    if (!f.remarks.value.trim()) { toast('Please write a reason', 'bad'); return; }
    const btn = qs('#returnOk'); btn.disabled = true;
    try {
      await api.post('/api/tso/zone/return', { date: S.data.date, zone_code: returnZone.zone.code, remarks: f.remarks.value });
      qs('#returnDialog').close(); toast('Report returned to AMO', 'ok');
      await load(S.date, true);
    } catch (e) { toast(e.message, 'bad'); } finally { btn.disabled = false; }
  };

  qs('#btnSubmit').onclick = () => {
    const d = S.data, t = d.totals;
    if (S.uploader && S.uploader.busy) { toast('Wait until the photo upload finishes', 'bad'); return; }
    let html = `<p>After submitting, the whole territory is <b>locked</b> for you and your AMOs and is sent to the check-back team.</p>
      <ul class="small"><li>${t.zones_submitted} of ${t.zones} AMOs submitted</li><li>${t.srs_with_images} of ${t.total_srs} SRs have photos</li><li>${t.approved} SR(s) approved</li></ul>`;
    if (d.notStarted.length) html += `<div class="banner banner-warn"><b>${d.notStarted.length} AMO(s) have not submitted:</b> ${d.notStarted.map(z => esc(z.zone.name)).join(', ')}.
      Their ${d.notStarted.reduce((n, z) => n + z.srs.length, 0)} SR(s) will be reported as <b>images not uploaded</b>.
      <label class="chk" style="flex-direction:row;gap:8px;margin-top:8px;color:inherit"><input type="checkbox" id="confirmNS"> I understand, submit anyway</label></div>`;
    qs('#submitBody').innerHTML = html;
    const ok = qs('#submitOk'), cb = qs('#confirmNS');
    ok.disabled = !!cb; if (cb) cb.onchange = () => { ok.disabled = !cb.checked; };
    qs('#submitDialog').showModal();
  };
  qs('#submitOk').onclick = async () => {
    const btn = qs('#submitOk'); btn.disabled = true;
    try {
      await saveTerritoryRemarks();
      await api.post('/api/tso/submit', { date: S.data.date, confirm_not_started: !!S.data.notStarted.length });
      qs('#submitDialog').close(); toast('Territory submitted ✓', 'ok');
      await load(S.date);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) { toast(e.message, 'bad'); btn.disabled = false; }
  };

  async function saveTerritoryRemarks() {
    const ta = qs('#tsoRemarks');
    if (!S.data.can_edit || ta.value.trim() === (S.data.territory_report.tso_remarks || '')) return;
    const r = await api.put('/api/tso/remarks', { date: S.data.date, tso_remarks: ta.value });
    S.data.territory_report.tso_remarks = r.tso_remarks;
    qs('#remarksSaved').textContent = 'Saved ✓';
  }
  const saveRemarksDebounced = debounce(() => saveTerritoryRemarks().catch(e => toast(e.message, 'bad')), 900);
  qs('#tsoRemarks').addEventListener('input', () => { qs('#remarksSaved').textContent = ''; saveRemarksDebounced(); });

  /* ---------------- toolbar ---------------- */
  qs('#dateSel').onchange = (e) => load(e.target.value);
  qs('#search').addEventListener('input', debounce(applyFilter, 150));
  qs('#onlyPending').onchange = applyFilter;
  qs('#btnExpand').onclick = () => S.data.zones.forEach(z => toggleZone(z.zone.code, true));
  qs('#btnCollapse').onclick = () => S.data.zones.forEach(z => toggleZone(z.zone.code, false));
  window.addEventListener('beforeunload', (e) => { if (S.uploader && S.uploader.busy) { e.preventDefault(); e.returnValue = ''; } });

  load(new URLSearchParams(location.search).get('date'));
})();
