#!/usr/bin/env tsx
/**
 * Generate a new access token via the running RAG server.
 * Requires the server to be running on port 3001 and an existing valid token.
 *
 * Usage: npx tsx scripts/gen-token.ts <current-token>
 *        npm run gen-token <current-token>
 *
 * If no token provided, prints instruction.
 */

import { request } from "node:http";

const token = process.argv[2];

if (!token) {
  console.log(`\nUsage: npm run gen-token <current-token>\n`);
  console.log(`The current token is shown when you start the server:`);
  console.log(`  🔑 Access token: xxxxxxxxxxxx\n`);
  process.exit(1);
}

const data = JSON.stringify({ token });
const options = {
  hostname: "127.0.0.1",
  port: 3001,
  path: "/api/token/renew",
  method: "POST",
  headers: { "Content-Type": "application/json" },
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
      const err = JSON.parse(body);
      console.error(`\n❌ Failed: ${err.error || res.statusMessage}`);
      console.error(`   Make sure the server is running and the token is valid.\n`);
    }
  });
});

req.on("error", (err) => {
  console.error(`\n❌ Cannot connect to server: ${err.message}`);
  console.error(`   Make sure the server is running on http://127.0.0.1:3001\n`);
});

req.write(data);
req.end();
