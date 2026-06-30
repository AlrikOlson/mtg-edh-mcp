import { describe, it, expect } from "vitest";
import { CollectionStore } from "./collectionStore.js";

describe("CollectionStore", () => {
  it("sets, reads, and reports membership + size", () => {
    const c = new CollectionStore();
    c.set(["a", "b", "b"]); // dedupes
    expect(c.size()).toBe(2);
    expect([...c.get()].sort()).toEqual(["a", "b"]);
    expect(c.has("a")).toBe(true);
    expect(c.has("z")).toBe(false);
  });

  it("add is incremental; set replaces", () => {
    const c = new CollectionStore();
    c.set(["a"]);
    c.add(["b", "c"]);
    expect(c.size()).toBe(3);
    c.set(["x"]);
    expect([...c.get()]).toEqual(["x"]);
  });

  it("get returns a copy (mutating it does not affect the store)", () => {
    const c = new CollectionStore();
    c.set(["a"]);
    c.get().add("b");
    expect(c.has("b")).toBe(false);
  });

  it("clear empties the session", () => {
    const c = new CollectionStore();
    c.set(["a", "b"]);
    c.clear();
    expect(c.size()).toBe(0);
    expect([...c.get()]).toEqual([]);
  });

  it("isolates collections by session", () => {
    const c = new CollectionStore();
    c.set(["a"], "alice");
    c.set(["b"], "bob");
    expect([...c.get("alice")]).toEqual(["a"]);
    expect([...c.get("bob")]).toEqual(["b"]);
    expect(c.size("carol")).toBe(0);
  });
});
