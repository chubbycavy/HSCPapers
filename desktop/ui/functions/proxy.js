import { onRequest as handler } from "../_lib/pdf-proxy.mjs";
export async function onRequest(args) {
  try { return await handler(args); }
  catch (e) { return new Response("Proxy error v3: " + (e?.stack || e?.message || e), { status: 500 }); }
}
