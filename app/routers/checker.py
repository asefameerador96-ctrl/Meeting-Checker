"""Checker (mother) portal API (docs/SPEC.md section C).

Only territories whose TerritoryReport is `submitted` for the date are visible here: that is the
"reflect to the mother portal" rule. An SR (= Assignment, a distinct zone/SR pair) counts as
*uploaded* when it has at least one `sr` image on that date in a submitted territory, and as
*checked* when it is uploaded and a checker has marked its SREntry checked.

The dashboard splits every SR in scope into four mutually exclusive buckets (they always sum to the total):
  not uploaded | uploaded, not yet checked | checked by checker (Correct photos? != No) | incorrect photo
  (checked and Correct photos? == No).

Wing scope: a checker whose users.scope_wings restricts them to some wings sees and edits only those wings,
everywhere (hierarchy, territory details, checks, dashboard, Excel exports, images). Admin sees all wings.
"""
import io
from collections import defaultdict
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from openpyxl import Workbook
from openpyxl.cell import WriteOnlyCell
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from pydantic import BaseModel, Field
from sqlalchemy import and_, case, distinct, func, or_, select
from sqlalchemy.orm import Session

from ..auth import audit, require_role
from ..db import get_db
from ..models import SR, Assignment, Image, SREntry, Territory, TerritoryReport, User, Zone, ZoneReport
from ..services import (allowed_wings, can_see_wing, ensure_viewable_date, get_sr_entry, get_territory_report,
                        get_zone_report, hierarchy_json, image_json, parse_date, sr_entry_json, viewable_dates,
                        zone_report_json)

router = APIRouter(prefix="/api/checker", tags=["checker"])
checker_only = require_role("checker", "admin")

MAX_REMARKS = 2000
VALID = ("yes", "no")


# ---------------- request bodies ----------------
class SRCheckIn(BaseModel):
    date: str
    zone_code: int
    sr_id: str = Field(min_length=1, max_length=40)
    checked: bool
    checker_valid: str | None = None
    checker_remarks: str | None = Field(default=None, max_length=MAX_REMARKS)


class ZoneCheckIn(BaseModel):
    date: str
    zone_code: int
    checker_meeting_valid: str | None = None


class SRKey(BaseModel):
    zone_code: int
    sr_id: str = Field(min_length=1, max_length=40)


class CheckAllIn(BaseModel):
    date: str
    territory_code: int
    items: list[SRKey] | None = None  # optional subset (e.g. the rows visible after client filtering)


# ---------------- helpers ----------------
def _now():
    return datetime.now(timezone.utc)


def _viewable(s: str | None) -> date:
    d = parse_date(s)
    ensure_viewable_date(d)
    return d


def _valid_value(v: str | None) -> str | None:
    if v in (None, ""):
        return None
    if v not in VALID:
        raise HTTPException(400, "Value must be 'yes', 'no' or empty")
    return v


def _territory(db: Session, code: int, user: User) -> Territory:
    t = db.get(Territory, code)
    if not t:
        raise HTTPException(404, "Territory not found")
    _assert_wing(user, t.wing)
    return t


def _assert_wing(user: User, wing: str | None):
    if not can_see_wing(user, wing):
        raise HTTPException(403, "This territory is outside the wings assigned to you")


def _zone_in_scope(db: Session, zone_code: int, user: User) -> Zone:
    z = db.get(Zone, zone_code)
    if not z:
        raise HTTPException(404, "Zone not found")
    _assert_wing(user, db.get(Territory, z.territory_code).wing)
    return z


def _assert_submitted(db: Session, d: date, territory_code: int):
    tr = get_territory_report(db, d, territory_code)
    if not tr or tr.status != "submitted":
        raise HTTPException(409, "The TSO has not submitted this territory for this date yet")


def _territory_json(t: Territory) -> dict:
    return {"code": t.code, "name": t.name, "division": t.division, "wing": t.wing}


def _scope_filter(db: Session, user: User, wing: str | None, division: str | None, territory_code: int | None) -> list:
    """WHERE conditions on Territory for the requested scope, always clipped to the user's allowed wings.
    Asking for a wing, division or territory outside the user's wings is a 403 (consistent across endpoints)."""
    conds = []
    allowed = allowed_wings(user)
    if wing:
        if allowed is not None and wing not in allowed:
            raise HTTPException(403, "This wing is not assigned to you")
        conds.append(Territory.wing == wing)
    elif allowed is not None:
        conds.append(Territory.wing.in_(allowed))
    if allowed is not None:
        if division and not db.scalar(select(func.count(Territory.code))
                                      .where(Territory.division == division, Territory.wing.in_(allowed))):
            if db.scalar(select(func.count(Territory.code)).where(Territory.division == division)):
                raise HTTPException(403, "This division is not in your assigned wing(s)")
        if territory_code:
            tw = db.scalar(select(Territory.wing).where(Territory.code == territory_code))
            if tw is not None and tw not in allowed:
                raise HTTPException(403, "This territory is not in your assigned wing(s)")
    if division:
        conds.append(Territory.division == division)
    if territory_code:
        conds.append(Territory.code == territory_code)
    return conds


def _submitted_territories(d: date):
    return select(TerritoryReport.territory_code).where(TerritoryReport.report_date == d,
                                                        TerritoryReport.status == "submitted")


def _uploaded_subquery(d: date):
    """Distinct (zone_code, sr_id, n_images) with >= 1 sr image on date d in a submitted territory."""
    return (select(Image.zone_code.label("zone_code"), Image.sr_id.label("sr_id"),
                   func.count(Image.id).label("n_images"))
            .where(Image.report_date == d, Image.kind == "sr",
                   Image.territory_code.in_(_submitted_territories(d)))
            .group_by(Image.zone_code, Image.sr_id)
            .subquery())


def _pct(n: int, total: int) -> float:
    return round(n * 100.0 / total, 1) if total else 0.0


# ---------------- endpoints ----------------
@router.get("/hierarchy")
def hierarchy(user: User = Depends(checker_only), db: Session = Depends(get_db)):
    out = hierarchy_json(db)
    allowed = allowed_wings(user)
    if allowed is not None:
        out["wings"] = [w for w in out["wings"] if w["name"] in allowed]
    out["my_wings"] = [w["name"] for w in out["wings"]] if allowed is not None else None  # None = all wings
    out["viewable_dates"] = viewable_dates()
    return out


@router.get("/territory")
def territory_details(date: str | None = None, territory_code: int = 0,
                      user: User = Depends(checker_only), db: Session = Depends(get_db)):
    d = _viewable(date)
    t = _territory(db, territory_code, user)
    tr = get_territory_report(db, d, t.code)
    tr_json = {"status": tr.status if tr else "open", "tso_remarks": tr.tso_remarks if tr else "",
               "submitted_at": tr.submitted_at.isoformat() if tr and tr.submitted_at else None,
               "submitted_by": tr.submitted_by if tr else None}
    base = {"date": d.isoformat(), "viewable_dates": viewable_dates(), "territory": _territory_json(t),
            "territory_report": tr_json}
    if not tr or tr.status != "submitted":
        return {**base, "submitted": False, "tso_images": [], "zones": [], "rows": [],
                "message": "The TSO has not submitted this territory for this date yet. "
                           "It will appear here once the TSO completes the final submission."}

    zones = list(db.scalars(select(Zone).where(Zone.territory_code == t.code).order_by(Zone.name, Zone.code)))
    zone_name = {z.code: z.name for z in zones}
    reports = {zr.zone_code: zr for zr in db.scalars(
        select(ZoneReport).where(ZoneReport.report_date == d, ZoneReport.territory_code == t.code))}
    entries = {(e.zone_code, e.sr_id): e for e in db.scalars(
        select(SREntry).where(SREntry.report_date == d, SREntry.territory_code == t.code))}
    amo_users = dict(db.execute(select(User.zone_code, User.username).where(
        User.role == "amo", User.zone_code.in_(list(zone_name)))).all())

    imgs = list(db.scalars(select(Image).where(Image.report_date == d, Image.territory_code == t.code)
                           .order_by(Image.id)))
    tso_images, meeting_imgs, sr_imgs = [], defaultdict(list), defaultdict(list)
    for img in imgs:
        j = image_json(img)
        if img.kind == "tso":
            tso_images.append(j)
        elif img.kind == "meeting":
            meeting_imgs[img.zone_code].append(j)
        else:
            sr_imgs[(img.zone_code, img.sr_id)].append(j)

    assigns = db.execute(select(Assignment, SR.name).join(SR, SR.id == Assignment.sr_id)
                         .where(Assignment.territory_code == t.code)).all()
    srs_per_zone: dict[int, int] = defaultdict(int)
    rows = []
    for a, sr_name in assigns:
        srs_per_zone[a.zone_code] += 1
        key = (a.zone_code, a.sr_id)
        ims = sr_imgs.get(key, [])
        e = sr_entry_json(entries.get(key))
        rows.append({
            "zone_code": a.zone_code, "zone_name": zone_name.get(a.zone_code, ""), "sr_id": a.sr_id,
            "sr_name": sr_name, "route_codes": a.route_codes, "route_names": a.route_names,
            "images": ims, "image_count": len(ims),
            "flags": {"duplicate": any(i["duplicate"] for i in ims), "old": any(i["old_photo"] for i in ims)},
            **e,
        })
    rows.sort(key=lambda r: (r["zone_name"], r["zone_code"], r["sr_id"]))

    zones_out = []
    for z in zones:
        zones_out.append({"zone": {"code": z.code, "name": z.name}, "amo_username": amo_users.get(z.code),
                          "report": zone_report_json(reports.get(z.code)),
                          "meeting_images": meeting_imgs.get(z.code, []),
                          "sr_count": srs_per_zone.get(z.code, 0)})
    return {**base, "submitted": True, "tso_images": tso_images, "zones": zones_out, "rows": rows}


def _sr_has_images(db: Session, d: date, zone_code: int, sr_id: str) -> bool:
    return db.scalar(select(Image.id).where(Image.report_date == d, Image.zone_code == zone_code,
                                            Image.sr_id == sr_id, Image.kind == "sr").limit(1)) is not None


@router.put("/sr")
def check_sr(body: SRCheckIn, user: User = Depends(checker_only), db: Session = Depends(get_db)):
    d = _viewable(body.date)
    z = _zone_in_scope(db, body.zone_code, user)
    _assert_submitted(db, d, z.territory_code)
    e = get_sr_entry(db, d, z.code, body.sr_id, create=True)  # 404 if the SR is not in the zone
    if body.checked and not e.checked and not _sr_has_images(db, d, z.code, body.sr_id):
        # "checked" means the checker verified the SR's photos; with no photo the SR is simply "not uploaded"
        raise HTTPException(409, "This SR has no photo to check")
    e.checker_valid = _valid_value(body.checker_valid)
    if body.checker_remarks is not None:
        e.checker_remarks = body.checker_remarks.strip()
    if body.checked:
        if not e.checked:
            e.checked, e.checked_by, e.checked_at = True, user.username, _now()
    else:
        e.checked, e.checked_by, e.checked_at = False, None, None
    audit(db, user, "checker_sr", f"{d} zone={z.code} sr={body.sr_id} checked={e.checked} valid={e.checker_valid}")
    db.commit()
    return {"ok": True, "entry": sr_entry_json(e)}


@router.put("/zone")
def check_zone(body: ZoneCheckIn, user: User = Depends(checker_only), db: Session = Depends(get_db)):
    d = _viewable(body.date)
    z = _zone_in_scope(db, body.zone_code, user)
    _assert_submitted(db, d, z.territory_code)
    zr = get_zone_report(db, d, z.code)
    if not zr:
        raise HTTPException(409, "The AMO did not submit a report for this zone")
    zr.checker_meeting_valid = _valid_value(body.checker_meeting_valid)
    zr.checker_by, zr.checker_at = (user.username, _now()) if zr.checker_meeting_valid else (None, None)
    audit(db, user, "checker_zone", f"{d} zone={z.code} meeting_valid={zr.checker_meeting_valid}")
    db.commit()
    return {"ok": True, "report": zone_report_json(zr)}


@router.post("/check-all")
def check_all(body: CheckAllIn, user: User = Depends(checker_only), db: Session = Depends(get_db)):
    d = _viewable(body.date)
    t = _territory(db, body.territory_code, user)
    _assert_submitted(db, d, t.code)
    assigns = list(db.scalars(select(Assignment).where(Assignment.territory_code == t.code)))
    if body.items is not None:
        wanted = {(i.zone_code, i.sr_id) for i in body.items}
        assigns = [a for a in assigns if (a.zone_code, a.sr_id) in wanted]
    # only SRs with photos can be checked (an SR image upload always creates its SREntry)
    with_images = set(db.execute(select(Image.zone_code, Image.sr_id).where(
        Image.report_date == d, Image.territory_code == t.code, Image.kind == "sr").distinct()).all())
    entries = {(e.zone_code, e.sr_id): e for e in db.scalars(
        select(SREntry).where(SREntry.report_date == d, SREntry.territory_code == t.code))}
    now, n = _now(), 0
    for a in assigns:
        e = entries.get((a.zone_code, a.sr_id))
        if e is None or (a.zone_code, a.sr_id) not in with_images:
            continue
        if not e.checked:
            e.checked, e.checked_by, e.checked_at = True, user.username, now
            n += 1
    audit(db, user, "checker_check_all", f"{d} territory={t.code} newly_checked={n}")
    db.commit()
    return {"ok": True, "checked": n}


def _bucket_columns(up):
    """Aggregates per group: total SRs, uploaded, checked (Correct photos? yes/blank), incorrect (checked + No),
    verdict yes. checked + incorrect = all checked SRs with photos; the four pie buckets are mutually exclusive."""
    is_up = up.c.zone_code.is_not(None)
    chk = and_(is_up, SREntry.checked.is_(True))
    bad = and_(chk, SREntry.checker_valid == "no")
    good = and_(chk, or_(SREntry.checker_valid.is_(None), SREntry.checker_valid != "no"))

    def n(cond):
        return func.coalesce(func.sum(case((cond, 1), else_=0)), 0)
    return [func.count(Assignment.id), func.count(up.c.zone_code), n(good), n(bad),
            n(and_(chk, SREntry.checker_valid == "yes"))]


def _counts(n, n_up, n_chk, n_bad) -> dict:
    n, n_up, n_chk, n_bad = int(n), int(n_up), int(n_chk), int(n_bad)
    return {"total_srs": n, "srs_with_images": n_up, "checked": n_chk, "incorrect": n_bad,
            "checked_total": n_chk + n_bad, "not_uploaded": n - n_up, "uploaded_not_checked": n_up - n_chk - n_bad,
            "pct_uploaded": _pct(n_up, n)}


@router.get("/dashboard")
def dashboard(date: str | None = None, wing: str | None = None, division: str | None = None,
              territory_code: int | None = None, user: User = Depends(checker_only), db: Session = Depends(get_db)):
    d = _viewable(date)
    scope = _scope_filter(db, user, wing, division, territory_code)
    up = _uploaded_subquery(d)

    def grouped(*keys):
        return (select(*keys, *_bucket_columns(up))
                .select_from(Assignment)
                .join(Territory, Territory.code == Assignment.territory_code)
                .outerjoin(up, and_(up.c.zone_code == Assignment.zone_code, up.c.sr_id == Assignment.sr_id))
                .outerjoin(SREntry, and_(SREntry.report_date == d, SREntry.zone_code == Assignment.zone_code,
                                         SREntry.sr_id == Assignment.sr_id))
                .where(*scope)
                .group_by(*keys))

    # one grouped pass over all assignments in scope
    by_division, wings = [], {}
    tot = defaultdict(int)
    q = grouped(Territory.wing, Territory.division).order_by(Territory.wing, Territory.division)
    for w, dv, n, n_up, n_chk, n_bad, n_yes in db.execute(q):
        by_division.append({"wing": w, "division": dv, **_counts(n, n_up, n_chk, n_bad)})
        wr = wings.setdefault(w, defaultdict(int))
        for k, v in (("n", n), ("up", n_up), ("chk", n_chk), ("bad", n_bad)):
            wr[k] += int(v)
            tot[k] += int(v)
        tot["yes"] += int(n_yes)
    by_wing = [{"wing": w, **_counts(c["n"], c["up"], c["chk"], c["bad"])} for w, c in wings.items()]

    # drill-down: once a division (or territory) is chosen, break the bar chart down by territory
    by_territory = []
    if division or territory_code:
        tq = grouped(Territory.wing, Territory.division, Territory.code, Territory.name).order_by(Territory.name,
                                                                                                    Territory.code)
        by_territory = [{"wing": w, "division": dv, "territory_code": tc, "territory": tn,
                         **_counts(n, n_up, n_chk, n_bad)}
                        for w, dv, tc, tn, n, n_up, n_chk, n_bad, _yes in db.execute(tq)]

    zones_total = db.scalar(select(func.count(Zone.code)).join(Territory, Territory.code == Zone.territory_code)
                            .where(*scope)) or 0
    zones_held = db.scalar(select(func.count(ZoneReport.id)).join(Territory, Territory.code == ZoneReport.territory_code)
                           .where(ZoneReport.report_date == d, ZoneReport.meeting_held.is_(True),
                                  ZoneReport.territory_code.in_(_submitted_territories(d)), *scope)) or 0
    terr_total = db.scalar(select(func.count(Territory.code)).where(*scope)) or 0
    terr_sub = db.scalar(select(func.count(distinct(TerritoryReport.territory_code)))
                         .join(Territory, Territory.code == TerritoryReport.territory_code)
                         .where(TerritoryReport.report_date == d, TerritoryReport.status == "submitted", *scope)) or 0

    c = _counts(tot["n"], tot["up"], tot["chk"], tot["bad"])
    total, uploaded, checked, incorrect = c["total_srs"], c["srs_with_images"], c["checked"], c["incorrect"]
    values = [c["not_uploaded"], c["uploaded_not_checked"], checked, incorrect]
    return {
        "date": d.isoformat(), "viewable_dates": viewable_dates(),
        "scope": {"wing": wing or None, "division": division or None, "territory_code": territory_code or None,
                  "allowed_wings": allowed_wings(user)},
        "totals": {"total_srs": total, "uploaded": uploaded, "not_uploaded": c["not_uploaded"], "checked": checked,
                   "incorrect": incorrect, "checked_total": c["checked_total"],
                   "uploaded_not_checked": c["uploaded_not_checked"], "pct_uploaded": _pct(uploaded, total),
                   "pct_not_uploaded": _pct(c["not_uploaded"], total), "pct_checked": _pct(checked, total),
                   "pct_incorrect": _pct(incorrect, total),
                   "zones_total": zones_total, "zones_meeting_held": zones_held,
                   "territories_total": terr_total, "territories_submitted": terr_sub,
                   "check_pass": tot["yes"], "check_fail": incorrect,
                   "pass_pct": _pct(tot["yes"], tot["yes"] + incorrect)},
        "pie": {"labels": list(PIE_LABELS), "values": values, "pct": [_pct(v, total) for v in values]},
        "by_division": by_division, "by_wing": by_wing, "by_territory": by_territory,
    }


PIE_LABELS = ("Images not uploaded", "Images uploaded (not yet checked)", "Checked by checker", "Incorrect photo")


# ---------------- Excel exports ----------------
def _export_rows(db: Session, d: date, scope: list, missing_only: bool) -> list[tuple]:
    """One row per assignment in scope (optionally only those without uploaded images). Columns:
    0 wing, 1 division, 2 territory code, 3 territory, 4 zone code, 5 zone name, 6 AMO username, 7 route codes,
    8 routes, 9 SR id, 10 SR name, 11 zone report status, 12 territory status, 13 AMO remarks, 14 TSO remarks,
    15 TSO status, 16 checked, 17 checker valid, 18 checker remarks, 19 checked by, 20 # images (uploaded)."""
    up = _uploaded_subquery(d)
    q = (select(Territory.wing, Territory.division, Territory.code, Territory.name, Zone.code, Zone.name,
                Assignment.route_codes, Assignment.route_names, Assignment.sr_id, SR.name,
                ZoneReport.status, TerritoryReport.status, SREntry.amo_remarks, SREntry.tso_remarks,
                SREntry.tso_status, SREntry.checked, SREntry.checker_valid, SREntry.checker_remarks,
                SREntry.checked_by, up.c.n_images)
         .select_from(Assignment)
         .join(Territory, Territory.code == Assignment.territory_code)
         .join(Zone, Zone.code == Assignment.zone_code)
         .join(SR, SR.id == Assignment.sr_id)
         .outerjoin(up, and_(up.c.zone_code == Assignment.zone_code, up.c.sr_id == Assignment.sr_id))
         .outerjoin(ZoneReport, and_(ZoneReport.report_date == d, ZoneReport.zone_code == Assignment.zone_code))
         .outerjoin(TerritoryReport, and_(TerritoryReport.report_date == d,
                                          TerritoryReport.territory_code == Assignment.territory_code))
         .outerjoin(SREntry, and_(SREntry.report_date == d, SREntry.zone_code == Assignment.zone_code,
                                  SREntry.sr_id == Assignment.sr_id))
         .where(*scope)
         .order_by(Territory.wing, Territory.division, Territory.name, Zone.name, Assignment.sr_id))
    if missing_only:
        q = q.where(up.c.zone_code.is_(None))
    amo = dict(db.execute(select(User.zone_code, User.username).where(User.role == "amo")).all())
    return [r[:6] + (amo.get(r[4], ""),) + r[6:] for r in db.execute(q)]


_AMO_STATUS = {None: "Not started", "draft": "Draft (not sent)", "submitted": "Submitted to TSO", "returned": "Returned to AMO"}
_TSO_STATUS = {None: "Not submitted", "open": "Not submitted", "submitted": "Submitted"}
_HEAD_FILL = PatternFill("solid", fgColor="1F5FA8")
_HEAD_FONT = Font(bold=True, color="FFFFFF")
_HEAD_ALIGN = Alignment(vertical="center", wrap_text=True)


class _Styled:
    """A cell value with a highlight (used for the "Incorrect photo" status in the full export)."""
    __slots__ = ("value", "fill", "color")

    def __init__(self, value, fill: str, color: str):
        self.value, self.fill, self.color = value, fill, color


def photo_status(n_img: int, checked, valid) -> str:
    """The SR's dashboard bucket (same definition as the pie)."""
    if not n_img:
        return PIE_LABELS[0]
    if not checked:
        return PIE_LABELS[1]
    return PIE_LABELS[3] if valid == "no" else PIE_LABELS[2]


def _cell(v):
    """Neutralise spreadsheet formula injection in user-supplied text (=, +, -, @ prefixes)."""
    if isinstance(v, str) and v[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + v
    return v


def _xlsx_response(title: str, headers: list[tuple[str, int]], rows: list[list], filename: str) -> StreamingResponse:
    wb = Workbook(write_only=True)
    ws = wb.create_sheet(title)
    for i, (_, width) in enumerate(headers, start=1):
        ws.column_dimensions[get_column_letter(i)].width = width
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{len(rows) + 1}"
    head = []
    for h, _ in headers:
        c = WriteOnlyCell(ws, value=h)
        c.fill, c.font, c.alignment = _HEAD_FILL, _HEAD_FONT, _HEAD_ALIGN
        head.append(c)
    ws.append(head)
    for r in rows:
        out = []
        for v in r:
            if isinstance(v, _Styled):
                c = WriteOnlyCell(ws, value=_cell(v.value))
                c.fill, c.font = PatternFill("solid", fgColor=v.fill), Font(bold=True, color=v.color)
                out.append(c)
            else:
                out.append(_cell(v))
        ws.append(out)
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return StreamingResponse(
        buf, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"', "Cache-Control": "no-store"})


_BASE_HEADERS = [("Date", 12), ("Wing", 16), ("Division", 18), ("Territory Code", 10), ("Territory", 20),
                 ("Zone Code", 10), ("AMO (Zone)", 22), ("AMO Username", 14), ("Route Codes", 18), ("Routes", 34),
                 ("SR ID", 12), ("SR Name", 24)]


def _base_cells(ds: str, r) -> list:
    return [ds, r[0], r[1], r[2], r[3], r[4], r[5], r[6] or "", r[7], r[8], r[9], r[10]]


@router.get("/export/missing.xlsx")
def export_missing(date: str | None = None, wing: str | None = None, division: str | None = None,
                   territory_code: int | None = None, user: User = Depends(checker_only), db: Session = Depends(get_db)):
    d = _viewable(date)
    ds = d.isoformat()
    rows = [_base_cells(ds, r) + [_AMO_STATUS.get(r[11], r[11]), _TSO_STATUS.get(r[12], r[12]), r[13] or "", r[14] or ""]
            for r in _export_rows(db, d, _scope_filter(db, user, wing, division, territory_code), missing_only=True)]
    headers = _BASE_HEADERS + [("AMO Report Status", 16), ("TSO Submission Status", 14),
                               ("AMO Remarks", 40), ("TSO Remarks", 32)]
    audit(db, user, "checker_export_missing", f"{ds} wing={wing} division={division} territory={territory_code} rows={len(rows)}")
    db.commit()
    return _xlsx_response("Missing images", headers, rows, f"missing_images_{ds}.xlsx")


@router.get("/export/full.xlsx")
def export_full(date: str | None = None, wing: str | None = None, division: str | None = None,
                territory_code: int | None = None, user: User = Depends(checker_only), db: Session = Depends(get_db)):
    d = _viewable(date)
    ds = d.isoformat()
    rows = []
    for r in _export_rows(db, d, _scope_filter(db, user, wing, division, territory_code), missing_only=False):
        n_img = r[20] or 0
        status = photo_status(n_img, r[16], r[17])
        rows.append(_base_cells(ds, r) + [
            _AMO_STATUS.get(r[11], r[11]), _TSO_STATUS.get(r[12], r[12]), n_img, "Yes" if n_img else "No",
            r[13] or "", (r[15] or "pending").capitalize(), r[14] or "", "Yes" if (r[16] and n_img) else "No",
            {"yes": "Yes", "no": "No"}.get(r[17], ""),
            _Styled(status, "FDE2E0", "B3261E") if status == PIE_LABELS[3] else status,
            r[18] or "", r[19] or ""])
    headers = _BASE_HEADERS + [("AMO Report Status", 16), ("TSO Submission Status", 14), ("# Photos", 9),
                               ("Images Uploaded", 10), ("AMO Remarks", 36), ("TSO Status", 11), ("TSO Remarks", 30),
                               ("Checked", 9), ("Correct Photos?", 10), ("Photo Status", 26), ("Checker Remarks", 30),
                               ("Checked By", 12)]
    audit(db, user, "checker_export_full", f"{ds} wing={wing} division={division} territory={territory_code} rows={len(rows)}")
    db.commit()
    return _xlsx_response("All SRs", headers, rows, f"sr_status_{ds}.xlsx")
