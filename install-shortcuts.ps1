$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$config = try { Get-Content (Join-Path $here 'config.json') -Raw -ErrorAction Stop | ConvertFrom-Json } catch { $null }
$appId = if ($config.appId) { $config.appId } else { 'PrInbox.Widget' }
$powershell = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$browser = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1

Add-Type -Path (Join-Path $here 'appid.cs')
$shell = New-Object -ComObject WScript.Shell

foreach ($folder in [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Startup')) {
    $path = Join-Path $folder 'PR inbox widget.lnk'
    $link = $shell.CreateShortcut($path)
    $link.TargetPath = $powershell
    $link.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$here\widget.ps1`""
    $link.WorkingDirectory = $here
    $link.WindowStyle = 7
    $link.IconLocation = "$here\widget.ico,0"
    $link.Description = 'Starts the PR review inbox server and widget'
    $link.Save()
    [AppId]::SetShortcut($path, $appId)
    $path
}
