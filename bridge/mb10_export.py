"""Read-only ZKTeco MB10 diagnostic export for Dawam Al-Muyassar.
No cloud upload; does not modify or clear device logs. Requires pyzk.
Run: python bridge/mb10_export.py
Optional environment variables: MB10_IP (default 192.168.0.121), MB10_PORT (4370).
Exports a local JSON file containing personal attendance data: protect and delete it after use.
"""
import hashlib
import json
import os
from datetime import datetime
from pathlib import Path
from zk import ZK

IP = os.environ.get("MB10_IP", "192.168.0.121")
PORT = int(os.environ.get("MB10_PORT", "4370"))
OUT = Path(__file__).resolve().parent / "mb10_attendance_local.json"

def fingerprint(device_user_id, stamp, status, punch):
    # Stable per-device digest for deduplication; device id is recorded separately.
    blob = json.dumps([device_user_id, stamp, status, punch], separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()

def main():
    conn = None
    try:
        conn = ZK(IP, port=PORT, timeout=10, password=0).connect()
        records = conn.get_attendance() or []
        items = []
        for rec in records:
            stamp = rec.timestamp.strftime("%Y-%m-%dT%H:%M:%S")
            user = str(rec.user_id)
            status = int(rec.status) if rec.status is not None else None
            punch = int(rec.punch) if rec.punch is not None else None
            items.append({
                "event_fingerprint": fingerprint(user, stamp, status, punch),
                "device_user_id": user, "occurred_at_device": stamp,
                "status_code": status, "punch_code": punch,
            })
        items.sort(key=lambda r: (r["occurred_at_device"], r["device_user_id"]))
        payload = {"device_ip": IP, "time_authority": "device",
                   "timezone": "Asia/Aden", "exported_at": datetime.now().isoformat(),
                   "count": len(items), "items": items}
        OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Read {len(items)} records; local export written to {OUT}")
        print("Nothing was uploaded, changed, or deleted on the device.")
    finally:
        if conn is not None:
            conn.disconnect()

if __name__ == "__main__":
    main()
