#!/usr/bin/env python3
"""Drop an R2 Data Catalog (Iceberg REST) table.

Counterpart to rename-table.py, for cleaning up superseded archives left behind
by a sink rebuild. Destructive — confirm the table's rows are recoverable
elsewhere (tenant D1 is the authoritative source for user/content/event) before
running, and prefer keeping prod archives (repo CLAUDE.md: prod 尽量不删除资源).

Usage: python3 drop-table.py <account_id> <bucket> <prefix> <table>
Reads the catalog token from R2_CATALOG_TOKEN (or analytics/.dev.vars).
"""
import os
import sys
import urllib.request
import urllib.error

account_id, bucket, prefix, table = sys.argv[1:5]

token = os.environ.get("R2_CATALOG_TOKEN")
if not token:
    vars_path = os.path.join(os.path.dirname(__file__), "..", ".dev.vars")
    with open(vars_path) as f:
        for line in f:
            if line.startswith("R2_CATALOG_TOKEN="):
                token = line.split("=", 1)[1].strip()
if not token:
    sys.exit("R2_CATALOG_TOKEN not found")

url = f"https://catalog.cloudflarestorage.com/{account_id}/{bucket}/v1/{prefix}/namespaces/uniscrm/tables/{table}?purgeRequested=true"
req = urllib.request.Request(url, method="DELETE", headers={
    "Authorization": f"Bearer {token}",
    # Cloudflare's edge rejects urllib's default UA with a 1010 error
    "User-Agent": "curl/8.7.1",
})
try:
    with urllib.request.urlopen(req) as res:
        print(f"{table}: HTTP {res.status}")
except urllib.error.HTTPError as e:
    print(f"{table}: HTTP {e.code} {e.read().decode()[:200]}")
    sys.exit(1)
