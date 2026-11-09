// Undo checkpoints for write tools.
//
// Locus' desktop agent takes a workspace checkpoint once per agent round, so an
// `undo` request restores the round. DSH exposes no checkpoint service to
// plugins, so this module keeps a bounded, in-memory record of the writes made
// through the Locus tools — the honest fallback the `unity_asset` tool's
// `undo` action and any future `undo` tool rely on. A checkpoint that a later
// write superseded can no longer be undone by its token.
//
// Limitation: records are process-local and survive neither a restart nor a
// domain reload of the editor (the editor does not expose file restoration).

const MAX_ENTRIES = 200

/** owner → { pipe, openedAt, records: [{tool, detail}] } inserted in order. */
const checkpoints = new Map()

export async function beginUndoCheckpoint(owner, target) {
  const existing = checkpoints.get(owner)
  if (existing && existing.pipe === target.pipe) {
    existing.openedAt = Date.now()
    return
  }
  checkpoints.set(owner, { pipe: target.pipe, openedAt: Date.now(), records: [] })
  while (checkpoints.size > MAX_ENTRIES) checkpoints.delete(checkpoints.keys().next().value)
}

export async function endUndoCheckpoint(owner, target) {
  // Records stay available for an explicit undo; end only marks the checkpoint
  // closed so later inspections can tell it did not capture a tool result.
  const entry = checkpoints.get(owner)
  if (entry && entry.pipe === target.pipe) entry.closedAt = Date.now()
}

/** Remember one completed write inside the owner's open checkpoint. */
export function recordWrite(owner, tool, detail) {
  const entry = checkpoints.get(owner)
  if (!entry) return
  entry.records.push({ tool, at: Date.now(), detail })
  if (entry.records.length > 50) entry.records.shift()
}

/** Records captured for one owner (oldest first). */
export function checkpointRecords(owner) {
  return checkpoints.get(owner)?.records ?? []
}

export function clearCheckpoints() {
  checkpoints.clear()
}
