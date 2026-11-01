# Dawam Muyassar MB10 auto-sync (Windows) — stage only, v0.2.21.
# Run once as the same Windows user who created MB10_IMPORT_TOKEN.dpapi.
# The worker runs at Windows logon, including while the desktop is locked.
# It does NOT run when signed out or when the computer is off/asleep.
$ErrorActionPreference = 'Stop'
$taskName = 'DawamMuyassar-MB10-AutoSync'
$root = Join-Path $env:LOCALAPPDATA 'DawamMuyassar\MB10'
$keyFile = Join-Path $HOME 'MB10_IMPORT_TOKEN.dpapi'
$source = Join-Path (Join-Path $HOME 'Downloads') 'mb10_sync.py'
$destination = Join-Path $root 'mb10_sync.py'
$runnerFile = Join-Path $root 'run_mb10_autosync.ps1'

if (!(Test-Path -LiteralPath $keyFile)) {
    throw 'The encrypted MB10 token file is missing. Log in as the original Windows user and locate ~/MB10_IMPORT_TOKEN.dpapi.'
}
# Verify Windows DPAPI can decrypt under THIS account; do not print the token.
$secure = Get-Content -LiteralPath $keyFile -Raw | ConvertTo-SecureString
$credential = [System.Management.Automation.PSCredential]::new('MB10', $secure)
if ($credential.GetNetworkCredential().Password.Length -lt 32) {
    throw 'The local MB10 token is invalid.'
}
Remove-Variable credential, secure

if (!(Test-Path -LiteralPath $source)) {
    throw 'Please download the working mb10_sync.py into your Downloads folder before installing.'
}
$scriptText = Get-Content -LiteralPath $source -Raw
if (!$scriptText.Contains('DawamMuyassar-MB10Agent/') -or !$scriptText.Contains('--automatic-minutes') -or !$scriptText.Contains('get_attendance()')) {
    throw 'The Python script is not the verified MB10 version. Download the current working script first.'
}
$py = Get-Command py.exe -ErrorAction Stop
& $py.Source -c 'from zk import ZK'
if ($LASTEXITCODE -ne 0) {
    throw 'Python pyzk module is missing. Run: py -m pip install pyzk'
}
New-Item -ItemType Directory -Path $root -Force | Out-Null
Copy-Item -LiteralPath $source -Destination $destination -Force

$runner = @'
# MB10 supervised Windows task. Never prints or stores the plain token.
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'DawamMuyassar\MB10'
$keyFile = Join-Path $HOME 'MB10_IMPORT_TOKEN.dpapi'
$logFile = Join-Path $root 'sync.log'
$mutex = New-Object System.Threading.Mutex($false, 'Local\DawamMuyassarMB10AutoSync')
$owned = $false
try {
    try { $owned = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $owned = $true }
    if (!$owned) { exit 0 }
    if (Test-Path $logFile) {
        $logSize = (Get-Item -LiteralPath $logFile).Length
        if ($logSize -gt 2097152) {
            Copy-Item -LiteralPath $logFile -Destination ($logFile + '.previous') -Force
            Clear-Content -LiteralPath $logFile
        }
    }
    function Write-SyncLog($line) {
        $date = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        Add-Content -LiteralPath $logFile -Value ($date + ' ' + $line) -Encoding UTF8
    }
    Write-SyncLog 'MB10 Windows task started.'
    $secure = Get-Content -LiteralPath $keyFile -Raw | ConvertTo-SecureString
    $credential = [System.Management.Automation.PSCredential]::new('MB10', $secure)
    $env:MB10_IMPORT_TOKEN = $credential.GetNetworkCredential().Password
    Remove-Variable credential, secure
    if ($env:MB10_IMPORT_TOKEN.Length -lt 32) {
        throw 'Invalid local encrypted key.'
    }
    $env:DAWAM_STAGE_URL = 'https://dawam-muyassar-stage.pages.dev'
    $env:PYTHONUNBUFFERED = '1'
    $scriptPath = Join-Path $root 'mb10_sync.py'
    # Redirect to protected local log; the Python agent does not print credentials.
    & py.exe -u $scriptPath --ip '192.168.0.121' --agent --automatic-minutes 10 2>&1 | ForEach-Object {
        Write-SyncLog ([string]$_)
    }
    if ($LASTEXITCODE -ne 0) { throw ('MB10 agent exited with code ' + $LASTEXITCODE) }
} catch {
    # Never include secrets, environment variables, HTTP headers or request bodies.
    if ($_.Exception.Message -match 'token|key|credential') {
        if (Get-Command Write-SyncLog -ErrorAction SilentlyContinue) { Write-SyncLog 'MB10 task credential/configuration error.' }
    } else {
        if (Get-Command Write-SyncLog -ErrorAction SilentlyContinue) { Write-SyncLog ('MB10 agent stopped: ' + $_.Exception.GetType().Name) }
    }
    exit 1
} finally {
    Remove-Item Env:\MB10_IMPORT_TOKEN -ErrorAction SilentlyContinue
    if ($owned) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
'@
Set-Content -LiteralPath $runnerFile -Value $runner -Encoding UTF8

$account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $runnerFile + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $account
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host ('Installed and started: ' + $taskName)
Write-Host ('Windows user: ' + $account)
Write-Host ('Log: ' + (Join-Path $root 'sync.log'))
Write-Host 'Runs every 10 minutes while this Windows user is signed in and PC is awake.'
Write-Host 'No password or token was displayed. Do not run another manual agent simultaneously.'
