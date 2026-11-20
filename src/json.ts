// One canonical runtime guard for decoded JSON. Kept in its own module so
// network-boundary parsing shares a single definition.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
