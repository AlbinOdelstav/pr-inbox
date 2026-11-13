param([switch]$OnTop)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 4477
$profileDir = Join-Path $env:LOCALAPPDATA 'pr-inbox-widget'
$browser = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
$browserExe = Split-Path -Leaf $browser
$config = try { Get-Content (Join-Path $here 'config.json') -Raw -ErrorAction Stop | ConvertFrom-Json } catch { $null }
$appId = if ($config.appId) { $config.appId } else { 'PrInbox.Widget' }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Win {
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint flags);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
}
'@

function Find-Widget {
    Get-CimInstance Win32_Process -Filter "Name='$browserExe'" |
        Where-Object { $_.CommandLine -like "*pr-inbox-widget*" } |
        ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } |
        Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match 'Reviews$' } |
        Select-Object -First 1
}

Start-Process powershell -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$here\run-server.ps1`"" -WindowStyle Hidden
if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
    for ($i = 0; $i -lt 40 -and -not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue); $i++) {
        Start-Sleep -Milliseconds 250
    }
}

$widget = Find-Widget
if (-not $widget) {
    Add-Type -AssemblyName System.Windows.Forms
    $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $x = $area.Right - 360; $y = $area.Bottom - 500
    Start-Process $browser -ArgumentList "--app=http://localhost:$port/widget", "--user-data-dir=`"$profileDir`"",
        '--no-first-run', '--no-default-browser-check', '--disable-sync', '--window-size=340,480', "--window-position=$x,$y"
    for ($i = 0; $i -lt 60 -and -not $widget; $i++) { Start-Sleep -Milliseconds 250; $widget = Find-Widget }
}
if (-not $widget) { Write-Error 'The widget window did not appear'; exit 1 }

try {
    Add-Type -Path (Join-Path $here 'appid.cs')
    $relaunch = "`"$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$here\widget.ps1`""
    [AppId]::SetWindow($widget.MainWindowHandle, $appId, $relaunch, 'PR inbox widget', "$here\widget.ico,0")
} catch {
    Write-Warning "Could not set the taskbar identity: $_"
}

$after = if ($OnTop) { [IntPtr]-1 } else { [IntPtr]-2 }
[Win]::ShowWindow($widget.MainWindowHandle, 9) | Out-Null
[Win]::SetWindowPos($widget.MainWindowHandle, $after, 0, 0, 0, 0, 0x0003) | Out-Null
[Win]::SetForegroundWindow($widget.MainWindowHandle) | Out-Null
