// Validates agent-supplied action args against the JSON Schema subset page actions declare:
// type (incl. arrays of types), properties, required, additionalProperties (boolean), enum, const,
// minLength/maxLength, pattern, minimum/maximum, items, minItems/maxItems. Unknown keywords are ignored.

export type JsonSchema = Record<string, unknown>;

const typeOf = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v;

const matchesType = (v: unknown, t: string) => {
  const actual = typeOf(v);
  return actual === t || (t === "number" && actual === "integer");
};

/** Returns the first validation error ("args.status: must be one of …"), or null when valid. */
export function validateJsonSchema(value: unknown, schema: JsonSchema | undefined, path = "args", depth = 0): string | null {
  if (!schema || typeof schema !== "object") return null;
  if (depth > 32) return `${path}: schema is nested too deeply`;
  const s = schema as Record<string, any>;

  if (s.type !== undefined) {
    const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => matchesType(value, t))) return `${path}: expected ${types.join(" or ")}, got ${typeOf(value)}`;
  }
  if (Array.isArray(s.enum) && !s.enum.some((e: unknown) => sameJson(e, value))) {
    return `${path}: must be one of ${s.enum.map((e: unknown) => JSON.stringify(e)).join(", ")}`;
  }
  if ("const" in s && !sameJson(s.const, value)) return `${path}: must equal ${JSON.stringify(s.const)}`;

  if (typeof value === "string") {
    if (typeof s.minLength === "number" && value.length < s.minLength) return `${path}: shorter than ${s.minLength} characters`;
    if (typeof s.maxLength === "number" && value.length > s.maxLength) return `${path}: longer than ${s.maxLength} characters`;
    if (typeof s.pattern === "string") {
      let re: RegExp | null = null;
      try { re = new RegExp(s.pattern, "u"); } catch { return `${path}: schema pattern is invalid`; }
      if (!re.test(value)) return `${path}: does not match ${s.pattern}`;
    }
  }
  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) return `${path}: must be >= ${s.minimum}`;
    if (typeof s.maximum === "number" && value > s.maximum) return `${path}: must be <= ${s.maximum}`;
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems) return `${path}: needs at least ${s.minItems} items`;
    if (typeof s.maxItems === "number" && value.length > s.maxItems) return `${path}: allows at most ${s.maxItems} items`;
    if (s.items && typeof s.items === "object") {
      for (let i = 0; i < value.length; i++) {
        const err = validateJsonSchema(value[i], s.items, `${path}[${i}]`, depth + 1);
        if (err) return err;
      }
    }
  }
  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    const props: Record<string, JsonSchema> = s.properties && typeof s.properties === "object" ? s.properties : {};
    for (const key of Array.isArray(s.required) ? s.required : []) {
      if (!(key in obj)) return `${path}.${key}: is required`;
    }
    for (const [key, v] of Object.entries(obj)) {
      if (Object.prototype.hasOwnProperty.call(props, key)) {
        const err = validateJsonSchema(v, props[key], `${path}.${key}`, depth + 1);
        if (err) return err;
      } else if (s.additionalProperties === false) {
        return `${path}.${key}: is not allowed`;
      }
    }
  }
  return null;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
