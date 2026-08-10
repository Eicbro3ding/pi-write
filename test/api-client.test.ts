import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, imageUrl } from "../web/src/api/client.ts";

describe("ApiClient", () => {
  afterEach(() => vi.restoreAllMocks());
  it("getBooks 请求 /api/books", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ books: [] }) }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("http://x:1");
    await client.getBooks();
    expect(fetchMock).toHaveBeenCalledWith("http://x:1/api/books", expect.anything());
  });
  it("默认 baseUrl 为同源相对路径(经 vite 代理/生产同源均可用)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ books: [] }) }));
    vi.stubGlobal("fetch", fetchMock);
    // 不传 baseUrl:必须请求相对路径,绝不可硬编码绝对地址(否则 vite dev 跨源被 CORS 拦)
    await new ApiClient().getBooks();
    expect(fetchMock).toHaveBeenCalledWith("/api/books", expect.anything());
  });
  it("错误体解析", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: { message: "未找到" } }) })));
    await expect(new ApiClient("http://x:1").getBook("nope")).rejects.toThrow("未找到");
  });
  it("exportBook 请求 GET /api/books/x/export 并解析为 Blob", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => new Blob(["zip"]) }));
    vi.stubGlobal("fetch", fetchMock);
    const blob = await new ApiClient("http://x:1").exportBook("x");
    expect(blob).toBeInstanceOf(Blob);
    expect(fetchMock).toHaveBeenCalledWith("http://x:1/api/books/x/export");
  });
  it("exportBook 非 2xx 时解析错误体抛 ApiError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: { message: "书不存在" } }) })));
    await expect(new ApiClient("http://x:1").exportBook("nope")).rejects.toThrow("书不存在");
  });
  it("importBook 请求 POST /api/books/import 且 body 为 FormData(不手设 content-type)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ book: { slug: "b", title: "B", chapters: [] } }) }));
    vi.stubGlobal("fetch", fetchMock);
    const book = await new ApiClient("http://x:1").importBook(new File(["zip"], "b.zip"));
    expect(book.slug).toBe("b");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://x:1/api/books/import",
      expect.objectContaining({ method: "POST", body: expect.any(FormData) }),
    );
    // FormData 由 fetch 自动设 boundary,不得带手动 content-type(走 request() 会强制 json)
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toBeUndefined();
  });
  it("deleteBook 请求 DELETE /api/books/x", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    await new ApiClient("http://x:1").deleteBook("x");
    expect(fetchMock).toHaveBeenCalledWith("http://x:1/api/books/x", expect.objectContaining({ method: "DELETE" }));
  });
  it("subscribeEvents 的 onOpen 回调接到 EventSource.onopen", () => {
    const onOpen = vi.fn();
    const close = vi.fn();
    const es: { onopen: (() => void) | null; onmessage: unknown; close: () => void } = {
      onopen: null,
      onmessage: null,
      close,
    };
    // 普通函数 + 返回对象的构造器形态(new EventSource(...) 返回 es),vi.fn 实现不可构造
    vi.stubGlobal("EventSource", function EventSourceStub() {
      return es;
    });
    const client = new ApiClient("http://x:1");
    const unsub = client.subscribeEvents(() => {}, onOpen);
    es.onopen?.();
    expect(onOpen).toHaveBeenCalledTimes(1);
    unsub();
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("subscribeEvents 不传 onOpen 时不抛错且连接可关闭", () => {
    const close = vi.fn();
    const es: { onopen: (() => void) | null; onmessage: unknown; close: () => void } = {
      onopen: null,
      onmessage: null,
      close,
    };
    vi.stubGlobal("EventSource", function EventSourceStub() {
      return es;
    });
    const unsub = new ApiClient("http://x:1").subscribeEvents(() => {});
    unsub();
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("getProviders 请求 GET /api/providers", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ providers: [] }) }));
    vi.stubGlobal("fetch", fetchMock);
    const list = await new ApiClient("http://x:1").getProviders();
    expect(list).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith("http://x:1/api/providers", expect.anything());
  });
  it("setProviderApiKey 请求 POST /api/providers/x/apikey 且 body 带 key", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    await new ApiClient("http://x:1").setProviderApiKey("anthropic", "sk-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://x:1/api/providers/anthropic/apikey",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ key: "sk-1" }) }),
    );
  });
  it("setProviderApiKey 非 2xx 时解析错误体抛 ApiError(含状态码)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "该 provider 需要额外配置" } }) })));
    try {
      await new ApiClient("http://x:1").setProviderApiKey("cloudflare", "k");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(400);
      expect((e as ApiError).message).toContain("需要额外配置");
    }
  });
  it("deleteProvider 请求 DELETE /api/providers/x", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    await new ApiClient("http://x:1").deleteProvider("openai");
    expect(fetchMock).toHaveBeenCalledWith("http://x:1/api/providers/openai", expect.objectContaining({ method: "DELETE" }));
  });
  it("uploadImage 请求 POST /api/books/x/images 且 body 为 FormData(不手设 content-type)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ file: "images/img-abc123.png" }) }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await new ApiClient("http://x:1").uploadImage("x", new File(["img"], "a.png", { type: "image/png" }));
    expect(r.file).toBe("images/img-abc123.png");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://x:1/api/books/x/images",
      expect.objectContaining({ method: "POST", body: expect.any(FormData) }),
    );
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toBeUndefined();
  });
  it("uploadImage 非 2xx 时解析错误体抛 ApiError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "仅支持 png/jpeg/webp/gif 图片" } }) })));
    await expect(new ApiClient("http://x:1").uploadImage("x", new File(["x"], "a.txt", { type: "text/plain" }))).rejects.toThrow("仅支持 png/jpeg/webp/gif 图片");
  });
  it("deleteImage 请求 DELETE /api/books/x/images/images%2Fa.png", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    await new ApiClient("http://x:1").deleteImage("x", "images/a.png");
    expect(fetchMock).toHaveBeenCalledWith("http://x:1/api/books/x/images/images%2Fa.png", expect.objectContaining({ method: "DELETE" }));
  });
  it("imageUrl 拼同源相对路径", () => {
    expect(imageUrl("x", "images/a.png")).toBe("/api/books/x/images/images%2Fa.png");
  });
});
