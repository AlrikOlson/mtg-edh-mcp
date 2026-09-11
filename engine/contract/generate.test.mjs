import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { generate, render } from "./generate.mjs";

const source = await readFile(new URL("./contract.json", import.meta.url), "utf8");
const contract = JSON.parse(source);

test("deterministically generates both bindings from exact source", () => {
  const first = render(source);
  assert.deepEqual(first, render(source));
  assert.match(first.rust, /deny_unknown_fields/);
  assert.match(first.typescript, /strictObject/);
  assert.notDeepEqual(first, render(source + " "));
});

for (const [name, change] of [
  [
    "invalid preview digest",
    (s) => {
      s.constants.PREVIEW_FIXTURE_DIGEST = "not-pinned";
    },
  ],
  [
    "invalid preview identity",
    (s) => {
      s.constants.PREVIEW_FIXTURE_ID = "not an ID";
    },
  ],
  [
    "zero preview version",
    (s) => {
      s.constants.PREVIEW_FIXTURE_VERSION = 0;
    },
  ],
  [
    "unknown keyword",
    (s) => {
      s.types.Id.pattern = ".*";
    },
  ],
  [
    "unsafe integer",
    (s) => {
      s.types.Count.max = 9007199254740992;
    },
  ],
  [
    "unknown type",
    (s) => {
      s.types.Hello.fields.engine_version.type = "Missing";
    },
  ],
  [
    "forward reference",
    (s) => {
      s.types.Hello.fields.engine_version.type = "Response";
    },
  ],
  [
    "invalid alphabet",
    (s) => {
      s.types.Id.alphabet = "anything";
    },
  ],
  [
    "duplicate enum value",
    (s) => {
      s.types.Test = { kind: "enum", values: ["same", "same"] };
    },
  ],
  [
    "empty union",
    (s) => {
      s.types.Test = { kind: "union", variants: {} };
    },
  ],
  [
    "invalid limits",
    (s) => {
      s.types.Id.min = 200;
    },
  ],
  [
    "reserved field",
    (s) => {
      s.types.Empty.fields.type = { type: "Id" };
    },
  ],
]) {
  test("rejects " + name + " rather than generating weaker validators", () => {
    const changed = structuredClone(contract);
    change(changed);
    assert.throws(() => generate(changed));
  });
}

test("catalog scalars preserve Unicode, fractional mana values and required nulls", () => {
  const schema = structuredClone(contract);
  schema.types.CatalogTextTest = {
    kind: "string",
    min: 0,
    max: 64,
    alphabet: "unicode",
  };
  schema.types.ManaValueTest = { kind: "number", min: 0, max: 1000000 };
  schema.types.FaceTest = {
    kind: "record",
    fields: {
      text: { type: "CatalogTextTest", nullable: true },
      cmc: { type: "ManaValueTest", nullable: true },
    },
  };
  const result = generate(schema);
  assert.match(result.rust, /deserialize_with = "required_nullable"/);
  assert.match(result.typescript, /isWellFormed/);
  assert.match(result.rust, /f64/);
  for (const bad of [false, "yes"]) {
    const invalid = structuredClone(schema);
    invalid.types.FaceTest.fields.text.nullable = bad;
    assert.throws(() => generate(invalid));
  }
  schema.types.ManaValueTest.max = Infinity;
  assert.throws(() => generate(schema));
});
