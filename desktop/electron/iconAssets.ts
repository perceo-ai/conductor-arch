import zlib from "node:zlib";

export type DecodedImage = {
  width: number;
  height: number;
  /** Row-major RGBA, 8 bits per channel. */
  data: Buffer;
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ICNS_MAGIC = "icns";

/**
 * Split an `.icns` container into its entries, keyed by the four character
 * type code (`ic09`, `ic10`, ...). Only the top level table is read; `icns`
 * nests a `TOC ` entry that we deliberately skip.
 */
export function parseIcns(buffer: Buffer): Map<string, Buffer> {
  if (buffer.length < 8 || buffer.toString("ascii", 0, 4) !== ICNS_MAGIC) {
    throw new Error("not an icns container");
  }

  const declaredLength = buffer.readUInt32BE(4);
  const end = Math.min(declaredLength, buffer.length);
  const entries = new Map<string, Buffer>();

  let offset = 8;
  while (offset + 8 <= end) {
    const type = buffer.toString("ascii", offset, offset + 4);
    const length = buffer.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > end) {
      throw new Error(`corrupt icns entry '${type}' at offset ${offset}`);
    }
    if (type !== "TOC ") {
      entries.set(type, buffer.subarray(offset + 8, offset + length));
    }
    offset += length;
  }

  return entries;
}

export function isPng(buffer: Buffer): boolean {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
}

/**
 * Minimal PNG decoder covering what `iconutil` and `sips` emit for app icons:
 * 8 bit samples, truecolour with or without alpha, no interlacing. Anything
 * else throws rather than returning silently wrong pixels.
 */
export function decodePng(buffer: Buffer): DecodedImage {
  if (!isPng(buffer)) {
    throw new Error("not a png");
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  const idat: Buffer[] = [];

  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      interlace = data.readUInt8(12);
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }

    offset += 12 + length;
  }

  if (bitDepth !== 8) {
    throw new Error(`unsupported png bit depth ${bitDepth}`);
  }
  if (colorType !== 2 && colorType !== 6) {
    throw new Error(`unsupported png colour type ${colorType}`);
  }
  if (interlace !== 0) {
    throw new Error("interlaced png is not supported");
  }

  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  const previous = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);

  let cursor = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw.readUInt8(cursor);
    cursor += 1;
    raw.copy(current, 0, cursor, cursor + stride);
    cursor += stride;
    unfilterRow(filter, current, previous, channels);

    for (let x = 0; x < width; x++) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      out[to] = current[from];
      out[to + 1] = current[from + 1];
      out[to + 2] = current[from + 2];
      out[to + 3] = channels === 4 ? current[from + 3] : 255;
    }

    current.copy(previous);
  }

  return { width, height, data: out };
}

function unfilterRow(filter: number, row: Buffer, previous: Buffer, channels: number): void {
  switch (filter) {
    case 0:
      return;
    case 1:
      for (let i = channels; i < row.length; i++) {
        row[i] = (row[i] + row[i - channels]) & 0xff;
      }
      return;
    case 2:
      for (let i = 0; i < row.length; i++) {
        row[i] = (row[i] + previous[i]) & 0xff;
      }
      return;
    case 3:
      for (let i = 0; i < row.length; i++) {
        const left = i >= channels ? row[i - channels] : 0;
        row[i] = (row[i] + ((left + previous[i]) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let i = 0; i < row.length; i++) {
        const left = i >= channels ? row[i - channels] : 0;
        const up = previous[i];
        const upLeft = i >= channels ? previous[i - channels] : 0;
        row[i] = (row[i] + paeth(left, up, upLeft)) & 0xff;
      }
      return;
    default:
      throw new Error(`unknown png filter ${filter}`);
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function alphaAt(image: DecodedImage, x: number, y: number): number {
  return image.data[(y * image.width + x) * 4 + 3];
}

/**
 * The lowest alpha anywhere in the image. macOS 26+ treats an app icon with
 * any transparency as loose artwork and mounts it on a light rounded plate, so
 * a shipped `.icns` has to be fully opaque and drawn edge to edge.
 */
export function minimumAlpha(image: DecodedImage): number {
  let lowest = 255;
  for (let i = 3; i < image.data.length; i += 4) {
    if (image.data[i] < lowest) {
      lowest = image.data[i];
    }
  }
  return lowest;
}
