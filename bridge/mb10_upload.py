"""Explicit-upload-only bridge for MB10 raw exports.
1. Run mb10_export.py to generate mb10_attendance_local.json.
2. Configure environment MB10_API_URL=https://YOUR-STAGING.pages.dev/api/device-import
   and MB10_IMPORT_TOKEN (Cloudflare Pages encrypted secret).
3. Run mb10_upload.py --upload. Default is a local dry run.
Use only on an authorized machine. Never commit JSON or credentials.
"""
import json
import os
import sys
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse

INPUT = Path(__file__).resolve().parent / "mb10_attendance_local.json"

def main():
    if not INPUT.is_file():
        raise SystemExit("Missing local export. Run mb10_export.py first.")
    payload = json.loads(INPUT.read_text(encoding="utf-8"))
    items = payload.get("items", [])
    print("Local records:", len(items))
    if "--upload" not in sys.argv:
        print("Dry run: nothing uploaded. Use --upload after D1 migration and secret setup.")
        return
    endpoint = os.environ.get("MB10_API_URL", "").strip()
    token = os.environ.get("MB10_IMPORT_TOKEN", "")
    parsed = urlparse(endpoint)
    if parsed.scheme != "https" or not parsed.hostname or parsed.path != "/api/device-import":
        raise SystemExit("Set MB10_API_URL to HTTPS staging /api/device-import")
    if len(token) < 32:
        raise SystemExit("MB10_IMPORT_TOKEN must be set (32+ characters)")
    inserted = duplicates = 0
    for offset in range(0, len(items), 100):
        batch = items[offset:offset+100]
        body = json.dumps({"items": batch}, ensure_ascii=False).encode("utf-8")
        req = Request(endpoint, data=body, method="POST", headers={
            "Content-Type": "application/json", "Authorization": "Bearer " + token
        })
        try:
            with urlopen(req, timeout=30) as response:
                result = json.loads(response.read().decode("utf-8"))
        except HTTPError as e:
            raise SystemExit(f"Batch {offset//100+1}: HTTP {e.code}; check migration, secret and app deployment") from None
        except URLError as e:
            raise SystemExit(f"Batch {offset//100+1}: network failure: {e.reason}") from None
        inserted += result["inserted"]
        duplicates += result["duplicates"]
        print(f"Batch {offset//100+1}: inserted {result['inserted']}, duplicates {result['duplicates']}")
    print(f"Finished: inserted={inserted}, duplicates={duplicates}. No device deletion.")

if __name__ == "__main__":
    main()
