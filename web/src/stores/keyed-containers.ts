export interface AbortableRequestOwner {
  readonly controller: AbortController;
}

export function keyedRecord<Key extends string, Value>(keys: readonly Key[], valueFor: (key: Key) => Value): Record<Key, Value> {
  return Object.fromEntries(keys.map((key) => [key, valueFor(key)])) as Record<Key, Value>;
}

export function withKey<Key extends string, Value>(record: Record<Key, Value>, key: NoInfer<Key>, value: NoInfer<Value>): Record<Key, Value> {
  return { ...record, [key]: value };
}

export function replaceRequestOwner<Key, Owner extends AbortableRequestOwner>(owners: Map<Key, Owner>, key: Key, owner: Owner): void {
  owners.get(key)?.controller.abort();
  owners.set(key, owner);
}

export function abortRequestOwner<Key, Owner extends AbortableRequestOwner>(owners: Map<Key, Owner>, key: Key): void {
  owners.get(key)?.controller.abort();
  owners.delete(key);
}

export function releaseRequestOwner<Key, Owner extends AbortableRequestOwner>(owners: Map<Key, Owner>, key: Key, owner: Owner): void {
  if (owners.get(key) === owner) owners.delete(key);
}

export function abortRequestOwners<Key, Owner extends AbortableRequestOwner>(owners: Map<Key, Owner>): void {
  for (const owner of owners.values()) owner.controller.abort();
  owners.clear();
}
