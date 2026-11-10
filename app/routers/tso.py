"""TSO portal API (docs/SPEC.md section B).

The TSO reviews the reports of the AMOs (zones) of their own territory, approves each SR
(remarks optional), may return a zone to its AMO, uploads their own photo(s) and finally submits
the territory, which locks it and makes it visible in the checker (mother) portal.
The territory is always taken from the logged-in user, never from the request.
"""
from collections import defaultdict
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import audit, require_role
from ..db import get_db
from ..models import SR, Assignment, Image, SREntry, Territory, User, Zone, ZoneReport
from ..services import (assert_tso_can_edit, editable_dates, get_sr_entry, get_territory_report, get_zone_report,
                        image_json, parse_date, sr_entry_json, zone_report_json)

router = APIRouter(prefix="/api/tso", tags=["tso"])

MAX_REMARKS = 2000
BLOCKING_ZONE_STATES = ("draft", "returned")


# ---------------- request bodies ----------------
class SRAction(BaseModel):
    date: str
    zone_code: int
    sr_id: str = Field(min_length=1, max_length=40)
    action: str  # approve | unapprove | remarks (save remarks only, status unchanged)
    tso_remarks: str | None = Field(default=None, max_length=MAX_REMARKS)


class ZoneIn(BaseModel):
    date: str
    zone_code: int


class ZoneReturnIn(ZoneIn):
    remarks: str = Field(max_length=MAX_REMARKS)


class RemarksIn(BaseModel):
    date: str
    tso_remarks: str = Field(default="", max_length=MAX_REMARKS)


class SubmitIn(BaseModel):
    date: str
    confirm_not_started: bool = False  # must be true when some AMOs have not submitted at all


# ---------------- helpers ----------------
def _territory_code(user: User) -> int:
    if not user.territory_code:
        raise HTTPException(403, "Your account is not linked to a territory")
    return user.territory_code


def _now():
    return datetime.now(timezone.utc)


def _date_open(d: date) -> bool:
    return d.isoformat() in editable_dates()


def _own_zone(db: Session, zone_code: int, territory_code: int) -> Zone:
    z = db.get(Zone, zone_code)
    if not z or z.territory_code != territory_code:
        raise HTTPException(404, "Zone is not in your territory")
    return z


def _submitted_zone_report(db: Session, d: date, zone_code: int) -> ZoneReport:
    zr = get_zone_report(db, d, zone_code)
    if not zr or zr.status != "submitted":
        raise HTTPException(409, "The AMO has not submitted this zone yet")
    return zr


def _zone_counts(db: Session, d: date, zone_code: int) -> dict:
    srs = [a.sr_id for a, _ in _zone_assignments(db, zone_code)]
    with_img = set(db.scalars(select(Image.sr_id).where(Image.report_date == d, Image.zone_code == zone_code,
                                                         Image.kind == "sr").distinct()))
    approved = set(db.scalars(select(SREntry.sr_id).where(SREntry.report_date == d, SREntry.zone_code == zone_code,
                                                           SREntry.tso_status == "approved")))
    return {"total_srs": len(srs), "with_images": sum(1 for s in srs if s in with_img),
            "approved": sum(1 for s in srs if s in approved)}


def _zone_assignments(db: Session, zone_code: int):
    return list(db.execute(select(Assignment, SR).join(SR, SR.id == Assignment.sr_id)
                           .where(Assignment.zone_code == zone_code).order_by(Assignment.sr_id)))


def _build_report(db: Session, d: date, tc: int) -> dict:
    t = db.get(Territory, tc)
    tr = get_territory_report(db, d, tc)
    t_submitted = bool(tr and tr.status == "submitted")
    can_edit = _date_open(d) and not t_submitted

    zones = list(db.scalars(select(Zone).where(Zone.territory_code == tc).order_by(Zone.code)))
    reports = {zr.zone_code: zr for zr in db.scalars(
        select(ZoneReport).where(ZoneReport.report_date == d, ZoneReport.territory_code == tc))}
    entries = {(e.zone_code, e.sr_id): e for e in db.scalars(
        select(SREntry).where(SREntry.report_date == d, SREntry.territory_code == tc))}
    amo_users = {u.zone_code: u.username for u in db.scalars(
        select(User).where(User.role == "amo", User.zone_code.in_([z.code for z in zones])))} if zones else {}
    meeting_imgs, sr_imgs, tso_imgs = defaultdict(list), defaultdict(list), []
    for img in db.scalars(select(Image).where(Image.report_date == d, Image.territory_code == tc).order_by(Image.id)):
        if img.kind == "tso":
            tso_imgs.append(image_json(img))
        elif img.kind == "meeting":
            meeting_imgs[img.zone_code].append(image_json(img))
        elif img.kind == "sr":
            sr_imgs[(img.zone_code, img.sr_id)].append(image_json(img))
    by_zone = defaultdict(list)
    for a, sr in db.execute(select(Assignment, SR).join(SR, SR.id == Assignment.sr_id)
                            .where(Assignment.territory_code == tc).order_by(Assignment.sr_id)):
        by_zone[a.zone_code].append((a, sr))

    out_zones = []
    totals = {"zones": len(zones), "zones_submitted": 0, "zones_not_started": 0, "zones_in_progress": 0,
              "total_srs": 0, "srs_with_images": 0, "approved": 0, "pending": 0}
    blockers: list[str] = []
    pending_srs = 0
    in_progress, not_started = [], []
    for z in zones:
        zr = reports.get(z.code)
        status = zr.status if zr else "not_started"
        srs, c_img, c_ok = [], 0, 0
        for a, sr in by_zone.get(z.code, []):
            e = entries.get((z.code, sr.id))
            imgs = sr_imgs.get((z.code, sr.id), [])
            ej = sr_entry_json(e)
            c_img += bool(imgs)
            c_ok += ej["tso_status"] == "approved"
            if status == "submitted" and ej["tso_status"] != "approved":
                pending_srs += 1
            srs.append({"sr_id": sr.id, "sr_name": sr.name, "route_codes": a.route_codes, "route_names": a.route_names,
                        "entry": ej, "images": imgs})
        totals["total_srs"] += len(srs)
        totals["srs_with_images"] += c_img
        totals["approved"] += c_ok
        if status == "submitted":
            totals["zones_submitted"] += 1
        elif status in BLOCKING_ZONE_STATES:
            totals["zones_in_progress"] += 1
            in_progress.append(f"{z.name} ({z.code}) is {'returned to the AMO' if status == 'returned' else 'still in draft'}")
        else:
            totals["zones_not_started"] += 1
            not_started.append(f"{z.name} ({z.code})")
        out_zones.append({"zone": {"code": z.code, "name": z.name}, "amo_username": amo_users.get(z.code),
                          "report": zone_report_json(zr), "meeting_images": meeting_imgs.get(z.code, []),
                          "srs": srs, "counts": {"total_srs": len(srs), "with_images": c_img, "approved": c_ok}})
    totals["pending"] = pending_srs

    if not t_submitted:
        if not tso_imgs:
            blockers.append("Upload at least one TSO photo")
        if pending_srs:
            blockers.append(f"Approve all SRs of submitted zones ({pending_srs} pending)")
        blockers.extend(f"{s}: the AMO must submit it" for s in in_progress)
        if not _date_open(d):
            blockers.append("This date is closed for editing")

    return {
        "date": d.isoformat(), "editable_dates": editable_dates(), "can_edit": can_edit,
        "lock_reason": "Territory already submitted" if t_submitted else ("" if can_edit else "This date is closed for editing"),
        "territory": {"code": t.code, "name": t.name, "division": t.division, "wing": t.wing},
        "territory_report": {"status": tr.status if tr else "open", "tso_remarks": tr.tso_remarks if tr else "",
                             "submitted_at": tr.submitted_at.isoformat() if tr and tr.submitted_at else None,
                             "submitted_by": tr.submitted_by if tr else None},
        "tso_images": tso_imgs, "zones": out_zones, "totals": totals,
        "can_submit": can_edit and not blockers, "submit_blockers": blockers,
        "not_started_zones": not_started,
    }


# ---------------- endpoints ----------------
@router.get("/report")
def get_report(date: str | None = None, user: User = Depends(require_role("tso")), db: Session = Depends(get_db)):
    return _build_report(db, parse_date(date), _territory_code(user))


@router.put("/sr")
def update_sr(body: SRAction, user: User = Depends(require_role("tso")), db: Session = Depends(get_db)):
    tc = _territory_code(user)
    d = parse_date(body.date)
    if body.action not in ("approve", "unapprove", "remarks"):
        raise HTTPException(400, "action must be approve, unapprove or remarks")
    assert_tso_can_edit(db, d, tc)
    _own_zone(db, body.zone_code, tc)
    _submitted_zone_report(db, d, body.zone_code)
    e = get_sr_entry(db, d, body.zone_code, body.sr_id, create=True)
    if body.tso_remarks is not None:
        e.tso_remarks = body.tso_remarks.strip()
    if body.action == "approve":
        e.tso_status, e.tso_at = "approved", _now()
    elif body.action == "unapprove":
        e.tso_status, e.tso_at = "pending", None
    audit(db, user, f"tso_sr_{body.action}", f"{d} zone={body.zone_code} sr={body.sr_id}")
    db.commit()
    return {"entry": sr_entry_json(e), "counts": _zone_counts(db, d, body.zone_code)}


@router.post("/zone/approve-all")
def approve_all(body: ZoneIn, user: User = Depends(require_role("tso")), db: Session = Depends(get_db)):
    tc = _territory_code(user)
    d = parse_date(body.date)
    assert_tso_can_edit(db, d, tc)
    _own_zone(db, body.zone_code, tc)
    _submitted_zone_report(db, d, body.zone_code)
    now, n = _now(), 0
    for a, _ in _zone_assignments(db, body.zone_code):
        e = get_sr_entry(db, d, body.zone_code, a.sr_id, create=True)
        if e.tso_status != "approved":
            e.tso_status, e.tso_at = "approved", now
            n += 1
    audit(db, user, "tso_approve_all", f"{d} zone={body.zone_code} n={n}")
    db.commit()
    return {"approved": n, "counts": _zone_counts(db, d, body.zone_code)}


@router.post("/zone/return")
def return_zone(body: ZoneReturnIn, user: User = Depends(require_role("tso")), db: Session = Depends(get_db)):
    tc = _territory_code(user)
    d = parse_date(body.date)
    remarks = body.remarks.strip()
    if not remarks:
        raise HTTPException(400, "Please write why the report is returned")
    assert_tso_can_edit(db, d, tc)
    _own_zone(db, body.zone_code, tc)
    zr = _submitted_zone_report(db, d, body.zone_code)
    zr.status, zr.returned_remarks = "returned", remarks
    audit(db, user, "tso_return_zone", f"{d} zone={body.zone_code}: {remarks}")
    db.commit()
    return {"ok": True, "report": zone_report_json(zr)}


@router.put("/remarks")
def save_remarks(body: RemarksIn, user: User = Depends(require_role("tso")), db: Session = Depends(get_db)):
    tc = _territory_code(user)
    d = parse_date(body.date)
    assert_tso_can_edit(db, d, tc)
    tr = get_territory_report(db, d, tc, create=True)
    tr.tso_remarks = body.tso_remarks.strip()
    db.commit()
    return {"ok": True, "tso_remarks": tr.tso_remarks}


@router.post("/submit")
def submit(body: SubmitIn, user: User = Depends(require_role("tso")), db: Session = Depends(get_db)):
    tc = _territory_code(user)
    d = parse_date(body.date)
    assert_tso_can_edit(db, d, tc)
    rep = _build_report(db, d, tc)
    if rep["submit_blockers"]:
        raise HTTPException(400, "Cannot submit yet: " + "; ".join(rep["submit_blockers"]))
    if rep["not_started_zones"] and not body.confirm_not_started:
        raise HTTPException(409, f"{len(rep['not_started_zones'])} AMO(s) have not submitted; confirm to continue")
    tr = get_territory_report(db, d, tc, create=True)
    tr.status, tr.submitted_at, tr.submitted_by = "submitted", _now(), user.username
    audit(db, user, "tso_submit", f"{d} territory={tc} not_started={len(rep['not_started_zones'])}")
    db.commit()
    return {"ok": True, "territory_report": {"status": tr.status, "tso_remarks": tr.tso_remarks,
                                             "submitted_at": tr.submitted_at.isoformat(), "submitted_by": tr.submitted_by}}
