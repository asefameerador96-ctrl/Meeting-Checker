"""Create tables and load hierarchy + users from seed/ on first start (idempotent)."""
import csv
import json
import logging

from sqlalchemy import func, select

from .config import BASE_DIR
from .db import Base, SessionLocal, engine
from .models import SR, Assignment, Route, Territory, User, Zone

log = logging.getLogger("seed")
SEED = BASE_DIR / "seed"


def init_db():
    Base.metadata.create_all(engine)


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
    init_db()
    with SessionLocal() as db:
        seed_hierarchy(db)
        db.flush()
        seed_users(db)
        db.commit()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run_seed()
