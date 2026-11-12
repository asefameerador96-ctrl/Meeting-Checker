"""Create tables and load hierarchy + users from seed/ on first start (idempotent)."""
import csv
import json
import logging
from contextlib import contextmanager

from sqlalchemy import func, select, text

from .config import BASE_DIR
from .db import Base, SessionLocal, engine
from .models import SR, Assignment, Route, Territory, User, Zone

log = logging.getLogger("seed")
SEED = BASE_DIR / "seed"


_SEED_LOCK_ID = 724501


@contextmanager
def _seed_lock():
    """On PostgreSQL, serialise schema creation + seeding across app instances starting at the same moment
    (otherwise they race and fail with duplicate-key errors). No-op on SQLite."""
    if engine.dialect.name != "postgresql":
        yield
        return
    with engine.connect() as conn:
        conn.execute(text("SELECT pg_advisory_lock(:k)"), {"k": _SEED_LOCK_ID})
        conn.commit()
        try:
            yield
        finally:
            conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": _SEED_LOCK_ID})
            conn.commit()


def init_db():
    with _seed_lock():
        Base.metadata.create_all(engine)
        _migrate_users_scope_wings()
        _migrate_images_source()


def _add_column(table: str, column: str, sql_type: str) -> bool:
    """ALTER TABLE <table> ADD COLUMN <column> unless it already exists (create_all never adds columns).
    Idempotent on PostgreSQL (advisory lock + IF NOT EXISTS) and on SQLite, where several workers starting at once
    may race: a 'duplicate column' error from the loser is treated as success after re-checking."""
    from sqlalchemy import inspect
    from sqlalchemy.exc import DBAPIError
    if column in {c["name"] for c in inspect(engine).get_columns(table)}:
        return False
    ine = "IF NOT EXISTS " if engine.dialect.name == "postgresql" else ""
    try:
        with engine.begin() as conn:
            conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {ine}{column} {sql_type}"))
    except DBAPIError:
        if column in {c["name"] for c in inspect(engine).get_columns(table)}:
            return False  # another worker added it first
        raise
    log.info("migrated: added %s.%s", table, column)
    return True


def _migrate_images_source():
    """Add images.source (camera | capture_input) to databases created before it existed. Existing rows keep NULL."""
    _add_column("images", "source", "VARCHAR(20)")


def _migrate_users_scope_wings():
    """Add users.scope_wings (JSON list of wings; NULL/'' = all wings) to databases created before it existed."""
    _add_column("users", "scope_wings", "TEXT")


DEFAULT_SCOPED_CHECKERS = 5  # checker01..checker05 get one wing each; checker06.. get all wings


def assign_default_checker_wings(db):
    """Default wing per checker, applied only where scope_wings IS NULL (never assigned), so an admin's
    later choice is never overwritten. checkerNN (NN <= 5) -> the NN-th wing in seed/territories.csv order."""
    wings: list[str] = []
    with open(SEED / "territories.csv", newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r["wing"] not in wings:
                wings.append(r["wing"])
    n = 0
    for u in db.scalars(select(User).where(User.role == "checker", User.scope_wings.is_(None))):
        name = u.username
        if not (name.startswith("checker") and name[7:].isdigit()):
            continue
        i = int(name[7:])
        if 1 <= i <= DEFAULT_SCOPED_CHECKERS and i <= len(wings):
            u.scope_wings = json.dumps([wings[i - 1]])
        else:
            u.scope_wings = ""
        n += 1
    if n:
        log.info("assigned default wings to %d checker(s)", n)


def seed_hierarchy(db):
    if db.scalar(select(func.count()).select_from(Territory)):
        return False
    with open(SEED / "territories.csv", newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            db.add(Territory(code=int(r["territory_code"]), name=r["territory"], division=r["division"], wing=r["wing"]))
    db.flush()
    zones, srs, assign = {}, {}, {}
    with open(SEED / "hierarchy.csv", newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        zc, tc, sid = int(r["zone_code"]), int(r["territory_code"]), r["sr_id"]
        zones.setdefault(zc, (r["amo"], tc))
        srs.setdefault(sid, r["sr_name"])
    for zc, (name, tc) in zones.items():
        db.add(Zone(code=zc, name=name, territory_code=tc))
    for sid, name in srs.items():
        db.add(SR(id=sid, name=name))
    db.flush()
    for r in rows:
        zc, sid = int(r["zone_code"]), r["sr_id"]
        db.add(Route(code=int(r["route_code"]), name=r["route"], sr_id=sid, zone_code=zc))
        a = assign.setdefault((zc, sid), {"tc": int(r["territory_code"]), "codes": [], "names": []})
        a["codes"].append(r["route_code"])
        a["names"].append(r["route"])
    for (zc, sid), a in assign.items():
        db.add(Assignment(zone_code=zc, sr_id=sid, territory_code=a["tc"],
                          route_codes=", ".join(a["codes"]), route_names=", ".join(a["names"])))
    log.info("seeded %d territories, %d zones, %d SRs, %d routes, %d assignments",
             db.scalar(select(func.count()).select_from(Territory)), len(zones), len(srs), len(rows), len(assign))
    return True


def seed_users(db):
    existing = set(db.scalars(select(User.username)))
    users = json.loads((SEED / "users.json").read_text())
    n = 0
    for u in users:
        if u["username"] in existing:
            continue
        db.add(User(username=u["username"], password_hash=u["password_hash"], role=u["role"],
                    display_name=u.get("display_name", ""), zone_code=u.get("zone_code"),
                    territory_code=u.get("territory_code")))
        n += 1
    if n:
        log.info("seeded %d users", n)


def run_seed():
    with _seed_lock():
        Base.metadata.create_all(engine)
        _migrate_users_scope_wings()  # before any User insert/select on an existing (older) database
        _migrate_images_source()
        with SessionLocal() as db:
            seed_hierarchy(db)
            db.flush()
            seed_users(db)
            db.flush()
            assign_default_checker_wings(db)
            db.commit()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run_seed()
