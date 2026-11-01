# Stop and unregister only the MB10 auto-sync Windows scheduled task.
# Does not delete biometric records, downloaded script, or DPAPI token.
$ErrorActionPreference = 'Stop'
$name = 'DawamMuyassar-MB10-AutoSync'
$task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($task) {
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Host 'MB10 automatic sync task disabled. Cloudflare records and local token remain untouched.'
} else {
    Write-Host 'No MB10 automatic sync task is registered.'
}
