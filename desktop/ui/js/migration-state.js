/* Preserve raw strings before remapping; never replace a previous checkpoint. */
((root, factory) => {
  const migration = factory();
  if (typeof module === "object" && module.exports) module.exports = migration;
  else root.MigrationState = migration;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";
  const BACKUP_KEY = "hsc-state-before-migration-v2";
  const KEYS = ["hsc-state-v1", "hsc-bookmarked", "hsc-recent", "hsc-downloaded", "hsc-queue"];
  function checkpoint(storage) {
    if (storage.getItem(BACKUP_KEY) !== null) return;
    const values = Object.fromEntries(KEYS.map(key => [key, storage.getItem(key)]));
    storage.setItem(BACKUP_KEY, JSON.stringify({ version: 1, at: new Date().toISOString(), values }));
    if (storage.getItem(BACKUP_KEY) === null) throw new Error("Could not retain migration state checkpoint");
  }
  function compatible(data) { return data?.dataVersion === 2 && Array.isArray(data.papers) && Array.isArray(data.recoveryPapers || []); }
  return { BACKUP_KEY, KEYS, checkpoint, compatible };
});
