const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
if (!fs.existsSync(edge)) {
  console.error('Edge executable not found at:', edge);
  process.exit(1);
}

const logoSvg = fs.readFileSync(path.resolve(__dirname, '../public/logo.svg'), 'utf8');

// Build an HTML page with canvas that renders the SVG and extracts PNG and WebP at various sizes
const htmlTemplate = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="background: transparent; margin: 0; padding: 0;">
<div id="output"></div>
<script>
async function run() {
  const svgText = ${JSON.stringify(logoSvg)};
  const blob = new Blob([svgText], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const img = new Image();

  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = url;
  });

  const sizes = [16, 32, 48, 64, 128, 256, 512];
  const results = {};

  for (const size of sizes) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
    results['png_' + size] = canvas.toDataURL('image/png');
    if (size === 512) {
      results['webp_512'] = canvas.toDataURL('image/webp');
    }
  }

  document.getElementById('output').innerText = '###START###' + JSON.stringify(results) + '###END###';
}
run();
</script>
</body>
</html>`;

const tempHtmlPath = path.resolve(__dirname, 'temp_raster.html');
fs.writeFileSync(tempHtmlPath, htmlTemplate, 'utf8');

console.log('Running Edge headless to rasterize SVG...');
const output = execFileSync(edge, [
  '--headless=new',
  '--dump-dom',
  '--virtual-time-budget=4000',
  'file:///' + tempHtmlPath.replace(/\\/g, '/')
], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });

fs.unlinkSync(tempHtmlPath);

// Extract JSON
const startToken = '###START###';
const endToken = '###END###';
const start = output.indexOf(startToken);
const end = output.indexOf(endToken);
if (start === -1 || end === -1) {
  console.error('Failed to find JSON markers in Edge output.');
  process.exit(1);
}

const jsonStr = output.substring(start + startToken.length, end);
const data = JSON.parse(jsonStr);

function dataUriToBuffer(uri) {
  const base64 = uri.split(',')[1];
  return Buffer.from(base64, 'base64');
}

// 1. Write public/logo.png (512x512)
const png512 = dataUriToBuffer(data.png_512);
fs.writeFileSync(path.resolve(__dirname, '../public/logo.png'), png512);
console.log('Wrote public/logo.png (', png512.length, 'bytes)');

// 2. Write public/logo.webp (512x512)
const webp512 = dataUriToBuffer(data.webp_512);
fs.writeFileSync(path.resolve(__dirname, '../public/logo.webp'), webp512);
console.log('Wrote public/logo.webp (', webp512.length, 'bytes)');

// 3. Build standard Windows ICO containing PNGs for 16x16, 32x32, 48x48
function createIco(pngBuffers) {
  const count = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const dirEntries = [];
  let offset = 6 + (16 * count);

  for (const item of pngBuffers) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(item.width >= 256 ? 0 : item.width, 0);
    entry.writeUInt8(item.height >= 256 ? 0 : item.height, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(item.buffer.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += item.buffer.length;
    dirEntries.push(entry);
  }

  return Buffer.concat([
    header,
    ...dirEntries,
    ...pngBuffers.map(p => p.buffer)
  ]);
}

const icoImages = [
  { width: 16, height: 16, buffer: dataUriToBuffer(data.png_16) },
  { width: 32, height: 32, buffer: dataUriToBuffer(data.png_32) },
  { width: 48, height: 48, buffer: dataUriToBuffer(data.png_48) }
];

const icoBuffer = createIco(icoImages);
fs.writeFileSync(path.resolve(__dirname, '../public/favicon.ico'), icoBuffer);
fs.writeFileSync(path.resolve(__dirname, '../public/logo.ico'), icoBuffer);
console.log('Wrote public/favicon.ico and public/logo.ico (', icoBuffer.length, 'bytes)');
console.log('All brand assets successfully updated to authentic Monolith design!');
