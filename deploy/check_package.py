"""Fail if the deployment zip is missing a file the app needs at runtime.

    python3 deploy/check_package.py preplan-app.zip

Besides a fixed list, every template referenced from app/main.py and every /static/... asset referenced from a
template in the package must be present, so a forgotten `git add` cannot ship a broken portal.
"""
import re
import sys
import zipfile

REQUIRED = [
    "startup.sh", "requirements.txt", "seed/users.json",
    "app/main.py", "app/static/css/app.css",
    "app/templates/base.html", "app/templates/login.html", "app/templates/amo.html",
    "app/templates/tso.html", "app/templates/checker.html", "app/templates/admin.html",
    "app/static/js/common.js", "app/static/js/amo.js", "app/static/js/tso.js",
    "app/static/js/checker.js", "app/static/js/admin.js",
]


def main(path: str) -> int:
    z = zipfile.ZipFile(path)
    names = set(z.namelist())
    need = set(REQUIRED)
    if "app/main.py" in names:
        for t in re.findall(r'["\']([\w-]+\.html)["\']', z.read("app/main.py").decode("utf8", "replace")):
            need.add(f"app/templates/{t}")
    for n in names:
        if n.startswith("app/templates/") and n.endswith(".html"):
            for asset in re.findall(r'/static/([\w./-]+?\.(?:js|css|png|svg|ico|webmanifest))', z.read(n).decode("utf8", "replace")):
                need.add(f"app/static/{asset}")
    missing = sorted(need - names)
    if missing:
        print("package is missing: " + ", ".join(missing), file=sys.stderr)
        return 1
    print(f"package ok: {len(names)} entries, {len(need)} required files present")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
