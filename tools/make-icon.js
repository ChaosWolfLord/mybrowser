// Renders icon.svg / icon-small.svg into icon.ico.
//
//   npx electron tools/make-icon.js
//
// Electron does the rasterising because it is already a dependency and it is
// the same engine that draws the app, so what lands in the .ico is exactly
// what the SVG looks like in the browser itself. No image toolchain needed.
//
// Small sizes use a separate, simplified drawing: at 16px the detailed one
// collapses into a brown smudge, because a 3.5px rim and a 19px blur have
// nowhere left to go. An .ico stores a different image per size, so use it.

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'icon.ico');
const CAPTURE_AT = 512;   // captured once per drawing, then scaled down

// Which drawing supplies which sizes.
const PLAN = [
  { svg: 'icon.svg', sizes: [256, 128, 64, 48] },
  { svg: 'icon-small.svg', sizes: [32, 24, 16] }
];

function tempPageFor(svgFile) {
  const svg = fs.readFileSync(path.join(ROOT, svgFile), 'utf-8');
  const html =
    '<!doctype html><meta charset="utf-8">' +
    '<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}' +
    'svg{display:block;width:100vw;height:100vh}</style>' + svg;
  const file = path.join(os.tmpdir(), 'mybrowser-icon-' + path.parse(svgFile).name + '.html');
  fs.writeFileSync(file, html, 'utf-8');
  return file;
}

// One window for the whole job, reloaded between drawings. Creating a
// second transparent window fails with ERR_FAILED however the page is
// supplied, so the window is made once and reused.
function makeWindow() {
  return new BrowserWindow({
    width: CAPTURE_AT,
    height: CAPTURE_AT,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,        // keeps the rounded corners actually round
    backgroundColor: '#00000000'
  });
}

async function capture(win, svgFile) {
  const page = tempPageFor(svgFile);
  try {
    await win.loadFile(page);
    // The blur filters are not finished at did-finish-load.
    await new Promise((r) => setTimeout(r, 300));
    let image = await win.webContents.capturePage();
    if (image.getSize().width !== CAPTURE_AT) {
      image = image.resize({ width: CAPTURE_AT, height: CAPTURE_AT, quality: 'best' });
    }
    return image;
  } finally {
    try { fs.unlinkSync(page); } catch (err) { /* temp file, never mind */ }
  }
}

// ICO container. Entries are PNG-compressed, which Windows has accepted
// since Vista and which keeps the alpha channel intact.
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);            // reserved
  header.writeUInt16LE(1, 2);            // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;

  entries.forEach((entry, i) => {
    const at = i * 16;
    // 256 is written as 0; the field is only one byte wide.
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, at);
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, at + 1);
    dir.writeUInt8(0, at + 2);           // palette size
    dir.writeUInt8(0, at + 3);           // reserved
    dir.writeUInt16LE(1, at + 4);        // colour planes
    dir.writeUInt16LE(32, at + 6);       // bits per pixel
    dir.writeUInt32LE(entry.png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([header, dir].concat(entries.map((e) => e.png)));
}

app.whenReady().then(async () => {
  try {
    const entries = [];
    const win = makeWindow();

    for (const group of PLAN) {
      const image = await capture(win, group.svg);
      for (const size of group.sizes) {
        const png = image.resize({ width: size, height: size, quality: 'best' }).toPNG();
        entries.push({ size, png });
        console.log('  ' + String(size).padStart(3) + 'px  ' +
                    String(png.length).padStart(6) + ' bytes  from ' + group.svg);
      }
    }

    win.destroy();
    entries.sort((a, b) => b.size - a.size);
    fs.writeFileSync(OUT, buildIco(entries));
    console.log('wrote ' + OUT + ' (' + fs.statSync(OUT).size + ' bytes, ' +
                entries.length + ' sizes)');
  } catch (err) {
    console.error('icon build failed:', err);
    process.exitCode = 1;
  }
  app.quit();
});
