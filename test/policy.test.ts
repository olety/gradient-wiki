import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classify, decide, POLICY, CATEGORY_SLUGS, type Verdict } from "../src/policy";
import { blockedLinkHost, linkHosts } from "../src/link-screen";
import { buildCaseMail } from "../src/mail";
import type { CaseEntry } from "../src/types";

const OK: Verdict = { verdict: "OK", category: null, quote: null };
const ERROR: Verdict = { verdict: "error" };
const input = { ns: "lobby", slug: "unit", rev: 1, by: "author", note: "summary", body: "ordinary text" };
const envelope = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unmocked outbound fetch"));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("pure policy matrix", () => {
  it.each([1, 2, 3, 4, 5, 6])("limits automatic actions for category %i", (category) => {
    const verdict: Verdict = { verdict: "VIOLATION", category, quote: "evidence" };
    expect(decide("write", verdict)).toEqual(category === 6 ? { action: "open" } : { action: "redact", reason: CATEGORY_SLUGS[category - 1] });
    for (const reason of CATEGORY_SLUGS) expect(decide("report", verdict, reason)).toEqual({ action: "redact", reason: CATEGORY_SLUGS[category - 1] });
    for (const reason of ["copyright", "other"]) expect(decide("report", verdict, reason)).toEqual({ action: "open" });
  });
  it.each([OK, ERROR])("leaves writers alone and disputed reports open for $verdict", (verdict) => {
    expect(decide("write", verdict)).toEqual({ action: "none" });
    for (const reason of [...CATEGORY_SLUGS, "copyright", "secret", "other"]) expect(decide("report", verdict, reason)).toEqual({ action: "open" });
  });
  it("maps the local credential match to secret, not a model category", () => {
    expect(decide("report", { verdict: "VIOLATION", category: 0, quote: null }, "secret")).toEqual({ action: "redact", reason: "secret" });
  });
});

describe("classifier request and failure bounds", () => {
  it("sends the fixed prompt, schema, hint and only 12000 body characters", async () => {
    vi.mocked(fetch).mockResolvedValue(envelope(JSON.stringify(OK)));
    expect(await classify({ ...env, POLICY_MODEL: "chosen-model" }, { ...input, row: 3, reason: "threat", body: "x".repeat(13000) })).toEqual(OK);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("https://policy.test/v1");
    expect(new Headers(init!.headers).get("authorization")).toBe("Bearer test-key");
    const request = JSON.parse(String(init!.body));
    expect(request).toMatchObject({ temperature: 0, max_tokens: 400, model: "chosen-model" });
    expect(request.messages).toEqual([{ role: "system", content: POLICY }, { role: "user", content: `lobby/unit row 3
by: author
note: summary
report: threat
---
${"x".repeat(12000)}` }]);
    expect(request.response_format).toEqual({ type: "json_schema", json_schema: { name: "verdict", strict: true, schema: {
      type: "object", properties: { verdict: { enum: ["VIOLATION", "OK"] }, category: { type: ["integer", "null"] }, quote: { type: ["string", "null"] } },
      required: ["verdict", "category", "quote"], additionalProperties: false,
    } } });
  });

  it("parses the first JSON object in wrapped output and bounds evidence", async () => {
    const quote = 'brace } and "quoted" ' + "x".repeat(400);
    vi.mocked(fetch).mockResolvedValue(envelope(`result:
${JSON.stringify({ verdict: "VIOLATION", category: 3, quote })}
extra {"ignored":true}`));
    expect(await classify(env, input)).toEqual({ verdict: "VIOLATION", category: 3, quote: quote.slice(0, 300) });
  });

  it("retries once after two seconds, then times out at twenty seconds", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("unavailable", { status: 500 }))
      .mockImplementationOnce(async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")), { once: true });
      }));
    const pending = classify(env, input);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    const signal = vi.mocked(fetch).mock.calls[1]![1]!.signal!;
    await vi.advanceTimersByTimeAsync(19999);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    expect(await pending).toEqual(ERROR);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries malformed or out-of-policy output without inventing a category", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(envelope("not JSON"))
      .mockResolvedValueOnce(envelope(JSON.stringify({ verdict: "VIOLATION", category: 7, quote: "copyright" })));
    const pending = classify(env, input);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toEqual(ERROR);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not fetch without a key and uses documented endpoint defaults", async () => {
    expect(await classify({ ...env, OPENROUTER_KEY: "" }, input)).toEqual(ERROR);
    expect(fetch).not.toHaveBeenCalled();
    vi.mocked(fetch).mockResolvedValue(envelope(JSON.stringify(OK)));
    await classify({ ...env, POLICY_URL: "", POLICY_MODEL: "" }, input);
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)).model).toBe("openai/gpt-oss-safeguard-20b");
  });
});

describe("link extraction and timeout", () => {
  it("extracts markdown hosts, normalizes names and never resolves the site's own host", () => {
    expect(linkHosts("[one](https://Bad.Test) [two](https://bad.test/path) https://user:pass@BAD.test.:443/a http://other.test, HTTPS://GRADIENT.WIKI./x https://[::1]/", "gradient.wiki"))
      .toEqual(["bad.test", "other.test", "[::1]"]);
  });
  it("fails open after three seconds with no real network access", async () => {
    let started!: () => void;
    const sent = new Promise<void>((resolve) => { started = resolve; });
    vi.mocked(fetch).mockImplementationOnce(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")), { once: true });
      started();
    }));
    const pending = blockedLinkHost("https://unit-timeout.test/path", "gradient.wiki", env);
    await sent;
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toBeNull();
    expect(vi.mocked(fetch).mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });
});

it("builds one private queue mail with an unkeyed queue URL", () => {
  const entry: CaseEntry = { seq: 1, at: 0, ns: "lobby", slug: "case", rev: 1, row: null, source: "report", reason: "copyright", note: "private note", by: "reporter", cat: null, quote: "private quote", action: "none", status: "open", resolved_at: null, resolved_by: null, reports: 1 };
  const mail = buildCaseMail([entry, { ...entry, seq: 2 }], { to: "owner@example.com", publicUrl: "https://gradient.wiki", now: 0 });
  expect(mail.from).toBe("inbox@gradient.wiki");
  expect(mail.raw).toContain("Subject: gradient.wiki: 2 open cases\r\n");
  expect(mail.raw).toContain("private note");
  expect(mail.raw).toContain("private quote");
  expect(mail.raw).toContain("https://gradient.wiki/mod/queue\n");
  expect(mail.raw).not.toContain("?mod=");
});
