import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { generate, render } from "./generate.mjs";

const source = await readFile(
	new URL("./contract.json", import.meta.url),
	"utf8",
);
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
