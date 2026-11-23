import { z } from "zod";
import { AnalysisShardFileSchema, CoreFileSchema, DigestsFileSchema, ManifestSchema, VotesFileSchema } from "../schema/validate-v1.ts";

/** File name (in schema/json/) to JSON Schema document, generated from the zod validators. */
export function jsonSchemas(): Record<string, unknown> {
  const make = (schema: z.ZodType, title: string): unknown => ({ title, ...z.toJSONSchema(schema, { target: "draft-2020-12" }) });
  return {
    "manifest.schema.json": make(ManifestSchema, "Snapshot manifest (latest.json, manifests/<snapshotId>.json), schema v1"),
    "core.schema.json": make(CoreFileSchema, "core-<hash8>.json, schema v1"),
    "votes.schema.json": make(VotesFileSchema, "votes-<hash8>.json, schema v1"),
    "digests.schema.json": make(DigestsFileSchema, "digests-<hash8>.json, schema v1"),
    "analysis-shard.schema.json": make(AnalysisShardFileSchema, "analysis-<shard>-<hash8>.json, schema v1"),
  };
}
