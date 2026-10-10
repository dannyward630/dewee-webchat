import { describe, expect, it } from "vitest";
import { createDeweeHandler } from "../src/server";

const h = createDeweeHandler({ secret: "s".repeat(32), allowClientCredentials: true });
const config = (url: string) =>
  h(new Request("https://site.test/api/dewee/config", { headers: { "x-dewee-gateway-url": url, "x-dewee-gateway-token": "t" } }));

describe("client credentials", () => {
  it.each(["http://localhost:8080", "https://127.0.0.1", "https://10.0.0.5", "https://169.254.169.254", "https://[::1]", "https://intranet", "http://gw.example.com"])(
    "rejects %s",
    async (url) => {
      const r = await config(url);
      expect(r.status).toBe(400);
    },
  );

  it("allows loopback only when explicitly listed", async () => {
    const local = createDeweeHandler({ secret: "s".repeat(32), allowClientCredentials: { allowedHosts: ["127.0.0.1"] } });
    const r = await local(new Request("https://site.test/api/dewee/config", { headers: { "x-dewee-gateway-url": "http://127.0.0.1:1", "x-dewee-gateway-token": "t" } }));
    expect(r.status).toBe(502); // passed validation, then failed to reach the (closed) port
  });
});
