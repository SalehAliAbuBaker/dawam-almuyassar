# MB10 — phase 2 staging integration
This change prepares raw import only, NOT live automatic sync or payroll posting.

## Preconditions
1. Use only Cloudflare project `dawam-muyassar-stage`, branch `feature/dawam-0.2.0-foundation`, and D1 database `dawam-muyassar-stage-db` (binding `DB`).
2. Back up staging D1. Apply `migrations/0002_device_raw_punches.sql` **to staging** via Cloudflare D1 Console, or a correctly configured Wrangler remote migration.
3. In Cloudflare Pages, add encrypted secret `MB10_IMPORT_TOKEN` of 32+ random characters, redeploy.
4. Configure `MB10_API_URL` to `https://<staging-project>.pages.dev/api/device-import` and `MB10_IMPORT_TOKEN` as environment variables only on the authorized Windows PC. Never paste the secret in chat or commit it.
5. Run `bridge/mb10_export.py` (read-only) and verify local count; default `bridge/mb10_upload.py` is a dry run. Execute `bridge/mb10_upload.py --upload` only after verifying correct staging URL and database.
6. Re-run same upload to verify inserted=0 and duplicates=count. Confirm database counts and sample timestamps before building employee mapping.
7. Do not copy to `punch_events` or calculate payroll until device_user_id mapping, punch interpretation (0=in, 1=out, 255=unknown), incomplete-day review and test cases are validated.

Times remain exactly as captured on MB10 (local `Asia/Aden`). Arrival timestamps are separate. Never clear device logs. This API does not accept browser session cookies; it requires a distinct bearer secret.

## Example inspection SQL (D1 Console staging only)
```sql
SELECT COUNT(*) AS raw_count FROM device_raw_punches;
SELECT device_user_id, occurred_at_device, punch_code FROM device_raw_punches ORDER BY occurred_at_device DESC LIMIT 5;
```
