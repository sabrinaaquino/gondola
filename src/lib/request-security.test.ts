import assert from "node:assert/strict";
import test from "node:test";
import { rejectUntrustedLocalRequest } from "./request-security";

test("accepts a same-origin local JSON request", () => {
  const request = new Request("http://localhost:3003/api/workspace", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:3003",
      "Sec-Fetch-Site": "same-origin",
    },
    body: "{}",
  });
  assert.equal(rejectUntrustedLocalRequest(request, "json"), undefined);
});

test("rejects simple cross-site and text/plain requests", () => {
  const request = new Request("http://localhost:3003/api/workspace", {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      Origin: "https://attacker.example",
      "Sec-Fetch-Site": "cross-site",
    },
    body: "{}",
  });
  assert.equal(rejectUntrustedLocalRequest(request, "json")?.status, 403);
});

test("rejects DNS-rebinding hostnames", () => {
  const request = new Request("http://attacker.example/api/xray", {
    headers: { "Sec-Fetch-Site": "same-origin" },
  });
  assert.equal(rejectUntrustedLocalRequest(request)?.status, 403);
});

test("keeps local command-line clients supported", () => {
  const request = new Request("http://127.0.0.1:3000/api/xray");
  assert.equal(rejectUntrustedLocalRequest(request), undefined);
});
