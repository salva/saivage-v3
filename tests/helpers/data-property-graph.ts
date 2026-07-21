export function dataPropertyGraphContains(root: unknown, forbidden: ReadonlySet<unknown>): boolean {
  const visited = new Set<object>();
  const visit = (value: unknown): boolean => {
    if (forbidden.has(value)) return true;
    if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false;
    if (typeof value === 'function') return false;
    if (visited.has(value)) return false;
    visited.add(value);
    if (value instanceof Map) {
      for (const [key, entry] of value) if (visit(key) || visit(entry)) return true;
    }
    if (value instanceof Set) {
      for (const entry of value) if (visit(entry)) return true;
    }
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && 'value' in descriptor && visit(descriptor.value)) return true;
    }
    return false;
  };
  return visit(root);
}
