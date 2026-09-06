// Renders icon.svg to icon-192.png and icon-512.png, then checks that the
// result survives a maskable launcher mask.
//
//   npm run icons
//
// `sharp` is deliberately NOT in package.json. It is a large native dependency
// with nothing to do with the tests, and `npm install` here exists to run the
// tests. Install it only when you are changing the icon:
//
//   npm i --no-save sharp
//
// Nothing else in the project needs a build step, and this does not become one:
// the PNGs are committed, so a clone never has to run this.
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const SIZES = [192, 512];

// A maskable icon may be cropped to any shape inside the central 80% of the
// canvas -- a circle, a squircle, a rounded square, whichever the launcher
// prefers. Anything outside that circle is not guaranteed to survive.
const SAFE_FRACTION = 0.4;

let sharp;
try {
  sharp = require('sharp');
} catch (e) {
  console.error('This needs sharp, which is not installed (by design).\n');
  console.error('  npm i --no-save sharp\n');
  console.error('then run `npm run icons` again.');
  process.exit(1);
}

// Finds the bounding radius of everything that isn't the flat background, so
// the safe-zone rule is checked rather than trusted. Uses the corner pixel as
// the background reference: the artwork is full bleed on a solid field.
async function maskRadius(pngPath) {
  const { data, info } = await sharp(pngPath).raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const bg = [data[0], data[1], data[2]];
  const cx = (info.width - 1) / 2, cy = (info.height - 1) / 2;
  let worst = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * ch;
      // Tolerance absorbs the antialiasing that edges the flat shapes.
      if (Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) < 24) continue;
      const r = Math.hypot(x - cx, y - cy);
      if (r > worst) worst = r;
    }
  }
  return { radius: worst, size: info.width };
}

(async () => {
  const svgPath = path.join(DIR, 'icon.svg');
  if (!fs.existsSync(svgPath)) {
    console.error(`No icon.svg at ${svgPath}`);
    process.exit(1);
  }
  const svg = fs.readFileSync(svgPath);

  for (const size of SIZES) {
    const out = path.join(DIR, `icon-${size}.png`);
    await sharp(svg, { density: 384 })
      .resize(size, size)
      .png({ compressionLevel: 9, palette: true })
      .toFile(out);
    console.log(`icon-${size}.png  ${fs.statSync(out).size} bytes`);
  }

  const { radius, size } = await maskRadius(path.join(DIR, 'icon-512.png'));
  const limit = size * SAFE_FRACTION;
  const ok = radius <= limit;
  console.log(
    `\nmaskable safe zone: content reaches ${radius.toFixed(1)}px from centre, ` +
    `limit ${limit.toFixed(1)}px  ->  ${ok ? 'OK' : 'TOO BIG'}`
  );
  if (!ok) {
    console.error('\nA launcher mask will clip this. Shrink the artwork in icon.svg.');
    process.exit(1);
  }

  console.log('\nDon\'t forget: bump CACHE in sw.js before deploying (invariant 9).');
})();
