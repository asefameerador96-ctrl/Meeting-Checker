// Camera-only photo capture test (Android phone emulation, Chromium fake camera).
//
//   PORT=8233 node tests/camera_flow.mjs
//
// Fresh SQLite DB + upload dir -> python3 -m app.seed -> known passwords -> uvicorn on PORT (default 8233).
// Checks: "Take ... photo" tiles open the in-page camera (no gallery picker / plain file input anywhere),
// shutter -> instant upload with per-photo progress (in the camera strip and on the page), counter + max respected,
// Done/Esc stop the camera, Submit still works, TSO photo works, permission-denied message, and the
// capture="environment" fallback when getUserMedia is unavailable. Server rejects uploads without a camera source.
//
// Env: PORT, CAM_DIR (work dir for db/uploads/screens; screenshots go to <dir>/shots/cam_*.png)
import { createRequire } from 'module';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch (_) { pw = require('/opt/node-tools/node_modules/playwright'); }
const { chromium, devices, request: pwRequest } = pw;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SP = process.env.CAM_DIR || '/tmp/claude-0/-home-user-Meeting-Checker/98c362b4-c99b-51aa-bee4-5e383fdb2f3c/scratchpad';
const PORT = +(process.env.PORT || 8233);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(SP, 'camera_test.db');
const UPL = path.join(SP, 'camera_test_up');
const SHOTS = path.join(SP, 'shots');
const PW = 'Cam-test-pass-1';
const ENV = { ...process.env, DATABASE_URL: `sqlite:///${DB}`, LOCAL_UPLOAD_DIR: UPL, STORAGE_BACKEND: 'local' };
const PHONE = devices['Pixel 7'];
const FAKE_CAM = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail).slice(0, 600) : ''}`);
  return !!ok;
}
function py(code, args = []) {
  const r = spawnSync('python3', ['-c', code, ...args], { cwd: ROOT, env: ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('python failed: ' + r.stderr);
  return r.stdout;
}
function sql(query, params = []) {
  return JSON.parse(py(`import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1]); print(json.dumps(c.execute(sys.argv[2], json.loads(sys.argv[3])).fetchall()))`,
    [DB, query, JSON.stringify(params)]));
}

async function startServer() {
  for (const p of [DB, DB + '-wal', DB + '-shm']) fs.rmSync(p, { force: true });
  fs.rmSync(UPL, { recursive: true, force: true });
  const s = spawnSync('python3', ['-m', 'app.seed'], { cwd: ROOT, env: ENV, encoding: 'utf8' });
  if (s.status !== 0) throw new Error('seed failed ' + s.stderr);
  py(`import sys
from app.auth import hash_password
from app.db import SessionLocal
from app.models import User
from sqlalchemy import update
with SessionLocal() as db:
    db.execute(update(User).values(password_hash=hash_password(sys.argv[1]))); db.commit()`, [PW]);
  const log = fs.openSync(path.join(SP, 'camera_server.log'), 'w');
  const srv = spawn('python3', ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(PORT)],
    { cwd: ROOT, env: ENV, stdio: ['ignore', log, log] });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/login'); if (r.ok) return srv; } catch (_) { }
    await new Promise(r => setTimeout(r, 250));
  }
  srv.kill(); throw new Error('server did not start; see camera_server.log');
}
async function login(page, user) {
  await page.goto(BASE + '/login');
  await page.fill('input[name=username]', user);
  await page.fill('input[name=password]', PW);
  await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 15000 }), page.click('#loginBtn')]);
}
function watch(page, tag) {
  page.on('pageerror', e => check(`${tag}: no JS page errors`, false, e.message));
  page.on('dialog', d => d.accept());
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `cam_${name}.png`) });
const camState = (page) => page.evaluate(() => {
  const d = document.querySelector('#cameraDlg');
  return {
    open: !!(d && d.open), streaming: !!(window.camera && window.camera.stream),
    live: !!(window.camera && window.camera.stream && window.camera.stream.getTracks().some(t => t.readyState === 'live')),
    count: d ? d.querySelector('.cam-count').textContent : '', shutterDisabled: d ? d.querySelector('.cam-shutter').disabled : null,
    strip: d ? d.querySelectorAll('.cam-strip .thumb').length : 0, msg: d ? d.querySelector('.cam-msg:not(.hidden)')?.textContent || '' : '',
    switchVisible: d ? !d.querySelector('.cam-switch').classList.contains('invisible') : null,
  };
});
async function openCamera(page, sel) {
  await page.click(`${sel} .add-tile`);
  await page.waitForSelector('#cameraDlg[open]', { timeout: 10000 });
}
async function waitLive(page) {
  await page.waitForFunction(() => document.querySelector('#cameraDlg video').videoWidth > 0 &&
    !document.querySelector('#cameraDlg .cam-shutter').disabled, null, { timeout: 15000 });
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const f of fs.readdirSync(SHOTS)) if (f.startsWith('cam_')) fs.rmSync(path.join(SHOTS, f));
  const srv = await startServer();
  const browser = await chromium.launch({ args: FAKE_CAM });
  try {
    const zones = sql('select code from zones where territory_code=1001 order by code').map(r => r[0]);
    const [zA, zB] = zones;
    const srsA = sql('select sr_id from assignments where zone_code=? order by sr_id', [zA]).map(r => r[0]);
    const srsB = sql('select sr_id from assignments where zone_code=? order by sr_id', [zB]).map(r => r[0]);

    /* ---------- AMO on an Android phone: live camera ---------- */
    const ctx = await browser.newContext({ ...PHONE, permissions: ['camera'] });
    const page = await ctx.newPage(); watch(page, 'amo' + zA);
    await login(page, 'amo' + zA);
    await page.waitForSelector('#main:not(.hidden)');
    check('UA is Android Chrome (Pixel 7)', /Android/.test(await page.evaluate(() => navigator.userAgent)));
    check('no file input anywhere (no gallery picker)', (await page.$$('input[type=file]')).length === 0);
    const sr0 = `#srList article.sr-card[data-sr="${srsA[0]}"]`;
    const tileTxt = await page.textContent(`${sr0} .up .add-tile`);
    check('SR tile labelled "Take plan photo"', /Take plan photo/.test(tileTxt), tileTxt);
    check('meeting tile labelled "Take meeting photo"', /Take meeting photo/.test(await page.textContent('#meetingUploader .add-tile')));
    check('tile is a button (opens camera)', await page.$eval(`${sr0} .up .add-tile`, e => e.tagName) === 'BUTTON');

    await openCamera(page, `${sr0} .up`);
    await waitLive(page);
    let st = await camState(page);
    check('camera dialog opens with live stream', st.open && st.live, st);
    check('counter "0 taken · 6 left"', /0 taken · 6 left/.test(st.count), st.count);
    check('switch button hidden with a single camera', st.switchVisible === false, st);
    const vw = await page.evaluate(() => [document.querySelector('#cameraDlg video').videoWidth, document.querySelector('#cameraDlg video').videoHeight]);
    check('requested high-res rear camera stream', vw[0] >= 1280, vw);
    const fm = await page.evaluate(() => window.camera.stream.getVideoTracks()[0].getConstraints());
    check('getUserMedia asked for facingMode environment', JSON.stringify(fm).includes('environment'), fm);
    await shot(page, 'open');

    // throttle so progress is visible
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 100, downloadThroughput: 300 * 1024, uploadThroughput: 25 * 1024 });
    await page.evaluate(() => {
      window.__pcts = new Set();
      new MutationObserver(() => document.querySelectorAll('.thumb.uploading .pct').forEach(p => window.__pcts.add(p.textContent)))
        .observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await page.click('#cameraDlg .cam-shutter');
    await page.waitForSelector('#cameraDlg .cam-strip .thumb', { timeout: 5000 });
    st = await camState(page);
    check('after 1 shot: counter "1 taken · 5 left", camera stays open', /1 taken · 5 left/.test(st.count) && st.open && st.live, st);
    await page.waitForFunction(() => /\d+%|Preparing|Saving/.test(document.querySelector('#cameraDlg .cam-strip .thumb .pct')?.textContent || ''), null, { timeout: 10000 }).catch(() => { });
    await page.waitForTimeout(400);
    await shot(page, 'uploading');
    check('page tile shows upload progress behind the dialog', await page.$(`${sr0} .up .thumb.uploading .prog`) !== null);
    for (let i = 0; i < 7; i++) {   // try 7 more: only 5 fit (max 6)
      await page.waitForTimeout(150);
      if (await page.isDisabled('#cameraDlg .cam-shutter')) break;
      await page.click('#cameraDlg .cam-shutter');
    }
    await page.evaluate(() => window.camera.shoot());   // programmatic extra shot must be ignored too
    st = await camState(page);
    check('max respected: 6 taken, 0 left, shutter disabled', /6 taken · 0 left/.test(st.count) && st.shutterDisabled === true && st.strip === 6, st);
    await shot(page, 'max');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await page.waitForFunction(() => document.querySelectorAll('#cameraDlg .cam-strip .thumb.done').length === 6, null, { timeout: 90000 });
    await shot(page, 'all_uploaded');
    const pcts = await page.evaluate(() => [...window.__pcts]);
    check('per-photo progress values seen', pcts.some(p => /^\d+%$/.test(p) && p !== '0%') || pcts.some(p => /Saving/.test(p)), pcts);
    await page.click('#cameraDlg .cam-done');
    await page.waitForSelector('#cameraDlg:not([open])', { state: 'attached' });
    st = await camState(page);
    check('Done closes dialog and stops all camera tracks', !st.open && !st.streaming, st);
    const nThumbs = await page.$$eval(`${sr0} .up .thumb:not(.uploading)`, e => e.length);
    check('6 thumbnails on the SR card, no add tile', nThumbs === 6 && !(await page.$(`${sr0} .up .add-tile`)), nThumbs);
    await page.locator(sr0).scrollIntoViewIfNeeded();
    await shot(page, 'thumbs');
    const rows = sql("select source, count(*), sum(duplicate_of_id is not null) from images where zone_code=? and sr_id=? group by source", [zA, srsA[0]]);
    check('DB: 6 images with source=camera', rows.length === 1 && rows[0][0] === 'camera' && rows[0][1] === 6, rows);

    // meeting photo (section shows once "meeting held = yes") + Esc closes camera
    await page.check('#meetingForm input[name=meeting_held][value=yes]');
    await openCamera(page, '#meetingUploader'); await waitLive(page);
    check('meeting camera counter "0 taken · 4 left"', /0 taken · 4 left/.test((await camState(page)).count));
    await page.click('#cameraDlg .cam-shutter');
    await page.waitForSelector('#cameraDlg .cam-strip .thumb.done', { timeout: 30000 });
    await page.keyboard.press('Escape');
    await page.waitForSelector('#cameraDlg:not([open])', { state: 'attached' });
    st = await camState(page);
    check('Esc / back closes camera and stops tracks', !st.open && !st.streaming, st);
    await page.waitForFunction(() => document.querySelectorAll('#meetingUploader .thumb:not(.uploading)').length === 1, null, { timeout: 30000 });
    check('meeting photo thumbnail shown', true);

    // rapid shutter taps (no waits) must not over-count or silently drop photos: slot is reserved before toBlob
    const sr1 = `#srList article.sr-card[data-sr="${srsA[1]}"]`;
    await openCamera(page, `${sr1} .up`); await waitLive(page);
    await page.evaluate(() => { const b = document.querySelector('#cameraDlg .cam-shutter'); for (let i = 0; i < 9; i++) b.click(); for (let i = 0; i < 8; i++) window.camera.shoot(); });
    await page.waitForFunction(() => window.camera.capturing === 0, null, { timeout: 15000 });
    st = await camState(page);
    const toastsAfterBurst = await page.$$eval('#cameraDlg .toasts .toast', e => e.map(x => x.textContent));
    check('rapid burst: exactly "6 taken · 0 left", 6 in strip, no "add 0 more" warning',
      /^6 taken · 0 left/.test(st.count) && st.strip === 6 && !toastsAfterBurst.some(t => /add 0 more/.test(t)), [st, toastsAfterBurst]);
    await page.waitForFunction(() => document.querySelectorAll('#cameraDlg .cam-strip .thumb.done').length === 6, null, { timeout: 60000 });
    check('rapid burst: DB has exactly 6 photos for the SR', sql('select count(*) from images where zone_code=? and sr_id=?', [zA, srsA[1]])[0][0] === 6);
    await page.click('#cameraDlg .cam-done');
    await page.waitForSelector('#cameraDlg:not([open])', { state: 'attached' });

    // a warning toast inside the camera must not cover the shutter / Done buttons
    const sr2 = `#srList article.sr-card[data-sr="${srsA[2]}"]`;
    await openCamera(page, `${sr2} .up`); await waitLive(page);
    await page.evaluate(() => toast('Warning: this photo was already uploaded before (re-used photo).', 'bad'));
    const hit = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      const at = (b) => document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      const sh = r('#cameraDlg .cam-shutter'), dn = r('#cameraDlg .cam-done'), t = r('#cameraDlg .toasts .toast');
      return { shutter: !!at(sh)?.closest('.cam-shutter'), done: !!at(dn)?.closest('.cam-done'), toastVisible: t.height > 0 && t.top >= 0 && t.bottom < sh.top };
    });
    check('toast in camera is visible above the controls and does not block shutter / Done', hit.shutter && hit.done && hit.toastVisible, hit);
    await shot(page, 'toast');
    await page.click('#cameraDlg .cam-shutter');
    await page.waitForSelector('#cameraDlg .cam-strip .thumb', { timeout: 5000 });
    check('shutter works while a warning toast is showing', /^1 taken/.test((await camState(page)).count));
    await page.waitForSelector('#cameraDlg .cam-strip .thumb.done', { timeout: 30000 });
    await page.keyboard.press('Escape');
    await page.waitForSelector('#cameraDlg:not([open])', { state: 'attached' });
    st = await camState(page);
    check('Esc (2nd time) stops tracks immediately', !st.open && !st.streaming, st);

    // complete the report and submit
    const f = '#meetingForm';
    await page.check(`${f} input[name=meeting_held][value=yes]`);
    await page.fill(`${f} input[name=meeting_time]`, '09:30');
    await page.fill(`${f} input[name=sr_present_count]`, '3');
    for (const sr of srsA.slice(1)) await page.fill(`#srList article.sr-card[data-sr="${sr}"] textarea`, 'Route vacant today');
    await page.locator('textarea').last().blur();
    await page.waitForTimeout(1500);
    await page.click('#btnSubmit');
    await page.waitForSelector('#confirmDlg[open]', { timeout: 10000 });
    await page.click('#confirmDlg button[value=ok]');
    await page.waitForFunction(() => /Submitted to TSO/.test(document.querySelector('#statusBadge').textContent), null, { timeout: 15000 });
    check('AMO Submit still works after camera uploads', true);
    check('locked report: no Take-photo tiles', (await page.$$('.add-tile')).length === 0);
    await ctx.close();

    /* ---------- TSO photo ---------- */
    {
      const c = await browser.newContext({ ...PHONE, permissions: ['camera'] });
      const p = await c.newPage(); watch(p, 'tso1001');
      await login(p, 'tso1001');
      await p.waitForSelector('#tsoUploader .add-tile');
      check('TSO tile labelled "Take TSO photo"', /Take TSO photo/.test(await p.textContent('#tsoUploader .add-tile')));
      await openCamera(p, '#tsoUploader'); await waitLive(p);
      check('TSO camera counter "0 taken · 10 left"', /0 taken · 10 left/.test((await camState(p)).count));
      await p.click('#cameraDlg .cam-shutter');
      await p.waitForSelector('#cameraDlg .cam-strip .thumb.done', { timeout: 30000 });
      await shot(p, 'tso');
      await p.click('#cameraDlg .cam-done');
      await p.waitForFunction(() => document.querySelectorAll('#tsoUploader .thumb:not(.uploading)').length === 1, null, { timeout: 30000 });
      const t = sql("select source from images where kind='tso' and territory_code=1001");
      check('TSO photo uploaded with source=camera', t.length === 1 && t[0][0] === 'camera', t);
      await p.locator('#finalCard').scrollIntoViewIfNeeded();
      await shot(p, 'tso_thumb');
      await c.close();
    }

    /* ---------- permission denied (mocked NotAllowedError) ---------- */
    {
      const c = await browser.newContext({ ...PHONE });
      await c.addInitScript(() => {
        navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
      });
      const p = await c.newPage(); watch(p, 'denied');
      await login(p, 'amo' + zB);
      await p.waitForSelector('#main:not(.hidden)');
      await openCamera(p, `#srList article.sr-card[data-sr="${srsB[0]}"] .up`);
      await p.waitForSelector('#cameraDlg .cam-msg:not(.hidden)', { timeout: 10000 });
      const st2 = await camState(p);
      check('permission denied: explains how to allow camera in Chrome site settings', /Permissions/.test(st2.msg) && /Camera/.test(st2.msg) && /Allow/.test(st2.msg), st2.msg);
      check('permission denied: shutter disabled + Try again offered', st2.shutterDisabled === true && await p.isVisible('#cameraDlg .cam-retry'));
      await shot(p, 'denied');
      await c.close();
    }
    /* ---------- real permission denial (no fake-ui auto-accept, permission not granted) ---------- */
    {
      const b2 = await chromium.launch({ args: ['--use-fake-device-for-media-stream'] });
      const c = await b2.newContext({ ...PHONE });
      const p = await c.newPage(); watch(p, 'denied-real');
      await login(p, 'amo' + zB);
      await p.waitForSelector('#main:not(.hidden)');
      await openCamera(p, `#srList article.sr-card[data-sr="${srsB[0]}"] .up`);
      const got = await p.waitForSelector('#cameraDlg .cam-msg:not(.hidden)', { timeout: 10000 }).then(() => true).catch(() => false);
      const st3 = await camState(p);
      // headless Chromium reports NotSupportedError here (real Android Chrome: NotAllowedError); both show the help
      check('real denial (no permission granted) shows the help message', got && /Allow/.test(st3.msg), st3);
      await b2.close();
    }

    /* ---------- fallback: no getUserMedia -> capture input ---------- */
    {
      const c = await browser.newContext({ ...PHONE });
      await c.addInitScript(() => { try { Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true }); } catch (_) { } });
      const p = await c.newPage(); watch(p, 'fallback');
      await login(p, 'amo' + zB);
      await p.waitForSelector('#main:not(.hidden)');
      const inputs = await p.$$eval('input[type=file]', els => els.map(e => ({ capture: e.getAttribute('capture'), accept: e.accept, multiple: e.multiple })));
      check('fallback inputs all have capture="environment", accept=image/*, no multiple', inputs.length > 0 &&
        inputs.every(i => i.capture === 'environment' && i.accept === 'image/*' && !i.multiple), inputs);
      const img = path.join(SP, 'camera_fallback.jpg');
      py(`import sys
from PIL import Image
Image.effect_noise((800,600),70).convert('RGB').save(sys.argv[1],'JPEG')`, [img]);
      const card = `#srList article.sr-card[data-sr="${srsB[1]}"]`;
      await p.setInputFiles(`${card} .up input[type=file]`, img);
      await p.waitForFunction((c2) => document.querySelectorAll(c2 + ' .up .thumb:not(.uploading)').length === 1, card, { timeout: 30000 });
      const s2 = sql('select source from images where zone_code=? and sr_id=?', [zB, srsB[1]]);
      check('fallback upload stored with source=capture_input', s2.length === 1 && s2[0][0] === 'capture_input', s2);
      await p.locator(card).scrollIntoViewIfNeeded();
      await shot(p, 'fallback');
      await c.close();
    }

    /* ---------- server: uploads without a camera source are rejected ---------- */
    {
      const api = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { 'X-Requested-With': 'fetch' } });
      await api.post('/api/login', { data: { username: 'amo' + zB, password: PW } });
      const date = sql('select max(report_date) from zone_reports')[0][0];
      const buf = fs.readFileSync(path.join(SP, 'camera_fallback.jpg'));
      const r = await api.post('/api/images', { multipart: { file: { name: 'g.jpg', mimeType: 'image/jpeg', buffer: buf }, kind: 'sr', date, sr_id: srsB[2] } });
      const body = await r.json();
      check('server rejects upload without source (400 "Photos must be taken with the camera")', r.status() === 400 && /taken with the camera/.test(body.detail), [r.status(), body]);
      await api.dispose();
    }
  } finally {
    await browser.close();
    srv.kill();
  }
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
main().catch(e => { console.error('FATAL', e); process.exit(2); });
