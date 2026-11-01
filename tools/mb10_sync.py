"""Read-only ZKTeco MB10 collection and optional HTTPS import into Dawam stage.
Python 3.14 / pyzk 0.9. No device deletions, edits, clock changes or disable.
Configured via environment variables; secrets are never committed.
"""
import argparse
import hashlib
import json
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime
from zk import ZK

# Cloudflare Pages may block the standard Python-urllib User-Agent with HTTP 403/1010.
# Use an explicit application identity on every HTTPS call, retaining Bearer auth.
USER_AGENT = 'DawamMuyassar-MB10Agent/0.2.23 (+https://dawam-muyassar-stage.pages.dev)'

def collect(ip, port, password):
    zk = ZK(ip, port=port, timeout=15, password=password, force_udp=False, ommit_ping=False)
    connection = zk.connect()
    try:
        entries = connection.get_attendance() or []
        unique = {}
        for rec in entries:
            device_user_id = str(rec.user_id)
            dt = rec.timestamp.strftime('%Y-%m-%dT%H:%M:%S')
            status = rec.status if isinstance(rec.status, int) and 0 <= rec.status <= 255 else None
            punch = rec.punch if isinstance(rec.punch, int) and 0 <= rec.punch <= 255 else None
            # Stable fingerprint independent of the order returned by the device.
            key = json.dumps([device_user_id, dt, status, punch], ensure_ascii=False, separators=(',', ':'))
            fingerprint = hashlib.sha256(('mb10-main|' + key).encode('utf-8')).hexdigest()
            unique[fingerprint] = dict(device_user_id=device_user_id, occurred_at_device=dt,
                                       status_code=status, punch_code=punch,
                                       event_fingerprint=fingerprint)
        return sorted(unique.values(), key=lambda x: (x['occurred_at_device'], x['device_user_id']))
    finally:
        connection.disconnect()

def main():
    parser = argparse.ArgumentParser(description="ZKTeco MB10 -> Dawam stage")
    parser.add_argument('--ip', default='192.168.0.121')
    parser.add_argument('--port', type=int, default=4370)
    parser.add_argument('--from-date', help='YYYY-MM-DD; only export movements from this date')
    parser.add_argument('--upload', action='store_true', help='Send raw punches to configured HTTPS stage API')
    parser.add_argument('--agent', action='store_true', help='Listen for requests from Dawam app')
    parser.add_argument('--agent-id', choices=('primary', 'backup'), default='primary', help='Unique role for this PC; secondary PC uses backup')
    parser.add_argument('--automatic-minutes', type=int, default=0,
                        help='When running --agent, auto-sync at this interval (e.g. 10); zero disables')
    args = parser.parse_args()
    if args.automatic_minutes < 0 or args.automatic_minutes > 1440:
        parser.error('--automatic-minutes must be between 0 and 1440')
    if args.automatic_minutes and not args.agent:
        parser.error('--automatic-minutes requires --agent')
    password = int(os.environ.get('MB10_COM_PASSWORD', '0'))
    if args.agent:
        return agent(args, password)
    items = collect(args.ip, args.port, password)
    if args.from_date:
        datetime.strptime(args.from_date, '%Y-%m-%d')
        items = [x for x in items if x['occurred_at_device'][:10] >= args.from_date]
    print(f"Device read OK; selected unique punches: {len(items)}")
    if items:
        print('Latest:', items[-1]['device_user_id'], items[-1]['occurred_at_device'])
    if not args.upload:
        print('Read-only mode: nothing uploaded. Use --upload once configured.')
        return
    base = os.environ.get('DAWAM_STAGE_URL', '').rstrip('/')
    token = os.environ.get('MB10_IMPORT_TOKEN' if args.agent_id == 'primary' else 'MB10_BACKUP_TOKEN', '')
    if not base.startswith('https://') or len(token) < 32:
        raise SystemExit('Set DAWAM_STAGE_URL (https) and MB10_IMPORT_TOKEN (32+ characters) in local environment.')
    total = 0
    duplicates = 0
    for offset in range(0, len(items), 100):
        batch = items[offset:offset + 100]
        data = json.dumps({'items': batch}).encode('utf-8')
        request = urllib.request.Request(base + '/api/device-import', data=data, method='POST',
            headers={'Content-Type':'application/json', 'Authorization':'Bearer '+token,
                     'User-Agent': USER_AGENT, 'X-MB10-Agent-ID':args.agent_id,
                     'Accept': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                result = json.load(response)
        except urllib.error.HTTPError as exc:
            raise SystemExit(f'Import HTTP {exc.code}; check stage endpoint, token, and D1 migration.') from None
        total += result.get('inserted', 0)
        duplicates += result.get('duplicates', 0)
    print(f'Upload completed. New: {total}; existing: {duplicates}; selected: {len(items)}')

def request_json(base, token, suffix, payload=None, agent_id='primary', device_ready=True):
    data = json.dumps(payload).encode('utf-8') if payload is not None else None
    req = urllib.request.Request(base + '/api/' + suffix, data=data,
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
                 'User-Agent': USER_AGENT, 'Accept': 'application/json',
                 'X-MB10-Agent-ID': agent_id, 'X-MB10-Device-Ready': '1' if device_ready else '0'},
        method='POST' if data is not None else 'GET')
    with urllib.request.urlopen(req, timeout=35) as response:
        return json.load(response)

def device_available(ip, port):
    """TCP preflight only: do not touch device configuration or attendance data."""
    try:
        with socket.create_connection((ip, port), timeout=3):
            return True
    except OSError:
        return False

def agent(args, password):
    base = os.environ.get('DAWAM_STAGE_URL', '').rstrip('/')
    key_name = 'MB10_IMPORT_TOKEN' if args.agent_id == 'primary' else 'MB10_BACKUP_TOKEN'
    token = os.environ.get(key_name, '')
    if not base.startswith('https://') or len(token) < 32:
        raise SystemExit(f'Missing DAWAM_STAGE_URL (https) / {key_name} (32+ chars)')
    print(f'MB10 {args.agent_id} agent is running. Ctrl+C stops it.', flush=True)
    if args.automatic_minutes:
        print(f'Automatic sync request every {args.automatic_minutes} minutes when active.', flush=True)
    last_auto = None
    last_probe = 0.0
    ready = False
    while True:
        job_id = None
        completed = False
        stop_heartbeat = None
        heartbeat_thread = None
        try:
            # A standby agent MUST report local connectivity before it can claim jobs.
            if time.monotonic() - last_probe >= 15 or last_probe == 0:
                ready = device_available(args.ip, args.port)
                last_probe = time.monotonic()
            if args.automatic_minutes and ready and (last_auto is None or
                    time.monotonic() - last_auto >= args.automatic_minutes * 60):
                result = request_json(base, token, 'mb10-agent', {'action': 'schedule'},
                                      agent_id=args.agent_id, device_ready=ready)
                last_auto = time.monotonic()
                if result.get('scheduled'):
                    print('Automatic sync queued by', args.agent_id, flush=True)
            data = request_json(base, token, 'mb10-agent',
                                agent_id=args.agent_id, device_ready=ready)
            job = data.get('job') or {}
            job_id = job.get('id')
            if job_id:
                print('Claimed sync:', job_id, 'on', args.agent_id, flush=True)
                stop_heartbeat = threading.Event()
                lost_lease = threading.Event()

                def heartbeat():
                    while not stop_heartbeat.wait(15):
                        try:
                            request_json(base, token, 'mb10-agent',
                                         {'action': 'heartbeat', 'id': job_id},
                                         agent_id=args.agent_id, device_ready=ready)
                        except urllib.error.HTTPError as exc:
                            if exc.code in (401, 403, 409):
                                lost_lease.set()
                                return
                        except Exception:
                            # Network issues do not justify deleting or clearing device logs.
                            pass

                heartbeat_thread = threading.Thread(target=heartbeat, daemon=True)
                heartbeat_thread.start()
                items = collect(args.ip, args.port, password)
                if lost_lease.is_set():
                    raise RuntimeError('Sync ownership expired; cancelling the upload')
                inserted = duplicates = 0
                for offset in range(0, len(items), 100):
                    # Ensure the server still recognizes THIS PC as the job owner.
                    request_json(base, token, 'mb10-agent',
                                 {'action': 'heartbeat', 'id': job_id},
                                 agent_id=args.agent_id, device_ready=True)
                    if lost_lease.is_set():
                        raise RuntimeError('Sync ownership lost; cancelling the upload')
                    result = request_json(base, token, 'device-import',
                                          {'items': items[offset:offset + 100]},
                                          agent_id=args.agent_id, device_ready=True)
                    inserted += result.get('inserted', 0)
                    duplicates += result.get('duplicates', 0)
                stop_heartbeat.set()
                heartbeat_thread.join(timeout=3)
                request_json(base, token, 'mb10-agent',
                             {'id': job_id, 'status': 'success',
                              'inserted': inserted, 'duplicates': duplicates},
                             agent_id=args.agent_id, device_ready=True)
                completed = True
                print('Done; new:', inserted, 'duplicates:', duplicates, flush=True)
        except KeyboardInterrupt:
            print('Agent stopped.')
            return
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                print(f'Sync request rejected (HTTP {exc.code}). Check matching stage '
                      'secret, PC identity, and Cloudflare policy.', flush=True)
                raise SystemExit(1)
            print(f'Sync HTTP error: {exc.code} {exc.reason}', flush=True)
        except Exception as exc:
            print('Sync error:', type(exc).__name__, str(exc)[:200], flush=True)
        finally:
            if stop_heartbeat:
                stop_heartbeat.set()
            if heartbeat_thread and heartbeat_thread.is_alive():
                heartbeat_thread.join(timeout=3)
            if job_id and not completed:
                # A lost lease cannot be marked successful by an old runner.
                # If the server is unreachable it will expire the job safely.
                try:
                    request_json(base, token, 'mb10-agent',
                                 {'id': job_id, 'status': 'error',
                                  'error': 'تعذر إتمام قراءة الجهاز أو رفع الحركات'},
                                 agent_id=args.agent_id, device_ready=ready)
                except Exception:
                    pass
        time.sleep(5)

if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('Error:', exc, file=sys.stderr)
        sys.exit(1)
