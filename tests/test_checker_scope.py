"""Checker wing scope (users.scope_wings) + the 4-bucket "SR photo coverage" dashboard.

Shares the throw-away DB of whichever test module imported `app` first (env vars are only set if `app` is not
imported yet), so every user / territory used here is distinct from test_api_basic.py.
"""
import io
import json
import os
import shutil
import sys
import tempfile
import uuid

if "app.config" not in sys.modules:
    import atexit
    _TMP = tempfile.mkdtemp(prefix="ppp_scope_")
    atexit.register(shutil.rmtree, _TMP, ignore_errors=True)
    os.environ["DATABASE_URL"] = f"sqlite:///{_TMP}/test.db"
    os.environ["LOCAL_UPLOAD_DIR"] = f"{_TMP}/uploads"
    os.environ["STORAGE_BACKEND"] = "local"
    os.environ["COOKIE_SECURE"] = "false"

import openpyxl  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image as PILImage  # noqa: E402
from sqlalchemy import func, inspect, select, text  # noqa: E402

from app.auth import hash_password  # noqa: E402
from app.db import SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Assignment, Image, SREntry, Territory, TerritoryReport, User  # noqa: E402
from app.seed import _migrate_users_scope_wings, init_db, run_seed  # noqa: E402
from app.services import today  # noqa: E402
from app.storage import get_storage  # noqa: E402

PW = "Scope-pass-123"
H = {"X-Requested-With": "fetch"}
WING_IN, WING_OUT = "Chittagong North", "Sylhet"
FIRST_FIVE = ["Chittagong North", "Chittagong South", "Noakhali", "Cumilla", "Sylhet"]
ALL_TEN = FIRST_FIVE + ["Dhaka North", "Dhaka South", "Gaibandha", "Rangpur", "South Bengal"]


def _jpeg() -> bytes:
    b = io.BytesIO()
    PILImage.new("RGB", (8, 8), (1, 2, 3)).save(b, "JPEG")
    return b.getvalue()


def _add_image(db, d, a: Assignment) -> Image:
    key = f"test/{uuid.uuid4().hex}"
    st = get_storage()
    st.put(key + ".jpg", _jpeg(), "image/jpeg")
    st.put(key + "_t.jpg", _jpeg(), "image/jpeg")
    img = Image(report_date=d, kind="sr", territory_code=a.territory_code, zone_code=a.zone_code, sr_id=a.sr_id,
                blob_key=key + ".jpg", thumb_key=key + "_t.jpg", size_bytes=1, width=8, height=8,
                sha256=uuid.uuid4().hex, orig_sha256=uuid.uuid4().hex, uploaded_by="test")
    db.add(img)
    db.flush()
    return img


def client_for(username: str) -> TestClient:
    c = TestClient(app, follow_redirects=False)
    r = c.post("/api/login", json={"username": username, "password": PW}, headers=H)
    assert r.status_code == 200, r.text
    return c


@pytest.fixture(scope="module")
def sw():
    """Two submitted territories, one in WING_IN and one in WING_OUT, with a known check state:
    in-wing territory: 1 SR checked (correct), 1 checked + incorrect, 1 uploaded unchecked, rest not uploaded."""
    run_seed()
    d = today()
    with SessionLocal() as db:
        def pick(wing):
            ts = list(db.scalars(select(Territory).where(Territory.wing == wing).order_by(Territory.code.desc())))
            for t in ts:
                n = db.scalar(select(Assignment.id).where(Assignment.territory_code == t.code).offset(3).limit(1))
                if n:
                    return t
            raise AssertionError("no territory with >= 4 SRs in " + wing)
        t_in, t_out = pick(WING_IN), pick(WING_OUT)
        h = hash_password(PW)
        db.add_all([
            User(username="s_chk_in", password_hash=h, role="checker", scope_wings=json.dumps([WING_IN])),
            User(username="s_chk_pipe", password_hash=h, role="checker", scope_wings=f"{WING_OUT}|{WING_IN}"),
            User(username="s_chk_all", password_hash=h, role="checker", scope_wings=""),
            User(username="s_chk_null", password_hash=h, role="checker"),
            User(username="s_admin", password_hash=h, role="admin"),
        ])
        out = {"d": d.isoformat(), "t_in": t_in.code, "t_out": t_out.code, "imgs": {}}
        for t in (t_in, t_out):
            db.add(TerritoryReport(report_date=d, territory_code=t.code, status="submitted"))
            assigns = list(db.scalars(select(Assignment).where(Assignment.territory_code == t.code)
                                      .order_by(Assignment.id)))
            for i, a in enumerate(assigns[:3]):
                img = _add_image(db, d, a)
                out["imgs"].setdefault(t.code, img.id)
                if i < 2:
                    db.add(SREntry(report_date=d, zone_code=a.zone_code, sr_id=a.sr_id, territory_code=t.code,
                                   checked=True, checked_by="test", checker_valid="yes" if i == 0 else "no"))
                else:
                    db.add(SREntry(report_date=d, zone_code=a.zone_code, sr_id=a.sr_id, territory_code=t.code,
                                   checker_valid="no"))  # verdict without "Checked": still "not yet checked"
            out.setdefault("n", {})[t.code] = len(assigns)
            out.setdefault("a", {})[t.code] = (assigns[3].zone_code, assigns[3].sr_id)
        db.commit()
    return out


# ---------------- migration + default assignment ----------------
def test_migration_and_default_wings(sw):
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE users DROP COLUMN scope_wings"))
    assert "scope_wings" not in {c["name"] for c in inspect(engine).get_columns("users")}
    init_db()
    _migrate_users_scope_wings()  # idempotent
    assert "scope_wings" in {c["name"] for c in inspect(engine).get_columns("users")}
    run_seed()  # default assignment where scope_wings IS NULL
    with SessionLocal() as db:
        got = dict(db.execute(select(User.username, User.scope_wings).where(User.username.like("checker%"))).all())
        for i, w in enumerate(ALL_TEN, start=1):  # checker01..10 -> one wing each
            assert json.loads(got[f"checker{i:02d}"]) == [w]
        # an admin's later choice is never overwritten by a re-seed
        db.execute(text("UPDATE users SET scope_wings='' WHERE username='checker01'"))
        db.commit()
    run_seed()
    with SessionLocal() as db:
        assert db.scalar(select(User.scope_wings).where(User.username == "checker01")) == ""
        # restore the module's scoped users (their values were dropped with the column)
        for name, v in (("s_chk_in", json.dumps([WING_IN])), ("s_chk_pipe", f"{WING_OUT}|{WING_IN}"),
                        ("s_chk_all", ""), ("checker01", json.dumps([FIRST_FIVE[0]]))):
            db.scalar(select(User).where(User.username == name)).scope_wings = v
        db.commit()


# ---------------- scope enforcement ----------------
def test_hierarchy_scoped(sw):
    h = client_for("s_chk_in").get("/api/checker/hierarchy").json()
    assert [w["name"] for w in h["wings"]] == [WING_IN] and h["my_wings"] == [WING_IN]
    h2 = client_for("s_chk_pipe").get("/api/checker/hierarchy").json()
    assert sorted(w["name"] for w in h2["wings"]) == sorted([WING_IN, WING_OUT])
    for u in ("s_chk_all", "s_chk_null", "s_admin"):
        h3 = client_for(u).get("/api/checker/hierarchy").json()
        assert len(h3["wings"]) == 10 and h3["my_wings"] is None, u


def test_cross_wing_requests_rejected(sw):
    c, d, out = client_for("s_chk_in"), sw["d"], sw["t_out"]
    zc, sr = sw["a"][out]
    assert c.get(f"/api/checker/territory?date={d}&territory_code={out}").status_code == 403
    assert c.get(f"/api/checker/territory?date={d}&territory_code={sw['t_in']}").json()["submitted"] is True
    assert c.put("/api/checker/sr", headers=H, json={"date": d, "zone_code": zc, "sr_id": sr,
                                                     "checked": False, "checker_valid": "no"}).status_code == 403
    assert c.put("/api/checker/zone", headers=H, json={"date": d, "zone_code": zc,
                                                       "checker_meeting_valid": "yes"}).status_code == 403
    assert c.post("/api/checker/check-all", headers=H, json={"date": d, "territory_code": out}).status_code == 403
    for url in ("/api/checker/dashboard", "/api/checker/export/full.xlsx", "/api/checker/export/missing.xlsx"):
        assert c.get(f"{url}?date={d}&wing={WING_OUT}").status_code == 403, url
        assert c.get(f"{url}?date={d}&wing={WING_IN}").status_code == 200, url
        # another wing's division / territory (without naming the wing) is also a 403, not an empty 200
        with SessionLocal() as db:
            div_out = db.scalar(select(Territory.division).where(Territory.code == out))
            div_in = db.scalar(select(Territory.division).where(Territory.code == sw["t_in"]))
        assert c.get(f"{url}?date={d}&division={div_out}").status_code == 403, url
        assert c.get(f"{url}?date={d}&territory_code={out}").status_code == 403, url
        assert c.get(f"{url}?date={d}&division={div_in}&territory_code={sw['t_in']}").status_code == 200, url
        assert client_for("s_chk_all").get(f"{url}?date={d}&territory_code={out}").status_code == 200, url
    # nothing was written to the out-of-scope SR
    with SessionLocal() as db:
        e = db.scalar(select(SREntry).where(SREntry.zone_code == zc, SREntry.sr_id == sr))
        assert e is None or e.checker_valid is None
    # images: in scope visible, out of scope 404; an all-wings checker sees both
    img_in, img_out = sw["imgs"][sw["t_in"]], sw["imgs"][out]
    assert c.get(f"/api/images/{img_in}/thumb").status_code == 200
    assert c.get(f"/api/images/{img_out}/thumb").status_code == 404
    assert c.get(f"/api/images/{img_out}/full").status_code == 404
    for u in ("s_chk_all", "s_admin"):
        assert client_for(u).get(f"/api/images/{img_out}/thumb").status_code == 200, u


def test_dashboard_no_wing_means_all_allowed_wings(sw):
    d = sw["d"]
    scoped = client_for("s_chk_in").get(f"/api/checker/dashboard?date={d}").json()
    assert {r["wing"] for r in scoped["by_division"]} == {WING_IN}
    assert scoped["scope"]["allowed_wings"] == [WING_IN]
    with SessionLocal() as db:
        n_in = db.scalar(select(func.count(Assignment.id)).join(
            Territory, Territory.code == Assignment.territory_code).where(Territory.wing == WING_IN))
    assert scoped["totals"]["total_srs"] == n_in
    everything = client_for("s_admin").get(f"/api/checker/dashboard?date={d}").json()
    assert len({r["wing"] for r in everything["by_division"]}) == 10
    # Excel without wing: only the allowed wing's rows
    r = client_for("s_chk_in").get(f"/api/checker/export/full.xlsx?date={d}")
    ws = openpyxl.load_workbook(io.BytesIO(r.content)).active
    rows = list(ws.iter_rows(values_only=True))
    wcol = rows[0].index("Wing")
    assert len(rows) - 1 == n_in and {x[wcol] for x in rows[1:]} == {WING_IN}
    r = client_for("s_chk_in").get(f"/api/checker/export/missing.xlsx?date={d}")
    rows = list(openpyxl.load_workbook(io.BytesIO(r.content)).active.iter_rows(values_only=True))
    assert {x[rows[0].index("Wing")] for x in rows[1:]} == {WING_IN}


def test_scope_change_takes_effect_immediately(sw):
    c = client_for("s_chk_all")
    adm = client_for("s_admin")
    assert c.get(f"/api/checker/territory?date={sw['d']}&territory_code={sw['t_out']}").status_code == 200
    r = adm.put("/api/admin/users/s_chk_all", headers=H, json={"scope_wings": [WING_IN]})
    assert r.status_code == 200 and r.json()["scope_wings"] == [WING_IN]
    assert c.get(f"/api/checker/territory?date={sw['d']}&territory_code={sw['t_out']}").status_code == 403
    assert [w["name"] for w in c.get("/api/checker/hierarchy").json()["wings"]] == [WING_IN]
    r = adm.put("/api/admin/users/s_chk_all", headers=H, json={"scope_wings": None})
    assert r.status_code == 200 and r.json()["scope_wings"] is None
    assert c.get(f"/api/checker/territory?date={sw['d']}&territory_code={sw['t_out']}").status_code == 200


def test_admin_wing_editor_validation(sw):
    adm = client_for("s_admin")
    assert len(adm.get("/api/admin/wings").json()["wings"]) == 10
    assert adm.put("/api/admin/users/s_chk_all", headers=H, json={"scope_wings": ["Atlantis"]}).status_code == 400
    assert adm.put("/api/admin/users/s_chk_all", headers=H, json={"scope_wings": []}).status_code == 400
    assert adm.put("/api/admin/users/s_admin", headers=H, json={"scope_wings": [WING_IN]}).status_code == 400
    # all ten selected = stored as "all wings"
    allw = adm.get("/api/admin/wings").json()["wings"]
    assert adm.put("/api/admin/users/s_chk_all", headers=H, json={"scope_wings": allw}).json()["scope_wings"] is None
    # active-only updates still work and do not touch the wings
    r = adm.put("/api/admin/users/s_chk_in", headers=H, json={"active": True})
    assert r.status_code == 200 and r.json()["scope_wings"] == [WING_IN]
    lst = adm.get("/api/admin/users", params={"q": "s_chk_", "role": "checker"}).json()["users"]
    assert {u["username"]: u["scope_wings"] for u in lst}["s_chk_in"] == [WING_IN]
    # non-admins cannot change wings
    assert client_for("s_chk_in").put("/api/admin/users/s_chk_in", headers=H,
                                      json={"scope_wings": None}).status_code == 403


# ---------------- 4-bucket pie ----------------
def test_pie_four_buckets(sw):
    t, d = sw["t_in"], sw["d"]
    r = client_for("s_chk_in").get(f"/api/checker/dashboard?date={d}&territory_code={t}").json()
    n = sw["n"][t]
    assert r["pie"]["labels"] == ["Images not uploaded", "Images uploaded (not yet checked)", "Checked by checker",
                                  "Incorrect photo"]
    assert r["pie"]["values"] == [n - 3, 1, 1, 1] and sum(r["pie"]["values"]) == r["totals"]["total_srs"] == n
    T = r["totals"]
    assert (T["checked"], T["incorrect"], T["checked_total"], T["uploaded_not_checked"]) == (1, 1, 2, 1)
    assert T["check_pass"] == 1 and T["check_fail"] == 1 and T["pass_pct"] == 50.0
    bt = [x for x in r["by_territory"] if x["territory_code"] == t][0]
    assert (bt["checked"], bt["incorrect"], bt["srs_with_images"]) == (1, 1, 3)
    assert sum(x["incorrect"] for x in r["by_division"]) == 1
    # full Excel: "Photo Status" column with the same 4 buckets
    x = client_for("s_chk_in").get(f"/api/checker/export/full.xlsx?date={d}&territory_code={t}")
    rows = list(openpyxl.load_workbook(io.BytesIO(x.content)).active.iter_rows(values_only=True))
    col = rows[0].index("Photo Status")
    from collections import Counter
    assert Counter(r[col] for r in rows[1:]) == Counter({"Images not uploaded": n - 3, "Checked by checker": 1,
                                                         "Incorrect photo": 1,
                                                         "Images uploaded (not yet checked)": 1})
