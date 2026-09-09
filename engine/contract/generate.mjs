import { createHash } from "node:crypto";

const MAX = 4294967295;
const reserved = new Set(
	"Self String Vec Option Result Serialize Deserialize".split(" "),
);
const keywords = new Set(
	"self super crate type as async await break const continue dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return static struct trait true unsafe use where while abstract become box do final macro override priv typeof unsized virtual yield try gen".split(
		" ",
	),
);
const q = JSON.stringify;
const rn = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "_");
const pascal = (s) =>
	s
		.split("_")
		.map((p) => p[0].toUpperCase() + p.slice(1))
		.join("");
export const validatorName = (n) =>
	"validate_" +
	n
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase();
const fail = (message) => {
	throw new Error("Invalid engine schema: " + message);
};
function object(v) {
	if (
		!v ||
		typeof v !== "object" ||
		Array.isArray(v) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(v))
	)
		fail("expected object");
}
function keys(v, required, optional = []) {
	object(v);
	for (const key of Object.keys(v))
		if (![...required, ...optional].includes(key)) fail("unknown key " + key);
	for (const key of required)
		if (!Object.hasOwn(v, key)) fail("missing key " + key);
}
function num(v, min = 0) {
	if (!Number.isSafeInteger(v) || v < min || v > MAX) fail("invalid u32 bound");
}
function bounds(s) {
	num(s.min);
	num(s.max);
	if (s.min > s.max) fail("reversed bounds");
}
function wire(n) {
	if (typeof n !== "string" || !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(n))
		fail("invalid wire name");
}
function variants(v) {
	if (!Array.isArray(v) || !v.length) fail("empty variants");
	const seen = new Set(),
		names = new Set();
	for (const n of v) {
		wire(n);
		const p = pascal(n);
		if (seen.has(n) || names.has(p) || p === "Self") fail("variant collision");
		seen.add(n);
		names.add(p);
	}
}
export function validateSchema(s) {
	keys(s, ["version", "constants", "types"]);
	if (s.version !== 1) fail("unsupported DSL");
	keys(s.constants, ["PROTOCOL_VERSION", "ENGINE_VERSION", "MAX_FRAME_BYTES"]);
	num(s.constants.PROTOCOL_VERSION, 1);
	num(s.constants.MAX_FRAME_BYTES, 1);
	if (
		typeof s.constants.ENGINE_VERSION !== "string" ||
		!/^[A-Za-z0-9_.:-]{1,128}$/.test(s.constants.ENGINE_VERSION)
	)
		fail("invalid engine version");
	object(s.types);
	const known = new Set(),
		names = new Set();
	const ref = (t) => {
		if (!known.has(t)) fail("unknown/forward type " + t);
	};
	for (const [n, t] of Object.entries(s.types)) {
		if (
			!/^[A-Z][A-Za-z0-9]*$/.test(n) ||
			reserved.has(n) ||
			names.has(validatorName(n))
		)
			fail("invalid/colliding type " + n);
		names.add(validatorName(n));
		object(t);
		switch (t.kind) {
			case "string":
				keys(t, ["kind", "min", "max", "alphabet"]);
				bounds(t);
				if (!["id", "hex", "text", "unicode", "color"].includes(t.alphabet))
					fail("alphabet");
				break;
			case "integer":
				keys(t, ["kind", "min", "max"]);
				bounds(t);
				break;
			case "number":
				keys(t, ["kind", "min", "max"]);
				if (
					!Number.isFinite(t.min) ||
					!Number.isFinite(t.max) ||
					t.min < 0 ||
					t.max > MAX ||
					t.min > t.max
				)
					fail("invalid number bounds");
				break;
			case "boolean":
				keys(t, ["kind"]);
				break;
			case "enum":
				keys(t, ["kind", "values"]);
				variants(t.values);
				break;
			case "record":
				keys(t, ["kind", "fields"]);
				object(t.fields);
				for (const [f, v] of Object.entries(t.fields)) {
					wire(f);
					if (keywords.has(f)) fail("reserved field " + f);
					keys(v, ["type"], ["optional", "nullable", "array"]);
					ref(v.type);
					if (Object.hasOwn(v, "optional") && v.optional !== true)
						fail("optional must be true");
					if (
						Object.hasOwn(v, "nullable") &&
						(v.nullable !== true || v.optional)
					)
						fail("nullable must be true and required");
					if (Object.hasOwn(v, "array")) {
						keys(v.array, ["min", "max"]);
						bounds(v.array);
					}
				}
				break;
			case "union":
				keys(t, ["kind", "variants"]);
				object(t.variants);
				variants(Object.keys(t.variants));
				Object.values(t.variants).forEach(ref);
				break;
			default:
				fail("unsupported kind");
		}
		known.add(n);
	}
	return s;
}
function lengthCheck(v, s, label) {
	return [
		"if !(" + rn(s.min) + "..=" + rn(s.max) + ").contains(&" + v + ".len()) {",
		"return Err(" +
			q(label + " length outside contract bounds") +
			".to_owned());",
		"}",
	];
}
function rust(n, s) {
	const derive = "#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]";
	let decl,
		lines = [];
	if (["string", "integer", "number", "boolean"].includes(s.kind))
		decl =
			"pub type " +
			n +
			" = " +
			{ string: "String", integer: "u32", number: "f64", boolean: "bool" }[
				s.kind
			] +
			";";
	if (s.kind === "string") {
		const alphabet = {
			id: 'byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte)',
			hex: "byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)",
			text: "(b' '..=b'~').contains(&byte)",
			color: 'b"WUBRG".contains(&byte)',
		}[s.alphabet];
		lines =
			s.alphabet === "unicode"
				? lengthCheck("value", s, n)
				: [
						...lengthCheck("value", s, n),
						"if !value.bytes().all(|byte| " + alphabet + ") {",
						"return Err(" + q(n + " invalid ASCII alphabet") + ".to_owned());",
						"}",
					];
	}
	if (s.kind === "integer" && (s.min !== 0 || s.max !== MAX))
		lines = [
			"if !(" + rn(s.min) + "..=" + rn(s.max) + ").contains(value) {",
			"return Err(" + q(n + " outside contract bounds") + ".to_owned());",
			"}",
		];
	if (s.kind === "number") {
		const float = (v) => (Number.isInteger(v) ? rn(v) + ".0" : rn(v));
		lines = [
			"if !value.is_finite() || !(" +
				float(s.min) +
				"..=" +
				float(s.max) +
				").contains(value) {",
			"return Err(" + q(n + " outside contract bounds") + ".to_owned());",
			"}",
		];
	}
	if (s.kind === "record") {
		const fields = [];
		for (const [f, t] of Object.entries(s.fields)) {
			let type = t.type;
			if (t.array) type = "Vec<" + type + ">";
			if (t.optional || t.nullable) type = "Option<" + type + ">";
			if (t.nullable)
				fields.push('#[serde(deserialize_with = "required_nullable")]');
			if (t.optional)
				fields.push(
					'#[serde(default, skip_serializing_if = "Option::is_none")]',
				);
			fields.push("pub " + f + ": " + type + ",");
			const accessor = "&value." + f,
				validate = validatorName(t.type),
				label = n + "." + f;
			if (t.optional || t.nullable)
				lines.push("if let Some(field) = " + accessor + " {");
			if (!t.optional && !t.nullable)
				lines.push("let field = " + accessor + ";");
			if (t.array)
				lines.push(
					...lengthCheck("field", t.array, label),
					"for item in field {",
				);
			lines.push(
				validate +
					"(" +
					(t.array ? "item" : "field") +
					").map_err(|e| format!(" +
					q(label + ": {e}") +
					"))?;",
			);
			if (t.array) lines.push("}");
			if (t.optional || t.nullable) lines.push("}");
		}
		decl = [
			derive,
			"#[serde(deny_unknown_fields)]",
			"pub struct " + n + " {",
			...fields,
			"}",
		].join("\n");
	}
	if (s.kind === "enum" || s.kind === "union") {
		const union = s.kind === "union";
		const entries = union
			? Object.entries(s.variants)
			: s.values.map((v) => [v, null]);
		decl = [
			derive,
			union
				? '#[serde(tag = "type", content = "data", deny_unknown_fields)]'
				: "",
			"pub enum " + n + " {",
			...entries.flatMap(([tag, t]) => [
				"#[serde(rename = " + q(tag) + ")]",
				pascal(tag) + (union ? "(" + t + ")" : "") + ",",
			]),
			"}",
		].join("\n");
		if (union) {
			const groups = new Map();
			for (const [tag, t] of entries) {
				const names = groups.get(t) || [];
				names.push(n + "::" + pascal(tag) + "(data)");
				groups.set(t, names);
			}
			lines = [
				"match value {",
				...Array.from(
					groups,
					([t, names]) =>
						names.join(" | ") + " => " + validatorName(t) + "(data),",
				),
				"}",
			];
		}
	}
	const param = lines.length ? "value" : "_value";
	if (s.kind !== "union") lines.push("Ok(())");
	const validate = [
		"/// Validate the generated wire constraints.",
		"///",
		"/// # Errors",
		"/// Returns the violated constraint.",
		"#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]",
		"pub fn " +
			validatorName(n) +
			"(" +
			param +
			": &" +
			(s.kind === "string" ? "str" : n) +
			") -> Result<(), String> {",
		...lines,
		"}",
	].join("\n");
	return decl + "\n\n" + validate;
}
function ts(s) {
	switch (s.kind) {
		case "string":
			if (s.alphabet === "unicode")
				return (
					"z.string().refine((value) => { const bytes = new TextEncoder().encode(value).length; return isWellFormed(value) && bytes >= " +
					s.min +
					" && bytes <= " +
					s.max +
					'; }, "Invalid Unicode or UTF-8 byte length")'
				);
			return (
				"z.string().min(" +
				s.min +
				").max(" +
				s.max +
				").regex(/^" +
				{
					id: "[A-Za-z0-9_.:-]",
					hex: "[0-9a-f]",
					text: "[\\x20-\\x7e]",
					color: "[WUBRG]",
				}[s.alphabet] +
				"*$(?![\\s\\S])/)"
			);
		case "number":
			return "z.number().min(" + s.min + ").max(" + s.max + ")";
		case "integer":
			return "z.number().int().min(" + s.min + ").max(" + s.max + ")";
		case "boolean":
			return "z.boolean()";
		case "enum":
			return "z.enum(" + q(s.values) + ")";
		case "record":
			return (
				"z.strictObject({\n" +
				Object.entries(s.fields)
					.map(([f, t]) => {
						let val = t.type + "Schema";
						if (t.array)
							val =
								"z.array(" +
								val +
								").min(" +
								t.array.min +
								").max(" +
								t.array.max +
								")";
						if (t.optional) val += ".nullable().optional()";
						if (t.nullable) val += ".nullable()";
						return q(f) + ": " + val + ",";
					})
					.join("\n") +
				"\n})"
			);
		case "union":
			return (
				'z.discriminatedUnion("type", [\n' +
				Object.entries(s.variants)
					.map(
						([tag, t]) =>
							"z.strictObject({type: z.literal(" +
							q(tag) +
							"), data: " +
							t +
							"Schema}),",
					)
					.join("\n") +
				"\n])"
			);
		default:
			throw new Error("unreachable validated kind");
	}
}
export function generate(schema) {
	validateSchema(schema);
	const { PROTOCOL_VERSION, ENGINE_VERSION, MAX_FRAME_BYTES } =
		schema.constants;
	return {
		rust: [
			"use serde::{Deserialize, Serialize};",
			"fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error> where D: serde::Deserializer<'de>, T: Deserialize<'de> { Option::<T>::deserialize(deserializer) }",
			"pub const PROTOCOL_VERSION: u32 = " + PROTOCOL_VERSION + ";",
			"pub const ENGINE_VERSION: &str = " + q(ENGINE_VERSION) + ";",
			"pub const MAX_FRAME_BYTES: usize = " + rn(MAX_FRAME_BYTES) + ";",
			...Object.entries(schema.types).map(([n, s]) => rust(n, s)),
			"",
		].join("\n\n"),
		typescript: [
			'import { z } from "zod";',
			"const isWellFormed = (value: string): boolean => Array.from(value).every((character) => { const point = character.codePointAt(0) ?? 0; return point < 0xd800 || point > 0xdfff; });",
			"export const PROTOCOL_VERSION = " + PROTOCOL_VERSION + ";",
			"export const ENGINE_VERSION = " + q(ENGINE_VERSION) + ";",
			"export const MAX_FRAME_BYTES = " + MAX_FRAME_BYTES + ";",
			...Object.entries(schema.types).map(
				([n, s]) =>
					"export const " +
					n +
					"Schema = " +
					ts(s) +
					";\nexport type " +
					n +
					" = z.infer<typeof " +
					n +
					"Schema>;",
			),
			"",
		].join("\n\n"),
	};
}
export function render(schemaText) {
	const hash = createHash("sha256").update(schemaText, "utf8").digest("hex");
	const output = generate(JSON.parse(schemaText));
	const header =
		"// @generated from canonical mtg-worker/protocol/contract.json; do not edit.\n";
	return {
		rust:
			header +
			"pub const SCHEMA_SHA256: &str = " +
			q(hash) +
			";\n" +
			output.rust,
		typescript:
			header +
			"export const SCHEMA_SHA256 = " +
			q(hash) +
			";\n" +
			output.typescript,
	};
}
