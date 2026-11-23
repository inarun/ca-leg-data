import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { jsonSchemas } from "../src/jsonSchema.ts";
import { REPO } from "./helpers.ts";

describe("schema/json", () => {
  it("the committed JSON Schema files match the zod validators (run npm run json-schema after changing them)", async () => {
    const docs = jsonSchemas();
    expect(Object.keys(docs).length).toBe(5);
    for (const [name, doc] of Object.entries(docs)) {
      const onDisk = (await readFile(join(REPO, "schema", "json", name), "utf8")).replace(/\r\n/g, "\n");
      expect(onDisk, name).toBe(JSON.stringify(doc, null, 2) + "\n");
    }
  });
});
