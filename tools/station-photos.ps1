# Saves the photographs the stations reproduce, downsized for the "Compare with photo" overlay,
# with the réseau crosses left in: they're part of the original frames.
#
# Usage: powershell -File tools/station-photos.ps1 <photos folder> <out folder> <frame id>...
#   e.g. tools/station-photos.ps1 reference/photos assets/photos AS11-40-5869 AS11-40-5875
param([string]$Photos, [string]$Out, [Parameter(ValueFromRemainingArguments = $true)][string[]]$Ids)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force $Out | Out-Null
# System.Drawing resolves relative paths against the process's directory, not PowerShell's.
$Photos = (Resolve-Path $Photos).Path
$Out = (Resolve-Path $Out).Path
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$params = New-Object System.Drawing.Imaging.EncoderParameters 1
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 84L
foreach ($id in $Ids) {
  $src = [System.Drawing.Image]::FromFile((Join-Path $Photos "${id}HR.jpg"))
  $h = 1200; $w = [int][Math]::Round($src.Width * $h / $src.Height)
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($src, 0, 0, $w, $h)
  $path = Join-Path $Out "$id.jpg"
  $bmp.Save($path, $codec, $params)
  $g.Dispose(); $bmp.Dispose(); $src.Dispose()
  Write-Output "$id -> $path ($([int]((Get-Item $path).Length / 1024)) KB)"
}
