from datetime import datetime, timedelta, timezone

import bcrypt
from fastapi import Depends, HTTPException, Request
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from .db import get_db
from .models import AuditLog, LoginFailure, User


def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt(rounds=10)).decode()


def verify_password(pw: str, h: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode(), h.encode())
    except ValueError:
        return False


# Brute-force protection shared by all instances (stored in the database):
#   - max 8 failed attempts per username in 15 minutes (account temporarily locked)
#   - max 40 failed attempts per client IP in 15 minutes
WINDOW = timedelta(minutes=15)
MAX_PER_USER = 8
MAX_PER_IP = 40


def throttle_check(db: Session, username: str, ip: str):
    since = datetime.now(timezone.utc) - WINDOW
    n_user = db.scalar(select(func.count()).select_from(LoginFailure)
                       .where(LoginFailure.username == username, LoginFailure.at >= since))
    n_ip = db.scalar(select(func.count()).select_from(LoginFailure)
                     .where(LoginFailure.ip == ip, LoginFailure.at >= since))
    if n_user >= MAX_PER_USER or n_ip >= MAX_PER_IP:
        raise HTTPException(429, "Too many failed attempts. Please wait 15 minutes and try again.")


def throttle_fail(db: Session, username: str, ip: str):
    db.add(LoginFailure(username=username[:60], ip=ip[:64], at=datetime.now(timezone.utc)))
    # housekeeping: drop entries older than a day
    db.execute(delete(LoginFailure).where(LoginFailure.at < datetime.now(timezone.utc) - timedelta(days=1)))
    db.commit()


def throttle_clear(db: Session, username: str):
    db.execute(delete(LoginFailure).where(LoginFailure.username == username))


def client_ip(request: Request) -> str:
    # Azure App Service front ends put the real client first in X-Forwarded-For ("ip:port, ...")
    xff = request.headers.get("x-forwarded-for", "")
    ip = xff.split(",")[0].strip() if xff else (request.client.host if request.client else "-")
    if ip.count(":") == 1:  # strip ":port" from IPv4
        ip = ip.split(":")[0]
    return ip or "-"


def login_user(request: Request, user: User):
    request.session.clear()
    request.session["uid"] = user.id
    request.session["sv"] = user.session_version


def current_user_optional(request: Request, db: Session = Depends(get_db)) -> User | None:
    uid = request.session.get("uid")
    if not uid:
        return None
    user = db.get(User, uid)
    if not user or not user.active or request.session.get("sv") != user.session_version:
        request.session.clear()
        return None
    return user


def current_user(user: User | None = Depends(current_user_optional)) -> User:
    if not user:
        raise HTTPException(401, "Not logged in")
    return user


def require_role(*roles):
    def dep(user: User = Depends(current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(403, "Not allowed for your role")
        return user
    return dep


def audit(db: Session, user: User | str, action: str, detail: str = ""):
    db.add(AuditLog(username=user if isinstance(user, str) else user.username, action=action, detail=detail[:2000],
                    at=datetime.now(timezone.utc)))
