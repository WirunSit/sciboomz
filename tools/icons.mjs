// Home-screen icons (phones: "Add to Home Screen" opens the game full screen)
// made from the logo on the game's dark blue. Usage: node tools/icons.mjs
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

const out = new URL('../client/public/icons/', import.meta.url);
mkdirSync(out, { recursive: true });
const logo = new URL('../client/public/assets/ui/logo.png', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
for (const size of [180, 192, 512]) {
  // The logo fills 84% of the square (room for the rounded mask phones put on icons)
  const inner = Math.round(size * 0.84);
  const art = await sharp(logo).resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: '#1b1d3a' } })
    .composite([{ input: art, gravity: 'center' }])
    .png()
    .toFile(new URL(`icon-${size}.png`, out).pathname.replace(/^\/(\w:)/, '$1'));
  console.log(`icons/icon-${size}.png`);
}
