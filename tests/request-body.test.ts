import { describe, expect, it } from "vitest";
import {
  readJsonRequest,
  RequestBodyTooLargeError,
} from "../src/server/request-body";

describe("bounded JSON request bodies", () => {
  it("rejects a declared oversized body before parsing it", async () => {
    const request = new Request("https://stowplan.test/api/sync", {
      body: "{}",
      headers: { "content-length": "17" },
      method: "POST",
    });
    await expect(readJsonRequest(request, 16)).rejects.toMatchObject({
      status: 413,
    } satisfies Partial<RequestBodyTooLargeError>);
  });

  it("counts streamed UTF-8 bytes when content length is absent", async () => {
    const body = JSON.stringify({ value: "😀" });
    const request = new Request("https://stowplan.test/api/sync", {
      body,
      method: "POST",
    });
    await expect(
      readJsonRequest(request, body.length),
    ).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  it("parses an in-budget body and rejects malformed UTF-8", async () => {
    await expect(readJsonRequest(
      new Request("https://stowplan.test/api/sync", {
        body: JSON.stringify({ workspaceId: "ws_test" }),
        method: "POST",
      }),
      128,
    )).resolves.toEqual({ workspaceId: "ws_test" });

    await expect(readJsonRequest(
      new Request("https://stowplan.test/api/sync", {
        body: new Uint8Array([0xc3, 0x28]),
        method: "POST",
      }),
      128,
    )).rejects.toThrow(/not valid UTF-8/);
  });
});
