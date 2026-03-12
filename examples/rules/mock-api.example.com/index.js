/**
 * EXAMPLE: Full static mock — never hits the upstream.
 *
 * Every request to mock-api.example.com receives a fixed JSON body.
 * Useful for local development when the real API is unavailable or to
 * freeze a known-good fixture while testing.
 *
 * Drop this file in: ~/.proxy-rules/rules/mock-api.example.com/index.js
 */

const MOCK_BODY = JSON.stringify({
  users: [
    { id: 1, name: "Alice", role: "admin" },
    { id: 2, name: "Bob",   role: "viewer" },
  ],
  total: 2,
});

/** @type {import('proxy-rules/types').ProxyRule} */
const rule = {
  // No `target` needed — onRequest always returns a StaticResponse so
  // the request is never forwarded.

  onRequest(ctx) {
    console.log(`[mock-api] intercepted ${ctx.req.method} ${ctx.url}`);

    // Return a StaticResponse to short-circuit the proxy.
    // The upstream (mock-api.example.com) is never contacted.
    return {
      status: 200,
      contentType: "application/json",
      headers: {
        "X-Mocked-By": "proxy-rules",
        "Cache-Control": "no-store",
      },
      body: MOCK_BODY,
    };
  },
};

export default rule;
