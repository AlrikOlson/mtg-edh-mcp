import { rename, writeFile } from "node:fs/promises";

/** Write `bytes` through a temporary file and rename, so a reader never sees a partial file. */
export async function writeFileAtomically(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
}
