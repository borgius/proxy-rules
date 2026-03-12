/**
 * EXAMPLE: Maintenance page — block all traffic with a 503.
 *
 * Intercepts every request to maintenance.example.com and returns an HTML
 * maintenance page without ever touching the upstream server.
 *
 * Drop this file in: ~/.proxy-rules/rules/maintenance.example.com/index.js
 */

const HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Maintenance</title></head>
<body>
  <h1>Down for maintenance</h1>
  <p>We'll be back shortly. Sorry for the inconvenience.</p>
</body>
</html>`;

/** @type {import('proxy-rules/types').ProxyRule} */
const rule = {
  onRequest() {
    return {
      status: 503,
      contentType: "text/html; charset=utf-8",
      headers: {
        "Retry-After": "3600",
      },
      body: HTML,
    };
  },
};

export default rule;
