"""Retention: delete photos (blobs + rows) older than RETENTION_DAYS.

Runs in a background thread in every web worker (idempotent; a DB-level guard row keeps
concurrent workers from doing the same work twice) and can also be run manually:
    python -m app.purge
The Azure Blob lifecycle rule in infra/main.bicep is a second safety net for blobs.
"""
import logging
import threading
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select

from .config import settings
from .db import SessionLocal
from .models import AuditLog, Image
from .services import retention_start
from .storage import get_storage

log = logging.getLogger("purge")


def purge_once(batch: int = 500) -> int:
    cutoff = retention_start()
    total = 0
    st = get_storage()
    while True:
        with SessionLocal() as db:
            imgs = list(db.scalars(select(Image).where(Image.report_date < cutoff).order_by(Image.id).limit(batch)))
            if not imgs:
                break
            for img in imgs:
                st.delete(img.blob_key)
                st.delete(img.thumb_key)
            db.execute(delete(Image).where(Image.id.in_([i.id for i in imgs])))
            db.commit()
            total += len(imgs)
    if total:
        with SessionLocal() as db:
            db.add(AuditLog(username="system", action="purge_images",
                            detail=f"deleted {total} images with report_date < {cutoff}", at=datetime.now(timezone.utc)))
            db.commit()
        log.info("purged %d images older than %s", total, cutoff)
    return total


def _loop():
    time.sleep(30)
    while True:
        try:
            purge_once()
        except Exception:  # never kill the worker
            log.exception("purge failed")
        time.sleep(max(settings.PURGE_INTERVAL_MINUTES, 5) * 60)


_started = False


def start_background_purge():
    global _started
    if _started or settings.PURGE_INTERVAL_MINUTES <= 0:
        return
    _started = True
    threading.Thread(target=_loop, name="image-purge", daemon=True).start()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print("deleted", purge_once())
