import qrcode from 'qrcode-generator';

/**
 * Renders a QR code as an SVG data URI (Decision 49, S7-10; library approved under Decision 62).
 * The SVG is built here from the module matrix, so it contains only rectangles: no text, no
 * scripts, nothing derived from the encoded value except dark/light modules. The web app shows it
 * in an <img>, where SVG cannot run scripts anyway.
 */
export function qrSvgDataUri(value: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(value, 'Byte');
  qr.make();
  const count = qr.getModuleCount();
  const margin = 4;
  const size = count + margin * 2;
  let path = '';
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) path += `M${col + margin} ${row + margin}h1v1h-1z`;
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" ` +
    `shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/>` +
    `<path fill="#000" d="${path}"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}
