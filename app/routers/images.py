"""Shared image upload / view / delete for all roles.

POST /api/images  (multipart/form-data)
  file        : the image (jpeg/png/webp/heic-converted-by-browser)
  kind        : "meeting" (AMO meeting photo) | "sr" (AMO outlet-plan photo for an SR) | "tso" (TSO photo)
  date        : YYYY-MM-DD
  sr_id       : required for kind=sr
  orig_sha256 : optional hex sha256 of the original file (client computed, for re-use detection)
  taken_at    : optional EXIF DateTimeOriginal "YYYY-MM-DD HH:MM:SS"
AMO zone / TSO territory are taken from the logged-in user, never from the request.
"""
import hashlib
import io
import uuid
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from PIL import Image as PILImage, ImageOps
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..auth import audit, current_user, require_role
from ..config import settings
from ..db import get_db
from ..models import Assignment, Image, User, Zone
from ..services import (assert_amo_can_edit, assert_tso_can_edit, get_sr_entry, get_zone_report, image_json,
                        parse_date)
from ..storage import get_storage

router = APIRouter(prefix="/api/images", tags=["images"])

try:  # optional HEIC support
    from pillow_heif import register_heif_opener  # type: ignore
    register_heif_opener()
except Exception:
    pass

PILImage.MAX_IMAGE_PIXELS = 80_000_000


def _process(data: bytes):
    try:
        im = PILImage.open(io.BytesIO(data))
        exif_dt = ""
        try:
            ex = im.getexif()
            raw = ex.get_ifd(0x8769).get(36867) or ex.get(306)  # DateTimeOriginal / DateTime
            if raw:
                exif_dt = str(raw).replace(":", "-", 2)[:19]
        except Exception:
            pass
        im = ImageOps.exif_transpose(im)
        im = im.convert("RGB")
    except Exception:
        raise HTTPException(400, "File is not a valid image")
    full = im.copy()
    full.thumbnail((2000, 2000))
    b1 = io.BytesIO()
    full.save(b1, "JPEG", quality=85, optimize=True)
    thumb = im.copy()
    thumb.thumbnail((400, 400))
    b2 = io.BytesIO()
    thumb.save(b2, "JPEG", quality=78)
    return b1.getvalue(), b2.getvalue(), full.width, full.height, exif_dt


@router.post("")
async def upload_image(file: UploadFile = File(...), kind: str = Form(...), date: str = Form(...),
                       sr_id: str = Form(""), orig_sha256: str = Form(""), taken_at: str = Form(""),
                       user: User = Depends(require_role("amo", "tso")), db: Session = Depends(get_db)):
    d = parse_date(date)
    zone_code = None
    if user.role == "amo":
        if kind not in ("meeting", "sr"):
            raise HTTPException(400, "AMO can upload kind=meeting or kind=sr")
        zone_code = user.zone_code
        assert_amo_can_edit(db, d, zone_code)
        territory_code = db.get(Zone, zone_code).territory_code
        if kind == "sr":
            if not sr_id or not db.scalar(select(Assignment.id).where(Assignment.zone_code == zone_code,
                                                                       Assignment.sr_id == sr_id)):
                raise HTTPException(400, "SR is not assigned to your zone")
            n = db.scalar(select(func.count()).select_from(Image).where(
                Image.report_date == d, Image.zone_code == zone_code, Image.sr_id == sr_id, Image.kind == "sr"))
            if n >= settings.MAX_IMAGES_PER_SR:
                raise HTTPException(400, f"Maximum {settings.MAX_IMAGES_PER_SR} images per SR")
        else:
            sr_id = ""
    else:
        if kind != "tso":
            raise HTTPException(400, "TSO can upload kind=tso only")
        territory_code = user.territory_code
        assert_tso_can_edit(db, d, territory_code)
        sr_id = ""
        n = db.scalar(select(func.count()).select_from(Image).where(
            Image.report_date == d, Image.territory_code == territory_code, Image.kind == "tso"))
        if n >= 10:
            raise HTTPException(400, "Maximum 10 TSO images")

    data = await file.read(settings.MAX_UPLOAD_MB * 1024 * 1024 + 1)
    if len(data) > settings.MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, f"Image larger than {settings.MAX_UPLOAD_MB} MB")
    if not data:
        raise HTTPException(400, "Empty file")
    full, thumb, w, h, exif_dt = _process(data)
    sha = hashlib.sha256(full).hexdigest()
    osha = (orig_sha256 or "").strip().lower()[:64]
    if not osha or len(osha) != 64 or any(c not in "0123456789abcdef" for c in osha):
        osha = hashlib.sha256(data).hexdigest()
    taken = (taken_at or exif_dt or "").strip()[:19]

    # re-use detection: same file seen before anywhere in the system
    dup = db.scalar(select(Image.id).where(or_(Image.sha256 == sha, Image.orig_sha256 == osha)).order_by(Image.id))
    old = False
    if taken:
        try:
            tk = datetime.fromisoformat(taken.replace(" ", "T")).date()
            old = tk < d - timedelta(days=settings.OLD_PHOTO_DAYS)
        except ValueError:
            taken = ""

    key = f"{d.isoformat()}/{territory_code}/{zone_code or 'tso'}/{uuid.uuid4().hex}"
    st = get_storage()
    st.put(key + ".jpg", full, "image/jpeg")
    st.put(key + "_t.jpg", thumb, "image/jpeg")
    img = Image(report_date=d, kind=kind, territory_code=territory_code, zone_code=zone_code,
                sr_id=sr_id or None, blob_key=key + ".jpg", thumb_key=key + "_t.jpg", size_bytes=len(full),
                width=w, height=h, sha256=sha, orig_sha256=osha, original_name=(file.filename or "")[:255],
                taken_at=taken, duplicate_of_id=dup, old_photo=old, uploaded_by=user.username)
    db.add(img)
    if user.role == "amo":
        get_zone_report(db, d, zone_code, create=True)
        if kind == "sr":
            e = get_sr_entry(db, d, zone_code, sr_id, create=True)
            e.tso_status = "pending"  # new evidence must be re-approved
    audit(db, user, "image_upload", f"{kind} {d} sr={sr_id} key={key}")
    db.commit()
    return image_json(img)


def _can_view(user: User, img: Image) -> bool:
    if user.role in ("checker", "admin"):
        return True
    if user.role == "amo":
        return img.zone_code == user.zone_code
    if user.role == "tso":
        return img.territory_code == user.territory_code
    return False


@router.get("/{image_id}/{variant}")
def view_image(image_id: int, variant: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    img = db.get(Image, image_id)
    if not img or not _can_view(user, img) or variant not in ("full", "thumb"):
        raise HTTPException(404, "Not found")
    return get_storage().response(img.blob_key if variant == "full" else img.thumb_key, "image/jpeg")


@router.delete("/{image_id}")
def delete_image(image_id: int, user: User = Depends(require_role("amo", "tso")), db: Session = Depends(get_db)):
    img = db.get(Image, image_id)
    if not img or not _can_view(user, img):
        raise HTTPException(404, "Not found")
    if user.role == "amo":
        if img.kind not in ("meeting", "sr"):
            raise HTTPException(403, "Not your image")
        assert_amo_can_edit(db, img.report_date, user.zone_code)
        if img.kind == "sr":
            e = get_sr_entry(db, img.report_date, img.zone_code, img.sr_id)
            if e:
                e.tso_status = "pending"
    else:
        if img.kind != "tso":
            raise HTTPException(403, "TSO can delete only TSO images")
        assert_tso_can_edit(db, img.report_date, user.territory_code)
    st = get_storage()
    st.delete(img.blob_key)
    st.delete(img.thumb_key)
    audit(db, user, "image_delete", f"id={img.id} {img.kind} {img.report_date}")
    db.delete(img)
    db.commit()
    return {"ok": True}
