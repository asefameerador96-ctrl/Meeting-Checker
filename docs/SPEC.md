# Pre-Plan Follow-Up Portal: build spec

## Purpose (from the business plan)
An online check that every field pre-plan meeting happens and that every SR leaves it with an
outlet-wise Maxim memo plan for the next day. Flow: **AMO submits → TSO approves & submits the territory →
Check-back team (checkers) verifies in the mother portal → Dashboard reports coverage and check results.**

## Hierarchy (seeded from the Excel, see `app/seed.py`)
Wing (10) > Division (50) > Territory (291, one **TSO** each, user `tso<territory_code>`) >
Zone (1049, one **AMO** each, user `amo<zone_code>`; the Excel "AMO" column is the zone name) >
Route (11331) > SR (6963). `Assignment` = distinct (zone, SR) pair (6969). It is the unit
called "SR" everywhere (images, approval, checks, dashboard counts). A few SRs belong to 2 zones; they count once per zone.
Checkers: `checker01..checker10` (role `checker`). One `admin`.

## Stack
FastAPI + SQLAlchemy 2 (SQLite dev / PostgreSQL prod) + Jinja2 templates + vanilla JS (no build step).
Charts: Chart.js 4.4.1 from `https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js`.
Excel export: openpyxl (server side). Timezone Asia/Dhaka (`services.today()`).

## Already implemented (do NOT rewrite; extend if strictly needed, keep backwards compatible)
- `app/models.py`: all tables. `app/services.py`: helpers (date rules, get-or-create, JSON serialisers, permission asserts, `hierarchy_json`).
- `app/auth.py`: `require_role(...)`, `current_user`, `audit(...)`.
- `app/routers/images.py`: `POST /api/images` (multipart: file, kind=meeting|sr|tso, date, sr_id), `GET /api/images/{id}/full|thumb`, `DELETE /api/images/{id}`.
  Uploading an `sr` image resets that SR entry's `tso_status` to `pending`. Images flagged `duplicate` (re-used photo) / `old_photo` (EXIF older than 2 days).
- `app/routers/auth_routes.py`: login/logout/me/change-password.
- `app/main.py`: pages `/amo`, `/tso`, `/checker` (checker+admin), `/admin` render `amo.html`, `tso.html`, `checker.html`, `admin.html`
  which must `{% extends "base.html" %}` and fill `{% block content %}` and `{% block scripts %}`.
  The template context has `user` and `v` (static version for cache busting: `/static/js/amo.js?v={{ v }}`).
- `app/static/js/common.js`: `api.get/post/put/del` (adds the required `X-Requested-With: fetch` header; throws Error(detail)),
  `toast(msg, 'ok'|'bad')`, `esc()`, `qs/qsa`, `fmtDateTime`, `debounce`, `lightbox.open([{url,caption}], i)`,
  `renderThumbs(container, images, {canDelete, onDelete, caption})`, `uploadImage(file, fields, onProgress)` and
  **`new Uploader(el, {fields:{kind,date,sr_id}, images, editable, max, label, onChange})`**: the multi-image upload widget with a
  per-image progress bar. USE IT for every upload; `uploader.busy` is true while uploading.
- `app/static/css/app.css`: design tokens + components (`.card`, `.card-head`, `.btn btn-primary|btn-ok|btn-bad|btn-ghost|btn-sm`,
  `.badge badge-ok|warn|bad|info`, `.banner banner-warn|ok|bad`, `.tbl` inside `.table-wrap`, `.tabs/.tab.active`, `.stat`,
  `.grid grid-2|grid-4`, `.row`, `.row-end`, `.radio-row`, `.sticky-actions`, `.muted`, `.small`, `dialog.modal`). Put page-specific CSS in a `<style>` in `{% block head %}`.
- Every mutating API call must be `/api/...` with `X-Requested-With: fetch` (enforced by middleware). Never trust zone/territory from the client.
  Derive them from the logged-in user.

## Status model
- `ZoneReport.status`: `not_started` (no row) → `draft` (AMO saving) → `submitted` (AMO sent to TSO, AMO locked) → TSO may `return` it
  (status `returned`, with `returned_remarks`; AMO can edit and re-submit).
- `SREntry.tso_status`: `pending` | `approved`. TSO approves each SR of a submitted zone report; remarks optional.
- `TerritoryReport.status`: `open` → `submitted` (TSO final submit; everything in the territory is locked for AMO and TSO and becomes
  visible in the checker portal).
- Editing (AMO/TSO) allowed only for dates in `services.editable_dates()` (today + ALLOW_BACKDATE_DAYS back). Use `assert_amo_can_edit` / `assert_tso_can_edit`.

---------------------------------------------------------------------------------------------------
## A. AMO portal: `app/routers/amo.py`, `app/templates/amo.html`, `app/static/js/amo.js`
Mobile-first (AMOs are on phones). One page.
API (all `require_role("amo")`, zone = `user.zone_code`):
- `GET /api/amo/report?date=YYYY-MM-DD` →
  `{date, editable_dates:[...], can_edit:bool, lock_reason:str, zone:{code,name}, territory:{code,name,division,wing},
    report: zone_report_json(...), territory_status:"open"|"submitted",
    meeting_images:[image_json], srs:[{sr_id, sr_name, route_codes, route_names, entry: sr_entry_json(...), images:[image_json]}],
    summary:{total_srs, srs_with_images, images_total}}`
- `PUT /api/amo/report` body `{date, location, meeting_held(bool|null), meeting_time("HH:MM"), not_held_reason, sr_present_count(int|null), vacancy_remarks}`
  → saves draft (creates ZoneReport). Validate meeting_time format, sr_present_count 0..999.
- `PUT /api/amo/sr/{sr_id}` body `{date, amo_remarks}`: saves remark (creates SREntry; must be an SR of the zone). Max 2000 chars.
- `POST /api/amo/submit` body `{date}`: validation: meeting_held must be set; if held → meeting_time required and ≥1 meeting photo;
  if not held → not_held_reason required; **every SR must have ≥1 image OR a non-empty AMO remark explaining why not**
  (return 400 listing the offending SR ids). Sets status `submitted`, `submitted_at`. Creates missing SREntry rows for all SRs.
UI:
- Header card: zone, territory, date selector (editable_dates), status badge, lock banner (submitted / returned with TSO note / territory submitted).
- Card "Pre-plan meeting": location (default territory name), meeting held Yes/No radios, time (input type=time) or reason, SR count present,
  vacancy remarks, meeting photo Uploader(kind=meeting, max 4). Auto-save on change (debounced) with a small "Saved ✓" indicator.
- Card per SR (list): SR name + id, routes, Uploader(kind=sr, sr_id, max 6, label "Add plan photos"), "Remarks" textarea (auto-save),
  badges: image count, TSO status (approved/pending), TSO remark if any. Show a progress summary "X of Y SRs have photos" with a progress bar at the top; a search box to filter SRs.
- Sticky "Submit to TSO" button at the bottom; disabled while any uploader is busy; on validation failure scroll to & highlight first offending SR.
- When locked: everything read-only (Uploader editable:false).

## B. TSO portal: `app/routers/tso.py`, `app/templates/tso.html`, `app/static/js/tso.js`
API (`require_role("tso")`, territory = `user.territory_code`). TSO sees ONLY zones/AMOs of their own territory.
- `GET /api/tso/report?date=` → `{date, editable_dates, can_edit, territory:{...}, territory_report:{status, tso_remarks, submitted_at, submitted_by},
   tso_images:[image_json], zones:[{zone:{code,name}, amo_username, report: zone_report_json, meeting_images, srs:[{sr_id, sr_name, route_names, entry, images}],
   counts:{total_srs, with_images, approved}}], totals:{zones, zones_submitted, total_srs, srs_with_images, approved, pending}, can_submit:bool, submit_blockers:[str]}`
- `PUT /api/tso/sr` body `{date, zone_code, sr_id, action:"approve"|"unapprove", tso_remarks}`: only for zones of this territory whose report is `submitted`.
  approve sets tso_status=approved, tso_at. Remarks optional (≤2000 chars).
- `POST /api/tso/zone/approve-all` body `{date, zone_code}`: approve every pending SR of that submitted zone (bulk convenience).
- `POST /api/tso/zone/return` body `{date, zone_code, remarks}`: send the zone back to the AMO (status `returned`, remarks required).
- `PUT /api/tso/remarks` body `{date, tso_remarks}`: overall territory remark (optional).
- `POST /api/tso/submit` body `{date}`. Blockers: (1) ≥1 TSO image uploaded (kind=tso), (2) every SR in every *submitted* zone is approved,
  (3) no zone is in `draft`/`returned` state with unsubmitted work... → rule: zones that are `draft` or `returned` block; zones `not_started` do NOT block
  (they are reported as not uploaded) but the UI must warn and require a confirm. Sets territory status submitted, submitted_at/by.
UI:
- Header: territory, date selector, totals stats, status.
- One collapsible card per zone (AMO): status badge, meeting info (held/time/reason/location/SR present/vacancy) + meeting photos; table/list of SRs with
  thumbnails (lightbox), image-count badge, REUSED/OLD flags, AMO remarks, TSO remarks input (optional), Approve button (toggles to "Approved ✓" with an undo),
  "Approve all" and "Return to AMO" buttons per zone. Not-started zones show "AMO has not submitted yet".
- Bottom card "TSO photo & final submission": Uploader(kind=tso, max 10), overall remarks. **The Submit button appears only once the TSO has uploaded at least one image
  AND all SRs of submitted zones are approved** (per user requirement). Show the remaining blockers as a checklist. Confirm dialog before final submit.

## C. Checker (mother) portal: `app/routers/checker.py`, `app/templates/checker.html`, `app/static/js/checker.js`
`require_role("checker","admin")`. Two tabs.
Only data of territories whose TerritoryReport is `submitted` counts as uploaded/visible (that is the "reflect to the mother portal" rule).
- `GET /api/checker/hierarchy` → `services.hierarchy_json(db)`.
- **Tab 1 "Territory details"**: filters Date + Wing → Division → Territory (cascading selects). `GET /api/checker/territory?date=&territory_code=` →
  `{territory, territory_report, submitted:bool, tso_images, zones:[{zone, report(+checker_meeting_valid), meeting_images}], rows:[{zone_code, zone_name, sr_id, sr_name,
  route_codes, route_names, images:[...], image_count, flags:{duplicate, old}, amo_remarks, tso_status, tso_remarks, checked, checker_valid, checker_remarks, checked_by, checked_at}]}`.
  If not submitted → return `submitted:false` + territory status and a message (no rows).
  Render a **constructive table**: columns Wing, Division, Territory, Zone(AMO), SR ID, SR Name, Routes, Photos (thumbs, lightbox), # Photos, Flags, AMO Remarks,
  TSO Status, TSO Remarks, Correct photos? (Yes/No select), **Checked** button (per row; toggles to "Checked ✓ by checker01"; can undo).
  Above the table: per-zone meeting block (meeting held, time, location, SR present vs SR count, meeting photos, "Meeting held with valid photo? Yes/No" select) and TSO photos + remarks.
  Also a "Check all visible" bulk button. Client-side text filter + "only unchecked" toggle.
  - `PUT /api/checker/sr` `{date, zone_code, sr_id, checked:bool, checker_valid:"yes"|"no"|null, checker_remarks}` (territory must be submitted).
  - `PUT /api/checker/zone` `{date, zone_code, checker_meeting_valid:"yes"|"no"|null}`.
  - `POST /api/checker/check-all` `{date, territory_code}`: mark all rows checked.
- **Tab 2 "Dashboard"**: filters Date (required) + optional Wing/Division/Territory scope. `GET /api/checker/dashboard?date=&wing=&division=&territory_code=` →
  `{scope, totals:{total_srs, uploaded, not_uploaded, checked, uploaded_not_checked, pct_uploaded, pct_not_uploaded, pct_checked,
     zones_total, zones_meeting_held, territories_total, territories_submitted, check_pass, check_fail, pass_pct},
    pie:{labels:["Images not uploaded","Images uploaded (not yet checked)","Checked by checker"], values:[...], pct:[...]},
    by_division:[{wing, division, total_srs, srs_with_images, checked}] , by_wing:[...]}`
  Definitions: total_srs = assignments in scope. uploaded = assignments with ≥1 sr image on that date in a submitted territory. checked = uploaded & checked.
  Pie slices are mutually exclusive and sum to total_srs: not_uploaded, uploaded_not_checked, checked; show % in labels/tooltip.
  **Bar chart: per division: Count of SR vs SRs with images uploaded** (grouped bars) for the scope (all divisions when no scope). Horizontal bars if >12 divisions.
  KPI tiles (from plan): "X of Y locations held the pre-plan meeting" (zones with meeting_held=true in submitted territories / all zones),
  "X of Y SRs with an outlet-wise pre-plan" (uploaded/total), "Checked", "Pass %" (checker_valid yes / (yes+no)), "Territories submitted X of Y".
  A table under the charts with the division numbers.
- **Excel download** (on Tab 2, uses the selected date + scope): `GET /api/checker/export/missing.xlsx?date=&wing=&division=&territory_code=` →
  list of SRs for that date with **no images uploaded/submitted** (i.e. not counted as uploaded), with columns: Date, Wing, Division, Territory Code, Territory,
  Zone Code, AMO (zone name), AMO Username, Route Codes, Routes, SR ID, SR Name, AMO Report Status, TSO Submission Status, AMO Remarks, TSO Remarks.
  Header styled, frozen, autofilter, sensible widths; filename `missing_images_<date>.xlsx`. Also optionally a second endpoint `.../export/full.xlsx` with all SR rows and status.

## D. Admin portal: `app/routers/admin.py`, `app/templates/admin.html`, `app/static/js/admin.js` (small)
`require_role("admin")`: list/search users (username, role, display, last login, active), reset a user's password (returns the new random password once,
bumps session_version), activate/deactivate, and a link to the checker portal. `GET /api/admin/users?q=&role=`, `POST /api/admin/users/{username}/reset-password`,
`PUT /api/admin/users/{username}` `{active}`.

## Non-functional
- Performance: dashboard over ~7k assignments per date must respond < 1s: use a few grouped queries, not N+1.
- Security: role checks on every endpoint; TSO/AMO scoped to own territory/zone; escape all user text in the DOM (`esc`).
- No external JS other than Chart.js from cdnjs. Must work on mobile (360px wide) and desktop.

## E. Retention & scale (added requirement)
- **Only the last 3 days (today, yesterday, day before; `RETENTION_DAYS`) can be viewed, checked or exported.** Every date-taking endpoint in every
  portal must call `services.ensure_viewable_date(d)` (AMO/TSO editing already goes through `ensure_editable_date`, which calls it), and every
  date selector must offer only `services.viewable_dates()` (return it as `viewable_dates` in the GET payloads; checker date input min/max accordingly).
- Photos older than the window are deleted automatically by `app/purge.py` (background thread, hourly) plus an Azure Blob lifecycle rule.
  Text records stay in the DB but are not reachable through the UI.
- Load: all ~1,350 users may upload at the same time (~20k photos/day, bursts of 10–20 uploads/s). The upload endpoint is a sync `def`
  (runs in the threadpool, Pillow off the event loop). Azure: autoscaling App Service plan (P1v3, 2→8 instances), PostgreSQL General Purpose,
  connection pool sized per worker (`DB_POOL_SIZE`/`DB_MAX_OVERFLOW`) so instances × workers × pool < Postgres max_connections.
