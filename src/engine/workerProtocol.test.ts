import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { captureCatalog } from "./catalog.js";
import { catalogFixture, baselineCatalogFixture } from "./catalogFixture.test-support.js";
import { CatalogPayloadSchema, type CatalogPayload } from "./protocol.generated.js";
import { expect, it } from "vitest";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import {
  ENGINE_VERSION,
  PROTOCOL_VERSION,
  SCHEMA_SHA256,
  type Response,
} from "./protocol.generated.js";
import { assertCompatibleHello, WorkerFrameDecoder } from "./protocol.js";

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
  for (const response of replies.slice(1)) {
    expect(response.request_id).toBe("req-1");
    expect(response.message.type).toBe("outcome");
    if (response.message.type === "outcome") expect(response.message.data.type).toBe("unsupported");
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
          message: { type: "catalog_check", data: captured.envelope },
        }),
      ]),
    );
    expect(replies).toHaveLength(2);
    expect(replies[0]?.message).toMatchObject({
      type: "hello",
      data: { admission: false, execution: false },
    });
    expect(replies[1]).toEqual({
      request_id: "catalog-baseline",
      message: { type: "catalog_checked", data: captured.envelope },
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
        message: { type: "catalog_check", data },
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
      data: captured.envelope,
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
            message: { type: "catalog_check", data: envelope },
          }),
        ]),
      );
      expect(replies.at(-1)?.message).toEqual({
        type: "catalog_checked",
        data: envelope,
      });
    } finally {
      await f.close();
    }
  },
);
