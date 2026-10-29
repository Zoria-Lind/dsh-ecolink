// Shared wire version: ignores access timestamps; includes every editable field.
// No Node imports: extension and adapter use the same fingerprint.
export function entryIdentity(item) {
  return JSON.stringify([item?.id ?? null, item?.key ?? null, item?.content ?? '',
    item?.injectionPolicy === 'universal' ? 'universal' : 'manual', item?.kind ?? 'fact', item?.revision ?? null])
}
export function injectionPolicy(item) { return item?.injectionPolicy === 'universal' ? 'universal' : 'manual' }
