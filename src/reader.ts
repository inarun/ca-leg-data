import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import yauzl from "yauzl";

/** Random-access reader over a pubinfo source: a zip file or a directory in pubinfo layout. */
export interface SourceReader {
  readonly kind: "zip" | "dir";
  has(name: string): boolean;
  read(name: string): Promise<Buffer>;
  readText(name: string): Promise<string>;
  entryCount(): number;
  close(): Promise<void>;
}

class DirReader implements SourceReader {
  readonly kind = "dir" as const;
  constructor(
    private readonly dir: string,
    private readonly names: Set<string>,
  ) {}
  has(name: string): boolean {
    return this.names.has(name);
  }
  async read(name: string): Promise<Buffer> {
    if (!this.names.has(name)) throw new Error(`source entry not found: ${name}`);
    return readFile(join(this.dir, name));
  }
  async readText(name: string): Promise<string> {
    return decodeUtf8(await this.read(name));
  }
  entryCount(): number {
    return this.names.size;
  }
  async close(): Promise<void> {}
}

class ZipReader implements SourceReader {
  readonly kind = "zip" as const;
  constructor(
    private readonly zip: yauzl.ZipFile,
    private readonly entries: Map<string, yauzl.Entry>,
  ) {}
  has(name: string): boolean {
    return this.entries.has(name);
  }
  read(name: string): Promise<Buffer> {
    const entry = this.entries.get(name);
    if (!entry) return Promise.reject(new Error(`source entry not found: ${name}`));
    return new Promise<Buffer>((resolve, reject) => {
      this.zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) return reject(err ?? new Error(`cannot open ${name}`));
        const chunks: Buffer[] = [];
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("error", reject);
        stream.on("end", () => resolve(Buffer.concat(chunks)));
      });
    });
  }
  async readText(name: string): Promise<string> {
    return decodeUtf8(await this.read(name));
  }
  entryCount(): number {
    return this.entries.size;
  }
  close(): Promise<void> {
    this.zip.close();
    return Promise.resolve();
  }
}

export function decodeUtf8(buf: Buffer): string {
  let text = buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

/** Opens a zip (never extracted to disk) or a directory. */
export async function openSource(path: string): Promise<SourceReader> {
  const info = await stat(path);
  if (info.isDirectory()) {
    const names = new Set(await readdir(path));
    return new DirReader(path, names);
  }
  return new Promise<SourceReader>((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error(`cannot open ${path}`));
      const entries = new Map<string, yauzl.Entry>();
      zip.on("entry", (entry: yauzl.Entry) => {
        entries.set(entry.fileName, entry);
        zip.readEntry();
      });
      zip.on("end", () => resolve(new ZipReader(zip, entries)));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}
