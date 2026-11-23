/** Minimal `--flag value` parser. Unknown flags are errors. */
export function parseArgs(argv: string[], allowed: string[], booleans: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const name = a.slice(2);
    if (booleans.includes(name)) {
      out[name] = "true";
      continue;
    }
    if (!allowed.includes(name)) throw new Error(`unknown flag --${name}; allowed: ${allowed.map((x) => "--" + x).join(", ")}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
    out[name] = value;
    i += 1;
  }
  return out;
}

export function need(args: Record<string, string>, name: string): string {
  const v = args[name];
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
}
