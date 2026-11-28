// Minimal, dependency-free ZIP writer and reader (PKWARE APPNOTE 6.3, no ZIP64, no encryption).
// Entries are Deflated when that is smaller, otherwise Stored. Output is deterministic.
import { deflateRawSync, inflateRawSync } from "node:zlib";

export interface ZipEntry {
  /** Path inside the archive, `/`-separated, relative. */
  readonly name: string;
  readonly data: string | Uint8Array;
}

export interface ExtractedEntry {
  readonly name: string;
  readonly data: Buffer;
  readonly method: "stored" | "deflated";
  readonly crc32: number;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const FLAG_UTF8 = 0x0800;
/** 1980-01-01 00:00:00 in DOS format: keeps archives reproducible. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;
const VERSION_NEEDED = 20;
/** Made by UNIX (3), spec 3.0. */
const VERSION_MADE_BY = 0x031e;
const UNIX_FILE_0644 = (0o100644 << 16) >>> 0;
const MAX_ENTRIES = 0xffff;
const MAX_SIZE = 0xffffffff;

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Throws for names that could escape the extraction directory or confuse unzip tools. */
export function assertEntryName(name: string): void {
  if (name.length === 0) throw new ZipError("entry name is empty");
  if (Buffer.byteLength(name, "utf8") > 0xffff) throw new ZipError(`entry name is too long: ${name.slice(0, 40)}...`);
  if (name.includes("\\")) throw new ZipError(`entry name must use "/": ${name}`);
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) throw new ZipError(`entry name must be relative: ${name}`);
  if (name.endsWith("/")) throw new ZipError(`entry name must be a file: ${name}`);
  if (name.includes("\0")) throw new ZipError("entry name contains a NUL byte");
  if (name.split("/").some((part) => part === ".." || part === "." || part === "")) throw new ZipError(`entry name has an unsafe path segment: ${name}`);
}

export function createZip(entries: readonly ZipEntry[]): Buffer {
  if (entries.length > MAX_ENTRIES) throw new ZipError(`too many entries (${entries.length}); ZIP64 is not supported`);
  const seen = new Set<string>();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    assertEntryName(entry.name);
    if (seen.has(entry.name)) throw new ZipError(`duplicate entry name: ${entry.name}`);
    seen.add(entry.name);
    const raw = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : Buffer.from(entry.data);
    if (raw.length > MAX_SIZE) throw new ZipError(`entry too large: ${entry.name}`);
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const name = Buffer.from(entry.name, "utf8");

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(VERSION_MADE_BY, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(UNIX_FILE_0644, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
    if (offset > MAX_SIZE) throw new ZipError("archive exceeds 4 GiB; ZIP64 is not supported");
  }
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBytes, eocd]);
}

/** Optional caps for archives that come from an untrusted upload (no caps when omitted: the old behaviour). */
export interface ReadZipLimits {
  /** Largest uncompressed size of one entry. */
  readonly maxEntryBytes?: number;
  /** Largest total uncompressed size of all entries. */
  readonly maxTotalBytes?: number;
  readonly maxEntries?: number;
}

/** Parses and fully verifies an archive produced by `createZip` (or any ZIP without ZIP64/encryption). */
export function readZip(buffer: Buffer, limits?: ReadZipLimits): ExtractedEntry[] {
  if (buffer.length < 22) throw new ZipError("archive is too small");
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("end of central directory not found");
  const count = buffer.readUInt16LE(eocd + 10);
  if (limits?.maxEntries !== undefined && count > limits.maxEntries) throw new ZipError(`too many entries (${count}); the limit is ${limits.maxEntries}`);
  let totalBytes = 0;
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (centralOffset + centralSize > eocd) throw new ZipError("central directory is out of range");
  const result: ExtractedEntry[] = [];
  let p = centralOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== CENTRAL_SIG) throw new ZipError(`bad central directory header #${i}`);
    const method = buffer.readUInt16LE(p + 10);
    const crc = buffer.readUInt32LE(p + 16);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const size = buffer.readUInt32LE(p + 24);
    const nameLength = buffer.readUInt16LE(p + 28);
    const extraLength = buffer.readUInt16LE(p + 30);
    const commentLength = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString("utf8", p + 46, p + 46 + nameLength);
    p += 46 + nameLength + extraLength + commentLength;
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIG) throw new ZipError(`bad local header for ${name}`);
    const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    if (start + compressedSize > centralOffset) throw new ZipError(`data of ${name} overlaps the central directory`);
    const stored = buffer.subarray(start, start + compressedSize);
    if (limits?.maxEntryBytes !== undefined && size > limits.maxEntryBytes) throw new ZipError(`${name} is ${size} bytes uncompressed; the limit is ${limits.maxEntryBytes}`);
    totalBytes += size;
    if (limits?.maxTotalBytes !== undefined && totalBytes > limits.maxTotalBytes) throw new ZipError(`the archive is larger than ${limits.maxTotalBytes} bytes uncompressed`);
    let data: Buffer;
    if (method === 0) data = Buffer.from(stored);
    else if (method === 8) {
      try {
        // With caps, never inflate past the declared size (a lying header cannot expand into memory).
        data = limits === undefined ? inflateRawSync(stored) : inflateRawSync(stored, { maxOutputLength: Math.max(size, 1) });
      } catch (err: unknown) {
        if (limits === undefined) throw err;
        throw new ZipError(`${name} does not inflate to its declared size: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    else throw new ZipError(`unsupported compression method ${method} for ${name}`);
    if (data.length !== size) throw new ZipError(`size mismatch for ${name}`);
    if (crc32(data) !== crc) throw new ZipError(`CRC-32 mismatch for ${name}`);
    result.push({ name, data, method: method === 0 ? "stored" : "deflated", crc32: crc });
  }
  return result;
}
