/* Checker (mother) portal: Tab 1 territory details + checks, Tab 2 dashboard + Excel exports. */
(function () {
  'use strict';

  const COLORS = {           // validated categorical slots (see dataviz palette); text never wears these
    missing: '#eb6834',      // images not uploaded
    uploaded: '#1baf7a',     // uploaded, not yet checked / SRs with images
    checked: '#2a78d6',      // checked by checker (Correct photos? not "No")
    incorrect: '#b3261e',    // checked, but Correct photos? = No (deep red, distinct from the orange "missing")
    total: '#6250d6',        // count of SR
  };
  const INK = { muted: '#898781', ink2: '#52514e', grid: '#e1e0d9', axis: '#c3c2b7', surface: '#ffffff' };
  const nf = new Intl.NumberFormat();
  const state = { hier: null, dates: [], detail: null, dash: null, pie: null, bar: null, dashSeq: 0, detSeq: 0 };

  /* ---------------- generic helpers ---------------- */
  function fmtDay(iso, i) {
    const d = new Date(iso + 'T00:00:00');
    const label = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    if (i === 0) return 'Today · ' + label;
    if (i === 1) return 'Yesterday · ' + label;
    return d.toLocaleDateString(undefined, { weekday: 'short' }) + ' · ' + label;
  }
  function setOptions(sel, items, placeholder, value) {
    sel.innerHTML = (placeholder != null ? `<option value="">${esc(placeholder)}</option>` : '') +
      items.map(it => `<option value="${esc(it.value)}">${esc(it.label)}</option>`).join('');
    if (value != null && items.some(it => String(it.value) === String(value))) sel.value = String(value);
  }
  function store(k, v) { try { localStorage.setItem('checker.' + k, JSON.stringify(v)); } catch (_) { } }
  function load(k) { try { return JSON.parse(localStorage.getItem('checker.' + k) || 'null'); } catch (_) { return null; } }
  const pct = (n, t) => t ? Math.round(n * 1000 / t) / 10 : 0;
  const yesNo = (v) => v === true ? 'Yes' : v === false ? 'No' : '—';

  /* Cascading Wing → Division → Territory selects. */
  class HierFilter {
    constructor(prefix, { allowAll, onChange }) {
      this.w = qs('#' + prefix + 'Wing'); this.d = qs('#' + prefix + 'Division'); this.t = qs('#' + prefix + 'Territory');
      this.allowAll = allowAll; this.onChange = onChange;
      this.w.onchange = () => { this.fillDivisions(); this.fillTerritories(); this.changed(); };
      this.d.onchange = () => { this.fillTerritories(); this.changed(); };
      this.t.onchange = () => this.changed();
    }
    wingObj() { return state.hier.wings.find(w => w.name === this.w.value); }
    divObj() { const w = this.wingObj(); return w && w.divisions.find(d => d.name === this.d.value); }
    init(saved) {
      saved = saved || {};
      // a checker assigned to exactly one wing gets it pre-selected and no "All wings" / "Select wing…" option
      const single = state.hier.wings.length === 1;
      setOptions(this.w, state.hier.wings.map(w => ({ value: w.name, label: w.name })),
        single ? null : (this.allowAll ? (state.hier.my_wings ? 'All my wings' : 'All wings') : 'Select wing…'), single ? state.hier.wings[0].name : saved.wing);
      this.w.disabled = single;
      this.fillDivisions(saved.division); this.fillTerritories(saved.territory_code);
    }
    fillDivisions(value) {
      const w = this.wingObj();
      setOptions(this.d, w ? w.divisions.map(d => ({ value: d.name, label: d.name })) : [],
        w ? (this.allowAll ? 'All divisions' : 'Select division…') : (this.allowAll ? 'All divisions' : '— choose wing first —'), value);
      this.d.disabled = !w;
    }
    fillTerritories(value) {
      const dv = this.divObj();
      setOptions(this.t, dv ? dv.territories.map(t => ({ value: t.code, label: `${t.name} (${t.code})` })) : [],
        dv ? (this.allowAll ? 'All territories' : 'Select territory…') : (this.allowAll ? 'All territories' : '— choose division first —'), value);
      this.t.disabled = !dv;
    }
    value() { return { wing: this.w.value, division: this.d.value, territory_code: this.t.value }; }
    set(v) { this.init(v); this.changed(); }
    changed() { this.onChange && this.onChange(this.value()); }
  }

  /* ---------------- tabs ---------------- */
  function showTab(name) {
    qsa('.tab').forEach(b => { const on = b.dataset.tab === name; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
    qs('#panel-details').classList.toggle('hidden', name !== 'details');
    qs('#panel-dashboard').classList.toggle('hidden', name !== 'dashboard');
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    if (name === 'dashboard') loadDashboard();
  }

  /* ================= Tab 1: territory details ================= */
  let detFilter;
  function detailParams() {
    return { date: qs('#dDate').value, territory_code: detFilter.value().territory_code };
  }

  async function loadDetail() {
    const p = detailParams(); const body = qs('#dBody');
    store('detail', { date: p.date, ...detFilter.value() });
    if (!p.territory_code) {
      state.detail = null;
      body.innerHTML = '<div class="card empty-state"><b>Choose a territory</b>Pick a wing, division and territory above to see everything submitted for that day.</div>';
      return;
    }
    const seq = ++state.detSeq;
    body.classList.add('is-loading');
    try {
      const data = await api.get(`/api/checker/territory?date=${encodeURIComponent(p.date)}&territory_code=${encodeURIComponent(p.territory_code)}`);
      if (seq !== state.detSeq) return;
      state.detail = data; renderDetail();
    } catch (e) {
      if (seq !== state.detSeq) return;
      body.innerHTML = `<div class="card"><div class="banner banner-bad">${esc(e.message)}</div></div>`;
    } finally { if (seq === state.detSeq) body.classList.remove('is-loading'); }
  }

  function renderDetail() {
    const D = state.detail, t = D.territory, body = qs('#dBody');
    const crumbs = `${esc(t.wing)} › ${esc(t.division)}`;
    if (!D.submitted) {
      body.innerHTML = `<div class="card"><div class="terr-title"><h2>${esc(t.name)} <span class="muted">(${esc(t.code)})</span></h2>
        <span class="badge badge-warn">Not submitted by TSO</span></div><div class="crumbs">${crumbs}</div>
        <div class="empty-state"><b>Nothing to check yet</b>${esc(D.message || '')}</div></div>`;
      return;
    }
    const tr = D.territory_report, rows = D.rows;
    const withImg = rows.filter(r => r.image_count > 0).length;
    const checked = rows.filter(isChecked).length;
    const held = D.zones.filter(z => z.report.meeting_held === true).length;
    body.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div>
            <div class="terr-title"><h2>${esc(t.name)} <span class="muted">(${esc(t.code)})</span></h2><span class="badge badge-ok">Submitted by TSO</span></div>
            <div class="crumbs">${crumbs} · submitted ${esc(fmtDateTime(tr.submitted_at))}${tr.submitted_by ? ' by ' + esc(tr.submitted_by) : ''}</div>
          </div>
        </div>
        <div class="mini-stats">
          <div class="stat"><div class="label">SRs</div><div class="value">${nf.format(rows.length)}</div></div>
          <div class="stat"><div class="label">SRs with photos</div><div class="value">${nf.format(withImg)}</div><div class="sub">${pct(withImg, rows.length)}%</div></div>
          <div class="stat"><div class="label">Checked</div><div class="value" id="stChecked">${nf.format(checked)}</div><div class="sub" id="stCheckedPct">${pct(checked, withImg)}% of SRs with photos</div></div>
          <div class="stat"><div class="label">Meetings held</div><div class="value">${held} <small class="muted">/ ${D.zones.length}</small></div></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3 style="margin:0">TSO photos &amp; remarks</h3></div>
        <div class="kv" style="margin-bottom:10px"><div><div class="k">TSO remarks</div><div class="v">${tr.tso_remarks ? esc(tr.tso_remarks) : '<span class="muted">—</span>'}</div></div></div>
        <div class="thumbs" id="tsoThumbs"></div>
      </div>

      <div class="card">
        <details class="zones-wrap" id="zonesWrap">
          <summary>Pre-plan meetings by AMO (${D.zones.length}) <span class="muted small" style="font-weight:400">· ${held} held</span></summary>
          <div class="zones" id="zones"></div>
        </details>
      </div>

      <div class="card">
        <div class="toolbar">
          <input type="search" id="srSearch" placeholder="Search SR, AMO, route, remarks…" aria-label="Search SRs">
          <label class="chk"><input type="checkbox" id="onlyUnchecked"> Only unchecked</label>
          <span class="muted small" id="visCount"></span>
          <span class="spacer"></span>
          <button class="btn btn-ok btn-sm" id="checkAll" type="button">Check all visible</button>
        </div>
        <div class="table-wrap sr-table-wrap"><table class="tbl sr-table" id="srTable"></table></div>
      </div>`;

    renderThumbs(qs('#tsoThumbs'), D.tso_images, { caption: () => 'TSO photo' });
    if (!D.tso_images.length) qs('#tsoThumbs').innerHTML = '<span class="muted small">No TSO photos</span>';
    const zw = qs('#zonesWrap'); zw.open = load('zonesOpen') !== false;
    zw.addEventListener('toggle', () => store('zonesOpen', zw.open));
    renderZones(); renderTable();
    const s = qs('#srSearch'), ou = qs('#onlyUnchecked');
    s.oninput = debounce(applyRowFilter, 150); ou.onchange = applyRowFilter;
    qs('#checkAll').onclick = checkAllVisible;
  }

  function renderZones() {
    const D = state.detail, box = qs('#zones'); box.innerHTML = '';
    D.zones.forEach(z => {
      const r = z.report, el = document.createElement('div');
      el.className = 'zone-card' + (r.checker_meeting_valid ? ' valid-' + r.checker_meeting_valid : '');
      const statusBadge = r.status === 'submitted' ? '<span class="badge badge-ok">Submitted</span>'
        : r.status === 'not_started' ? '<span class="badge badge-bad">Not submitted</span>' : `<span class="badge badge-warn">${esc(r.status)}</span>`;
      const meeting = r.meeting_held === true ? `<span class="badge badge-ok">Held${r.meeting_time ? ' · ' + esc(r.meeting_time) : ''}</span>`
        : r.meeting_held === false ? '<span class="badge badge-bad">Not held</span>' : '<span class="badge">Unknown</span>';
      el.innerHTML = `
        <div class="zc-head"><div><b>${esc(z.zone.name)}</b><div class="muted small">Zone ${esc(z.zone.code)}${z.amo_username ? ' · ' + esc(z.amo_username) : ''}</div></div>
          <div class="flags">${statusBadge}${meeting}</div></div>
        <div class="kv small">
          <div><div class="k">Location</div><div class="v">${esc(r.location) || '—'}</div></div>
          <div><div class="k">SR present</div><div class="v">${r.sr_present_count ?? '—'} <span class="muted">of ${z.sr_count}</span></div></div>
          ${r.meeting_held === false ? `<div style="grid-column:1/-1"><div class="k">Reason not held</div><div class="v">${esc(r.not_held_reason) || '—'}</div></div>` : ''}
          ${r.vacancy_remarks ? `<div style="grid-column:1/-1"><div class="k">Vacancy remarks</div><div class="v">${esc(r.vacancy_remarks)}</div></div>` : ''}
        </div>
        <div class="thumbs"></div>
        <label class="valid small">Meeting held with valid photo?
          <select ${r.status === 'not_started' ? 'disabled' : ''}><option value="">—</option><option value="yes">Yes</option><option value="no">No</option></select></label>`;
      const th = el.querySelector('.thumbs');
      if (z.meeting_images.length) renderThumbs(th, z.meeting_images, { caption: () => `${z.zone.name} · meeting photo` });
      else th.innerHTML = '<span class="muted small">No meeting photo</span>';
      const sel = el.querySelector('select'); sel.value = r.checker_meeting_valid || '';
      sel.onchange = async () => {
        sel.disabled = true;
        try {
          const res = await api.put('/api/checker/zone', { date: D.date, zone_code: z.zone.code, checker_meeting_valid: sel.value || null });
          z.report = Object.assign(z.report, res.report);
          el.classList.remove('valid-yes', 'valid-no'); if (sel.value) el.classList.add('valid-' + sel.value);
          toast('Saved', 'ok');
        } catch (e) { toast(e.message, 'bad'); sel.value = z.report.checker_meeting_valid || ''; }
        finally { sel.disabled = false; }
      };
      box.appendChild(el);
    });
  }

  const COLS = ['Wing / Division / Territory / Zone', 'SR ID', 'SR Name', 'Routes', 'Photos', '# Photos', 'Flags',
    'AMO Remarks', 'TSO Status', 'TSO Remarks', 'Correct photos?', 'Checked'];

  function renderTable() {
    const D = state.detail, t = D.territory, tbl = qs('#srTable');
    tbl.innerHTML = `<thead><tr>${COLS.map(c => `<th${c === '# Photos' ? ' class="num"' : ''}>${esc(c)}</th>`).join('')}</tr></thead><tbody></tbody>`;
    const tb = tbl.querySelector('tbody');
    let zone = null;
    D.rows.forEach((r, i) => {
      if (r.zone_code !== zone) {
        zone = r.zone_code;
        const z = D.zones.find(x => x.zone.code === zone);
        const g = document.createElement('tr'); g.className = 'grp'; g.dataset.zone = zone;
        g.innerHTML = `<td class="grp" colspan="${COLS.length}">${esc(r.zone_name)} <span style="font-weight:400">· Zone ${esc(zone)}${z && z.amo_username ? ' · ' + esc(z.amo_username) : ''}</span></td>`;
        tb.appendChild(g);
      }
      const tr = document.createElement('tr'); tr.dataset.i = i; tr.dataset.zone = r.zone_code;
      r._search = [r.sr_id, r.sr_name, r.zone_name, r.route_names, r.route_codes, r.amo_remarks, r.tso_remarks, r.checker_remarks].join(' ').toLowerCase();
      const flags = [r.flags.duplicate ? '<span class="badge badge-bad" title="A photo was re-used from an earlier upload">REUSED</span>' : '',
        r.flags.old ? '<span class="badge badge-warn" title="A photo was taken more than 2 days before">OLD</span>' : ''].join('');
      tr.innerHTML = `
        <td class="c-hier" data-label="Wing / Division / Territory / Zone">${esc(t.wing)}<br>${esc(t.division)}<br>${esc(t.name)}<br><span class="c-zone">${esc(r.zone_name)}</span></td>
        <td data-label="SR ID" class="nowrap">${esc(r.sr_id)}</td>
        <td data-label="SR Name"><b>${esc(r.sr_name)}</b></td>
        <td data-label="Routes" class="c-routes" title="${esc(r.route_codes)}">${esc(r.route_names)}</td>
        <td data-label="Photos" class="c-photos"><div class="thumbs"></div></td>
        <td data-label="# Photos" class="num">${r.image_count}</td>
        <td data-label="Flags"><div class="flags">${flags || '<span class="muted">—</span>'}</div></td>
        <td data-label="AMO Remarks" class="c-rem">${esc(r.amo_remarks) || '<span class="muted">—</span>'}</td>
        <td data-label="TSO Status">${r.tso_status === 'approved' ? '<span class="badge badge-ok">Approved</span>' : '<span class="badge badge-warn">Pending</span>'}</td>
        <td data-label="TSO Remarks" class="c-rem">${esc(r.tso_remarks) || '<span class="muted">—</span>'}</td>
        <td data-label="Correct photos?" class="c-valid">
          <div><select aria-label="Correct photos for ${esc(r.sr_name)}"><option value="">—</option><option value="yes">Yes</option><option value="no">No</option></select>
          <input type="text" maxlength="2000" placeholder="Checker remarks" aria-label="Checker remarks for ${esc(r.sr_name)}"></div>
        </td>
        <td data-label="Checked" class="c-check"><button type="button" class="btn btn-sm btn-check"></button></td>`;
      const th = tr.querySelector('.c-photos .thumbs');
      if (r.images.length) renderThumbs(th, r.images, { caption: (img) => `${r.sr_name} (${r.sr_id})${img.duplicate ? ' · REUSED' : ''}${img.old_photo ? ' · OLD' : ''}` });
      else { th.textContent = 'No photo'; tr.classList.add('no-img'); }
      const sel = tr.querySelector('select'), rem = tr.querySelector('input'), btn = tr.querySelector('.btn-check');
      sel.value = r.checker_valid || ''; rem.value = r.checker_remarks || '';
      sel.onchange = () => saveRow(r, tr, { checker_valid: sel.value || null });
      rem.onchange = () => saveRow(r, tr, { checker_remarks: rem.value });
      btn.onclick = () => saveRow(r, tr, { checked: !r.checked });
      paintRow(r, tr);
      tb.appendChild(tr);
    });
    applyRowFilter();
  }

  // "Checked" = a checker verified the SR's photos (same definition as the dashboard and the Excel export);
  // an SR without photos is "not uploaded" and has nothing to check.
  const canCheck = (r) => r.image_count > 0;
  const isChecked = (r) => !!r.checked && canCheck(r);

  function paintRow(r, tr) {
    const btn = tr.querySelector('.btn-check');
    if (!canCheck(r) && !r.checked) {
      btn.disabled = true; btn.classList.remove('done'); btn.classList.add('na');
      btn.textContent = 'No photo'; btn.title = 'No photo uploaded for this SR — nothing to check';
      btn.removeAttribute('aria-pressed');
      return;
    }
    tr.classList.toggle('is-checked', !!r.checked);
    btn.classList.toggle('done', !!r.checked);
    btn.innerHTML = r.checked ? `Checked ✓<span class="by">by ${esc(r.checked_by || '')}</span>` : 'Checked';
    btn.title = r.checked ? `Checked ${fmtDateTime(r.checked_at)} — click to undo` : 'Mark this SR as checked';
    btn.setAttribute('aria-pressed', r.checked ? 'true' : 'false');
  }

  async function saveRow(r, tr, change) {
    const D = state.detail, btn = tr.querySelector('.btn-check'), sel = tr.querySelector('select'), rem = tr.querySelector('input');
    const body = { date: D.date, zone_code: r.zone_code, sr_id: r.sr_id, checked: r.checked, checker_valid: r.checker_valid,
      checker_remarks: r.checker_remarks, ...change };
    btn.disabled = true;
    try {
      const res = await api.put('/api/checker/sr', body);
      Object.assign(r, res.entry); paintRow(r, tr);
      updateCheckedStats();
      if (!('checked' in change)) toast('Saved', 'ok');
    } catch (e) {
      toast(e.message, 'bad'); sel.value = r.checker_valid || ''; rem.value = r.checker_remarks || '';
    } finally { btn.disabled = !canCheck(r) && !r.checked; }
    if (qs('#onlyUnchecked').checked && r.checked) setTimeout(applyRowFilter, 600);
  }

  function updateCheckedStats() {
    const rows = state.detail.rows, n = rows.filter(isChecked).length, withImg = rows.filter(canCheck).length;
    qs('#stChecked').textContent = nf.format(n); qs('#stCheckedPct').textContent = pct(n, withImg) + '% of SRs with photos';
    applyRowFilter();
  }

  function visibleRows() {
    const q = (qs('#srSearch').value || '').trim().toLowerCase(), only = qs('#onlyUnchecked').checked;
    return state.detail.rows.filter(r => (!q || r._search.includes(q)) && (!only || (!r.checked && canCheck(r))));
  }

  function applyRowFilter() {
    const vis = new Set(visibleRows()), rows = state.detail.rows, zonesShown = new Set();
    qsa('#srTable tbody tr').forEach(tr => {
      if (tr.classList.contains('grp')) return;
      const r = rows[+tr.dataset.i], on = vis.has(r);
      tr.classList.toggle('hidden', !on); if (on) zonesShown.add(tr.dataset.zone);
    });
    qsa('#srTable tbody tr.grp').forEach(g => g.classList.toggle('hidden', !zonesShown.has(g.dataset.zone)));
    const pending = [...vis].filter(r => !r.checked && canCheck(r)).length;
    qs('#visCount').textContent = `${vis.size} of ${rows.length} SRs shown`;
    const b = qs('#checkAll'); b.disabled = pending === 0; b.textContent = pending ? `Check all visible (${pending})` : 'All visible checked';
  }

  async function checkAllVisible() {
    const D = state.detail, pend = visibleRows().filter(r => !r.checked && canCheck(r));
    if (!pend.length) return;
    if (!confirm(`Mark ${pend.length} SR(s) as checked?`)) return;
    const b = qs('#checkAll'); b.disabled = true;
    try {
      const all = pend.length === D.rows.filter(r => !r.checked && canCheck(r)).length;
      await api.post('/api/checker/check-all', { date: D.date, territory_code: D.territory.code,
        items: all ? null : pend.map(r => ({ zone_code: r.zone_code, sr_id: r.sr_id })) });
      toast(`${pend.length} SR(s) marked checked`, 'ok');
      await loadDetail();
    } catch (e) { toast(e.message, 'bad'); b.disabled = false; }
  }

  /* ================= Tab 2: dashboard ================= */
  let dashFilter;
  function dashQuery() {
    const v = dashFilter.value(), p = new URLSearchParams({ date: qs('#bDate').value });
    if (v.wing) p.set('wing', v.wing); if (v.division) p.set('division', v.division); if (v.territory_code) p.set('territory_code', v.territory_code);
    return p.toString();
  }

  const loadDashboard = debounce(async function () {
    if (qs('#panel-dashboard').classList.contains('hidden')) return;
    const q = dashQuery(), seq = ++state.dashSeq, body = qs('#bBody');
    store('dash', { date: qs('#bDate').value, ...dashFilter.value() });
    body.classList.add('is-loading');   // keep the previous frame while refetching
    try {
      const data = await api.get('/api/checker/dashboard?' + q);
      if (seq !== state.dashSeq) return;
      state.dash = data; renderDashboard();
    } catch (e) { if (seq === state.dashSeq) toast(e.message, 'bad'); }
    finally { if (seq === state.dashSeq) body.classList.remove('is-loading'); }
  }, 120);

  function scopeLabel() {
    const v = dashFilter.value();
    if (v.territory_code) return qs('#bTerritory').selectedOptions[0].textContent;
    return v.division || v.wing || (state.hier.my_wings ? 'All my wings' : 'All wings');
  }

  function kpi(label, value, of, sub, barPct) {
    return `<div class="stat"><div class="label">${esc(label)}</div>
      <div class="value">${value}${of != null ? ` <small>of ${of}</small>` : ''}</div>
      <div class="sub">${sub}</div>${barPct != null ? `<div class="progressbar"><i style="width:${Math.min(100, barPct)}%"></i></div>` : ''}</div>`;
  }

  function renderDashboard() {
    const D = state.dash, T = D.totals;
    qs('#kpis').innerHTML = [
      kpi('Pre-plan meetings held', nf.format(T.zones_meeting_held), nf.format(T.zones_total), `${pct(T.zones_meeting_held, T.zones_total)}% of locations (AMOs)`, pct(T.zones_meeting_held, T.zones_total)),
      kpi('SRs with outlet-wise pre-plan', nf.format(T.uploaded), nf.format(T.total_srs), `${T.pct_uploaded}% have photos · ${nf.format(T.not_uploaded)} missing`, T.pct_uploaded),
      kpi('Checked by checkers', nf.format(T.checked_total), nf.format(T.uploaded), `${pct(T.checked_total, T.uploaded)}% of uploaded · ${nf.format(T.uploaded_not_checked)} to go`, pct(T.checked_total, T.uploaded)),
      kpi('Incorrect photos', nf.format(T.incorrect), nf.format(T.checked_total), `${pct(T.incorrect, T.checked_total)}% of checked SRs marked "No"`, null),
      kpi('Check pass rate', (T.check_pass + T.check_fail) ? T.pass_pct + '%' : '—', null, `${nf.format(T.check_pass)} correct · ${nf.format(T.check_fail)} incorrect photos`, null),
      kpi('Territories submitted', nf.format(T.territories_submitted), nf.format(T.territories_total), `${pct(T.territories_submitted, T.territories_total)}% submitted by TSOs`, pct(T.territories_submitted, T.territories_total)),
    ].join('');
    qs('#pieSub').textContent = `${nf.format(T.total_srs)} SRs · ${scopeLabel()} · ${fmtDay(D.date, state.dates.indexOf(D.date))}`;
    renderPie(); renderBar(); renderDivTable(); updateDownloadLinks();
  }

  function renderPie() {
    const P = state.dash.pie, total = state.dash.totals.total_srs;  // center label reads state on every draw
    const colors = [COLORS.missing, COLORS.uploaded, COLORS.checked, COLORS.incorrect];
    const center = {
      id: 'centerTotal',
      afterDraw(chart) {
        const m = chart.getDatasetMeta(0); if (!m.data.length) return;
        const { x, y } = m.data[0], ctx = chart.ctx, total = state.dash ? state.dash.totals.total_srs : 0;
        ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#1b2430'; ctx.font = '700 24px system-ui, -apple-system, "Segoe UI", sans-serif'; ctx.fillText(nf.format(total), x, y - 8);
        ctx.fillStyle = INK.ink2; ctx.font = '500 12px system-ui, -apple-system, "Segoe UI", sans-serif'; ctx.fillText('SRs in scope', x, y + 14);
        ctx.restore();
      },
    };
    const values = total ? P.values : P.values.map(() => 0);
    if (state.pie) { state.pie.data.labels = P.labels; state.pie.data.datasets[0].data = values; state.pie.update(); }
    else {
      state.pie = new Chart(qs('#pieChart'), {
        type: 'doughnut',
        data: { labels: P.labels, datasets: [{ data: values, backgroundColor: colors, borderColor: INK.surface, borderWidth: 2, hoverOffset: 6 }] },
        options: {
          responsive: true, maintainAspectRatio: false, cutout: '58%', animation: { duration: 250 },
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: (c) => ` ${nf.format(c.raw)} SRs · ${state.dash.pie.pct[c.dataIndex]}%` } },
          },
        },
        plugins: [center],
      });
    }
    qs('#pieLegend').innerHTML = P.labels.map((l, i) =>
      `<span class="li"><span class="sw" style="background:${colors[i]}"></span>${esc(l)} <b>${nf.format(P.values[i])}</b><span class="muted">(${P.pct[i]}%)</span></span>`).join('');
  }

  // all / wing scope: one bar pair per division; division or territory scope: one per territory
  const barByTerritory = () => (state.dash.by_territory || []).length > 0;
  function barRows() {
    if (barByTerritory()) return state.dash.by_territory.map(d => ({ label: `${d.territory} (${d.territory_code})`, ...d }));
    return state.dash.by_division.map(d => ({ label: d.division, ...d }));
  }

  function renderBar() {
    const rows = barRows(), horizontal = rows.length > 12;
    const box = qs('#barBox');
    box.style.height = horizontal ? Math.max(320, rows.length * 34 + 70) + 'px' : '320px';
    const ds = [
      { label: 'Count of SR', data: rows.map(r => r.total_srs), backgroundColor: COLORS.total },
      { label: 'SRs with images uploaded', data: rows.map(r => r.srs_with_images), backgroundColor: COLORS.uploaded },
    ].map(d => Object.assign(d, { borderRadius: 4, borderSkipped: 'start', maxBarThickness: 24, categoryPercentage: 0.7, barPercentage: 0.9 }));
    const axisIdx = horizontal ? 'y' : 'x';
    const tickFont = { size: 11 };
    const valueAxis = { position: horizontal ? 'top' : 'left', beginAtZero: true, grid: { color: INK.grid }, border: { color: INK.axis }, ticks: { color: INK.muted, font: tickFont, precision: 0 } };
    const catAxis = { grid: { display: false }, border: { color: INK.axis },
      ticks: { color: INK.ink2, font: tickFont, autoSkip: false, maxRotation: 45, callback: function (val) { const l = this.getLabelForValue(val); return l.length > 22 ? l.slice(0, 21) + '…' : l; } } };
    if (state.bar) state.bar.destroy();
    state.bar = new Chart(qs('#barChart'), {
      type: 'bar',
      data: { labels: rows.map(r => r.label), datasets: ds },
      options: {
        indexAxis: axisIdx, responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
        interaction: { mode: 'index', intersect: false },
        scales: horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: {
            title: (items) => { const r = rows[items[0].dataIndex]; return r.territory_code ? `${r.territory} (${r.territory_code}) · ${r.division}` : `${r.division} (${r.wing})`; },
            label: (c) => ` ${c.dataset.label}: ${nf.format(c.raw)}`,
            footer: (items) => { const r = rows[items[0].dataIndex]; return `${r.pct_uploaded}% uploaded · ${nf.format(r.checked)} checked (correct) · ${nf.format(r.incorrect)} incorrect`; },
          } },
        },
        onClick: (_e, els) => {
          if (!els.length) return; const r = rows[els[0].index], v = dashFilter.value();
          if (r.territory_code) { if (String(v.territory_code) !== String(r.territory_code)) dashFilter.set({ wing: r.wing, division: r.division, territory_code: r.territory_code }); return; }
          if (v.division === r.division) return;
          dashFilter.set({ wing: r.wing, division: r.division });
        },
        onHover: (e, els) => { e.native.target.style.cursor = els.length && !dashFilter.value().territory_code ? 'pointer' : 'default'; },
      },
    });
    const v = dashFilter.value();
    qs('#barTitle').textContent = barByTerritory() ? `Count of SR vs SRs with images · ${v.division || rows[0].division}, by territory` : 'Count of SR vs SRs with images, by division';
    qs('#barSub').textContent = v.territory_code ? 'Showing the selected territory.' : barByTerritory() ? 'Click a territory to focus on it.' : 'Click a division to drill into it.';
    qs('#barLegend').innerHTML = ds.map(d => `<span class="li"><span class="sw" style="background:${d.backgroundColor}"></span>${esc(d.label)}</span>`).join('');
  }

  function renderDivTable() {
    const D = state.dash, rows = D.by_division, T = D.totals;
    qs('#tblTitle').textContent = 'Division numbers';
    qs('#tblNote').textContent = `${rows.length} division(s) · ${fmtDay(D.date, state.dates.indexOf(D.date))}`;
    const pc = (n, t) => `${pct(n, t)}%<span class="pct-bar"><i style="width:${pct(n, t)}%"></i></span>`;
    qs('#divTable').innerHTML = `
      <thead><tr><th>Wing</th><th>Division</th><th class="num">Count of SR</th><th class="num">SRs with images</th><th class="num">Not uploaded</th><th class="num">% uploaded</th><th class="num" title="Checked by checker with Correct photos? Yes or blank">Checked (correct)</th><th class="num" title="Checked by checker and marked Correct photos? No">Incorrect photo</th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr data-i="${i}" title="Show ${esc(r.division)}"><td>${esc(r.wing)}</td><td>${esc(r.division)}</td><td class="num">${nf.format(r.total_srs)}</td>
        <td class="num">${nf.format(r.srs_with_images)}</td><td class="num">${nf.format(r.total_srs - r.srs_with_images)}</td>
        <td class="num nowrap">${pc(r.srs_with_images, r.total_srs)}</td><td class="num">${nf.format(r.checked)}</td><td class="num${r.incorrect ? ' c-bad' : ''}">${nf.format(r.incorrect)}</td></tr>`).join('') ||
        '<tr><td colspan="8" class="muted">No data</td></tr>'}</tbody>
      <tfoot><tr><td colspan="2">Total</td><td class="num">${nf.format(T.total_srs)}</td><td class="num">${nf.format(T.uploaded)}</td>
        <td class="num">${nf.format(T.not_uploaded)}</td><td class="num nowrap">${pc(T.uploaded, T.total_srs)}</td><td class="num">${nf.format(T.checked)}</td><td class="num${T.incorrect ? ' c-bad' : ''}">${nf.format(T.incorrect)}</td></tr></tfoot>`;
    qsa('#divTable tbody tr[data-i]').forEach(tr => tr.onclick = () => { const r = rows[+tr.dataset.i]; dashFilter.set({ wing: r.wing, division: r.division }); });
  }

  function updateDownloadLinks() {
    const q = dashQuery();
    qs('#dlMissing').href = '/api/checker/export/missing.xlsx?' + q;
    qs('#dlFull').href = '/api/checker/export/full.xlsx?' + q;
  }

  async function download(e) {
    e.preventDefault();
    const a = e.currentTarget, label = a.textContent;
    updateDownloadLinks();
    a.classList.add('is-loading'); a.textContent = 'Preparing…';
    try {
      const r = await fetch(a.href, { credentials: 'same-origin' });
      if (!r.ok) { let m = r.statusText; try { m = (await r.json()).detail || m; } catch (_) { } throw new Error(m); }
      const blob = await r.blob();
      const name = ((r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/) || [])[1] || 'export.xlsx';
      const url = URL.createObjectURL(blob), tmp = document.createElement('a');
      tmp.href = url; tmp.download = name; document.body.appendChild(tmp); tmp.click(); tmp.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast('Downloaded ' + name, 'ok');
    } catch (err) { toast(err.message || 'Download failed', 'bad'); }
    finally { a.classList.remove('is-loading'); a.textContent = label; }
  }

  /* ---------------- boot ---------------- */
  async function init() {
    try { state.hier = await api.get('/api/checker/hierarchy'); }
    catch (e) { qs('#dBody').innerHTML = `<div class="card banner banner-bad">${esc(e.message)}</div>`; return; }
    state.dates = state.hier.viewable_dates || [];
    const mw = state.hier.my_wings, mwEl = qs('#myWings');
    if (mw) { mwEl.innerHTML = `Your wing${mw.length === 1 ? '' : 's'}: <b>${mw.length ? mw.map(esc).join(', ') : 'none assigned — ask the admin'}</b>`; mwEl.classList.remove('hidden'); }
    const dateOpts = state.dates.map((d, i) => ({ value: d, label: fmtDay(d, i) }));
    const sd = load('detail') || {}, sb = load('dash') || {};
    setOptions(qs('#dDate'), dateOpts, null, sd.date); setOptions(qs('#bDate'), dateOpts, null, sb.date);

    detFilter = new HierFilter('d', { allowAll: false, onChange: loadDetail });
    detFilter.init(sd);
    qs('#dDate').onchange = loadDetail; qs('#dReload').onclick = loadDetail;

    dashFilter = new HierFilter('b', { allowAll: true, onChange: loadDashboard });
    dashFilter.init(sb);
    qs('#bDate').onchange = loadDashboard;
    qs('#dlMissing').onclick = download; qs('#dlFull').onclick = download;

    qsa('.tab').forEach(b => b.onclick = () => showTab(b.dataset.tab));
    window.addEventListener('hashchange', () => showTab(location.hash === '#dashboard' ? 'dashboard' : 'details'));
    showTab(location.hash === '#dashboard' ? 'dashboard' : 'details');
    if (detFilter.value().territory_code) loadDetail();
  }

  if (typeof Chart !== 'undefined') {
    Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    Chart.defaults.color = INK.ink2;
  }
  document.addEventListener('DOMContentLoaded', init);
})();
