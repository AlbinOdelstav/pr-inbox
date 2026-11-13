param([string]$Out = (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'widget.ico'))

Add-Type -AssemblyName System.Drawing

function New-IconPng([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.PixelOffsetMode = 'HighQuality'
    $g.Clear([System.Drawing.Color]::Transparent)

    $pad = [Math]::Max(0.5, $size * 0.03)
    $rect = New-Object System.Drawing.RectangleF $pad, $pad, ($size - 2 * $pad), ($size - 2 * $pad)
    $r = $rect.Width * 0.28
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($rect.X, $rect.Y, 2 * $r, 2 * $r, 180, 90)
    $path.AddArc($rect.Right - 2 * $r, $rect.Y, 2 * $r, 2 * $r, 270, 90)
    $path.AddArc($rect.Right - 2 * $r, $rect.Bottom - 2 * $r, 2 * $r, 2 * $r, 0, 90)
    $path.AddArc($rect.X, $rect.Bottom - 2 * $r, 2 * $r, 2 * $r, 90, 90)
    $path.CloseFigure()

    $from = [System.Drawing.Color]::FromArgb(255, 0x6d, 0x5e, 0xfc)
    $to = [System.Drawing.Color]::FromArgb(255, 0x9b, 0x6b, 0xff)
    $fill = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $from, $to, 45.0
    $g.FillPath($fill, $path)

    $shine = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(46, 255, 255, 255)), ([System.Drawing.Color]::FromArgb(0, 255, 255, 255)), 90.0
    $g.FillPath($shine, $path)

    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), ([Math]::Max(1.6, $size * 0.105))
    $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
    $s = $size / 32.0
    $points = [System.Drawing.PointF[]]@(
        (New-Object System.Drawing.PointF (9.5 * $s), (16.8 * $s)),
        (New-Object System.Drawing.PointF (14.0 * $s), (21.2 * $s)),
        (New-Object System.Drawing.PointF (22.5 * $s), (11.2 * $s)))
    $g.DrawLines($pen, $points)

    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    , $ms.ToArray()
}

$sizes = 16, 20, 24, 32, 40, 48, 64, 128, 256
$images = foreach ($size in $sizes) { , (New-IconPng $size) }

$file = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $file
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $dim = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
    $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([UInt16]1); $w.Write([UInt16]32)
    $w.Write([UInt32]$images[$i].Length); $w.Write([UInt32]$offset)
    $offset += $images[$i].Length
}
foreach ($img in $images) { $w.Write($img) }
$w.Flush()
[System.IO.File]::WriteAllBytes($Out, $file.ToArray())
[System.IO.File]::WriteAllBytes([System.IO.Path]::ChangeExtension($Out, '.png'), $images[-1])
$Out
