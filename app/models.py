from datetime import date, datetime, timezone

from sqlalchemy import (Boolean, Date, DateTime, ForeignKey, Integer, String, Text,
                        UniqueConstraint, Index)
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def utcnow():
    return datetime.now(timezone.utc)


# ---------------- Hierarchy (seeded from the Excel) ----------------
class Territory(Base):
    __tablename__ = "territories"
    code: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    division: Mapped[str] = mapped_column(String(120), index=True)
    wing: Mapped[str] = mapped_column(String(120), index=True)


class Zone(Base):
    """An AMO area (Zone Code + AMO name in the Excel). Belongs to exactly one territory."""
    __tablename__ = "zones"
    code: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    territory_code: Mapped[int] = mapped_column(ForeignKey("territories.code"), index=True)


class SR(Base):
    __tablename__ = "srs"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    name: Mapped[str] = mapped_column(String(160))


class Route(Base):
    __tablename__ = "routes"
    code: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(160))
    sr_id: Mapped[str] = mapped_column(ForeignKey("srs.id"), index=True)
    zone_code: Mapped[int] = mapped_column(ForeignKey("zones.code"), index=True)


class Assignment(Base):
    """Distinct (zone, SR) pair = one SR that an AMO is responsible for. This is the unit
    that gets images uploaded / approved / checked and the unit counted as 'SR' on the dashboard."""
    __tablename__ = "assignments"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    zone_code: Mapped[int] = mapped_column(ForeignKey("zones.code"), index=True)
    sr_id: Mapped[str] = mapped_column(ForeignKey("srs.id"), index=True)
    territory_code: Mapped[int] = mapped_column(ForeignKey("territories.code"), index=True)
    route_codes: Mapped[str] = mapped_column(Text, default="")   # "10001, 10002"
    route_names: Mapped[str] = mapped_column(Text, default="")   # "Agrabad, Motiharpol"
    __table_args__ = (UniqueConstraint("zone_code", "sr_id", name="uq_assignment"),)


# ---------------- Users ----------------
class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(60), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(100))
    role: Mapped[str] = mapped_column(String(20), index=True)  # amo | tso | checker | admin
    display_name: Mapped[str] = mapped_column(String(160), default="")
    zone_code: Mapped[int | None] = mapped_column(ForeignKey("zones.code"), nullable=True)
    territory_code: Mapped[int | None] = mapped_column(ForeignKey("territories.code"), nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    session_version: Mapped[int] = mapped_column(Integer, default=1)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


# ---------------- Daily reports ----------------
class ZoneReport(Base):
    """AMO's daily pre-plan meeting report for their zone."""
    __tablename__ = "zone_reports"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    report_date: Mapped[date] = mapped_column(Date, index=True)
    zone_code: Mapped[int] = mapped_column(ForeignKey("zones.code"), index=True)
    territory_code: Mapped[int] = mapped_column(ForeignKey("territories.code"), index=True)
    location: Mapped[str] = mapped_column(String(255), default="")
    meeting_held: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    meeting_time: Mapped[str] = mapped_column(String(10), default="")       # "HH:MM"
    not_held_reason: Mapped[str] = mapped_column(Text, default="")
    sr_present_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    vacancy_remarks: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(20), default="draft")  # draft | submitted | returned
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    returned_remarks: Mapped[str] = mapped_column(Text, default="")  # TSO note when sending back
    # check-back team
    checker_meeting_valid: Mapped[str | None] = mapped_column(String(3), nullable=True)  # yes | no
    checker_by: Mapped[str | None] = mapped_column(String(60), nullable=True)
    checker_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    __table_args__ = (UniqueConstraint("report_date", "zone_code", name="uq_zone_report"),)


class SREntry(Base):
    """Per SR per day: AMO remarks, TSO approval, checker result. Images link via Image.sr_id."""
    __tablename__ = "sr_entries"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    report_date: Mapped[date] = mapped_column(Date, index=True)
    zone_code: Mapped[int] = mapped_column(ForeignKey("zones.code"), index=True)
    sr_id: Mapped[str] = mapped_column(ForeignKey("srs.id"))
    territory_code: Mapped[int] = mapped_column(ForeignKey("territories.code"), index=True)
    amo_remarks: Mapped[str] = mapped_column(Text, default="")
    tso_status: Mapped[str] = mapped_column(String(20), default="pending")  # pending | approved
    tso_remarks: Mapped[str] = mapped_column(Text, default="")
    tso_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    checked: Mapped[bool] = mapped_column(Boolean, default=False)
    checker_valid: Mapped[str | None] = mapped_column(String(3), nullable=True)  # yes | no (correct photos?)
    checker_remarks: Mapped[str] = mapped_column(Text, default="")
    checked_by: Mapped[str | None] = mapped_column(String(60), nullable=True)
    checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    __table_args__ = (UniqueConstraint("report_date", "zone_code", "sr_id", name="uq_sr_entry"),)


class TerritoryReport(Base):
    """TSO's daily review + final submission of the territory to the checker (mother) portal."""
    __tablename__ = "territory_reports"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    report_date: Mapped[date] = mapped_column(Date, index=True)
    territory_code: Mapped[int] = mapped_column(ForeignKey("territories.code"), index=True)
    status: Mapped[str] = mapped_column(String(20), default="open")  # open | submitted
    tso_remarks: Mapped[str] = mapped_column(Text, default="")
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    submitted_by: Mapped[str | None] = mapped_column(String(60), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    __table_args__ = (UniqueConstraint("report_date", "territory_code", name="uq_territory_report"),)


class Image(Base):
    __tablename__ = "images"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    report_date: Mapped[date] = mapped_column(Date, index=True)
    kind: Mapped[str] = mapped_column(String(10))  # meeting (AMO meeting photo) | sr (SR outlet plan) | tso (TSO photo)
    territory_code: Mapped[int] = mapped_column(ForeignKey("territories.code"), index=True)
    zone_code: Mapped[int | None] = mapped_column(ForeignKey("zones.code"), nullable=True, index=True)
    sr_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    blob_key: Mapped[str] = mapped_column(String(255))
    thumb_key: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(60), default="image/jpeg")
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    width: Mapped[int] = mapped_column(Integer, default=0)
    height: Mapped[int] = mapped_column(Integer, default=0)
    sha256: Mapped[str] = mapped_column(String(64), index=True)        # of stored (processed) bytes
    orig_sha256: Mapped[str] = mapped_column(String(64), default="", index=True)  # of the original file (client-computed)
    original_name: Mapped[str] = mapped_column(String(255), default="")
    taken_at: Mapped[str] = mapped_column(String(25), default="")      # EXIF DateTimeOriginal "YYYY-MM-DD HH:MM:SS" if known
    duplicate_of_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    old_photo: Mapped[bool] = mapped_column(Boolean, default=False)
    uploaded_by: Mapped[str] = mapped_column(String(60))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    __table_args__ = (Index("ix_images_scope", "report_date", "zone_code", "sr_id"),)


class AuditLog(Base):
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    username: Mapped[str] = mapped_column(String(60))
    action: Mapped[str] = mapped_column(String(60))
    detail: Mapped[str] = mapped_column(Text, default="")
