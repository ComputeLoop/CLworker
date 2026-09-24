/**
 * Zero-dependency image dimension parser for PNG and JPEG, enough to
 * validate image archives without loading a decoder.
 */
export interface ImageSize {
  width: number;
  height: number;
}

export function imageSize(buf: Uint8Array): ImageSize | null {
  if (!buf || buf.byteLength < 24) return null;
  const png = pngSize(buf);
  if (png) return png;
  return jpegSize(buf);
}

function pngSize(buf: Uint8Array): ImageSize | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i++) {
    if (buf[i] !== sig[i]) return null;
  }
  if (buf.byteLength < 24) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0 || width > 100_000 || height > 100_000) {
    return null;
  }
  return { width, height };
}

function jpegSize(buf: Uint8Array): ImageSize | null {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = 2;
  while (offset + 9 < buf.byteLength) {
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buf[offset + 1];
    if (marker === 0xff) {
      offset++;
      continue;
    }
    // Standalone markers carry no length field.
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      offset += 2;
      continue;
    }
    const length = view.getUint16(offset + 2);
    if (length < 2) return null;

    // SOF markers (except DHT 0xc4, JPG 0xc8, DAC 0xcc) carry height+width.
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      const height = view.getUint16(offset + 5);
      const width = view.getUint16(offset + 7);
      if (width > 0 && height > 0 && width <= 100_000 && height <= 100_000) {
        return { width, height };
      }
      return null;
    }
    offset += 2 + length;
  }
  return null;
}