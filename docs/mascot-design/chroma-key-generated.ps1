param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Destination
)

# The image generator emits RGB. Generate against a flat green field, then
# recover smooth alpha and remove green spill from antialiased edge pixels.
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;

public static class MascotChromaKey {
  private static int Byte(double value) {
    return Math.Max(0, Math.Min(255, (int)Math.Round(value)));
  }

  public static void Convert(string source, string destination) {
    const double bgR = 5, bgG = 251, bgB = 4;
    const double bgExcess = bgG - (bgR + bgB) / 2;
    using (var input = new Bitmap(source))
    using (var output = new Bitmap(input.Width, input.Height, PixelFormat.Format32bppArgb)) {
      for (int y = 0; y < input.Height; y++) {
        for (int x = 0; x < input.Width; x++) {
          Color pixel = input.GetPixel(x, y);
          double excess = pixel.G - (pixel.R + pixel.B) / 2.0;
          double opacity = 1 - excess / bgExcess;
          if (opacity < 0.12) {
            output.SetPixel(x, y, Color.Transparent);
            continue;
          }
          if (opacity > 0.98) opacity = 1;
          double bgPart = 1 - opacity;
          int r = Byte((pixel.R - bgPart * bgR) / opacity);
          int g = Byte((pixel.G - bgPart * bgG) / opacity);
          int b = Byte((pixel.B - bgPart * bgB) / opacity);
          output.SetPixel(x, y, Color.FromArgb(Byte(opacity * 255), r, g, b));
        }
      }
      using (var clean = new Bitmap(input.Width, input.Height, PixelFormat.Format32bppArgb)) {
        int[] neighbors = new int[9];
        for (int y = 0; y < input.Height; y++) {
          for (int x = 0; x < input.Width; x++) {
            Color pixel = output.GetPixel(x, y);
            if (pixel.A == 0) continue;
            int count = 0;
            for (int dy = -1; dy <= 1; dy++) {
              for (int dx = -1; dx <= 1; dx++) {
                int px = x + dx, py = y + dy;
                neighbors[count++] = px < 0 || py < 0 || px >= input.Width || py >= input.Height
                  ? pixel.A : output.GetPixel(px, py).A;
              }
            }
            Array.Sort(neighbors);
            int alpha = neighbors[4];
            if (alpha > 0) clean.SetPixel(x, y, Color.FromArgb(alpha, pixel.R, pixel.G, pixel.B));
          }
        }
        clean.Save(destination, ImageFormat.Png);
      }
    }
  }
}
'@

[MascotChromaKey]::Convert($Source, $Destination)
