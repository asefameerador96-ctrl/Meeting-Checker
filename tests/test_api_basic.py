"""Basic API tests: auth, role redirects, CSRF header, zone scoping of images, upload + thumbnail, admin.

Runs against a throw-away SQLite DB + upload dir. The env vars MUST be set before `app` is imported,
because app.config / app.db read them at import time.
"""
import atexit
import io
import os
import shutil
import tempfile

_TMP = tempfile.mkdtemp(prefix="ppp_test_")
atexit.register(shutil.rmtree, _TMP, ignore_errors=True)
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP}/test.db"
os.environ["LOCAL_UPLOAD_DIR"] = f"{_TMP}/uploads"
os.environ["STORAGE_BACKEND"] = "local"
os.environ["COOKIE_SECURE"] = "false"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image as PILImage  # noqa: E402
from sqlalchemy import select  # noqa: E402

from app.auth import hash_password  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Assignment, TerritoryReport, User, Zone  # noqa: E402
from app.seed import run_seed  # noqa: E402
from app.services import today  # noqa: E402

PW = "Test-pass-123"
H = {"X-Requested-With": "fetch"}


@pytest.fixture(scope="module")
def world():
    """Seed the hierarchy and create test users with a known password in two zones of different territories."""
    run_seed()
    with SessionLocal() as db:
        a = db.scalar(select(Assignment).order_by(Assignment.id))
        zone_a = db.get(Zone, a.zone_code)
        zone_b = db.scalar(select(Zone).where(Zone.territory_code != zone_a.territory_code).order_by(Zone.code))
        zone_a_srs = select(Assignment.sr_id).where(Assignment.zone_code == zone_a.code)
        sr_b = db.scalar(select(Assignment.sr_id).where(Assignment.zone_code == zone_b.code,
                                                        Assignment.sr_id.not_in(zone_a_srs)))
        h = hash_password(PW)
        db.add_all([
            User(username="t_amo_a", password_hash=h, role="amo", zone_code=zone_a.code),
            User(username="t_amo_b", password_hash=h, role="amo", zone_code=zone_b.code),
            User(username="t_tso_a", password_hash=h, role="tso", territory_code=zone_a.territory_code),
            User(username="t_checker", password_hash=h, role="checker"),
            User(username="t_admin", password_hash=h, role="admin"),
            User(username="t_victim", password_hash=h, role="checker"),
        ])
        db.commit()
        return {"zone_a": zone_a.code, "sr_a": a.sr_id, "zone_b": zone_b.code, "sr_b": sr_b}


def client_for(username: str | None = None) -> TestClient:
    c = TestClient(app, follow_redirects=False)
    if username:
        r = c.post("/api/login", json={"username": username, "password": PW}, headers=H)
        assert r.status_code == 200, r.text
    return c


def jpeg_bytes(color=(200, 30, 30)) -> bytes:
    buf = io.BytesIO()
    PILImage.new("RGB", (64, 48), color).save(buf, "JPEG")
    return buf.getvalue()


def upload(c: TestClient, sr_id: str, color=(200, 30, 30), source="camera"):
    data = {"kind": "sr", "date": today().isoformat(), "sr_id": sr_id}
    if source is not None:
        data["source"] = source
    return c.post("/api/images", headers=H, data=data,
                  files={"file": ("plan.jpg", jpeg_bytes(color), "image/jpeg")})


# ---------------- auth ----------------
def test_login_logout(world):
    c = TestClient(app, follow_redirects=False)
    r = c.post("/api/login", json={"username": "t_amo_a", "password": "wrong-password"}, headers=H)
    assert r.status_code == 401
    r = c.post("/api/login", json={"username": "T_AMO_A ", "password": PW}, headers=H)
    assert r.status_code == 200 and r.json()["redirect"] == "/amo"
    me = c.get("/api/me").json()
    assert me["username"] == "t_amo_a" and me["role"] == "amo" and me["zone_code"] == world["zone_a"]
    assert c.post("/api/logout", headers=H).status_code == 200
    assert c.get("/api/me").status_code == 401


def test_anonymous_pages_redirect_to_login(world):
    c = client_for()
    for path in ("/", "/amo", "/tso", "/checker", "/admin"):
        r = c.get(path)
        assert r.status_code == 302 and r.headers["location"] == "/login", path


@pytest.mark.parametrize("username,home,allowed", [
    ("t_amo_a", "/amo", {"/amo"}),
    ("t_tso_a", "/tso", {"/tso"}),
    ("t_checker", "/checker", {"/checker"}),
    ("t_admin", "/admin", {"/admin", "/checker"}),
])
def test_role_redirects(world, username, home, allowed):
    c = client_for(username)
    assert c.get("/").headers["location"] == home
    assert c.get("/login").headers["location"] == home
    for path in ("/amo", "/tso", "/checker", "/admin"):
        r = c.get(path)
        if path in allowed:
            assert r.status_code == 200, (username, path)
            assert "text/html" in r.headers["content-type"]
        else:
            assert r.status_code == 302 and r.headers["location"] == home, (username, path)


def test_csrf_header_required_for_mutations(world):
    c = TestClient(app, follow_redirects=False)
    r = c.post("/api/login", json={"username": "t_amo_a", "password": PW})
    assert r.status_code == 403 and "X-Requested-With" in r.json()["detail"]
    c = client_for("t_amo_a")
    r = c.post("/api/logout")
    assert r.status_code == 403
    r = c.post("/api/images", data={"kind": "sr", "date": today().isoformat(), "sr_id": world["sr_a"]},
               files={"file": ("x.jpg", jpeg_bytes(), "image/jpeg")})
    assert r.status_code == 403
    assert c.get("/api/me").status_code == 200  # GET does not need the header


def test_api_role_enforcement(world):
    assert client_for("t_amo_a").get("/api/admin/users").status_code == 403
    assert client_for("t_checker").get("/api/admin/users").status_code == 403
    assert client_for().get("/api/admin/users").status_code == 401


# ---------------- images ----------------
def test_upload_and_thumb(world):
    c = client_for("t_amo_a")
    r = upload(c, world["sr_a"])
    assert r.status_code == 200, r.text
    img = r.json()
    assert img["kind"] == "sr" and img["sr_id"] == world["sr_a"] and img["zone_code"] == world["zone_a"]
    assert img["duplicate"] is False and img["uploaded_by"] == "t_amo_a"
    for url in (img["thumb_url"], img["url"]):
        g = c.get(url)
        assert g.status_code == 200 and g.headers["content-type"] == "image/jpeg"
        assert g.content[:2] == b"\xff\xd8"
    # same territory TSO may view it; a checker only once the TSO has submitted the territory
    assert client_for("t_tso_a").get(img["thumb_url"]).status_code == 200
    chk = client_for("t_checker")
    assert chk.get(img["thumb_url"]).status_code == 404
    with SessionLocal() as db:
        tc = db.get(Zone, world["zone_a"]).territory_code
        tr = TerritoryReport(report_date=today(), territory_code=tc, status="submitted")
        db.add(tr)
        db.commit()
        try:
            assert chk.get(img["thumb_url"]).status_code == 200
        finally:
            db.delete(tr)
            db.commit()
    # re-uploading the identical photo is flagged as re-used
    again = upload(c, world["sr_a"])
    assert again.status_code == 200 and again.json()["duplicate"] is True


def test_camera_only_uploads(world, monkeypatch):
    from app.config import settings
    from app.models import Image
    c = client_for("t_amo_a")
    # no source / gallery-like source is rejected while CAMERA_ONLY (default) is on
    for src in (None, "", "gallery", "file"):
        r = upload(c, world["sr_a"], color=(5, 60, 90), source=src)
        assert r.status_code == 400 and "camera" in r.json()["detail"].lower(), (src, r.text)
    # the capture-input fallback is accepted and the source is stored on the image
    r = upload(c, world["sr_a"], color=(6, 61, 91), source="capture_input")
    assert r.status_code == 200, r.text
    r2 = upload(c, world["sr_a"], color=(7, 62, 92), source="camera")
    assert r2.status_code == 200, r2.text
    with SessionLocal() as db:
        assert db.get(Image, r.json()["id"]).source == "capture_input"
        assert db.get(Image, r2.json()["id"]).source == "camera"
    # with CAMERA_ONLY off, uploads without a source are accepted again (source NULL)
    monkeypatch.setattr(settings, "CAMERA_ONLY", False)
    r3 = upload(c, world["sr_a"], color=(8, 63, 93), source=None)
    assert r3.status_code == 200, r3.text
    with SessionLocal() as db:
        assert db.get(Image, r3.json()["id"]).source is None
    for x in (r, r2, r3):
        assert c.delete(f"/api/images/{x.json()['id']}", headers=H).status_code == 200


def test_migrate_images_source_on_existing_db(world):
    """An existing (production) DB created before images.source existed gets the column added, idempotently."""
    from sqlalchemy import inspect, text
    from app.db import engine
    from app.seed import _migrate_images_source, init_db
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE images DROP COLUMN source"))
    assert "source" not in {c["name"] for c in inspect(engine).get_columns("images")}
    init_db()
    assert "source" in {c["name"] for c in inspect(engine).get_columns("images")}
    _migrate_images_source()  # second run is a no-op
    assert "source" in {c["name"] for c in inspect(engine).get_columns("images")}


def test_amo_cannot_upload_for_foreign_sr(world):
    r = upload(client_for("t_amo_a"), world["sr_b"], color=(1, 2, 3))
    assert r.status_code == 400


def test_amo_cannot_view_other_zone_image(world):
    r = upload(client_for("t_amo_b"), world["sr_b"], color=(10, 120, 240))
    assert r.status_code == 200, r.text
    img = r.json()
    other = client_for("t_amo_a")
    assert other.get(img["thumb_url"]).status_code in (403, 404)
    assert other.get(img["url"]).status_code in (403, 404)
    assert other.delete(f"/api/images/{img['id']}", headers=H).status_code in (403, 404)
    # TSO of another territory cannot see it either
    assert client_for("t_tso_a").get(img["thumb_url"]).status_code in (403, 404)
    assert client_for("t_amo_b").get(img["thumb_url"]).status_code == 200


# ---------------- admin ----------------
def test_admin_list_summary_and_csv(world):
    c = client_for("t_admin")
    d = c.get("/api/admin/users", params={"q": "t_", "role": "checker"}).json()
    names = {u["username"] for u in d["users"]}
    assert {"t_checker", "t_victim"} <= names and all(u["role"] == "checker" for u in d["users"])
    roles = {r["role"]: r for r in d["summary"]["roles"]}
    assert roles["checker"]["total"] >= 12 and roles["amo"]["total"] >= 1049
    csv = c.get("/api/admin/users.csv", params={"role": "checker"})
    assert csv.status_code == 200 and csv.headers["content-type"].startswith("text/csv")
    body = csv.content.decode("utf-8-sig")
    assert body.startswith("Username,Role") and "t_victim" in body
    assert "$2b$" not in body and "password" not in body.lower()


def test_admin_reset_password_and_deactivate(world):
    admin = client_for("t_admin")
    victim = client_for("t_victim")
    r = admin.post("/api/admin/users/t_victim/reset-password", headers=H)
    assert r.status_code == 200
    new_pw = r.json()["password"]
    assert len(new_pw) >= 8
    assert victim.get("/api/me").status_code == 401  # old session invalidated
    c = TestClient(app)
    assert c.post("/api/login", json={"username": "t_victim", "password": PW}, headers=H).status_code == 401
    assert c.post("/api/login", json={"username": "t_victim", "password": new_pw}, headers=H).status_code == 200

    r = admin.put("/api/admin/users/t_victim", json={"active": False}, headers=H)
    assert r.status_code == 200 and r.json()["active"] is False
    assert c.get("/api/me").status_code == 401
    assert c.post("/api/login", json={"username": "t_victim", "password": new_pw}, headers=H).status_code == 401
    assert admin.put("/api/admin/users/t_victim", json={"active": True}, headers=H).json()["active"] is True

    # an admin cannot lock themselves out
    assert admin.put("/api/admin/users/t_admin", json={"active": False}, headers=H).status_code == 400
    assert admin.post("/api/admin/users/nobody-here/reset-password", headers=H).status_code == 404
