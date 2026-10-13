export async function onRequest(args) {
  try {
    const { onRequest: handler } = await import("../_lib/pdf-proxy.mjs");
    return await handler(args);
  } catch (e) {
    return new Response("Proxy error v4: " + (e?.stack || e?.message || e), { status: 500 });
  }
}
