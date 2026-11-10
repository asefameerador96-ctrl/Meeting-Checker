// End-to-end business-flow test of the Pre-Plan Follow-Up Portal, driven through the REAL UI.
//
//   node tests/e2e_flow.mjs
//
// Each run: fresh SQLite DB + upload dir -> python3 -m app.seed -> uvicorn on PORT (default 8201) ->
// AMOs of territory 1001 (mobile 390px) fill meeting + upload SR photos (with visible per-image progress) + remarks + submit ->
// TSO tso1001 approves (some with remarks), uploads a TSO photo, Submit appears, submits ->
// checker01 tab 1 (Wing/Division/Territory filters, table, Checked buttons), tab 2 (dashboard cross-checked against DB,
// missing-images Excel verified) -> isolation checks via API.
//
// Env: PORT, E2E_DIR (work dir for db/uploads/screens), CREDS (credentials xlsx), KEEP_SERVER=1
import { createRequire } from 'module';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch (_) { pw = require('/opt/node-tools/node_modules/playwright'); }
const { chromium, request: pwRequest } = pw;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SP = process.env.E2E_DIR || '/tmp/claude-0/-home-user-Meeting-Checker/98c362b4-c99b-51aa-bee4-5e383fdb2f3c/scratchpad';
const PORT = +(process.env.PORT || 8201);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(SP, 'verify_e2e.db');
const UPL = path.join(SP, 'vup_e2e');
const SHOTS = path.join(SP, 'shots');
const IMGDIR = path.join(SP, 'e2e_imgs');
const CREDS = process.env.CREDS || path.join(SP, 'credentials', 'Meeting_Checker_Credentials.xlsx');
const TERR = 1001, TERR_OTHER = 1002;
const ENV = { ...process.env, DATABASE_URL: `sqlite:///${DB}`, LOCAL_UPLOAD_DIR: UPL, STORAGE_BACKEND: 'local' };

/* ---------------- result bookkeeping ---------------- */
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 600) : ''}`);
  return !!ok;
}
const eqSet = (a, b) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

/* ---------------- python helpers (DB, xlsx, images) ---------------- */
function py(code, args = []) {
  const r = spawnSync('python3', ['-c', code, ...args], { cwd: ROOT, env: ENV, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error('python failed: ' + r.stderr);
  return r.stdout;
}
function sql(query, params = []) {
  return JSON.parse(py(`import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1]); print(json.dumps(c.execute(sys.argv[2], json.loads(sys.argv[3])).fetchall()))`,
    [DB, query, JSON.stringify(params)]));
}
function readXlsx(file) {
  return JSON.parse(py(`import openpyxl,json,sys
wb=openpyxl.load_workbook(sys.argv[1]); out={}
for ws in wb: out[ws.title]={'rows':[[c for c in r] for r in ws.iter_rows(values_only=True)],'freeze':ws.freeze_panes,'filter':ws.auto_filter.ref}
print(json.dumps(out, default=str))`, [file]));
}
function credentials() {
  const rows = JSON.parse(py(`import openpyxl,json,sys
wb=openpyxl.load_workbook(sys.argv[1]); out={}
for ws in wb:
  for r in ws.iter_rows(min_row=2, values_only=True):
    if r[0]: out[str(r[0])]=str(r[1])
print(json.dumps(out))`, [CREDS]));
  return rows;
}
function makeImages(n) {
  fs.rmSync(IMGDIR, { recursive: true, force: true }); fs.mkdirSync(IMGDIR, { recursive: true });
  py(`import sys,os,random
from PIL import Image, ImageDraw
d,n=sys.argv[1],int(sys.argv[2])
for i in range(n):
  random.seed(i*7919+13)
  w,h=1100,820
  im=Image.effect_noise((w,h),60+i).convert('RGB')
  tint=Image.new('RGB',(w,h),(random.randrange(256),random.randrange(256),random.randrange(256)))
  im=Image.blend(im,tint,0.55); dr=ImageDraw.Draw(im)
  for k in range(30):
    x0,y0=random.randrange(w-50),random.randrange(h-50); dr.rectangle([x0,y0,x0+random.randrange(1,50),y0+random.randrange(1,50)],outline=(random.randrange(256),)*3,width=3)
  dr.text((40,40),'E2E plan photo %d'%i,fill=(255,255,255))
  im.save(os.path.join(d,'plan_%02d.jpg'%i),'JPEG',quality=92)
`, [IMGDIR, String(n)]);
  return fs.readdirSync(IMGDIR).filter(f => f.endsWith('.jpg')).sort().map(f => path.join(IMGDIR, f));
}

/* ---------------- server lifecycle ---------------- */
async function startServer() {
  for (const p of [DB, DB + '-wal', DB + '-shm']) fs.rmSync(p, { force: true });
  fs.rmSync(UPL, { recursive: true, force: true });
  const s = spawnSync('python3', ['-m', 'app.seed'], { cwd: ROOT, env: ENV, encoding: 'utf8' });
  if (s.status !== 0) throw new Error('seed failed ' + s.stderr);
  const log = fs.openSync(path.join(SP, 'e2e_server.log'), 'w');
  const srv = spawn('python3', ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(PORT)],
    { cwd: ROOT, env: ENV, stdio: ['ignore', log, log] });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/login'); if (r.ok) return srv; } catch (_) { }
    await new Promise(r => setTimeout(r, 250));
  }
  srv.kill(); throw new Error('server did not start; see e2e_server.log');
}

/* ---------------- browser helpers ---------------- */
async function login(page, user, pass) {
  await page.goto(BASE + '/login');
  await page.fill('input[name=username]', user);
  await page.fill('input[name=password]', pass);
  await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 15000 }), page.click('#loginBtn')]);
}
async function apiCtx(user, pass) {
  const ctx = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { 'X-Requested-With': 'fetch' } });
  const r = await ctx.post('/api/login', { data: { username: user, password: pass } });
  if (!r.ok()) throw new Error(`api login ${user} failed ${r.status()}`);
  return ctx;
}
function watchErrors(page, tag) {
  page.on('pageerror', e => check(`${tag}: no JS page errors`, false, e.message));
  page.on('dialog', d => d.accept());
}
const shot = (page, name, full = true) => page.screenshot({ path: path.join(SHOTS, `e2e_${name}.png`), fullPage: full });

/* ======================================================================== */
async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const f of fs.readdirSync(SHOTS)) if (f.startsWith('e2e_')) fs.rmSync(path.join(SHOTS, f));
  const PW = credentials();
  const imgs = makeImages(48); let imgI = 0;
  const nextImgs = (n) => { const out = []; for (let i = 0; i < n; i++) out.push(imgs[imgI++ % imgs.length]); return out; };
  const srv = await startServer();
  const browser = await chromium.launch();
  const plan = {};   // zone -> {photos:{sr:n}, remarks:{sr:text}}
  let today;
  try {
    const zones = sql('select code, name from zones where territory_code=? order by code', [TERR]);
    const srsByZone = {};
    for (const [zc] of zones) srsByZone[zc] = sql('select sr_id from assignments where zone_code=? order by sr_id', [zc]).map(r => r[0]);
    check('territory 1001 has AMO zones in DB', zones.length >= 2, zones);

    /* ===================== AMO portal (mobile 390px) ===================== */
    for (const [zi, [zc, zname]] of zones.entries()) {
      const user = 'amo' + zc;
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      const page = await ctx.newPage(); watchErrors(page, user);
      await login(page, user, PW[user]);
      check(`${user} lands on /amo`, new URL(page.url()).pathname === '/amo', page.url());
      await page.waitForSelector('#main:not(.hidden)');
      const rep = await page.evaluate(() => api.get('/api/amo/report'));
      today = rep.date;
      const uiSrs = await page.$$eval('#srList article.sr-card', els => els.map(e => e.dataset.sr));
      check(`${user} sees exactly the SRs of zone ${zc}`, eqSet(uiSrs, srsByZone[zc]), { uiSrs, db: srsByZone[zc] });
      const hScroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`${user} no horizontal scroll at 390px`, hScroll <= 0, hScroll);

      // meeting section
      const f = '#meetingForm';
      check(`${user} meeting location pre-filled`, (await page.inputValue(`${f} input[name=location]`)).length > 0);
      await page.fill(`${f} input[name=location]`, `${zname} office`);
      await page.check(`${f} input[name=meeting_held][value=yes]`);
      await page.fill(`${f} input[name=meeting_time]`, '09:30');
      await page.fill(`${f} input[name=sr_present_count]`, String(srsByZone[zc].length - 1));
      await page.fill(`${f} textarea[name=vacancy_remarks]`, 'One SR on leave');
      await page.waitForFunction(() => /Saved/.test(document.querySelector('#meetingSaved').textContent), null, { timeout: 10000 });

      // throttle the network for the first AMO so per-image progress is observable
      let cdp = null;
      if (zi === 0) {
        cdp = await ctx.newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 80, downloadThroughput: 400 * 1024, uploadThroughput: 120 * 1024 });
        await page.evaluate(() => {
          window.__pcts = new Set(); window.__btnDisabledDuringUpload = null;
          new MutationObserver(() => {
            document.querySelectorAll('.thumb.uploading .pct').forEach(p => window.__pcts.add(p.textContent));
            if (document.querySelector('.thumb.uploading')) {
              const b = document.querySelector('#btnSubmit');
              window.__btnDisabledDuringUpload = (window.__btnDisabledDuringUpload ?? true) && b.disabled;
            }
          }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
        });
      }
      await page.setInputFiles('#meetingUploader input[type=file]', nextImgs(1));
      if (zi === 0) {
        await page.waitForSelector('#meetingUploader .thumb.uploading .prog', { timeout: 5000 });
        await page.waitForFunction(() => /\d+%/.test((document.querySelector('#meetingUploader .thumb.uploading .pct') || {}).textContent || ''), null, { timeout: 15000 }).catch(() => { });
        await page.locator('#meetingCard').screenshot({ path: path.join(SHOTS, 'e2e_amo_progress_meeting.png') });
      }
      await page.waitForFunction(() => !document.querySelector('#meetingUploader .thumb.uploading') && document.querySelectorAll('#meetingUploader .thumb').length >= 1, null, { timeout: 60000 });

      // SR photos for most SRs; the last 2 SRs of every zone get a remark only
      const srs = srsByZone[zc], photos = {}, remarks = {};
      for (const [i, sr] of srs.entries()) {
        const card = `#srList article.sr-card[data-sr="${sr}"]`;
        if (i < srs.length - 2) {
          const n = i % 3 === 0 ? 2 : 1;
          await page.setInputFiles(`${card} .up input[type=file]`, nextImgs(n));
          if (zi === 0 && i === 0) {
            await page.waitForSelector(`${card} .thumb.uploading`, { timeout: 5000 });
            await page.waitForFunction((c) => /\d+%/.test((document.querySelector(c + ' .thumb.uploading .pct') || {}).textContent || ''), card, { timeout: 15000 }).catch(() => { });
            await page.locator(card).scrollIntoViewIfNeeded();
            await shot(page, 'amo_progress_sr', false);
            const hint = await page.textContent('#submitHint');
            check(`${user} submit hint says photos are uploading while busy`, /uploading/i.test(hint), hint);
            check(`${user} Submit button disabled while uploading`, await page.isDisabled('#btnSubmit'));
          }
          await page.waitForFunction(([c, n]) => !document.querySelector(c + ' .thumb.uploading') && document.querySelectorAll(c + ' .up .thumb:not(.failed)').length === n,
            [card, n], { timeout: 90000 });
          photos[sr] = n;
          if (i === 1) {   // an optional remark on an SR that has photos too
            await page.fill(`${card} textarea`, 'Plan shared on WhatsApp as well');
            remarks[sr] = 'Plan shared on WhatsApp as well';
          }
          if (zi === 0 && i === 0) {
            await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
          }
        } else {
          const t = `SR ${sr} absent - route vacant today (zone ${zc})`;
          await page.fill(`${card} textarea`, t); remarks[sr] = t;
        }
      }
      if (zi === 0) {
        const pcts = await page.evaluate(() => [...window.__pcts]);
        const numeric = pcts.filter(p => /^\d+%$/.test(p));
        check(`${user} per-image progress showed intermediate % values`, numeric.some(p => p !== '0%' && p !== '100%'), pcts);
        check(`${user} progress phases Preparing/Saving visible`, pcts.some(p => /Preparing|Saving/.test(p)), pcts);
      }
      await page.locator('textarea').last().blur();
      await page.waitForTimeout(1200);
      const prog = await page.textContent('#progCount');
      const nPhotoSrs = Object.keys(photos).length;
      check(`${user} progress summary "${nPhotoSrs} of ${srs.length}"`, prog.includes(`${nPhotoSrs} of ${srs.length}`), prog);
      await shot(page, `amo_${zc}_filled`);

      // submit
      await page.click('#btnSubmit');
      await page.waitForSelector('#confirmDlg[open]', { timeout: 10000 });
      await shot(page, `amo_${zc}_confirm`, false);
      await page.click('#confirmDlg button[value=ok]');
      await page.waitForFunction(() => /Submitted to TSO/.test(document.querySelector('#statusBadge').textContent), null, { timeout: 15000 });
      check(`${user} submit hides Submit button (locked)`, await page.isHidden('#submitArea'));
      check(`${user} locked: no add-photo tiles`, (await page.$$('.add-tile')).filter(Boolean).length === 0 || await page.evaluate(() => [...document.querySelectorAll('.add-tile')].every(e => !e.offsetParent)));
      await page.evaluate(() => window.scrollTo(0, 0));
      await shot(page, `amo_${zc}_submitted`, false);
      // server-side: locked after submit
      const r = await page.evaluate(async (sr) => { try { await api.put('/api/amo/sr/' + sr, { date: (await api.get('/api/amo/report')).date, amo_remarks: 'x' }); return 200; } catch (e) { return e.status; } }, srs[0]);
      check(`${user} cannot edit after submit (409)`, r === 409, r);
      plan[zc] = { photos, remarks, srs };
      await ctx.close();
    }
    const zr = sql('select zone_code,status,meeting_held,meeting_time from zone_reports where report_date=? and territory_code=?', [today, TERR]);
    check('DB: all zone reports of 1001 submitted', zr.length === zones.length && zr.every(r => r[1] === 'submitted' && r[2] === 1 && r[3] === '09:30'), zr);
    for (const zc of Object.keys(plan)) {
      const dbImgs = Object.fromEntries(sql("select sr_id,count(*) from images where report_date=? and zone_code=? and kind='sr' group by sr_id", [today, +zc]));
      check(`DB: SR image counts zone ${zc} match uploads`, JSON.stringify(Object.fromEntries(Object.entries(dbImgs).sort())) === JSON.stringify(Object.fromEntries(Object.entries(plan[zc].photos).sort())), { dbImgs, plan: plan[zc].photos });
      const dup = sql("select count(*) from images where report_date=? and zone_code=? and duplicate_of_id is not null", [today, +zc])[0][0];
      check(`DB: no false REUSED flags zone ${zc}`, dup === 0, dup);
    }

    /* ===================== TSO portal ===================== */
    {
      const user = 'tso' + TERR;
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage(); watchErrors(page, user);
      await login(page, user, PW[user]);
      check(`${user} lands on /tso`, new URL(page.url()).pathname === '/tso', page.url());
      await page.waitForSelector('#zones .zone');
      const uiZones = await page.$$eval('#zones .zone', els => els.map(e => +e.dataset.zone));
      check(`${user} sees only the zones of territory ${TERR}`, eqSet(uiZones.map(String), zones.map(z => String(z[0]))), uiZones);
      await page.click('#btnExpand');
      check(`${user} Submit hidden before approvals/photo`, await page.isHidden('#btnSubmit'));
      // AMO remarks visible
      const zc0 = zones[0][0], remSr = Object.keys(plan[zc0].remarks).slice(-1)[0];
      const amoRemark = await page.textContent(`.zone[data-zone="${zc0}"] .sr[data-sr="${remSr}"] .amo-remark`);
      check(`${user} sees AMO remark`, amoRemark.includes(plan[zc0].remarks[remSr]), amoRemark);
      const thumbs = await page.$$eval(`.zone[data-zone="${zc0}"] .sr .photos img`, e => e.length);
      check(`${user} sees AMO photos (${thumbs})`, thumbs === Object.values(plan[zc0].photos).reduce((a, b) => a + b, 0), thumbs);
      await shot(page, 'tso_review');

      const tsoRemarks = {};
      let k = 0;
      for (const [zc] of zones) {
        for (const sr of plan[zc].srs) {
          const row = `.zone[data-zone="${zc}"] .sr[data-sr="${sr}"]`;
          if (k % 4 === 0) {
            const t = `TSO verified plan for ${sr}`;
            await page.fill(`${row} textarea.tso-rm`, t); tsoRemarks[`${zc}|${sr}`] = t;
          }
          await page.click(`${row} .act .btn-primary`);
          await page.waitForSelector(`${row}.approved`, { timeout: 10000 });
          k++;
        }
      }
      await page.waitForTimeout(1200);
      check(`${user} Submit still hidden after approving all (no TSO photo yet)`, await page.isHidden('#btnSubmit'));
      await page.locator('#finalCard').scrollIntoViewIfNeeded();
      await shot(page, 'tso_before_photo', false);
      await page.setInputFiles('#tsoUploader input[type=file]', nextImgs(1));
      await page.waitForFunction(() => !document.querySelector('#tsoUploader .thumb.uploading') && document.querySelectorAll('#tsoUploader .thumb').length === 1, null, { timeout: 60000 });
      await page.fill('#tsoRemarks', 'All AMOs held the meeting today.');
      await page.waitForSelector('#btnSubmit:not(.hidden)', { timeout: 5000 }).catch(() => { });
      check(`${user} Submit button appears after TSO photo`, await page.isVisible('#btnSubmit'));
      await page.locator('#finalCard').scrollIntoViewIfNeeded();
      await shot(page, 'tso_ready', false);
      await page.waitForTimeout(1200);
      await page.click('#btnSubmit');
      await page.waitForSelector('#submitDialog[open]');
      await shot(page, 'tso_confirm', false);
      await page.click('#submitOk');
      await page.waitForFunction(() => /Submitted/.test(document.querySelector('#tStatus').textContent), null, { timeout: 15000 });
      await shot(page, 'tso_submitted');
      const tr = sql('select status, tso_remarks from territory_reports where report_date=? and territory_code=?', [today, TERR]);
      check('DB: territory 1001 submitted with TSO remarks', tr.length === 1 && tr[0][0] === 'submitted' && tr[0][1] === 'All AMOs held the meeting today.', tr);
      const pend = sql("select count(*) from sr_entries where report_date=? and territory_code=? and tso_status!='approved'", [today, TERR])[0][0];
      check('DB: all SR entries of 1001 approved', pend === 0, pend);
      const savedTso = Object.fromEntries(sql("select zone_code||'|'||sr_id, tso_remarks from sr_entries where report_date=? and territory_code=? and tso_remarks!=''", [today, TERR]));
      check('DB: TSO remarks saved exactly where given', JSON.stringify(Object.keys(savedTso).sort()) === JSON.stringify(Object.keys(tsoRemarks).sort()) &&
        Object.entries(tsoRemarks).every(([k, v]) => savedTso[k] === v), { savedTso, tsoRemarks });
      // mobile view of TSO for a UX look
      const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
      const mp = await m.newPage(); await mp.goto(BASE + '/tso'); await mp.waitForSelector('#zones .zone'); await mp.waitForTimeout(800);
      await shot(mp, 'tso_mobile');
      const hs = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check('tso mobile: no horizontal scroll at 390px', hs <= 0, hs);
      await m.close(); await ctx.close();
    }

    /* ===================== Checker portal ===================== */
    const T = sql('select wing, division, name from territories where code=?', [TERR])[0];
    const [WING, DIV] = T;
    {
      const user = 'checker01';
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
      const page = await ctx.newPage(); watchErrors(page, user);
      await login(page, user, PW[user]);
      check(`${user} lands on /checker`, new URL(page.url()).pathname === '/checker', page.url());
      await page.waitForFunction(() => document.querySelectorAll('#dWing option').length > 1 && document.querySelectorAll('#dDate option').length > 0);
      const dates = await page.$$eval('#dDate option', o => o.map(x => x.value));
      check('checker date options = last 3 days, today first', dates.length === 3 && dates[0] === today, dates);
      await page.selectOption('#dDate', today);
      await page.selectOption('#dWing', WING);
      await page.selectOption('#dDivision', DIV);
      await page.selectOption('#dTerritory', String(TERR));
      await page.waitForSelector('#srTable tbody tr:not(.grp)', { timeout: 15000 });
      const nRows = await page.$$eval('#srTable tbody tr:not(.grp)', r => r.length);
      const totalSrs = Object.values(plan).reduce((a, p) => a + p.srs.length, 0);
      check(`checker tab1 shows ${totalSrs} SR rows`, nRows === totalSrs, nRows);
      const heads = await page.$$eval('#srTable thead th', t => t.map(x => x.textContent.trim()));
      const want = ['Wing', 'Division', 'Territory', 'SR ID', 'SR Name', 'Routes', 'Photos', '# Photos', 'Flags', 'AMO Remarks', 'TSO Status', 'TSO Remarks', 'Checked'];
      check('checker table has the SPEC columns', want.every(w => heads.some(h => h.includes(w))) && heads.some(h => /Zone|AMO/.test(h)), heads);
      // row content vs plan
      const rowData = await page.evaluate(() => [...document.querySelectorAll('#srTable tbody tr:not(.grp)')].map(tr => ({
        sr: tr.querySelector('[data-label="SR ID"]').textContent.trim(), n: +tr.querySelector('[data-label="# Photos"]').textContent,
        amo: tr.querySelector('[data-label="AMO Remarks"]').textContent.trim(), tso: tr.querySelector('[data-label="TSO Status"]').textContent.trim(),
        zone: tr.dataset.zone })));
      const bad = rowData.filter(r => { const p = plan[r.zone]; return !p || (p.photos[r.sr] || 0) !== r.n || (p.remarks[r.sr] && !r.amo.includes(p.remarks[r.sr])) || r.tso !== 'Approved'; });
      check('checker rows match uploads/remarks/approval', bad.length === 0, bad.slice(0, 5));
      // Checked buttons on a few rows
      const rows = page.locator('#srTable tbody tr:not(.grp)');
      // only SRs with photos can be checked (same definition as the dashboard); pick 5 of them
      const withPhoto = rowData.map((r, i) => r.n > 0 ? i : -1).filter(i => i >= 0);
      const noPhoto = rowData.map((r, i) => r.n === 0 ? i : -1).filter(i => i >= 0);
      const toCheck = [withPhoto[0], withPhoto[1], withPhoto[3], withPhoto[8], withPhoto[withPhoto.length - 1]];
      if (noPhoto.length) {
        const np = rows.nth(noPhoto[0]).locator('.btn-check');
        check('no-photo SR row: Checked button disabled ("No photo")', (await np.isDisabled()) && /No photo/.test(await np.textContent()), await np.textContent());
      }
      for (const i of toCheck) {
        await rows.nth(i).locator('.btn-check').click();
        await page.waitForFunction((i) => /Checked ✓/.test(document.querySelectorAll('#srTable tbody tr:not(.grp)')[i].querySelector('.btn-check').textContent), i, { timeout: 10000 });
      }
      await rows.nth(toCheck[0]).locator('.c-valid select').selectOption('yes');
      await rows.nth(toCheck[1]).locator('.c-valid select').selectOption('no');
      await page.waitForTimeout(800);
      const byTxt = await rows.nth(toCheck[0]).locator('.btn-check').textContent();
      check('Checked button shows "Checked ✓ by checker01"', /Checked ✓\s*by checker01/.test(byTxt), byTxt);
      // undo one
      await rows.nth(toCheck[3]).locator('.btn-check').click();
      await page.waitForFunction((i) => !/✓/.test(document.querySelectorAll('#srTable tbody tr:not(.grp)')[i].querySelector('.btn-check').textContent), toCheck[3], { timeout: 10000 });
      await page.waitForTimeout(500);
      await page.evaluate(() => window.scrollTo(0, 0));
      await shot(page, 'checker_tab1');
      // zones meeting block
      await page.click('#zonesWrap summary').catch(() => { });
      await page.waitForTimeout(500);
      await shot(page, 'checker_tab1_zones');
      const dbChecked = sql('select zone_code, sr_id, checked_by from sr_entries where report_date=? and territory_code=? and checked=1', [today, TERR]);
      check('DB: 4 rows checked by checker01', dbChecked.length === toCheck.length - 1 && dbChecked.every(r => r[2] === 'checker01'), dbChecked);

      // check a row of an SR that has no photo? (remark-only rows) count to compute expected "checked"
      // ===== Tab 2: dashboard
      await page.click('#tab-dashboard');
      await page.waitForFunction(() => window.Chart && Chart.getChart(document.querySelector('#pieChart')), null, { timeout: 15000 });
      await page.waitForTimeout(800);
      const dashUi = await page.evaluate(() => ({
        pie: Chart.getChart(qs('#pieChart')).data.datasets[0].data.slice(), labels: Chart.getChart(qs('#pieChart')).data.labels.slice(),
        bar: { labels: Chart.getChart(qs('#barChart')).data.labels.slice(), ds: Chart.getChart(qs('#barChart')).data.datasets.map(d => ({ label: d.label, data: d.data.slice() })) },
        legend: qs('#pieLegend').textContent, kpis: [...document.querySelectorAll('#kpis .stat')].map(s => s.textContent.replace(/\s+/g, ' ').trim()),
      }));
      // expected from DB (all scope)
      const exp = (scopeWhere, params) => {
        const total = sql(`select count(*) from assignments a join territories t on t.code=a.territory_code where 1=1 ${scopeWhere}`, params)[0][0];
        const up = sql(`select count(*) from (select distinct i.zone_code, i.sr_id from images i join territories t on t.code=i.territory_code
            join territory_reports tr on tr.territory_code=i.territory_code and tr.report_date=i.report_date and tr.status='submitted'
            where i.kind='sr' and i.report_date=? ${scopeWhere})`, [today, ...params])[0][0];
        const chk = sql(`select count(*) from sr_entries e join territories t on t.code=e.territory_code where e.report_date=? and e.checked=1
            and exists(select 1 from images i where i.kind='sr' and i.report_date=e.report_date and i.zone_code=e.zone_code and i.sr_id=e.sr_id) ${scopeWhere}`, [today, ...params])[0][0];
        return { total, up, chk, pie: [total - up, up - chk, chk] };
      };
      const eAll = exp('', []);
      check('dashboard pie (all wings) = DB [not uploaded, uploaded-not-checked, checked]', JSON.stringify(dashUi.pie) === JSON.stringify(eAll.pie), { ui: dashUi.pie, db: eAll });
      check('pie labels per SPEC', JSON.stringify(dashUi.labels) === JSON.stringify(['Images not uploaded', 'Images uploaded (not yet checked)', 'Checked by checker']), dashUi.labels);
      const nDiv = sql('select count(distinct division) from territories')[0][0];
      check('bar chart: one bar group per division (all scope)', dashUi.bar.labels.length === nDiv && dashUi.bar.ds.length === 2, { n: dashUi.bar.labels.length, nDiv, ds: dashUi.bar.ds.map(d => d.label) });
      const iDiv = dashUi.bar.labels.indexOf(DIV);
      const divTotal = sql('select count(*) from assignments a join territories t on t.code=a.territory_code where t.division=?', [DIV])[0][0];
      const eDiv = exp('and t.division=?', [DIV]);
      check(`bar ${DIV}: Count of SR / SRs with images = DB`, iDiv >= 0 && dashUi.bar.ds[0].data[iDiv] === divTotal && dashUi.bar.ds[1].data[iDiv] === eDiv.up,
        { ui: iDiv >= 0 ? dashUi.bar.ds.map(d => d.data[iDiv]) : null, db: [divTotal, eDiv.up] });
      const otherBars = dashUi.bar.labels.map((l, i) => [l, dashUi.bar.ds[1].data[i]]).filter(([l, v]) => l !== DIV && v !== 0);
      check('bar: other divisions have 0 uploaded', otherBars.length === 0, otherBars);
      await page.locator('#bBody').screenshot({ path: path.join(SHOTS, 'e2e_checker_tab2_all.png') });
      // pass% KPI (1 yes, 1 no)
      check('KPI pass rate shows 50%', dashUi.kpis.some(k => /pass rate/i.test(k) && /50(\.0)?%/.test(k)), dashUi.kpis);

      // scope to the division
      await page.selectOption('#bWing', WING);
      await page.selectOption('#bDivision', DIV);
      await page.waitForTimeout(1200);
      const api = await page.evaluate((q) => api.get('/api/checker/dashboard?' + q), new URLSearchParams({ date: today, wing: WING, division: DIV }).toString());
      check(`dashboard API (${DIV}) totals = DB`, api.totals.total_srs === eDiv.total && api.totals.uploaded === eDiv.up && api.totals.checked === eDiv.chk &&
        JSON.stringify(api.pie.values) === JSON.stringify(eDiv.pie), { api: api.totals, db: eDiv });
      const zTot = sql('select count(*) from zones z join territories t on t.code=z.territory_code where t.division=?', [DIV])[0][0];
      check('KPI meetings held = zones of 1001 / zones in division', api.totals.zones_meeting_held === zones.length && api.totals.zones_total === zTot, api.totals);
      check('territories submitted 1 of N', api.totals.territories_submitted === 1, api.totals);
      const pieDiv = await page.evaluate(() => Chart.getChart(qs('#pieChart')).data.datasets[0].data.slice());
      check('pie updates after scoping to division', JSON.stringify(pieDiv) === JSON.stringify(eDiv.pie), { ui: pieDiv, db: eDiv.pie });
      const barDiv = await page.evaluate(() => Chart.getChart(qs('#barChart')).data.labels.slice());
      const nTerrDiv = sql('select count(*) from territories where division=?', [DIV])[0][0];
      check('bar drills down to one bar pair per territory of the division', barDiv.length === nTerrDiv && barDiv.some(l => l.includes(`(${TERR})`)), { barDiv, nTerrDiv });
      const pieLegend = await page.textContent('#pieLegend');
      check('pie legend shows percentages', /%/.test(pieLegend), pieLegend);
      await shot(page, 'checker_tab2');
      const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, storageState: await ctx.storageState() });
      const mp = await m.newPage(); await mp.goto(BASE + '/checker#dashboard'); await mp.waitForTimeout(2000); await shot(mp, 'checker_tab2_mobile');
      await mp.goto(BASE + '/checker#details'); await mp.waitForSelector('#srTable tbody tr', { timeout: 10000 }).catch(() => { }); await mp.waitForTimeout(800); await shot(mp, 'checker_tab1_mobile');
      await m.close();

      // ===== missing-images Excel (selected date + division scope)
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('#dlMissing')]);
      const xf = path.join(SP, 'e2e_missing.xlsx'); await dl.saveAs(xf);
      check('download filename missing_images_<date>.xlsx', dl.suggestedFilename() === `missing_images_${today}.xlsx`, dl.suggestedFilename());
      const book = readXlsx(xf), sheet = Object.values(book)[0], [hdr, ...data] = sheet.rows;
      const wantHdr = ['Date', 'Wing', 'Division', 'Territory Code', 'Territory', 'Zone Code', 'AMO', 'AMO Username', 'Route Codes', 'Routes', 'SR ID', 'SR Name', 'AMO Report Status', 'TSO Submission Status', 'AMO Remarks', 'TSO Remarks'];
      check('missing xlsx has all hierarchy + remark columns', wantHdr.every(w => hdr.some(h => String(h).startsWith(w))), hdr);
      check('missing xlsx header frozen + autofilter', sheet.freeze === 'A2' && !!sheet.filter, { f: sheet.freeze, a: sheet.filter });
      const col = (n) => hdr.findIndex(h => String(h).startsWith(n));
      const key = (r) => `${r[col('Zone Code')]}|${r[col('SR ID')]}`;
      const expected = sql(`select a.zone_code||'|'||a.sr_id from assignments a join territories t on t.code=a.territory_code where t.division=?
          and not exists(select 1 from images i join territory_reports tr on tr.territory_code=i.territory_code and tr.report_date=i.report_date and tr.status='submitted'
                         where i.kind='sr' and i.report_date=? and i.zone_code=a.zone_code and i.sr_id=a.sr_id)`, [DIV, today]).map(r => r[0]);
      const expected1001 = []; for (const [zc] of zones) for (const sr of plan[zc].srs) if (!plan[zc].photos[sr]) expected1001.push(`${zc}|${sr}`);
      const otherTerr = sql('select a.zone_code||\'|\'||a.sr_id from assignments a join territories t on t.code=a.territory_code where t.division=? and t.code!=?', [DIV, TERR]).map(r => r[0]);
      check('missing xlsx rows = SRs without images in 1001 + all SRs of non-submitted territories', eqSet(data.map(key), [...expected1001, ...otherTerr]) && eqSet(expected, [...expected1001, ...otherTerr]),
        { xlsx: data.length, expect: expected1001.length + otherTerr.length, extra: data.map(key).filter(k => !expected.includes(k)).slice(0, 5), missing: expected.filter(k => !data.map(key).includes(k)).slice(0, 5) });
      check('missing xlsx Date column = selected date for all rows', data.every(r => String(r[col('Date')]).startsWith(today)));
      const rem = data.filter(r => String(r[col('Territory Code')]) === String(TERR));
      const remBad = rem.filter(r => { const [zc, sr] = key(r).split('|'); return r[col('AMO Remarks')] !== plan[zc].remarks[sr]; });
      check('missing xlsx AMO Remarks filled for 1001 SRs', rem.length === expected1001.length && remBad.length === 0, remBad.slice(0, 3));
      const usr = data.filter(r => !/^amo\d+$/.test(String(r[col('AMO Username')] || '')));
      check('missing xlsx AMO Username filled', usr.length === 0, usr.slice(0, 3));
      const st1001 = [...new Set(rem.map(r => `${r[col('AMO Report Status')]} / ${r[col('TSO Submission Status')]}`))];
      check('missing xlsx statuses for 1001 rows', st1001.length === 1 && /Submitted/.test(st1001[0]), st1001);
      // a past date (yesterday) must also be selectable and contain everything as missing
      const y = dates[1];
      const ry = await page.request.get(`${BASE}/api/checker/export/missing.xlsx?date=${y}&territory_code=${TERR}`);
      check('missing xlsx for yesterday downloadable', ry.ok(), ry.status());
      if (ry.ok()) { const f2 = path.join(SP, 'e2e_missing_y.xlsx'); fs.writeFileSync(f2, await ry.body()); const b2 = Object.values(readXlsx(f2))[0]; check('yesterday: all 1001 SRs missing', b2.rows.length - 1 === Object.values(plan).reduce((a, p) => a + p.srs.length, 0), b2.rows.length - 1); }
      await ctx.close();
    }

    /* ===================== isolation ===================== */
    {
      const img1001 = sql("select id from images where territory_code=? and kind='sr' limit 1", [TERR])[0][0];
      const imgTso = sql("select id from images where territory_code=? and kind='tso' limit 1", [TERR])[0][0];
      const tso2 = await apiCtx('tso' + TERR_OTHER, PW['tso' + TERR_OTHER]);
      const rep2 = await (await tso2.get('/api/tso/report')).json();
      const z2 = rep2.zones.map(z => z.zone.code);
      check('tso1002 report contains no 1001 zones', z2.every(c => !zones.some(z => z[0] === c)) && rep2.territory.code === TERR_OTHER, z2);
      const r1 = await tso2.get(`/api/images/${img1001}/full`);
      check('tso1002 cannot fetch 1001 SR image', [403, 404].includes(r1.status()), r1.status());
      const r2 = await tso2.put('/api/tso/sr', { data: { date: today, zone_code: zones[0][0], sr_id: plan[zones[0][0]].srs[0], action: 'unapprove' } });
      check('tso1002 cannot unapprove 1001 SR', [403, 404].includes(r2.status()), r2.status());
      const r2b = await tso2.post('/api/tso/zone/return', { data: { date: today, zone_code: zones[0][0], remarks: 'x' } });
      check('tso1002 cannot return 1001 zone', [403, 404].includes(r2b.status()), r2b.status());
      const r2c = await tso2.get(`/api/tso/report?territory_code=${TERR}`);
      check('tso1002 ignores territory_code param', (await r2c.json()).territory.code === TERR_OTHER);
      const r2d = await tso2.delete(`/api/images/${imgTso}`);
      check('tso1002 cannot delete 1001 TSO image', [403, 404].includes(r2d.status()), r2d.status());

      const otherZone = sql('select code from zones where territory_code=? order by code limit 1', [TERR_OTHER])[0][0];
      const amo2 = await apiCtx('amo' + otherZone, PW['amo' + otherZone]);
      for (const v of ['full', 'thumb']) {
        const r = await amo2.get(`/api/images/${img1001}/${v}`);
        check(`amo${otherZone} cannot view 1001 image (${v})`, [403, 404].includes(r.status()), r.status());
      }
      const rd = await amo2.delete(`/api/images/${img1001}`);
      check(`amo${otherZone} cannot delete 1001 image`, [403, 404].includes(rd.status()), rd.status());
      const rs = await amo2.put(`/api/amo/sr/${plan[zones[0][0]].srs[0]}`, { data: { date: today, amo_remarks: 'hack' } });
      check(`amo${otherZone} cannot write remark on a 1001 SR`, [400, 403, 404].includes(rs.status()), rs.status());
      const ru = await amo2.post('/api/images', { multipart: { file: { name: 'a.jpg', mimeType: 'image/jpeg', buffer: fs.readFileSync(imgs[47]) }, kind: 'sr', date: today, sr_id: plan[zones[0][0]].srs[0] } });
      check(`amo${otherZone} cannot upload to a 1001 SR`, [400, 403, 404].includes(ru.status()), ru.status());
      const rc = await amo2.get(`/api/checker/dashboard?date=${today}`);
      check(`amo${otherZone} cannot call checker API`, rc.status() === 403, rc.status());
      const rt = await amo2.get('/api/tso/report');
      check(`amo${otherZone} cannot call TSO API`, rt.status() === 403, rt.status());

      const chk = await apiCtx('checker01', PW.checker01);
      for (const [m, u, body] of [['get', '/api/amo/report'], ['put', '/api/amo/report', { date: today }], ['post', '/api/amo/submit', { date: today }], ['get', '/api/tso/report'], ['post', '/api/tso/submit', { date: today }], ['get', '/api/admin/users']]) {
        const r = await chk[m](u, body ? { data: body } : undefined);
        check(`checker01 ${m.toUpperCase()} ${u} -> 403`, r.status() === 403, r.status());
      }
      const ru2 = await chk.post('/api/images', { multipart: { file: { name: 'a.jpg', mimeType: 'image/jpeg', buffer: fs.readFileSync(imgs[46]) }, kind: 'sr', date: today, sr_id: plan[zones[0][0]].srs[0] } });
      check('checker01 cannot upload images', [400, 403].includes(ru2.status()), ru2.status());
      // checker must not see data of a territory the TSO has not submitted (rows hidden)
      const rt2 = await (await chk.get(`/api/checker/territory?date=${today}&territory_code=${TERR_OTHER}`)).json();
      check('checker: non-submitted territory returns submitted:false and no rows', rt2.submitted === false && !(rt2.rows || []).length, { submitted: rt2.submitted, rows: (rt2.rows || []).length });
      const rx = await chk.put('/api/checker/sr', { data: { date: today, zone_code: otherZone, sr_id: sql('select sr_id from assignments where zone_code=? limit 1', [otherZone])[0][0], checked: true } });
      check('checker cannot check SR of non-submitted territory', rx.status() >= 400, rx.status());
      // no CSRF header -> 403
      const raw = await pwRequest.newContext({ baseURL: BASE });
      await raw.post('/api/login', { data: { username: 'checker01', password: PW.checker01 } });
      const rcsrf = await raw.put('/api/checker/sr', { data: { date: today, zone_code: zones[0][0], sr_id: plan[zones[0][0]].srs[0], checked: true } });
      check('mutating call without X-Requested-With -> 403', rcsrf.status() === 403, rcsrf.status());
      // unauthenticated
      const anon = await pwRequest.newContext({ baseURL: BASE });
      const ra = await anon.get(`/api/images/${img1001}/full`);
      check('anonymous cannot fetch images', [401, 403].includes(ra.status()), ra.status());
      // AMO of 1001 sees after territory submit that everything is locked
      const amo1 = await apiCtx('amo' + zones[0][0], PW['amo' + zones[0][0]]);
      const a1 = await (await amo1.get('/api/amo/report')).json();
      check('AMO report after TSO submit: territory_status submitted, can_edit false', a1.territory_status === 'submitted' && a1.can_edit === false, { ts: a1.territory_status, ce: a1.can_edit });
      // pre-submit leak: can a checker fetch a photo of a territory that is NOT yet submitted (by id)?
      const lz = sql('select code from zones where territory_code=? order by code', [TERR_OTHER])[0][0];
      const amoL = await apiCtx('amo' + lz, PW['amo' + lz]);
      const up = await amoL.post('/api/images', { multipart: { file: { name: 'z.jpg', mimeType: 'image/jpeg', buffer: fs.readFileSync(imgs[45]) }, kind: 'sr', date: today, sr_id: sql('select sr_id from assignments where zone_code=? limit 1', [lz])[0][0] } });
      if (up.ok()) {
        const id = (await up.json()).id;
        const rl = await chk.get(`/api/images/${id}/full`);
        check('checker cannot fetch photo of a not-yet-submitted territory by id', rl.status() !== 200, rl.status());
        await amoL.delete(`/api/images/${id}`);
      }
      for (const c of [tso2, amo2, chk, raw, anon, amo1, amoL]) await c.dispose();
    }
  } finally {
    await browser.close();
    if (!process.env.KEEP_SERVER) srv.kill();
  }
}

main().then(() => {
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  fs.writeFileSync(path.join(SP, 'e2e_results.json'), JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
}, (e) => { console.error('FATAL', e); fs.writeFileSync(path.join(SP, 'e2e_results.json'), JSON.stringify(results, null, 2)); process.exit(2); });
