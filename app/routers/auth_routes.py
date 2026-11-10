from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import (audit, current_user, hash_password, login_user, throttle_check, throttle_fail,
                    verify_password)
from ..db import get_db
from ..models import Territory, User, Zone

router = APIRouter(prefix="/api", tags=["auth"])

HOME = {"amo": "/amo", "tso": "/tso", "checker": "/checker", "admin": "/admin"}


class LoginIn(BaseModel):
    username: str
    password: str


@router.post("/login")
def login(body: LoginIn, request: Request, db: Session = Depends(get_db)):
    uname = body.username.strip().lower()
    key = f"{request.client.host if request.client else '-'}:{uname}"
    throttle_check(key)
    user = db.scalar(select(User).where(User.username == uname))
    if not user or not user.active or not verify_password(body.password, user.password_hash):
        throttle_fail(key)
        raise HTTPException(401, "Invalid username or password")
    user.last_login_at = datetime.now(timezone.utc)
    audit(db, user, "login")
    db.commit()
    login_user(request, user)
    return {"ok": True, "redirect": HOME.get(user.role, "/")}


@router.post("/logout")
def logout(request: Request):
    request.session.clear()
    return {"ok": True}


@router.get("/me")
def me(user: User = Depends(current_user), db: Session = Depends(get_db)):
    out = {"username": user.username, "role": user.role, "display_name": user.display_name,
           "zone_code": user.zone_code, "territory_code": user.territory_code}
    tc = user.territory_code
    if user.zone_code:
        z = db.get(Zone, user.zone_code)
        out["zone_name"] = z.name
        tc = z.territory_code
    if tc:
        t = db.get(Territory, tc)
        out.update(territory_code=t.code, territory_name=t.name, division=t.division, wing=t.wing)
    return out


class PwIn(BaseModel):
    current_password: str
    new_password: str


@router.post("/change-password")
def change_password(body: PwIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(400, "Current password is wrong")
    if len(body.new_password) < 8:
        raise HTTPException(400, "New password must be at least 8 characters")
    user.password_hash = hash_password(body.new_password)
    user.session_version += 1
    audit(db, user, "change_password")
    db.commit()
    login_user(request, user)
    return {"ok": True}
