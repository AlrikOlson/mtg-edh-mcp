import { describe, expect, it } from "vitest";
import { cachedSnapshotProvider } from "./snapshot.js";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}

describe("snapshot activation barrier", () => {
  it("drains existing readers and holds new readers until activation finishes", async () => {
    const snapshot = cachedSnapshotProvider("old");
    const entered = deferred();
    const finish = deferred();
    const seen: string[] = [];
    const oldRead = snapshot.provider.withRead(async () => {
      seen.push(snapshot.get());
      entered.resolve();
      await finish.promise;
      seen.push(snapshot.get());
    });
    await entered.promise;
    let acquired = false;
    const pause = snapshot.pause().then((release) => {
      acquired = true;
      return release;
    });
    const newRead = snapshot.provider.withRead(async () => {
      seen.push(snapshot.get());
    });
    await Promise.resolve();
    expect(acquired).toBe(false);
    expect(seen).toEqual(["old"]);
    finish.resolve();
    await oldRead;
    const release = await pause;
    expect(seen).toEqual(["old", "old"]);
    snapshot.set("new");
    release();
    await newRead;
    expect(seen).toEqual(["old", "old", "new"]);
  });

  it("releases a reader that throws so a failed tool cannot block refresh", async () => {
    const snapshot = cachedSnapshotProvider("old");
    await expect(
      snapshot.provider.withRead(async () => {
        throw new Error("tool failed");
      }),
    ).rejects.toThrow("tool failed");
    const release = await snapshot.pause();
    release();
    expect(await snapshot.provider.withRead(async () => snapshot.get())).toBe("old");
  });
});
