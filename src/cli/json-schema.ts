import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { jsonSchemas } from "../jsonSchema.ts";

/** Writes schema/json/*.schema.json from the zod validators in schema/validate-v1.ts. */
async function main(): Promise<void> {
  const dir = "schema/json";
  await mkdir(dir, { recursive: true });
  for (const [name, doc] of Object.entries(jsonSchemas())) {
    await writeFile(join(dir, name), JSON.stringify(doc, null, 2) + "\n", "utf8");
    console.log(`wrote ${join(dir, name)}`);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
