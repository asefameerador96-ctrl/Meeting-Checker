import logging

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
STATIC_VERSION = "1"

app = FastAPI(title="Pre-Plan Follow-Up Portal", docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def csrf_and_headers(request: Request, call_next):
    # Mutating API calls must carry a custom header (blocked cross-site without CORS preflight).
    if request.url.path.startswith("/api/") and request.method not in ("GET", "HEAD", "OPTIONS"):
        if request.headers.get("x-requested-with") != "fetch":
            return JSONResponse({"detail": "Missing X-Requested-With header"}, status_code=403)
    resp = await call_next(request)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    if request.url.path.startswith("/api/") and "cache-control" not in resp.headers:
        resp.headers["Cache-Control"] = "no-store"
    return resp


app.add_middleware(SessionMiddleware, secret_key=settings.SECRET_KEY, session_cookie="ppp_session",
                   max_age=settings.SESSION_MAX_AGE, same_site="lax", https_only=settings.COOKIE_SECURE)
app.mount("/static", StaticFiles(directory=str(APP_DIR / "static")), name="static")
for r in (auth_routes, images, amo, tso, checker, admin):
    app.include_router(r.router)


@app.on_event("startup")
def _startup():
    init_db()  # create tables if missing (seeding runs in startup.sh / python -m app.seed)
    from .purge import start_background_purge
    start_background_purge()


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
    return templates.TemplateResponse(request, "login.html", {"user": None, "v": STATIC_VERSION})


@app.get("/healthz", include_in_schema=False)
def healthz():
    return {"ok": True}
