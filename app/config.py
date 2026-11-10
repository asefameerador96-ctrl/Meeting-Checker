import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def _bool(v, default=False):
    if v is None:
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on")


class Settings:
    # Database: SQLite for local dev, PostgreSQL on Azure (postgresql+psycopg://user:pass@host:5432/db?sslmode=require)
    DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{BASE_DIR / 'data' / 'app.db'}")
    SECRET_KEY = os.getenv("SECRET_KEY", "dev-insecure-secret-change-me")
    # Image storage: "local" (./data/uploads) or "azure" (Blob Storage)
    STORAGE_BACKEND = os.getenv("STORAGE_BACKEND", "local")
    LOCAL_UPLOAD_DIR = Path(os.getenv("LOCAL_UPLOAD_DIR", str(BASE_DIR / "data" / "uploads")))
    AZURE_STORAGE_CONNECTION_STRING = os.getenv("AZURE_STORAGE_CONNECTION_STRING", "")
    AZURE_STORAGE_CONTAINER = os.getenv("AZURE_STORAGE_CONTAINER", "meeting-images")
    TIMEZONE = os.getenv("APP_TIMEZONE", "Asia/Dhaka")
    # How many days back an AMO/TSO may still create/edit a report (0 = today only)
    ALLOW_BACKDATE_DAYS = int(os.getenv("ALLOW_BACKDATE_DAYS", "1"))
    MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "15"))
    MAX_IMAGES_PER_SR = int(os.getenv("MAX_IMAGES_PER_SR", "6"))
    # Photos whose EXIF capture time is older than this many days before the report date are flagged
    OLD_PHOTO_DAYS = int(os.getenv("OLD_PHOTO_DAYS", "2"))
    # Data/photo retention window: only the last N days (today included) can be viewed/checked;
    # photos older than that are deleted automatically (app purge job + Blob lifecycle rule).
    RETENTION_DAYS = int(os.getenv("RETENTION_DAYS", "3"))
    PURGE_INTERVAL_MINUTES = int(os.getenv("PURGE_INTERVAL_MINUTES", "60"))
    DB_POOL_SIZE = int(os.getenv("DB_POOL_SIZE", "5"))
    DB_MAX_OVERFLOW = int(os.getenv("DB_MAX_OVERFLOW", "5"))
    COOKIE_SECURE = _bool(os.getenv("COOKIE_SECURE"), default=False)
    SEED_ON_STARTUP = _bool(os.getenv("SEED_ON_STARTUP"), default=True)
    SESSION_MAX_AGE = int(os.getenv("SESSION_MAX_AGE", str(14 * 24 * 3600)))


settings = Settings()
