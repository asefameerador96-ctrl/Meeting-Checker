/* Admin portal: user list/search, password reset, activate/deactivate. */
(function () {
  'use strict';
  const PAGE = 50;
  const ROLE_LABEL = { amo: 'AMO', tso: 'TSO', checker: 'Checker', admin: 'Admin' };
  const st = { q: '', role: '', active: '', offset: 0, total: 0, me: '', users: [], seq: 0 };

  function params(withPage) {
    const p = new URLSearchParams();
    if (st.q) p.set('q', st.q);
    if (st.role) p.set('role', st.role);
    if (st.active) p.set('active', st.active);
    if (withPage) { p.set('offset', st.offset); p.set('limit', PAGE); }
    return p.toString();
  }

  function renderSummary(s) {
    const box = qs('#roleStats');
    const tiles = [{ role: '', label: 'All users', ...s.totals }].concat(s.roles.map(r => ({ ...r, label: ROLE_LABEL[r.role] || r.role })));
    box.innerHTML = tiles.map(t => `
      <button type="button" class="stat${st.role === t.role ? ' sel' : ''}" data-role="${esc(t.role)}">
        <div class="label">${esc(t.label)}</div>
        <div class="value">${Number(t.total).toLocaleString()}</div>
        <div class="sub">${Number(t.active).toLocaleString()} active${t.inactive ? ` · ${Number(t.inactive).toLocaleString()} inactive` : ''}</div>
        <div class="sub">${Number(t.never_logged_in).toLocaleString()} never logged in</div>
      </button>`).join('');
    qsa('.stat', box).forEach(b => b.onclick = () => { qs('#fRole').value = b.dataset.role; onFilter(); });
  }

  function place(u) {
    if (u.role === 'amo') return `<div>${esc(u.zone_name || '')} <span class="u-sub">(${esc(u.zone_code)})</span></div><div class="u-sub">${esc(u.territory_name || '')} · ${esc(u.division || '')} · ${esc(u.wing || '')}</div>`;
    if (u.role === 'tso') return `<div>${esc(u.territory_name || '')} <span class="u-sub">(${esc(u.territory_code)})</span></div><div class="u-sub">${esc(u.division || '')} · ${esc(u.wing || '')}</div>`;
    return '<span class="muted">All territories</span>';
  }

  function rowHtml(u) {
    const self = u.username === st.me;
    const status = u.active ? '<span class="badge badge-ok">Active</span>' : '<span class="badge badge-bad">Inactive</span>';
    const actions = self ? '<span class="u-sub">This is you</span>' : `
      <button class="btn btn-sm" type="button" data-act="reset">Reset password</button>
      ${u.active ? '<button class="btn btn-sm btn-ghost" type="button" data-act="deactivate">Deactivate</button>'
                 : '<button class="btn btn-sm btn-ok" type="button" data-act="activate">Activate</button>'}`;
    return `<tr data-u="${esc(u.username)}" class="${u.active ? '' : 'inactive'}">
      <td><div class="u-name">${esc(u.username)}</div><div class="u-sub">${esc(u.display_name)}</div></td>
      <td data-k="Role"><span class="badge badge-info">${esc(ROLE_LABEL[u.role] || u.role)}</span></td>
      <td data-k="Area">${place(u)}</td>
      <td data-k="Last login" class="nowrap">${u.last_login_at ? esc(fmtDateTime(u.last_login_at)) : '<span class="muted">Never</span>'}</td>
      <td data-k="Status">${status}</td>
      <td class="u-act-cell"><div class="u-actions">${actions}</div></td>
    </tr>`;
  }

  function renderRows() {
    const tb = qs('#userRows');
    tb.innerHTML = st.users.length ? st.users.map(rowHtml).join('') : '<tr><td colspan="6" class="skeleton">No users match these filters.</td></tr>';
    const from = st.total ? st.offset + 1 : 0, to = st.offset + st.users.length;
    qs('#resultInfo').textContent = `${st.total.toLocaleString()} user${st.total === 1 ? '' : 's'}` + (st.total ? ` · showing ${from}–${to}` : '');
    const pages = Math.max(1, Math.ceil(st.total / PAGE));
    qs('#pageInfo').textContent = `Page ${Math.floor(st.offset / PAGE) + 1} of ${pages}`;
    qs('#prevPage').disabled = st.offset <= 0;
    qs('#nextPage').disabled = to >= st.total;
  }

  async function load() {
    const seq = ++st.seq;
    qs('#userTbl').style.opacity = '.55';
    try {
      const d = await api.get('/api/admin/users?' + params(true));
      if (seq !== st.seq) return;  // a newer request superseded this one
      Object.assign(st, { total: d.total, me: d.me, users: d.users });
      renderSummary(d.summary); renderRows();
    } catch (e) {
      if (seq === st.seq) { qs('#resultInfo').textContent = 'Could not load users'; toast(e.message, 'bad'); }
    } finally {
      if (seq === st.seq) qs('#userTbl').style.opacity = '';
    }
    const link = qs('#csvLink'), p = params(false);
    link.href = '/api/admin/users.csv' + (p ? '?' + p : '');
    link.textContent = p ? 'Export these usernames (no passwords)' : 'Export all usernames (no passwords)';
  }

  function onFilter() {
    st.q = qs('#fQ').value.trim(); st.role = qs('#fRole').value; st.active = qs('#fActive').value; st.offset = 0;
    load();
  }

  async function act(username, action, btn) {
    const u = st.users.find(x => x.username === username); if (!u) return;
    const enc = encodeURIComponent(username);
    if (action === 'reset') {
      if (!confirm(`Reset the password for ${username}? They will be signed out and need the new password.`)) return;
      btn.disabled = true;
      try {
        const r = await api.post(`/api/admin/users/${enc}/reset-password`);
        qs('#pwUser').textContent = r.username; qs('#pwValue').textContent = r.password;
        qs('#pwCopy').textContent = 'Copy'; qs('#pwResult').showModal();
      } catch (e) { toast(e.message, 'bad'); } finally { btn.disabled = false; }
      return;
    }
    const active = action === 'activate';
    if (!active && !confirm(`Deactivate ${username}? They will be signed out and cannot log in until re-activated.`)) return;
    btn.disabled = true;
    try {
      const nu = await api.put(`/api/admin/users/${enc}`, { active });
      Object.assign(u, nu);
      toast(`${username} ${active ? 'activated' : 'deactivated'}`, 'ok');
      load();
    } catch (e) { toast(e.message, 'bad'); btn.disabled = false; }
  }

  document.addEventListener('DOMContentLoaded', () => {
    qs('#fQ').addEventListener('input', debounce(onFilter, 300));
    qs('#fRole').onchange = onFilter; qs('#fActive').onchange = onFilter;
    qs('#prevPage').onclick = () => { st.offset = Math.max(0, st.offset - PAGE); load(); };
    qs('#nextPage').onclick = () => { st.offset += PAGE; load(); };
    qs('#userRows').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      act(b.closest('tr').dataset.u, b.dataset.act, b);
    });
    const dlg = qs('#pwResult');
    qs('#pwDone').onclick = () => dlg.close();
    dlg.addEventListener('close', () => { qs('#pwValue').textContent = ''; });  // don't leave it in the DOM
    qs('#pwCopy').onclick = async () => {
      try { await navigator.clipboard.writeText(qs('#pwValue').textContent); qs('#pwCopy').textContent = 'Copied ✓'; }
      catch (_) { const r = document.createRange(); r.selectNodeContents(qs('#pwValue')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Press Ctrl+C / long-press to copy', 'ok'); }
    };
    load();
  });
})();
