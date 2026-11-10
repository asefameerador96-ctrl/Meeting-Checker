"""AMO portal API (see docs/SPEC.md section A).

The AMO's zone is always taken from the logged-in user (``user.zone_code``), never from the request.
"""
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import audit, require_role
from ..db import get_db
from ..models import SREntry, Territory, User, Zone
from ..services import (amo_can_edit, assert_amo_can_edit, editable_dates, ensure_editable_date, ensure_viewable_date, get_sr_entry,
                        get_territory_report, get_zone_report, image_json, images_for, parse_date, zone_report_json,
                        zone_srs, sr_entry_json)

router = APIRouter(prefix="/api/amo", tags=["amo"])

TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
MAX_REMARK = 2000


def _zone(db: Session, user: User) -> tuple[Zone, Territory]:
    if not user.zone_code:
        raise HTTPException(403, "Your account is not linked to a zone")
    z = db.get(Zone, user.zone_code)
    if not z:
        raise HTTPException(404, "Zone not found")
    return z, db.get(Territory, z.territory_code)


def _clean(s: str | None, limit: int) -> str:
    return (s or "").strip()[:limit]


# ------------------------------------------------------------------ read
@router.get("/report")
def get_report(date: str | None = Query(None), user: User = Depends(require_role("amo")),
               db: Session = Depends(get_db)):
    d = parse_date(date)
    ensure_viewable_date(d)  # SPEC E: only the retention window is viewable, never the future
    z, t = _zone(db, user)
    zr = get_zone_report(db, d, z.code)
    tr = get_territory_report(db, d, t.code)
    territory_status = tr.status if tr else "open"

    dates = editable_dates()
    if d.isoformat() not in dates:
        can_edit, lock_reason = False, "This date is closed for editing"
    else:
        can_edit, lock_reason = amo_can_edit(db, d, z.code)

    images = images_for(db, d, zone_code=z.code)
    meeting_images = [image_json(i) for i in images if i.kind == "meeting"]
    by_sr: dict[str, list] = {}
    for i in images:
        if i.kind == "sr" and i.sr_id:
            by_sr.setdefault(i.sr_id, []).append(image_json(i))
    entries = {e.sr_id: e for e in db.scalars(select(SREntry).where(SREntry.report_date == d,
                                                                    SREntry.zone_code == z.code))}
    srs = []
    for a, sr in zone_srs(db, z.code):
        imgs = by_sr.get(sr.id, [])
        srs.append({"sr_id": sr.id, "sr_name": sr.name, "route_codes": a.route_codes, "route_names": a.route_names,
                    "entry": sr_entry_json(entries.get(sr.id)), "images": imgs})

    return {
        "date": d.isoformat(), "editable_dates": dates, "can_edit": can_edit, "lock_reason": lock_reason,
        "zone": {"code": z.code, "name": z.name},
        "territory": {"code": t.code, "name": t.name, "division": t.division, "wing": t.wing},
        "report": zone_report_json(zr), "territory_status": territory_status,
        "meeting_images": meeting_images, "srs": srs,
        "summary": {"total_srs": len(srs), "srs_with_images": sum(1 for s in srs if s["images"]),
                    "images_total": sum(len(s["images"]) for s in srs)},
    }


# ------------------------------------------------------------------ meeting draft
class MeetingIn(BaseModel):
    date: str
    location: str | None = None
    meeting_held: bool | None = None
    meeting_time: str | None = None
    not_held_reason: str | None = None
    sr_present_count: int | None = Field(None, ge=0, le=999)
    vacancy_remarks: str | None = None


@router.put("/report")
def save_report(body: MeetingIn, user: User = Depends(require_role("amo")), db: Session = Depends(get_db)):
    d = parse_date(body.date)
    z, _ = _zone(db, user)
    assert_amo_can_edit(db, d, z.code)
    sent = body.model_fields_set
    t = (body.meeting_time or "").strip()
    if "meeting_time" in sent and t and not TIME_RE.match(t):
        raise HTTPException(400, "Meeting time must be HH:MM (24h)")

    zr = get_zone_report(db, d, z.code, create=True)
    if "location" in sent:
        zr.location = _clean(body.location, 255)
    if "meeting_held" in sent:
        zr.meeting_held = body.meeting_held
    if "meeting_time" in sent:
        zr.meeting_time = t
    if "not_held_reason" in sent:
        zr.not_held_reason = _clean(body.not_held_reason, MAX_REMARK)
    if "sr_present_count" in sent:
        zr.sr_present_count = body.sr_present_count
    if "vacancy_remarks" in sent:
        zr.vacancy_remarks = _clean(body.vacancy_remarks, MAX_REMARK)
    db.commit()
    return {"ok": True, "report": zone_report_json(zr)}


# ------------------------------------------------------------------ SR remark
class SRRemarkIn(BaseModel):
    date: str
    amo_remarks: str = Field("", max_length=MAX_REMARK)


@router.put("/sr/{sr_id}")
def save_sr_remark(sr_id: str, body: SRRemarkIn, user: User = Depends(require_role("amo")),
                   db: Session = Depends(get_db)):
    d = parse_date(body.date)
    z, _ = _zone(db, user)
    assert_amo_can_edit(db, d, z.code)
    get_zone_report(db, d, z.code, create=True)
    e = get_sr_entry(db, d, z.code, sr_id, create=True)  # 404 if the SR is not in this zone
    e.amo_remarks = body.amo_remarks.strip()
    db.commit()
    return {"ok": True, "entry": sr_entry_json(e)}


# ------------------------------------------------------------------ submit
class SubmitIn(BaseModel):
    date: str


@router.post("/submit")
def submit(body: SubmitIn, user: User = Depends(require_role("amo")), db: Session = Depends(get_db)):
    d = parse_date(body.date)
    ensure_editable_date(d)
    z, _ = _zone(db, user)
    assert_amo_can_edit(db, d, z.code)
    zr = get_zone_report(db, d, z.code)

    meeting_errors: list[str] = []
    meeting_photos = images_for(db, d, zone_code=z.code, kind="meeting")
    if not zr or zr.meeting_held is None:
        meeting_errors.append("Select whether the pre-plan meeting was held")
    elif zr.meeting_held:
        if not zr.meeting_time:
            meeting_errors.append("Enter the meeting time")
        if not meeting_photos:
            meeting_errors.append("Upload at least one meeting photo")
    elif not (zr.not_held_reason or "").strip():
        meeting_errors.append("Enter the reason the meeting was not held")

    with_images = {i.sr_id for i in images_for(db, d, zone_code=z.code, kind="sr")}
    entries = {e.sr_id: e for e in db.scalars(select(SREntry).where(SREntry.report_date == d,
                                                                    SREntry.zone_code == z.code))}
    assigned = zone_srs(db, z.code)
    missing = [sr.id for _, sr in assigned
               if sr.id not in with_images and not (entries.get(sr.id) and entries[sr.id].amo_remarks.strip())]
    errors = list(meeting_errors)
    if missing:
        errors.append(f"{len(missing)} SR(s) need at least one photo or a remark explaining why not: "
                      + ", ".join(missing))
    if errors:
        return JSONResponse(status_code=400, content={
            "detail": "; ".join(errors), "errors": errors, "meeting_errors": meeting_errors, "missing_srs": missing})

    for a, sr in assigned:
        if sr.id not in entries:
            db.add(SREntry(report_date=d, zone_code=z.code, sr_id=sr.id, territory_code=a.territory_code))
    zr.status = "submitted"
    zr.submitted_at = datetime.now(timezone.utc)
    audit(db, user, "amo_submit", f"{d} zone={z.code} srs={len(assigned)} with_images={len(with_images)}")
    db.commit()
    return {"ok": True, "report": zone_report_json(zr)}
