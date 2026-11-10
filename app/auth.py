import time
from collections import defaultdict, deque
from datetime import datetime, timezone

import bcrypt
from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from .db import get_db
from .models import AuditLog, User


def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt(rounds=10)).decode()


def verify_password(pw: str, h: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode(), h.encode())
    except ValueError:
        return False


# naive in-memory login throttle: max 10 failures per (ip, username) per 10 minutes
_fails: dict[str, deque] = defaultdict(deque)


def throttle_check(key: str):
    q = _fails[key]
    now = time.time()
    while q and now - q[0] > 600:
        q.popleft()
    if len(q) >= 10:
        raise HTTPException(429, "Too many failed attempts. Try again in a few minutes.")


def throttle_fail(key: str):
    _fails[key].append(time.time())


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
