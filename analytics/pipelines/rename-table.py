#!/usr/bin/env python3
"""Rename an R2 Data Catalog (Iceberg REST) table aside.

Sinks refuse to write to existing tables, so a rebuild renames the old table
to keep its data (see memory: pipeline sink rename, don't drop).

Usage: python3 rename-table.py <account_id> <bucket> <prefix> <src_table> <dst_table>
Reads the catalog token from R2_CATALOG_TOKEN (or analytics/.dev.vars).
"""
import json
import os
import sys
import urllib.request

account_id, bucket, prefix, src, dst = sys.argv[1:6]

token = os.environ.get("R2_CATALOG_TOKEN")
if not token:
    vars_path = os.path.join(os.path.dirname(__file__), "..", ".dev.vars")
    with open(vars_path) as f:
        for line in f:
            if line.startswith("R2_CATALOG_TOKEN="):
                token = line.split("=", 1)[1].strip()
if not token:
    sys.exit("R2_CATALOG_TOKEN not found")

url = f"https://catalog.cloudflarestorage.com/{account_id}/{bucket}/v1/{prefix}/tables/rename"
body = json.dumps({
    "source": {"namespace": ["uniscrm"], "name": src},
    "destination": {"namespace": ["uniscrm"], "name": dst},
}).encode()

req = urllib.request.Request(url, data=body, method="POST", headers={
    "Authorization": f"Bearer {token}",
    "Content-Type": "application/json",
    # Cloudflare's edge rejects urllib's default UA with a 1010 error
    "User-Agent": "curl/8.7.1",
})
try:
    with urllib.request.urlopen(req) as res:
        print(f"HTTP {res.status}")
        print(res.read().decode() or "(empty body)")
except urllib.error.HTTPError as e:
    print(f"HTTP {e.code}")
    print(e.read().decode())
    sys.exit(1)
