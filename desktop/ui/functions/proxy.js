export async function onRequest({ request }) {
  return new Response("proxy-test-ok", { status: 200 });
}
