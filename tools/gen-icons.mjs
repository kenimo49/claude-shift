// SVG → PNG (16/48/128) を生成
import sharp from "sharp";
import { readFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const iconsDir = join(root, "extension", "icons");
const svgPath = join(iconsDir, "icon.svg");
const svgBuffer = readFileSync(svgPath);
const sizes = [16, 48, 128];

for (const size of sizes) {
  const out = join(iconsDir, `icon${size}.png`);
  await sharp(svgBuffer, { density: 384 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(out);
  console.log(`Generated: ${out}`);
}
