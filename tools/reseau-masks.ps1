# Writes a mask for each Apollo Hasselblad scan that blanks out the réseau crosses: the 5 × 5 grid
# of fine black crosses etched on the camera's réseau plate, printed on every frame at the same
# place. Left in, feature matching and splat training would treat them as objects floating in
# front of every camera. Masks are white where the photo is used and black where it's ignored,
# the convention COLMAP (<image>.png) and Brush (masks/<image stem>.png) both read.
#
# Usage: powershell -File tools/reseau-masks.ps1 <photos folder> <COLMAP mask folder> <Brush mask folder>
param([string]$Photos, [string]$ColmapMasks, [string]$BrushMasks)

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class Reseau {
  // Grey levels of the image, 0..255.
  static byte[] Grey(Bitmap bmp, out int w, out int h) {
    w = bmp.Width; h = bmp.Height;
    var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
    var raw = new byte[data.Stride * h];
    Marshal.Copy(data.Scan0, raw, 0, raw.Length);
    bmp.UnlockBits(data);
    var g = new byte[w * h];
    for (int y = 0; y < h; y++)
      for (int x = 0; x < w; x++) {
        int q = y * data.Stride + x * 3;
        g[y * w + x] = (byte)((raw[q] * 29 + raw[q + 1] * 150 + raw[q + 2] * 77) >> 8);
      }
    return g;
  }

  // How clearly a thin dark cross is centred at (cx, cy): along each arm, how much darker the
  // line is than the pixels on both sides of it (an edge is darker than one side only). Clipped,
  // so one strong feature can't outweigh a whole arm.
  static double CrossScore(byte[] g, int w, int h, int cx, int cy, int arm) {
    if (cx < arm + 3 || cx >= w - arm - 3 || cy < arm + 3 || cy >= h - arm - 3) return 0;
    double sum = 0; int n = 0;
    for (int t = -arm; t <= arm; t++) {
      if (Math.Abs(t) < 4) continue; // the centre is often lost in the photo's detail
      int x = cx + t, y = cy + t;
      int lh = g[cy * w + x], ah = Math.Min(g[(cy - 3) * w + x], g[(cy + 3) * w + x]);
      int lv = g[y * w + cx], av = Math.Min(g[y * w + cx - 3], g[y * w + cx + 3]);
      sum += Math.Max(0, Math.Min(ah - lh, 30)) + Math.Max(0, Math.Min(av - lv, 30));
      n += 2;
    }
    return sum / n;
  }

  // Finds the grid (it's regular: find its origin and spacing once per frame) and writes the mask.
  public static string Mask(string imagePath, string outA, string outB) {
    using (var bmp = new Bitmap(imagePath)) {
      int w, h;
      var g = Grey(bmp, out w, out h);
      // The réseau pitch is 451.4 px on these ~2350 px scans (it comes out the same on nearly every
      // frame); a smaller scan scales it. Only the grid's offset varies with how each frame was cropped.
      double bs = 451.4 * Math.Min(1.0, w / 2349.0);
      double best = -1e9; double bx = 0, by = 0;
      int arm = (int)(bs * 0.08);
      for (int ox = -64; ox <= 64; ox += 2) {
        for (int oy = -64; oy <= 64; oy += 2) {
          double total = 0;
          for (int i = -2; i <= 2; i++)
            for (int j = -2; j <= 2; j++)
              total += CrossScore(g, w, h, (int)(w / 2.0 + ox + i * bs), (int)(h / 2.0 + oy + j * bs), arm);
          if (total > best) { best = total; bx = ox; by = oy; }
        }
      }
      // Refine each cross on its own (the plate and scan aren't perfectly regular), then mask it.
      using (var mask = new Bitmap(w, h, PixelFormat.Format24bppRgb))
      using (var gr = Graphics.FromImage(mask)) {
        gr.Clear(Color.White);
        int found = 0;
        for (int i = -2; i <= 2; i++) {
          for (int j = -2; j <= 2; j++) {
            int cx = (int)(w / 2.0 + bx + i * bs), cy = (int)(h / 2.0 + by + j * bs);
            double top = -1e9; int fx = cx, fy = cy;
            for (int dx = -8; dx <= 8; dx++)
              for (int dy = -8; dy <= 8; dy++) {
                double v = CrossScore(g, w, h, cx + dx, cy + dy, arm);
                if (v > top) { top = v; fx = cx + dx; fy = cy + dy; }
              }
            // Where a cross is lost in shadow, trust the grid rather than whatever scored best nearby.
            if (top > 4) found++;
            else { fx = cx; fy = cy; }
            int a = (int)(bs * 0.115), t = 8;
            gr.FillRectangle(Brushes.Black, fx - a, fy - t, 2 * a + 1, 2 * t + 1);
            gr.FillRectangle(Brushes.Black, fx - t, fy - a, 2 * t + 1, 2 * a + 1);
          }
        }
        mask.Save(outA, ImageFormat.Png);
        mask.Save(outB, ImageFormat.Png);
        return String.Format("{0}x{1} pitch {2:F1} offset ({3},{4}) crosses {5}/25", w, h, bs, bx, by, found);
      }
    }
  }
}
'@

New-Item -ItemType Directory -Force $ColmapMasks, $BrushMasks | Out-Null
Get-ChildItem -LiteralPath $Photos -Filter *.jpg | ForEach-Object {
  $r = [Reseau]::Mask($_.FullName, (Join-Path $ColmapMasks ($_.Name + '.png')), (Join-Path $BrushMasks ($_.BaseName + '.png')))
  Write-Output "$($_.Name): $r"
}
