// Id and collection rules from docs/api.md, shared by the scripts and the CLI.

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isValidId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

const QA_RE = /^items\/([^/]+)\/qa$/;

// "items" | "orchestrators" | "meta" | "items/<valid id>/qa"
export function isValidCollection(name) {
  if (name === "items" || name === "orchestrators" || name === "meta") return true;
  const m = QA_RE.exec(name);
  return !!m && isValidId(m[1]);
}

// The item id of a qa collection, or null.
export function qaItemId(collection) {
  const m = QA_RE.exec(collection);
  return m ? m[1] : null;
}
