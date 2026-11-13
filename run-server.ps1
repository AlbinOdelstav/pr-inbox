$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 4477
$log = Join-Path $here 'server.log'

$mutex = New-Object System.Threading.Mutex($false, 'Local\pr-inbox-server-supervisor')
if (-not $mutex.WaitOne(0)) { exit 0 }

try {
    while ($true) {
        if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
            Start-Sleep -Seconds 10
            continue
        }
        Add-Content -Path $log -Value "$(Get-Date -Format s) starting server"
        $p = Start-Process node -ArgumentList "`"$here\server.mjs`"", '--no-open' -WindowStyle Hidden -PassThru `
            -RedirectStandardError (Join-Path $here 'server.err.log')
        $null = $p.Handle
        $p.WaitForExit()
        Add-Content -Path $log -Value "$(Get-Date -Format s) server exited with code $($p.ExitCode), restarting in 3 s"
        Start-Sleep -Seconds 3
    }
} finally {
    $mutex.ReleaseMutex()
}
