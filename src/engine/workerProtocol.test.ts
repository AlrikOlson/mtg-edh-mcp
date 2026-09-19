import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { captureCatalog } from "./catalog.js";
import { podDigest } from "./pod.js";
import { capturePreviewFixture } from "./previewFixture.js";
import {
  PreviewCatalogPayloadSchema,
  PREVIEW_FIXTURE_ID,
  PREVIEW_FIXTURE_VERSION,
  PREVIEW_FIXTURE_DIGEST,
} from "./protocol.generated.js";
import { catalogFixture, baselineCatalogFixture } from "./catalogFixture.test-support.js";
import {
  CatalogPayloadSchema,
  CommanderScenarioSchema,
  type CatalogPayload,
  type CommanderScenario,
} from "./protocol.generated.js";
import { expect, it } from "vitest";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import {
  ENGINE_VERSION,
  PROTOCOL_VERSION,
  SCHEMA_SHA256,
  type Response,
  type CatalogEnvelope,
} from "./protocol.generated.js";
import { assertCompatibleHello, WorkerFrameDecoder } from "./protocol.js";
import { deriveTrialSeed } from "./trialSeed.js";

const binary = process.env.MTG_WORKER_BINARY;
const native = it.skipIf(!binary);
const hello = {
  request_id: "h-1",
  message: {
    type: "hello",
    data: {
      protocol_version: PROTOCOL_VERSION,
      engine_version: ENGINE_VERSION,
      schema_sha256: SCHEMA_SHA256,
    },
  },
};
const commander = (data: CatalogEnvelope) => ({
  type: "commander" as const,
  data,
});
const line = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");

/** Acceptance harness only; the production supervisor belongs to a later chunk. */
async function run(input: Buffer): Promise<Response[]> {
  if (!binary) throw new Error("MTG_WORKER_BINARY is required for native acceptance");
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["--protocol"], {
      stdio: ["pipe", "pipe", "pipe"],
      signal: AbortSignal.timeout(5000),
    });
    const decoder = new WorkerFrameDecoder(),
      replies: Response[] = [];
    let diagnostics = "",
      outputBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        outputBytes += chunk.length;
        if (outputBytes > 4194304) throw new Error("acceptance output limit exceeded");
        replies.push(...decoder.push(chunk));
      } catch (error) {
        child.kill("SIGKILL");
        reject(error);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostics += chunk.toString();
      if (diagnostics.length > 4096) {
        child.kill("SIGKILL");
        reject(new Error("excessive stderr"));
      }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      try {
        decoder.finish();
        expect(code).toBe(0);
        expect(diagnostics).toBe("");
        resolve(replies);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.on("error", reject);
    child.stdin.end(input);
  });
}

native("exchanges real generated Rust replies with the TypeScript validator", async () => {
  const f = z
    .object({
      valid: z.array(
        z.object({
          name: z.string(),
          direction: z.string(),
          value: z.unknown(),
        }),
      ),
    })
    .parse(
      JSON.parse(
        await readFile(new URL("../../engine/contract/fixtures.json", import.meta.url), "utf8"),
      ),
    );
  const requests = f.valid.filter(
    (c) => c.direction === "request" && ["admit", "run", "decision", "cancel"].includes(c.name),
  );
  const replies = await run(Buffer.concat([line(hello), ...requests.map((c) => line(c.value))]));
  expect(replies).toHaveLength(1 + requests.length);
  const first = replies[0];
  if (!first) throw new Error("missing hello");
  assertCompatibleHello(first, "h-1");
  for (const [index, response] of replies.slice(1).entries()) {
    expect(response.request_id).toBe("req-1");
    expect(response.message.type).toBe("outcome");
    // Schema-only fixtures never admit or execute: the Commander admission's
    // placeholder catalog, forged preview admissions, runs, cancels and a
    // decision while no run is suspended are all refused as invalid.
    z.object({ message: z.object({ type: z.string(), data: z.unknown() }) }).parse(
      requests[index]?.value,
    );
    if (response.message.type === "outcome") expect(response.message.data.type).toBe("invalid");
  }
});
native("rejects mismatched worker versions and drains only framed diagnostics", async () => {
  const changed = structuredClone(hello);
  changed.message.data.protocol_version = PROTOCOL_VERSION + 1;
  const replies = await run(line(changed));
  expect(replies).toHaveLength(1);
  expect(() =>
    assertCompatibleHello(
      replies[0] ?? {
        message: { type: "outcome", data: { type: "cancelled", data: {} } },
      },
      "h-1",
    ),
  ).toThrow("invalid_handshake");
});
native("recovers after a malformed input frame through the real binary", async () => {
  const replies = await run(Buffer.concat([Buffer.from("{\n"), line(hello)]));
  expect(replies).toHaveLength(2);
  const last = replies[1];
  if (!last) throw new Error("missing hello");
  assertCompatibleHello(last, "h-1");
});
native("round trips every frozen baseline gameplay record through the native worker", async () => {
  const f = await baselineCatalogFixture();
  try {
    const captured = captureCatalog(f.options());
    if (!captured.ok) throw new Error(JSON.stringify(captured));
    const replies = await run(
      Buffer.concat([
        line(hello),
        line({
          request_id: "catalog-baseline",
          message: {
            type: "catalog_check",
            data: commander(captured.envelope),
          },
        }),
      ]),
    );
    expect(replies).toHaveLength(2);
    expect(replies[0]?.message).toMatchObject({
      type: "hello",
      data: { admission: true, execution: true, decisions: true, cancellation: true },
    });
    expect(replies[1]).toEqual({
      request_id: "catalog-baseline",
      message: {
        type: "catalog_checked",
        data: commander(captured.envelope),
      },
    });
    const payload = CatalogPayloadSchema.parse(JSON.parse(captured.envelope.payload_json));
    expect(payload.records).toHaveLength(77);
    for (const record of payload.records)
      expect(record.gameplay).toEqual(
        f.source.records.find((r) => r.oracle_id === record.oracle_id)!.gameplay,
      );
    expect(payload.deck.cards.reduce((n, e) => n + e.qty, 0)).toBe(99);
  } finally {
    await f.close();
  }
});

native("rejects rehashed corrupt catalogs and recovers without admitting a game", async () => {
  const f = await catalogFixture();
  try {
    const captured = captureCatalog(f.options());
    if (!captured.ok) throw new Error(JSON.stringify(captured));
    const payload = CatalogPayloadSchema.parse(JSON.parse(captured.envelope.payload_json));
    const mutate = (edit: (p: CatalogPayload) => void) => {
      const p = structuredClone(payload);
      edit(p);
      const payload_json = JSON.stringify(p);
      return {
        ...captured.envelope,
        payload_json,
        payload_digest: createHash("sha256").update(payload_json).digest("hex"),
      };
    };
    const bad = [
      { ...captured.envelope, payload_digest: "0".repeat(64) },
      { ...captured.envelope, expected_deck_version: 100 },
      { ...captured.envelope, expected_index_revision: "0".repeat(64) },
      mutate((p) => {
        p.deck.data_snapshot = "wrong";
      }),
      mutate((p) => {
        p.deck.cards[0]!.oracle_id = "missing";
      }),
      mutate((p) => {
        p.deck.cards[0]!.printing_id = p.records[0]!.printing_ids[0]!;
      }),
      mutate((p) => {
        p.records.push(p.records[0]!);
      }),
      mutate((p) => {
        p.records[0]!.gameplay.source.oracle_id = "wrong";
      }),
      mutate((p) => {
        p.records[0]!.gameplay.faces![0]!.face_index = 1;
      }),
      mutate((p) => {
        p.records[0]!.gameplay.characteristics.name = "\ud800";
      }),
      mutate((p) => {
        p.records[0]!.gameplay.characteristics.cmc = -0.5;
      }),
      mutate((p) => {
        p.deck.cards[0]!.qty = 1001;
      }),
    ];
    const frames = [...bad, captured.envelope].map((data, i) =>
      line({
        request_id: "cat-" + i,
        message: { type: "catalog_check", data: commander(data) },
      }),
    );
    const replies = await run(Buffer.concat([line(hello), ...frames]));
    expect(replies).toHaveLength(bad.length + 2);
    for (let i = 0; i < bad.length; i++)
      expect(replies[i + 1]).toMatchObject({
        request_id: "cat-" + i,
        message: {
          type: "outcome",
          data: { type: "invalid", data: { code: "catalog_invalid" } },
        },
      });
    expect(replies.at(-1)?.message).toEqual({
      type: "catalog_checked",
      data: commander(captured.envelope),
    });
  } finally {
    await f.close();
  }
});

native(
  "preserves ordered multiface source and related printing links as unevaluated data",
  async () => {
    const f = await catalogFixture();
    try {
      const captured = captureCatalog(f.options());
      if (!captured.ok) throw new Error(JSON.stringify(captured));
      const payload = CatalogPayloadSchema.parse(JSON.parse(captured.envelope.payload_json));
      const g = payload.records[1]!.gameplay;
      g.layout = "modal_dfc";
      g.face_relationship = "modal";
      g.characteristics.type_line = null;
      g.characteristics.mana_cost = null;
      g.faces = [0, 1].map((face_index) => ({
        face_index,
        source_path: "/card_faces/" + face_index,
        oracle_id: "face-" + face_index,
        characteristics: {
          ...g.characteristics,
          name: "Face 🧙 " + face_index,
          cmc: face_index / 2,
        },
      }));
      g.related_cards = [
        {
          id: "token-printing",
          component: "token",
          name: "Éowyn",
          type_line: "Token Creature",
          uri: "https://api.scryfall.com/cards/token-printing",
        },
      ];
      const payload_json = JSON.stringify(payload);
      const envelope = {
        ...captured.envelope,
        payload_json,
        payload_digest: createHash("sha256").update(payload_json).digest("hex"),
      };
      const replies = await run(
        Buffer.concat([
          line(hello),
          line({
            request_id: "faces",
            message: { type: "catalog_check", data: commander(envelope) },
          }),
        ]),
      );
      expect(replies.at(-1)?.message).toEqual({
        type: "catalog_checked",
        data: commander(envelope),
      });
    } finally {
      await f.close();
    }
  },
);

native("reports every frozen source obligation without granting play support", async () => {
  const f = await baselineCatalogFixture();
  try {
    const captured = captureCatalog(f.options());
    if (!captured.ok) throw new Error(JSON.stringify(captured));
    const { loadEngineBaseline } = await import("../evaluation/engineBaseline.js");
    const { digestEvaluation } = await import("../evaluation/registration.js");
    const baseline = await loadEngineBaseline();
    const queries = f.source.records.map((r, i) =>
      line({
        request_id: "support-" + i,
        message: {
          type: "support_check",
          data: {
            catalog: commander(captured.envelope),
            oracle_id: r.oracle_id,
            expected_implementation_version: "core-support-v1",
            expected_implementation_digest: null,
          },
        },
      }),
    );
    const replies = await run(Buffer.concat([line(hello), ...queries]));
    expect(replies).toHaveLength(78);
    let qualified = 0,
      faceSpans = 0;
    for (const [i, record] of f.source.records.entries()) {
      const message = replies[i + 1]?.message;
      if (message?.type !== "support_checked") throw new Error(JSON.stringify(message));
      const report = message.data;
      const required = baseline.requirements.find((r) => r.oracle_id === record.oracle_id);
      if (!required) throw new Error("Missing frozen requirement");
      expect(report.oracle_id).toBe(record.oracle_id);
      expect(report.source_matches).toBe(true);
      expect(report.supported).toBe(false);
      expect(report.source_digest).toBe(digestEvaluation(record.gameplay));
      expect(report.oracle_text_digest).toBe(
        digestEvaluation(record.gameplay.characteristics.oracle_text),
      );
      expect(report.face_digests).toEqual(record.gameplay.faces?.map(digestEvaluation));
      expect(report.expected_scenarios).toEqual(required.scenarios);
      expect(report.owners).toEqual(required.owners);
      const spans = report.requirements
        .filter((r) => r.face_index !== null && r.start !== null)
        .map(({ face_index, start, end }) => ({ face_index, start, end }));
      expect(spans).toEqual(required.spans);
      faceSpans += spans.length;
      for (const object of baseline.generated_objects.filter((o) =>
        o.source_cards.some((r) => r.oracle_id === record.oracle_id),
      )) {
        expect(
          report.requirements.some(
            (r) =>
              !r.qualified &&
              r.reason.startsWith("generated_definition_missing: " + object.name + ":"),
          ),
        ).toBe(true);
      }
      expect(
        report.requirements.some((r) => r.id === "catalog-physical-adapter" && !r.qualified),
      ).toBe(true);
      for (const row of report.requirements.filter((r) => r.qualified)) {
        qualified++;
        expect(row.id).toBe("intrinsic-basic-mana");
        expect(row.evidence).toBe("tests/strict_support.rs::intrinsic_basic_mana");
        expect(["Forest", "Island", "Swamp"]).toContain(record.gameplay.characteristics.name);
      }
    }
    expect(faceSpans).toBe(baseline.requirements.reduce((n, r) => n + r.spans.length, 0));
    expect(qualified).toBe(3);
    expect(replies[0]?.message).toMatchObject({
      type: "hello",
      data: { admission: true, execution: true, decisions: true, cancellation: true },
    });
  } finally {
    await f.close();
  }
});

native(
  "invalidates source evidence and recovers after support limits and forged modes",
  async () => {
    const f = await baselineCatalogFixture();
    try {
      const captured = captureCatalog(f.options());
      if (!captured.ok) throw new Error(JSON.stringify(captured));
      const forest = f.source.records.find((r) => r.gameplay.characteristics.name === "Forest");
      if (!forest) throw new Error("Missing Forest");
      const query = (catalog: typeof captured.envelope, extra: Record<string, unknown> = {}) => ({
        request_id: "support-negative",
        message: {
          type: "support_check",
          data: {
            catalog: commander(catalog),
            oracle_id: forest.oracle_id,
            expected_implementation_version: "core-support-v1",
            expected_implementation_digest: null,
            ...extra,
          },
        },
      });
      const mutate = (edit: (record: CatalogPayload["records"][number]) => void) => {
        const payload = CatalogPayloadSchema.parse(JSON.parse(captured.envelope.payload_json));
        const record = payload.records.find((r) => r.oracle_id === forest.oracle_id);
        if (!record) throw new Error("Missing captured Forest");
        edit(record);
        const payload_json = JSON.stringify(payload);
        return {
          ...captured.envelope,
          payload_json,
          payload_digest: createHash("sha256").update(payload_json).digest("hex"),
        };
      };
      const changed = [
        mutate((r) => {
          r.gameplay.characteristics.oracle_text += "\nYou may draw a card.";
        }),
        mutate((r) => {
          if (r.gameplay.faces?.[0]) r.gameplay.faces[0].characteristics.oracle_text += " 🧙";
        }),
        mutate((r) => {
          r.gameplay.characteristics.power = "*";
        }),
        mutate((r) => {
          r.gameplay.characteristics.keywords = ["Unimplemented"];
        }),
        mutate((r) => {
          r.gameplay.layout = "unknown-layout";
        }),
      ];
      const over = mutate((r) => {
        r.gameplay.characteristics.oracle_text = "x\n".repeat(2049);
      });
      const requests = [
        ...changed.map((c) => query(c)),
        query(over),
        query(captured.envelope, { expected_implementation_version: "stale" }),
        query(captured.envelope, {
          expected_implementation_digest: "0".repeat(64),
        }),
        query(captured.envelope, { permissive: true }),
        query(captured.envelope),
        {
          request_id: "forged-run",
          message: {
            type: "run",
            data: {
              admission_id: forest.oracle_id,
              scenario_digest: "0".repeat(64),
              trial_index: 0,
              seed: "0000000000000000",
            },
          },
        },
      ];
      const replies = await run(Buffer.concat([line(hello), ...requests.map(line)]));
      expect(replies).toHaveLength(requests.length + 1);
      for (const reply of replies.slice(1, changed.length + 1)) {
        if (reply.message.type !== "support_checked") throw new Error(JSON.stringify(reply));
        expect(reply.message.data.source_matches).toBe(false);
        expect(reply.message.data.supported).toBe(false);
        expect(
          reply.message.data.requirements.every((r) => !r.qualified && r.evidence === null),
        ).toBe(true);
        expect(reply.message.data.expected_scenarios).toEqual([]);
      }
      for (const [offset, code] of [
        "support_report_limit",
        "support_version_mismatch",
        "support_version_mismatch",
        "malformed_frame",
      ].entries())
        expect(replies[changed.length + 1 + offset]?.message).toMatchObject({
          type: "outcome",
          data: { type: "invalid", data: { code } },
        });
      expect(replies.at(-2)?.message).toMatchObject({
        type: "support_checked",
        data: { source_matches: true, supported: false },
      });
      expect(replies.at(-1)?.message).toMatchObject({
        type: "outcome",
        data: { type: "invalid", data: { code: "admission_unknown" } },
      });
    } finally {
      await f.close();
    }
  },
);

function previewScenario(
  captured: Awaited<ReturnType<typeof capturePreviewFixture>>,
  policies: [string, string] = ["fixture-test", "fixture-test"],
) {
  return {
    type: "preview_fixture" as const,
    data: {
      scenario_id: "preview-boundary",
      engine_version: ENGINE_VERSION,
      snapshot_digest: captured.catalog.data.payload_digest,
      rules_digest: captured.rules_digest,
      fixture_id: PREVIEW_FIXTURE_ID,
      fixture_version: PREVIEW_FIXTURE_VERSION,
      fixture_digest: PREVIEW_FIXTURE_DIGEST,
      seats: policies.map((id, seat) => ({
        seat,
        deck_digest: PREVIEW_FIXTURE_DIGEST,
        policy: {
          id,
          version: "1",
          observation_version: "1",
          search_nodes: 1,
        },
      })),
      seed: "0000000000000000",
      limits: {
        trials: 1,
        concurrency: 1,
        max_turns: 10,
        max_actions: 1000,
        max_actions_per_turn: 100,
        max_work: 100000,
        max_elapsed_ms: 5000,
        max_memory_bytes: 100000000,
        max_output_bytes: 1000000,
      },
    },
  };
}
native(
  "qualifies the trusted internal fixture through the actual worker without issuing admission",
  async () => {
    const captured = await capturePreviewFixture();
    const query = {
      scenario: previewScenario(captured),
      catalog: captured.catalog,
      expected_implementation_version: "core-support-v1",
      expected_implementation_digest: null,
    };
    const replies = await run(
      Buffer.concat([
        line(hello),
        line({
          request_id: "preview",
          message: { type: "profile_preflight", data: query },
        }),
        line({
          request_id: "forged",
          message: {
            type: "run",
            data: {
              admission_id: PREVIEW_FIXTURE_ID,
              scenario_digest: PREVIEW_FIXTURE_DIGEST,
              trial_index: 0,
              seed: "0000000000000000",
            },
          },
        }),
      ]),
    );
    expect(replies).toHaveLength(3);
    expect(replies[0]?.message).toMatchObject({
      type: "hello",
      data: { admission: true, execution: true, decisions: true, cancellation: true },
    });
    const reply = replies[1]?.message;
    expect(reply?.type).toBe("profile_preflighted");
    if (reply?.type !== "profile_preflighted") throw new Error(JSON.stringify(reply));
    expect(reply.data).toMatchObject({
      profile: "internal_fixture_v1",
      qualified: true,
      fixture_digest: PREVIEW_FIXTURE_DIGEST,
      catalog_digest: captured.catalog.data.payload_digest,
    });
    expect(reply.data).not.toHaveProperty("admission_id");
    expect(reply.data.reports).toHaveLength(2);
    for (const report of reply.data.reports) {
      expect(report).toMatchObject({
        profile: "internal_fixture_v1",
        source_matches: true,
        supported: true,
      });
      expect(report.requirements.every((r) => r.qualified && r.evidence && r.implementation)).toBe(
        true,
      );
    }
    expect(replies[2]?.message).toMatchObject({
      type: "outcome",
      data: { type: "invalid", data: { code: "admission_unknown" } },
    });
  },
);
native(
  "rejects forged fixture source quantities bindings and profile confusion before any trial",
  async () => {
    const captured = await capturePreviewFixture();
    const base = {
      scenario: previewScenario(captured),
      catalog: captured.catalog,
      expected_implementation_version: "core-support-v1",
      expected_implementation_digest: null,
    };
    const mutate = (edit: (p: ReturnType<typeof PreviewCatalogPayloadSchema.parse>) => void) => {
      const payload = PreviewCatalogPayloadSchema.parse(
        JSON.parse(captured.catalog.data.payload_json),
      );
      edit(payload);
      const payload_json = JSON.stringify(payload);
      const envelope = {
        ...captured.catalog.data,
        payload_json,
        payload_digest: createHash("sha256").update(payload_json).digest("hex"),
      };
      return {
        ...base,
        catalog: { type: "preview_fixture", data: envelope },
        scenario: {
          ...base.scenario,
          data: {
            ...base.scenario.data,
            snapshot_digest: envelope.payload_digest,
          },
        },
      };
    };
    const bad = [
      { ...base, scenario: base.scenario.data },
      { ...base, scenario: { ...base.scenario, type: "unknown" } },
      { ...base, catalog: captured.catalog.data },
      { ...base, catalog: { ...captured.catalog, type: "commander" } },
      { ...base, scenario: { type: "commander", data: base.scenario.data } },
      {
        ...base,
        scenario: {
          ...base.scenario,
          data: { ...base.scenario.data, commanders: ["dummy"] },
        },
      },
      {
        ...base,
        scenario: {
          ...base.scenario,
          data: { ...base.scenario.data, rules_digest: "0".repeat(64) },
        },
      },
      {
        ...base,
        scenario: {
          ...base.scenario,
          data: { ...base.scenario.data, fixture_digest: "0".repeat(64) },
        },
      },
      {
        ...base,
        catalog: {
          ...base.catalog,
          data: { ...base.catalog.data, expected_fixture_version: 2 },
        },
      },
      { ...base, expected_implementation_digest: "0".repeat(64) },
      { ...base, supported: true },
      mutate((p) => {
        p.cards[0]!.qty++;
      }),
      mutate((p) => {
        p.records[1]!.gameplay.characteristics.oracle_text = "Draw a card.";
      }),
      mutate((p) => {
        p.records[1]!.gameplay.faces![0]!.characteristics.power = "3";
      }),
      mutate((p) => {
        p.records[1]!.gameplay.characteristics.keywords = ["Flying"];
      }),
      mutate((p) => {
        p.records[0]!.gameplay.source.oracle_id = p.records[1]!.oracle_id;
      }),
      mutate((p) => {
        p.fixture_digest = "0".repeat(64);
      }),
      mutate((p) => {
        p.records[1]!.printing_ids.push("forged");
      }),
    ];
    const replies = await run(
      Buffer.concat([
        line(hello),
        ...[...bad, base].map((data, i) =>
          line({
            request_id: "negative-" + i,
            message: { type: "profile_preflight", data },
          }),
        ),
      ]),
    );
    expect(replies).toHaveLength(bad.length + 2);
    for (const reply of replies.slice(1, -1))
      expect(reply.message).toMatchObject({
        type: "outcome",
        data: { type: "invalid" },
      });
    expect(replies.at(-1)?.message).toMatchObject({
      type: "profile_preflighted",
      data: { qualified: true },
    });
    expect(replies.some((r) => r.message.type === "admitted" || r.message.type === "event")).toBe(
      false,
    );
  },
);

native(
  "admits the trusted fixture and runs one bounded deterministic game through the real worker",
  async () => {
    const captured = await capturePreviewFixture();
    const admission = {
      scenario: previewScenario(captured, ["fixture-baseline", "fixture-pass"]),
      catalog: captured.catalog,
      expected_implementation_version: "core-support-v1",
      expected_implementation_digest: null,
    };
    const first = await run(
      Buffer.concat([
        line(hello),
        line({ request_id: "admit", message: { type: "admit", data: admission } }),
      ]),
    );
    const admitted = first[1]?.message;
    if (admitted?.type !== "admitted") throw new Error(JSON.stringify(admitted));
    expect(admitted.data).toMatchObject({
      scenario_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      catalog_digest: captured.catalog.data.payload_digest,
      initial_state_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const runRequest = (request_id: string, seed: string) => ({
      request_id,
      message: {
        type: "run",
        data: {
          admission_id: admitted.data.admission_id,
          scenario_digest: admitted.data.scenario_digest,
          trial_index: 0,
          seed,
        },
      },
    });
    // The shared contract fixture's Commander admission is structurally valid
    // but carries a placeholder catalog; integrity refuses it before binding.
    const commanderAdmission = z
      .object({
        valid: z.array(z.object({ name: z.string(), value: z.unknown() })),
      })
      .parse(
        JSON.parse(
          await readFile(new URL("../../engine/contract/fixtures.json", import.meta.url), "utf8"),
        ),
      )
      .valid.find((c) => c.name === "admit")?.value;
    const commanderRequest = z.object({ message: z.unknown() }).parse(commanderAdmission).message;
    const input = Buffer.concat([
      line(hello),
      line({ request_id: "admit", message: { type: "admit", data: admission } }),
      line(runRequest("forged", "0000000000000000")),
      line(runRequest("run", deriveTrialSeed("0000000000000000", 0))),
      line({ request_id: "commander", message: commanderRequest }),
    ]);
    // A cancel written together with the run would be honored at the first
    // checkpoint; mid-run cancellation ordering is proven in the canonical
    // worker suite, not through this all-at-once harness.
    const [a, b] = await Promise.all([run(input), run(input)]);
    expect(a).toEqual(b);
    expect(a[0]?.message).toMatchObject({
      type: "hello",
      data: { admission: true, execution: true, decisions: true, cancellation: true },
    });
    expect(a[1]).toEqual({ request_id: "admit", message: admitted });
    expect(a[2]?.message).toMatchObject({
      type: "outcome",
      data: { type: "invalid", data: { code: "trial_seed_mismatch" } },
    });
    const runReplies = a.filter((reply) => reply.request_id === "run");
    expect(runReplies).toHaveLength(5);
    for (const [index, reply] of runReplies.slice(0, 4).entries())
      expect(reply.message).toMatchObject({
        type: "event",
        data: { sequence: index, data: { type: "progress", data: { turns: index + 1 } } },
      });
    const outcome = runReplies[4]?.message;
    if (outcome?.type !== "outcome" || outcome.data.type !== "completed")
      throw new Error(JSON.stringify(outcome));
    expect(outcome.data.data).toMatchObject({
      winner_seats: [0],
      reason: "life_reached_zero",
      turns: 5,
      initial_state_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      final_state_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(outcome.data.data.initial_state_hash).not.toBe(outcome.data.data.final_state_hash);
    const rest = a.slice(3 + runReplies.length);
    expect(rest.map((reply) => reply.request_id)).toEqual(["commander"]);
    expect(rest[0]?.message).toMatchObject({
      type: "outcome",
      data: { type: "invalid", data: { code: "catalog_invalid" } },
    });
  },
);

native("refuses the real Muldrotha mirror pod per card before any Commander setup", async () => {
  const f = await baselineCatalogFixture();
  try {
    const captured = captureCatalog(f.options());
    if (!captured.ok) throw new Error(JSON.stringify(captured));
    const payload = CatalogPayloadSchema.parse(JSON.parse(captured.envelope.payload_json));
    const rulesDigest = z
      .object({ rules: z.object({ sha256: z.string() }) })
      .parse(
        JSON.parse(
          await readFile(
            new URL("../../engine/contract/preview-fixture.json", import.meta.url),
            "utf8",
          ),
        ),
      ).rules.sha256;
    // Every seat plays the captured deck as its own physical instances.
    const entries = [...payload.deck.commanders, ...payload.deck.cards];
    const scenarioFor = (envelope: CatalogEnvelope): CommanderScenario =>
      CommanderScenarioSchema.parse({
        scenario_id: "muldrotha-mirror-pod",
        engine_version: ENGINE_VERSION,
        // The scenario binds the ordered pod, not one capture (contract 7).
        snapshot_digest: podDigest([envelope.payload_digest]),
        rules_digest: rulesDigest,
        seats: [0, 1, 2, 3].map((seat) => {
          const cards = entries.flatMap((entry) =>
            Array.from({ length: entry.qty }, (_, copy) => ({
              physical_id: `s${seat}-${entry.oracle_id}-${copy}`,
              oracle_id: entry.oracle_id,
            })),
          );
          return {
            seat,
            deck_digest: envelope.payload_digest,
            policy: {
              id: "fixture-baseline",
              version: "1",
              observation_version: "1",
              search_nodes: 1,
            },
            commanders: [cards[0]!.physical_id],
            cards,
          };
        }),
        seed: "0123456789abcdef",
        limits: {
          trials: 1,
          concurrency: 1,
          max_turns: 10,
          max_actions: 10000,
          max_actions_per_turn: 1000,
          max_work: 1000000,
          max_elapsed_ms: 30000,
          max_memory_bytes: 100000000,
          max_output_bytes: 1000000,
        },
      });
    const admit = (request_id: string, scenario: CommanderScenario, envelope: CatalogEnvelope) => ({
      request_id,
      message: {
        type: "admit",
        data: {
          scenario: { type: "commander", data: scenario },
          // Contract 7: an admission carries a pod of captures; a mirror pod is one.
          catalog: { type: "commander", data: { decks: [envelope] } },
          expected_implementation_version: "core-support-v1",
          expected_implementation_digest: null,
        },
      },
    });
    const partnerJson = JSON.stringify({
      ...payload,
      deck: { ...payload.deck, command_zone_kind: "partner" },
    });
    const partner: CatalogEnvelope = {
      ...captured.envelope,
      payload_json: partnerJson,
      payload_digest: createHash("sha256").update(partnerJson).digest("hex"),
    };
    const pod = scenarioFor(captured.envelope);
    const replies = await run(
      Buffer.concat([
        line(hello),
        line(admit("pod", pod, captured.envelope)),
        line(admit("rules", { ...pod, rules_digest: "0".repeat(64) }, captured.envelope)),
        line(admit("partner", scenarioFor(partner), partner)),
      ]),
    );
    expect(replies.map((reply) => reply.request_id)).toEqual(["h-1", "pod", "rules", "partner"]);
    const outcome = replies[1]?.message;
    if (outcome?.type !== "outcome" || outcome.data.type !== "unsupported")
      throw new Error(JSON.stringify(outcome));
    const diagnostics = z
      .array(
        z.object({
          code: z.string(),
          oracle_id: z.string().optional(),
          physical_id: z.string().optional(),
        }),
      )
      .parse(outcome.data.data.diagnostics);
    // One exact refusal per Oracle identity of the 100-card deck, in deck
    // order, none per seat or per physical copy, and nothing admitted.
    expect(diagnostics.map((d) => d.oracle_id)).toEqual(entries.map((e) => e.oracle_id));
    expect(diagnostics).toHaveLength(f.source.records.length);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.code).toBe("card_unsupported");
      expect(diagnostic.physical_id).toBeUndefined();
    }
    expect(replies[2]?.message).toMatchObject({
      type: "outcome",
      data: { type: "invalid", data: { code: "commander_scenario_binding_mismatch" } },
    });
    expect(replies[3]?.message).toMatchObject({
      type: "outcome",
      data: {
        type: "unsupported",
        data: { diagnostics: [{ code: "commander_variant_unsupported" }] },
      },
    });
    expect(replies.some((r) => r.message.type === "admitted")).toBe(false);
  } finally {
    await f.close();
  }
});
