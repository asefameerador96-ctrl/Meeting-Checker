"""Admin portal API (docs/SPEC.md section D).

GET  /api/admin/users?q=&role=&active=&offset=&limit=   list/search users (+ per-role summary)
GET  /api/admin/summary                                 user counts by role (total/active/never logged in)
GET  /api/admin/users.csv?q=&role=&active=              CSV export of usernames + hierarchy (never passwords)
POST /api/admin/users/{username}/reset-password         new random password, returned once; logs the user out
PUT  /api/admin/users/{username}  {active?, scope_wings?} activate / deactivate (logs the user out);
                                                        checkers: scope_wings = [wing, ...] or null (= all wings)
GET  /api/admin/wings                                   wing names (for the checker wing editor)
"""
import csv
import io
import json
import secrets
import string

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import case, func, or_, select
from sqlalchemy.orm import Session

from ..auth import audit, hash_password, require_role
from ..db import get_db
from ..models import Territory, User, Zone
from ..services import TZ, parse_scope_wings, today

router = APIRouter(prefix="/api/admin", tags=["admin"])

ROLES = ("amo", "tso", "checker", "admin")
MAX_LIMIT = 200
# unambiguous characters only (no 0/O, 1/l/I) so passwords can be read out over the phone
_PW_ALPHABET = "".join(c for c in string.ascii_letters + string.digits if c not in "0O1lI")


def _new_password(n: int = 10) -> str:
    while True:
        pw = "".join(secrets.choice(_PW_ALPHABET) for _ in range(n))
        if any(c.isdigit() for c in pw) and any(c.isalpha() for c in pw):
            return pw


def _filtered_query(q: str, role: str, active: str):
    """SELECT User, Zone, Territory with the admin filters applied (one query, no N+1)."""
    terr_code = func.coalesce(Zone.territory_code, User.territory_code)
    stmt = (select(User, Zone, Territory)
            .outerjoin(Zone, Zone.code == User.zone_code)
            .outerjoin(Territory, Territory.code == terr_code))
    if role:
        if role not in ROLES:
            raise HTTPException(400, "Unknown role")
        stmt = stmt.where(User.role == role)
    if active in ("true", "false"):
        stmt = stmt.where(User.active.is_(active == "true"))
    q = (q or "").strip()
    if q:
        like = f"%{q.lower()}%"
        stmt = stmt.where(or_(func.lower(User.username).like(like), func.lower(User.display_name).like(like),
                              func.lower(Zone.name).like(like), func.lower(Territory.name).like(like),
                              func.lower(Territory.division).like(like), func.lower(Territory.wing).like(like)))
    return stmt


def _user_json(u: User, z: Zone | None, t: Territory | None) -> dict:
    return {"username": u.username, "role": u.role, "display_name": u.display_name, "active": u.active,
            "zone_code": u.zone_code, "zone_name": z.name if z else None,
            "territory_code": t.code if t else None, "territory_name": t.name if t else None,
            "division": t.division if t else None, "wing": t.wing if t else None,
            "scope_wings": parse_scope_wings(u.scope_wings) if u.role == "checker" else None,  # None = all wings
            "last_login_at": u.last_login_at.isoformat() if u.last_login_at else None,
            "created_at": u.created_at.isoformat() if u.created_at else None}


def _summary(db: Session) -> dict:
    rows = db.execute(select(User.role, func.count(),
                             func.sum(case((User.active.is_(True), 1), else_=0)),
                             func.sum(case((User.last_login_at.is_(None), 1), else_=0)))
                      .group_by(User.role)).all()
    by = {r: {"role": r, "total": 0, "active": 0, "inactive": 0, "never_logged_in": 0} for r in ROLES}
    for role, total, act, never in rows:
        d = by.setdefault(role, {"role": role})
        d.update(total=int(total), active=int(act or 0), inactive=int(total) - int(act or 0),
                 never_logged_in=int(never or 0))
    tot = {k: sum(v[k] for v in by.values()) for k in ("total", "active", "inactive", "never_logged_in")}
    return {"roles": list(by.values()), "totals": tot}


def _get_user(db: Session, username: str) -> User:
    u = db.scalar(select(User).where(User.username == username.strip().lower()))
    if not u:
        raise HTTPException(404, "User not found")
    return u


@router.get("/summary")
def summary(admin: User = Depends(require_role("admin")), db: Session = Depends(get_db)):
    return _summary(db)


@router.get("/users")
def list_users(q: str = "", role: str = "", active: str = "", offset: int = Query(0, ge=0),
               limit: int = Query(50, ge=1, le=MAX_LIMIT),
               admin: User = Depends(require_role("admin")), db: Session = Depends(get_db)):
    stmt = _filtered_query(q, role, active)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    order = case({r: i for i, r in enumerate(("admin", "checker", "tso", "amo"))}, value=User.role)
    rows = db.execute(stmt.order_by(order, User.username).offset(offset).limit(limit)).all()
    return {"total": total, "offset": offset, "limit": limit, "me": admin.username,
            "users": [_user_json(u, z, t) for u, z, t in rows], "summary": _summary(db)}


def _csv_cell(v) -> str:
    s = "" if v is None else str(v)
    # neutralise spreadsheet formula injection
    return "'" + s if s[:1] in ("=", "+", "-", "@", "\t", "\r") else s


def _checker_wings_text(u: User) -> str:
    if u.role != "checker":
        return ""
    w = parse_scope_wings(u.scope_wings)
    return "All wings" if w is None else "; ".join(w)


@router.get("/users.csv")
def export_users_csv(q: str = "", role: str = "", active: str = "",
                     admin: User = Depends(require_role("admin")), db: Session = Depends(get_db)):
    """All matching usernames with role and hierarchy. Password hashes are never exported."""
    stmt = _filtered_query(q, role, active).order_by(User.role, User.username)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Username", "Role", "Display Name", "Active", "Wing", "Division", "Territory Code", "Territory",
                "Zone Code", "Zone (AMO)", "Last Login"])
    n = 0
    for u, z, t in db.execute(stmt):
        last = u.last_login_at.astimezone(TZ).strftime("%Y-%m-%d %H:%M") if u.last_login_at else ""
        w.writerow([_csv_cell(x) for x in (u.username, u.role, u.display_name, "yes" if u.active else "no",
                                           t.wing if t else _checker_wings_text(u), t.division if t else "", t.code if t else "",
                                           t.name if t else "", u.zone_code or "", z.name if z else "", last)])
        n += 1
    audit(db, admin, "admin_export_users", f"rows={n} q={q!r} role={role!r} active={active!r}")
    db.commit()
    fname = f"users_{today().isoformat()}.csv"
    # BOM so Excel opens UTF-8 (Bangla names) correctly
    return Response("﻿" + buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{fname}"'})


@router.post("/users/{username}/reset-password")
def reset_password(username: str, admin: User = Depends(require_role("admin")), db: Session = Depends(get_db)):
    u = _get_user(db, username)
    if u.id == admin.id:
        raise HTTPException(400, "Use 'Password' in the top bar to change your own password")
    pw = _new_password()
    u.password_hash = hash_password(pw)
    u.session_version += 1  # signs the user out everywhere
    audit(db, admin, "admin_reset_password", f"user={u.username}")
    db.commit()
    return {"ok": True, "username": u.username, "password": pw}


def _all_wings(db: Session) -> list[str]:
    return list(db.scalars(select(Territory.wing).distinct().order_by(Territory.wing)))


@router.get("/wings")
def wings(admin: User = Depends(require_role("admin")), db: Session = Depends(get_db)):
    return {"wings": _all_wings(db)}


class UserUpdateIn(BaseModel):
    active: bool | None = None
    # checkers only. A list of wing names restricts the checker to them; null (or every wing) = all wings.
    # Omit the field to leave it unchanged.
    scope_wings: list[str] | None = Field(default=None, max_length=50)


@router.put("/users/{username}")
def update_user(username: str, body: UserUpdateIn, admin: User = Depends(require_role("admin")),
                db: Session = Depends(get_db)):
    u = _get_user(db, username)
    if body.active is False and u.id == admin.id:
        raise HTTPException(400, "You cannot deactivate your own account")
    if "scope_wings" in body.model_fields_set:
        if u.role != "checker":
            raise HTTPException(400, "Wings can only be assigned to checker accounts")
        if body.scope_wings is None:
            new = ""
        else:
            valid = _all_wings(db)
            picked = list(dict.fromkeys(w.strip() for w in body.scope_wings if w and w.strip()))
            unknown = [w for w in picked if w not in valid]
            if unknown:
                raise HTTPException(400, f"Unknown wing(s): {', '.join(unknown)}")
            if not picked:
                raise HTTPException(400, "Select at least one wing, or All wings")
            new = "" if set(picked) == set(valid) else json.dumps([w for w in valid if w in picked])
        if u.scope_wings != new:
            u.scope_wings = new  # read on every request, so it takes effect immediately
            audit(db, admin, "admin_set_wings", f"user={u.username} wings={new or 'all'}")
            db.commit()
    if body.active is not None and u.active != body.active:
        u.active = body.active
        if not body.active:
            u.session_version += 1
        audit(db, admin, "admin_set_active", f"user={u.username} active={body.active}")
        db.commit()
    z = db.get(Zone, u.zone_code) if u.zone_code else None
    t = db.get(Territory, z.territory_code if z else u.territory_code) if (z or u.territory_code) else None
    return _user_json(u, z, t)
