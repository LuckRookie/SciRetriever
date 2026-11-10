// Builds the browser extension (block 09 of plan 20) and its installation
// package, served by the library at GET /api/v1/capture/extension.
import { build } from "esbuild";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

const repository = resolve(new URL("..", import.meta.url).pathname);
const source = resolve(repository, "apps/browser-extension/src");
const output = resolve(repository, "apps/browser-extension/dist/extension");
const artifact = resolve(
  repository,
  "apps/server/dist/agent-access/browser-extension.zip",
);

/** CRC-32 for the ZIP headers. */
const table = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A stored (uncompressed) ZIP of flat files: small, and loadable by Chrome. */
function zip(files) {
  const locals = [],
    centrals = [];
  let offset = 0;
  for (const { name, bytes } of files) {
    const nameBytes = Buffer.from(name, "utf8"),
      crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, bytes);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + bytes.length;
  }
  const directory = Buffer.concat(centrals),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export async function buildBrowserExtension(target = output) {
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await build({
    entryPoints: [join(source, "popup.ts")],
    outfile: join(target, "popup.js"),
    bundle: true,
    format: "esm",
    target: "chrome116",
    legalComments: "none",
    logLevel: "warning",
  });
  for (const file of ["manifest.json", "popup.html", "popup.css"])
    await copyFile(join(source, file), join(target, file));
  return target;
}

export async function packageBrowserExtension(
  directory,
  destination = artifact,
) {
  const names = (await readdir(directory)).sort();
  const files = await Promise.all(
    names.map(async (name) => ({
      name,
      bytes: await readFile(join(directory, name)),
    })),
  );
  await mkdir(resolve(destination, ".."), { recursive: true });
  await writeFile(destination, zip(files));
  return destination;
}

if (import.meta.url === `file://${process.argv[1]}`)
  await packageBrowserExtension(await buildBrowserExtension());
