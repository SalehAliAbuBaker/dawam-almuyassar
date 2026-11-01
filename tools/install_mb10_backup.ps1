# Dawam Muyassar MB10 hot-standby installer — stage 0.2.23, Windows user excmanager.
# First invocation generates a separate DPAPI-protected backup credential and
# copies it to the clipboard for ONE-TIME setup in Cloudflare Pages.
# Re-run ONLY after adding MB10_BACKUP_TOKEN to the stage project's secrets.
$ErrorActionPreference = 'Stop'
if ($env:USERNAME -ine 'excmanager') {
    throw 'Sign in to Windows as excmanager before installing the backup task.'
}
$taskName = 'DawamMuyassar-MB10-Backup'
$root = Join-Path $env:LOCALAPPDATA 'DawamMuyassar\MB10Backup'
$keyFile = Join-Path $HOME 'MB10_BACKUP_TOKEN.dpapi'
$source = Join-Path (Join-Path $HOME 'Downloads') 'mb10_sync.py'
$destination = Join-Path $root 'mb10_sync.py'
$runnerFile = Join-Path $root 'run_mb10_backup.ps1'
New-Item -ItemType Directory -Path $root -Force | Out-Null

if (!(Test-Path -LiteralPath $keyFile)) {
    $bytes = New-Object byte[] 48
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
    $secure = ConvertTo-SecureString $token -AsPlainText -Force
    $secure | ConvertFrom-SecureString | Set-Content -LiteralPath $keyFile -Encoding Ascii -NoNewline
    try {
        Set-Clipboard -Value $token
        Write-Host 'New backup secret copied ONCE to the Windows clipboard.'
    } catch {
        Write-Host ('Copy this backup secret into Cloudflare ONCE: ' + $token)
    }
    Remove-Variable token, secure
    Write-Host 'Stage Cloudflare Pages > Settings > Variables and Secrets: set MB10_BACKUP_TOKEN.'
    Write-Host 'Redeploy the STAGE project (never production). Clear the clipboard afterward.'
    Write-Host 'Run this installer AGAIN to register and start the backup task.'
    return
}

if (!(Test-Path -LiteralPath $source)) {
    throw 'Download tools/mb10_sync.py (stage 0.2.23+) to Downloads first.'
}
$scriptText = Get-Content -LiteralPath $source -Raw
if (!$scriptText.Contains('--agent-id') -or !$scriptText.Contains('MB10_BACKUP_TOKEN') -or !$scriptText.Contains('get_attendance()')) {
    throw 'An old Python script was found. Download stage tools/mb10_sync.py again.'
}
$py = Get-Command py.exe -ErrorAction Stop
& $py.Source -c 'from zk import ZK'
if ($LASTEXITCODE -ne 0) { throw 'Python pyzk is not installed for this Windows account.' }
$secure = Get-Content -LiteralPath $keyFile -Raw | ConvertTo-SecureString
$credential = [System.Management.Automation.PSCredential]::new('MB10Backup', $secure)
if ($credential.GetNetworkCredential().Password.Length -lt 32) {
    throw 'Encrypted backup credential is invalid.'
}
Remove-Variable credential, secure
Copy-Item -LiteralPath $source -Destination $destination -Force

$runner = @'
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'DawamMuyassar\MB10Backup'
$keyFile = Join-Path $HOME 'MB10_BACKUP_TOKEN.dpapi'
$logFile = Join-Path $root 'backup-sync.log'
$mutex = [System.Threading.Mutex]::new($false, 'Local\DawamMuyassarMB10Backup')
$owned = $false
try {
    try { $owned = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $owned = $true }
    if (!$owned) { exit 0 }
    if (Test-Path -LiteralPath $logFile) {
        if ((Get-Item -LiteralPath $logFile).Length -gt 2097152) {
            Copy-Item -LiteralPath $logFile -Destination ($logFile + '.previous') -Force
            Clear-Content -LiteralPath $logFile
        }
    }
    function Write-SyncLog($line) {
        Add-Content -LiteralPath $logFile -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss')+' '+$line) -Encoding UTF8
    }
    Write-SyncLog 'MB10 standby task started.'
    $secure = Get-Content -LiteralPath $keyFile -Raw | ConvertTo-SecureString
    $credential = [System.Management.Automation.PSCredential]::new('MB10Backup',$secure)
    $env:MB10_BACKUP_TOKEN = $credential.GetNetworkCredential().Password
    Remove-Variable credential, secure
    if ($env:MB10_BACKUP_TOKEN.Length -lt 32) { throw 'Invalid backup credential.' }
    $env:DAWAM_STAGE_URL = 'https://dawam-muyassar-stage.pages.dev'
    $env:PYTHONUNBUFFERED = '1'
    & py.exe -u (Join-Path $root 'mb10_sync.py') --ip '192.168.0.121' --port 4370 --agent --agent-id backup --automatic-minutes 10 2>&1 | ForEach-Object {
        Write-SyncLog ([string]$_)
    }
    if ($LASTEXITCODE -ne 0) { throw ('Backup agent exited with code '+$LASTEXITCODE) }
} catch {
    if (Get-Command Write-SyncLog -ErrorAction SilentlyContinue) {
        Write-SyncLog ('MB10 standby stopped: '+$_.Exception.GetType().Name)
    }
    exit 1
} finally {
    Remove-Item Env:\MB10_BACKUP_TOKEN -ErrorAction SilentlyContinue
    if ($owned) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
'@
Set-Content -LiteralPath $runnerFile -Value $runner -Encoding UTF8
$account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $runnerFile + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $account
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host ('Installed and started: '+$taskName)
Write-Host ('Windows user: '+$account)
Write-Host ('Log file: '+(Join-Path $root 'backup-sync.log'))
Write-Host 'The backup only claims jobs when the primary is offline or cannot reach MB10.'
Write-Host 'Leave Windows signed in and lock the desktop; no daily PowerShell is necessary.'
