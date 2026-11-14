export async function evaRequest(path, body) {
  const response = await fetch(`/api/eva/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "No se pudo completar la operación EVA");
  return data;
}
