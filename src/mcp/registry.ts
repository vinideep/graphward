export type PropertySchema = {
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  enum?: string[];
  items?: PropertySchema;
  properties?: Record<string, PropertySchema>;
  required?: string[];
  minimum?: number;
  additionalProperties?: boolean;
  minLength?: number;
  minItems?: number;
};

export type JsonSchema = {
  type: "object";
  properties?: Record<string, PropertySchema>;
  required?: string[];
  additionalProperties?: boolean;
};

export interface RegisteredTool<TArgs extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (args: TArgs, context?: { signal?: AbortSignal }) => Promise<unknown>;
}

function validateValue(name: string, value: unknown, schema: PropertySchema): void {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object.`);
    validateArguments({ type: "object", properties: schema.properties, required: schema.required, additionalProperties: schema.additionalProperties }, value);
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${name} must have at least ${schema.minItems} items.`);
    if (schema.items) value.forEach((item, index) => validateValue(`${name}[${index}]`, item, schema.items!));
    return;
  }
  if (typeof value !== schema.type) throw new Error(`${name} must be a ${schema.type}.`);
  if (schema.type === "number" && !Number.isFinite(value)) throw new Error(`${name} must be finite.`);
  if (schema.type === "string" && schema.minLength !== undefined && (value as string).trim().length < schema.minLength) throw new Error(`${name} is empty.`);
  if (schema.type === "number" && schema.minimum !== undefined && (value as number) < schema.minimum) throw new Error(`${name} must be at least ${schema.minimum}.`);
  if (schema.enum && !schema.enum.includes(value as string)) throw new Error(`${name} must be one of: ${schema.enum.join(", ")}.`);
}

export function validateArguments(schema: JsonSchema, input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Tool arguments must be an object.");
  const args = input as Record<string, unknown>;
  for (const required of schema.required ?? []) if (args[required] === undefined) throw new Error(`${required} is required.`);
  const properties = schema.properties ?? {};
  for (const [name, value] of Object.entries(args)) {
    const property = properties[name];
    if (!property) {
      if (schema.additionalProperties === false) throw new Error(`Unknown argument: ${name}.`);
      continue;
    }
    validateValue(name, value, property);
  }
  return args;
}

export class McpToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register<TArgs extends Record<string, unknown>>(tool: RegisteredTool<TArgs>): this {
    if (this.tools.has(tool.name)) throw new Error(`Duplicate MCP tool: ${tool.name}`);
    this.tools.set(tool.name, tool as RegisteredTool);
    return this;
  }

  has(name: string): boolean { return this.tools.has(name); }

  list(): Array<{ name: string; description: string; inputSchema: JsonSchema }> {
    return [...this.tools.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  async execute(name: string, input: unknown, context?: { signal?: AbortSignal }): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    const args = validateArguments(tool.inputSchema, input);
    return tool.handler(args, context);
  }
}
