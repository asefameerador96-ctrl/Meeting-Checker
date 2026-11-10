"""Convert the hierarchy Excel into seed files and generate user credentials.

Usage:
    python scripts/prepare_data.py <hierarchy.xlsx> <credentials_out.xlsx>

Writes:
    seed/hierarchy.csv   - one row per route (Wing > Division > Territory > Zone/AMO > Route > SR)
    seed/territories.csv - Wing > Division > Territory Code > Territory
    seed/users.json      - usernames + bcrypt hashes (NO plaintext passwords)
and the credentials workbook (plaintext passwords) to the given path, which must
be kept OUT of the repository and handed to the business owner.

Re-running regenerates ALL passwords. Use --keep to reuse the passwords already
in an existing credentials workbook (only new users get new passwords).
"""
import json
import secrets
import sys
from pathlib import Path

import bcrypt
import openpyxl
import pandas as pd
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter

ROOT = Path(__file__).resolve().parent.parent
ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"


def make_password(n=10):
    while True:
        p = "".join(secrets.choice(ALPHABET) for _ in range(n))
        if any(c.isdigit() for c in p) and any(c.isupper() for c in p) and any(c.islower() for c in p):
            return p


def read_sheet(path, name):
    df = pd.read_excel(path, sheet_name=name, header=4)
    df = df.drop(columns=[c for c in df.columns if str(c).startswith("Unnamed")])
    for c in df.columns:
        if df[c].dtype == object or str(df[c].dtype) == "str":
            df[c] = df[c].astype(str).str.strip()
    return df


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    keep = "--keep" in sys.argv
    if len(args) != 2:
        print(__doc__)
        sys.exit(1)
    xlsx, cred_out = Path(args[0]), Path(args[1])

    terr = read_sheet(xlsx, "Territory")
    terr.columns = ["wing", "division", "territory_code", "territory"]
    routes = read_sheet(xlsx, "Route - SR - AMO")
    routes.columns = ["wing", "division", "territory", "route_code", "route", "sr_id", "sr_name", "zone_code", "amo"]
    routes = routes.merge(terr[["territory", "territory_code"]], on="territory", how="left")
    assert routes["territory_code"].notna().all(), "route with unknown territory"
    routes["territory_code"] = routes["territory_code"].astype(int)

    seed = ROOT / "seed"
    seed.mkdir(exist_ok=True)
    terr.to_csv(seed / "territories.csv", index=False)
    routes[["wing", "division", "territory_code", "territory", "zone_code", "amo",
            "route_code", "route", "sr_id", "sr_name"]].to_csv(seed / "hierarchy.csv", index=False)

    old = {}
    if keep and cred_out.exists():
        wb = openpyxl.load_workbook(cred_out, read_only=True)
        for ws in wb.worksheets:
            for row in ws.iter_rows(min_row=2, values_only=True):
                if row and row[0] and len(row) > 1 and row[1]:
                    old[str(row[0])] = str(row[1])

    users = []  # (username, password, role, scope, display, extra cols)
    for _, t in terr.sort_values("territory_code").iterrows():
        u = f"tso{int(t.territory_code)}"
        users.append(dict(username=u, role="tso", territory_code=int(t.territory_code),
                          display_name=f"TSO - {t.territory}",
                          cols=[t.wing, t.division, int(t.territory_code), t.territory]))
    zones = routes.groupby(["zone_code"]).agg(
        amo=("amo", "first"), wing=("wing", "first"), division=("division", "first"),
        territory_code=("territory_code", "first"), territory=("territory", "first"),
        srs=("sr_id", "nunique")).reset_index().sort_values("zone_code")
    for _, z in zones.iterrows():
        u = f"amo{int(z.zone_code)}"
        users.append(dict(username=u, role="amo", zone_code=int(z.zone_code),
                          display_name=f"AMO - {z.amo} ({int(z.zone_code)})",
                          cols=[z.wing, z.division, int(z.territory_code), z.territory, int(z.zone_code), z.amo, int(z.srs)]))
    for i in range(1, 11):
        users.append(dict(username=f"checker{i:02d}", role="checker", display_name=f"Checker {i:02d}", cols=[]))
    users.append(dict(username="admin", role="admin", display_name="Administrator", cols=[]))

    out = []
    for u in users:
        pw = old.get(u["username"]) or make_password()
        u["password"] = pw
        h = bcrypt.hashpw(pw.encode(), bcrypt.gensalt(rounds=10)).decode()
        out.append({k: v for k, v in u.items() if k not in ("cols", "password")} | {"password_hash": h})
    (seed / "users.json").write_text(json.dumps(out, indent=0))

    wb = openpyxl.Workbook()
    sheets = {
        "amo": ("AMO", ["Username", "Password", "Role", "Wing", "Division", "Territory Code", "Territory", "Zone Code", "AMO", "SR Count"]),
        "tso": ("TSO", ["Username", "Password", "Role", "Wing", "Division", "Territory Code", "Territory"]),
        "checker": ("Checker", ["Username", "Password", "Role", "Name"]),
        "admin": ("Admin", ["Username", "Password", "Role", "Name"]),
    }
    first = True
    for role, (title, header) in sheets.items():
        ws = wb.active if first else wb.create_sheet()
        first = False
        ws.title = title
        ws.append(header)
        for c in ws[1]:
            c.font = Font(bold=True, color="FFFFFF")
            c.fill = PatternFill("solid", fgColor="1F4E79")
        for u in users:
            if u["role"] != role:
                continue
            extra = u["cols"] if u["cols"] else [u["display_name"]]
            ws.append([u["username"], u["password"], role.upper()] + extra)
        for i, _ in enumerate(header, 1):
            ws.column_dimensions[get_column_letter(i)].width = 18
        ws.freeze_panes = "A2"
    cred_out.parent.mkdir(parents=True, exist_ok=True)
    wb.save(cred_out)
    counts = {r: sum(1 for u in users if u["role"] == r) for r in sheets}
    print("users:", counts, "routes:", len(routes), "territories:", len(terr))


if __name__ == "__main__":
    main()
