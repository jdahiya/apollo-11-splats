# Adds what moved between photos to the training masks: Aldrin, the photographer's own shadow,
# the core tube (driven in and pulled out again) and lens flares. Their outlines are in
# transients.json, drawn by hand, as polygons in 0..1 image coordinates. Masked pixels are left
# out of training, so these don't turn into ghosts. Run after reseau-masks.ps1.
#
# Usage: powershell -File tools/paint-transients.ps1 <COLMAP mask folder> <Brush mask folder>
param([string]$ColmapMasks, [string]$BrushMasks)

Add-Type -AssemblyName System.Drawing
$shapes = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'transients.json') | ConvertFrom-Json
foreach ($entry in $shapes.PSObject.Properties) {
  $name = $entry.Name
  $stem = [IO.Path]::GetFileNameWithoutExtension($name)
  foreach ($path in @((Join-Path $ColmapMasks "$name.png"), (Join-Path $BrushMasks "$stem.png"))) {
    if (-not (Test-Path -LiteralPath $path)) { continue }
    # Load a copy so the file isn't locked while it's rewritten.
    $bytes = [IO.File]::ReadAllBytes($path)
    $stream = New-Object IO.MemoryStream (, $bytes)
    $src = [System.Drawing.Image]::FromStream($stream)
    $mask = New-Object System.Drawing.Bitmap $src.Width, $src.Height, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = [System.Drawing.Graphics]::FromImage($mask)
    $g.DrawImage($src, 0, 0, $src.Width, $src.Height)
    $src.Dispose(); $stream.Dispose()
    foreach ($poly in $entry.Value) {
      $points = [System.Drawing.PointF[]]($poly | ForEach-Object { New-Object System.Drawing.PointF ([float]($_[0] * $mask.Width)), ([float]($_[1] * $mask.Height)) })
      $g.FillPolygon([System.Drawing.Brushes]::Black, $points)
    }
    $g.Dispose()
    $mask.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $mask.Dispose()
  }
  Write-Output "$name`: $(@($entry.Value).Count) shape(s)"
}
