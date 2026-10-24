import { deflateSync } from "node:zlib";

/** Deterministic synthetic spectrum, encoded without another image dependency. */
export function designSampleImage(): Buffer {
  const width = 480,
    height = 220;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      const peak =
        170 -
        125 * Math.exp(-((x - 145) ** 2) / 440) -
        75 * Math.exp(-((x - 330) ** 2) / 1000);
      const axis =
        (x === 40 && y > 20 && y < 180) || (y === 180 && x >= 40 && x < 455);
      const curve = x > 40 && x < 455 && Math.abs(y - peak) < 2;
      pixels.set(
        axis ? [105, 112, 119] : curve ? [58, 103, 137] : [247, 246, 242],
        offset,
      );
    }
  const chunk = (kind: string, data: Buffer) => {
    const content = Buffer.concat([Buffer.from(kind), data]);
    let crc = 0xffffffff;
    for (const byte of content) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const header = Buffer.alloc(4),
      tail = Buffer.alloc(4);
    header.writeUInt32BE(data.length);
    tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([header, content, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
