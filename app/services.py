"""Shared business helpers used by all portals."""
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .models import SR, Assignment, Image, SREntry, Territory, TerritoryReport, Zone, ZoneReport

TZ = ZoneInfo(settings.TIMEZONE)


def today() -> date:
    return datetime.now(TZ).date()


def parse_date(s: str | None, default_today=True) -> date:
    if not s:
        if default_today:
            return today()
        raise HTTPException(400, "date is required")
    try:
        return date.fromisoformat(s)
    except ValueError:
        raise HTTPException(400, "Invalid date, expected YYYY-MM-DD")


def ensure_editable_date(d: date):
    """AMO/TSO may only work on today or up to ALLOW_BACKDATE_DAYS back; never the future."""
    t = today()
    ensure_viewable_date(d)
    if d > t:
        raise HTTPException(400, "Cannot submit for a future date")
    if d < t - timedelta(days=settings.ALLOW_BACKDATE_DAYS):
        raise HTTPException(400, f"Reports older than {settings.ALLOW_BACKDATE_DAYS} day(s) are closed")


def editable_dates() -> list[str]:
    t = today()
    n = min(settings.ALLOW_BACKDATE_DAYS + 1, max(settings.RETENTION_DAYS, 1))
    return [(t - timedelta(days=i)).isoformat() for i in range(n)]


def retention_start() -> date:
    """Oldest date still viewable (today - RETENTION_DAYS + 1)."""
    return today() - timedelta(days=max(settings.RETENTION_DAYS, 1) - 1)


def viewable_dates() -> list[str]:
    """Dates that can be viewed/checked/exported (newest first)."""
    t = today()
    return [(t - timedelta(days=i)).isoformat() for i in range(max(settings.RETENTION_DAYS, 1))]


def ensure_viewable_date(d: date):
    """Only the last RETENTION_DAYS days of data & photos are available."""
    if d > today():
        raise HTTPException(400, "Date is in the future")
    if d < retention_start():
        raise HTTPException(410, f"Only the last {settings.RETENTION_DAYS} days are available; older photos are deleted")


# ---- get-or-create helpers ----
def get_zone_report(db: Session, d: date, zone_code: int, create=False) -> ZoneReport | None:
    zr = db.scalar(select(ZoneReport).where(ZoneReport.report_date == d, ZoneReport.zone_code == zone_code))
    if zr is None and create:
        z = db.get(Zone, zone_code)
        zr = ZoneReport(report_date=d, zone_code=zone_code, territory_code=z.territory_code)
        db.add(zr)
        db.flush()
    return zr


def get_territory_report(db: Session, d: date, territory_code: int, create=False) -> TerritoryReport | None:
    tr = db.scalar(select(TerritoryReport).where(TerritoryReport.report_date == d,
                                                 TerritoryReport.territory_code == territory_code))
    if tr is None and create:
        tr = TerritoryReport(report_date=d, territory_code=territory_code)
        db.add(tr)
        db.flush()
    return tr


def get_sr_entry(db: Session, d: date, zone_code: int, sr_id: str, create=False) -> SREntry | None:
    e = db.scalar(select(SREntry).where(SREntry.report_date == d, SREntry.zone_code == zone_code,
                                        SREntry.sr_id == sr_id))
    if e is None and create:
        a = db.scalar(select(Assignment).where(Assignment.zone_code == zone_code, Assignment.sr_id == sr_id))
        if not a:
            raise HTTPException(404, "SR is not assigned to this zone")
        e = SREntry(report_date=d, zone_code=zone_code, sr_id=sr_id, territory_code=a.territory_code)
        db.add(e)
        db.flush()
    return e


def territory_submitted(db: Session, d: date, territory_code: int) -> bool:
    tr = get_territory_report(db, d, territory_code)
    return bool(tr and tr.status == "submitted")


def amo_can_edit(db: Session, d: date, zone_code: int) -> tuple[bool, str]:
    """AMO can edit while their zone report is draft/returned and the TSO has not submitted the territory."""
    z = db.get(Zone, zone_code)
    if territory_submitted(db, d, z.territory_code):
        return False, "Territory already submitted by TSO"
    zr = get_zone_report(db, d, zone_code)
    if zr and zr.status == "submitted":
        return False, "Already submitted to TSO"
    return True, ""


def assert_amo_can_edit(db: Session, d: date, zone_code: int):
    ensure_editable_date(d)
    ok, why = amo_can_edit(db, d, zone_code)
    if not ok:
        raise HTTPException(409, why)


def assert_tso_can_edit(db: Session, d: date, territory_code: int):
    ensure_editable_date(d)
    if territory_submitted(db, d, territory_code):
        raise HTTPException(409, "Territory already submitted")


# ---- serialisation ----
def image_json(img: Image) -> dict:
    return {
        "id": img.id, "kind": img.kind, "sr_id": img.sr_id, "zone_code": img.zone_code,
        "url": f"/api/images/{img.id}/full", "thumb_url": f"/api/images/{img.id}/thumb",
        "width": img.width, "height": img.height, "size_bytes": img.size_bytes,
        "original_name": img.original_name, "taken_at": img.taken_at,
        "duplicate": img.duplicate_of_id is not None, "duplicate_of_id": img.duplicate_of_id,
        "old_photo": img.old_photo, "uploaded_by": img.uploaded_by,
        "created_at": img.created_at.isoformat() if img.created_at else None,
    }


def images_for(db: Session, d: date, *, territory_code=None, zone_code=None, kind=None) -> list[Image]:
    q = select(Image).where(Image.report_date == d)
    if territory_code is not None:
        q = q.where(Image.territory_code == territory_code)
    if zone_code is not None:
        q = q.where(Image.zone_code == zone_code)
    if kind is not None:
        q = q.where(Image.kind == kind)
    return list(db.scalars(q.order_by(Image.id)))


def zone_srs(db: Session, zone_code: int):
    """[(Assignment, SR)] for a zone ordered by SR id."""
    return list(db.execute(select(Assignment, SR).join(SR, SR.id == Assignment.sr_id)
                           .where(Assignment.zone_code == zone_code).order_by(Assignment.sr_id)))


def zone_report_json(zr: ZoneReport | None) -> dict:
    if not zr:
        return {"status": "not_started", "location": "", "meeting_held": None, "meeting_time": "",
                "not_held_reason": "", "sr_present_count": None, "vacancy_remarks": "", "submitted_at": None,
                "returned_remarks": "", "checker_meeting_valid": None, "checker_by": None}
    return {"status": zr.status, "location": zr.location, "meeting_held": zr.meeting_held,
            "meeting_time": zr.meeting_time, "not_held_reason": zr.not_held_reason,
            "sr_present_count": zr.sr_present_count, "vacancy_remarks": zr.vacancy_remarks,
            "submitted_at": zr.submitted_at.isoformat() if zr.submitted_at else None,
            "returned_remarks": zr.returned_remarks, "checker_meeting_valid": zr.checker_meeting_valid,
            "checker_by": zr.checker_by}


def sr_entry_json(e: SREntry | None) -> dict:
    if not e:
        return {"amo_remarks": "", "tso_status": "pending", "tso_remarks": "", "checked": False,
                "checker_valid": None, "checker_remarks": "", "checked_by": None, "checked_at": None}
    return {"amo_remarks": e.amo_remarks, "tso_status": e.tso_status, "tso_remarks": e.tso_remarks,
            "checked": e.checked, "checker_valid": e.checker_valid, "checker_remarks": e.checker_remarks,
            "checked_by": e.checked_by, "checked_at": e.checked_at.isoformat() if e.checked_at else None}


def hierarchy_json(db: Session) -> dict:
    """{wings:[{name, divisions:[{name, territories:[{code,name}]}]}]} for filter dropdowns."""
    out: dict = {}
    for t in db.scalars(select(Territory).order_by(Territory.wing, Territory.division, Territory.name)):
        out.setdefault(t.wing, {}).setdefault(t.division, []).append({"code": t.code, "name": t.name})
    return {"wings": [{"name": w, "divisions": [{"name": dv, "territories": ts} for dv, ts in divs.items()]}
                      for w, divs in out.items()]}
