#!/usr/bin/env tsx
/**
 * Generate a new access token via the running RAG server.
 * Server must be running on port 3001.
 *
 * Usage: npm run gen-token
 */

import { request } from "node:http";

const options = {
  hostname: "127.0.0.1",
  port: 3001,
  path: "/api/token/new",
  method: "POST",
  headers: { "Accept": "application/json" },
};

const req = request(options, (res) => {
  let body = "";
  res.on("data", (chunk) => (body += chunk));
  res.on("end", () => {
    if (res.statusCode === 200) {
      const result = JSON.parse(body);
      console.log(`\n🔑 New access token: ${result.token}`);
      console.log(`   Expires in: ${result.expiresIn / 60} minutes`);
      console.log(`\n   RAG Document Manager: http://localhost:3001/?token=${result.token}`);
      console.log(`   Resume Chat:          http://localhost:3001/resume/chat?token=${result.token}\n`);
    } else {
      try {
        const err = JSON.parse(body);
        console.error(`\n❌ Failed: ${err.error || res.statusMessage}\n`);
      } catch {
        console.error(`\n❌ Server returned ${res.statusCode}\n`);
      }
    }
  });
});

req.on("error", (err) => {
  console.error(`\n❌ Cannot connect to server: ${err.message}`);
  console.error(`   Make sure the server is running on http://127.0.0.1:3001\n`);
});

req.end();
