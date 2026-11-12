from datetime import datetime
import hashlib
import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware

from .auth import current_user_optional
from .config import BASE_DIR, settings
from .models import User
from .routers import admin, amo, auth_routes, checker, images, tso
from .seed import init_db

logging.basicConfig(level=logging.INFO)
APP_DIR = BASE_DIR / "app"
templates = Jinja2Templates(directory=str(APP_DIR / "templates"))


def _static_version() -> str:
    """Cache-busting token for /static URLs: changes whenever any static file changes."""
    h = hashlib.sha1()
    for p in sorted((APP_DIR / "static").rglob("*")):
        if p.is_file():
            h.update(p.relative_to(APP_DIR).as_posix().encode())
            h.update(p.read_bytes())
    return h.hexdigest()[:10]


STATIC_VERSION = _static_version()


@asynccontextmanager
async def lifespan(_app):
    init_db()  # create tables if missing (seeding runs in startup.sh / python -m app.seed)
    from .purge import start_background_purge
    start_background_purge()
    log = logging.getLogger("app")
    from .db import engine
    log.info("database=%s storage=%s static=%s", engine.dialect.name, settings.STORAGE_BACKEND, STATIC_VERSION)
    yield


app = FastAPI(title="Meeting Checker", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


CSP = ("default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; "
       "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.blob.core.windows.net; "
       "connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; "
       "form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests")


@app.middleware("http")
async def csrf_and_headers(request: Request, call_next):
    canon = settings.CANONICAL_HOST
    if canon and request.url.path != "/healthz":
        host = (request.headers.get("host") or "").split(":")[0].lower()
        if host and host != canon and host not in ("localhost", "127.0.0.1"):
            q = ("?" + request.url.query) if request.url.query else ""
            return RedirectResponse(f"https://{canon}{request.url.path}{q}",
                                    status_code=308 if request.method not in ("GET", "HEAD") else 301)
    # Mutating API calls must carry a custom header (blocked cross-site without CORS preflight).
    if request.url.path.startswith("/api/") and request.method not in ("GET", "HEAD", "OPTIONS"):
        if request.headers.get("x-requested-with") != "fetch":
            return JSONResponse({"detail": "Missing X-Requested-With header"}, status_code=403)
    resp = await call_next(request)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    resp.headers.setdefault("Permissions-Policy", "camera=(self), microphone=(), geolocation=(), payment=()")
    resp.headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
    resp.headers.setdefault("Content-Security-Policy", CSP)
    if request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https" or settings.COOKIE_SECURE:
        resp.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    if request.url.path.startswith("/api/") and "cache-control" not in resp.headers:
        resp.headers["Cache-Control"] = "no-store"
    return resp


app.add_middleware(SessionMiddleware, secret_key=settings.SECRET_KEY, session_cookie="ppp_session",
                   max_age=settings.SESSION_MAX_AGE, same_site="lax", https_only=settings.COOKIE_SECURE)
app.mount("/static", StaticFiles(directory=str(APP_DIR / "static")), name="static")
for r in (auth_routes, images, amo, tso, checker, admin):
    app.include_router(r.router)




HOME = {"amo": "/amo", "tso": "/tso", "checker": "/checker", "admin": "/admin"}


def _page(name: str, role: str | tuple):
    roles = (role,) if isinstance(role, str) else role

    def handler(request: Request, user: User | None = Depends(current_user_optional)):
        if not user:
            return RedirectResponse("/login", status_code=302)
        if user.role not in roles:
            return RedirectResponse(HOME.get(user.role, "/login"), status_code=302)
        return templates.TemplateResponse(request, name, {"user": user, "v": STATIC_VERSION})
    return handler


app.add_api_route("/amo", _page("amo.html", "amo"), include_in_schema=False)
app.add_api_route("/tso", _page("tso.html", "tso"), include_in_schema=False)
app.add_api_route("/checker", _page("checker.html", ("checker", "admin")), include_in_schema=False)
app.add_api_route("/admin", _page("admin.html", "admin"), include_in_schema=False)


@app.get("/", include_in_schema=False)
def root(user: User | None = Depends(current_user_optional)):
    return RedirectResponse(HOME.get(user.role, "/login") if user else "/login", status_code=302)


@app.get("/login", include_in_schema=False)
def login_page(request: Request, user: User | None = Depends(current_user_optional)):
    if user:
        return RedirectResponse(HOME.get(user.role, "/"), status_code=302)
    return templates.TemplateResponse(request, "login.html", {"user": None, "v": STATIC_VERSION, "year": datetime.now().year})


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    from fastapi.responses import FileResponse
    return FileResponse(APP_DIR / "static" / "img" / "favicon.ico", media_type="image/x-icon",
                        headers={"Cache-Control": "public, max-age=604800"})


@app.get("/healthz", include_in_schema=False)
def healthz():
    return {"ok": True}
