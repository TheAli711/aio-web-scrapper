import { mkdir, readFile, rm, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Object storage abstraction for large artifacts (page markdown/html/text/links).
 * Postgres holds metadata + the object key; bodies live here.
 *
 * Implementations: LocalFsStorage (dev / single node). An S3/R2 driver implements the same
 * four methods (PutObject / GetObject / DeleteObject / DeleteObjects by prefix).
 */
export interface ObjectStorage {
  put(key: string, body: Buffer | string, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
}

const SAFE_KEY = /^[A-Za-z0-9/_.-]+$/;

function assertSafeKey(key: string) {
  if (!SAFE_KEY.test(key) || key.includes("..") || key.startsWith("/")) {
    throw new Error(`unsafe object key: ${key}`);
  }
}

export class LocalFsStorage implements ObjectStorage {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    assertSafeKey(key);
    return path.join(path.resolve(this.root), key);
  }

  async put(key: string, body: Buffer | string): Promise<void> {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    // write-then-rename so readers never observe partial objects
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, file);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.resolve(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<void> {
    await rm(this.resolve(prefix.replace(/\/+$/, "")), { recursive: true, force: true });
  }
}

/** In-memory implementation for tests. */
export class MemoryStorage implements ObjectStorage {
  readonly objects = new Map<string, Buffer>();
  async put(key: string, body: Buffer | string) {
    assertSafeKey(key);
    this.objects.set(key, Buffer.isBuffer(body) ? body : Buffer.from(body));
  }
  async get(key: string) {
    return this.objects.get(key) ?? null;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async deletePrefix(prefix: string) {
    for (const k of [...this.objects.keys()]) if (k.startsWith(prefix)) this.objects.delete(k);
  }
}
