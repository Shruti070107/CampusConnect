import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { uploadFileWithProgress } from "./uploadFileWithProgress";

class MockXHR {
  static instances: MockXHR[] = [];
  static lastInstance: MockXHR | null = null;

  upload: {
    onprogress:
      ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
  } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 200;
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown = null;
  aborted = false;

  constructor() {
    MockXHR.instances.push(this);
    MockXHR.lastInstance = this;
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  send(body: unknown) {
    this.body = body;
  }

  abort() {
    this.aborted = true;
  }

  emitProgress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }

  emitSuccess() {
    this.onload?.();
  }

  emitError() {
    this.onerror?.();
  }
}

function makeResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

function makeFetchMock({
  signError = null,
  finalizeError = null,
}: { signError?: string | null; finalizeError?: string | null } = {}) {
  const signCalls: Array<{ url: string; init: RequestInit }> = [];
  const finalizeCalls: Array<{ url: string; init: RequestInit }> = [];

  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (body.action === "finalize") {
      finalizeCalls.push({ url, init });
      if (finalizeError) return makeResponse({ error: finalizeError }, 500);
      return makeResponse({ ok: true });
    }
    signCalls.push({ url, init });
    if (signError) return makeResponse({ error: signError }, 400);
    return makeResponse({
      url: "https://signed.example/sign/avatars/user-123/avatar.png?token=tok",
      path: "user-123/avatar.png",
      token: "tok",
      expiresIn: 900,
    });
  });

  return { fetchMock, signCalls, finalizeCalls };
}

const SUPABASE_URL = "https://project.supabase.co";
const ACCESS_TOKEN = "jwt-token";

function makePngFile(name = "avatar.png", size = 10) {
  return new File([new Uint8Array(size)], name, { type: "image/png" });
}

describe("uploadFileWithProgress", () => {
  beforeEach(() => {
    MockXHR.instances = [];
    MockXHR.lastInstance = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("signs, uploads via signed PUT with progress and finalizes", async () => {
    const { fetchMock, signCalls, finalizeCalls } = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("XMLHttpRequest", MockXHR);

    const file = makePngFile("avatar.png", 12);
    const progress: number[] = [];
    const result = uploadFileWithProgress(
      SUPABASE_URL,
      ACCESS_TOKEN,
      "avatars",
      "user-123/avatar.png",
      file,
      (percent) => progress.push(percent),
    );

    await vi.waitFor(() => {
      if (!MockXHR.lastInstance) throw new Error("XHR not created");
    });
    expect(signCalls).toHaveLength(1);
    expect(signCalls[0].url).toBe(`${SUPABASE_URL}/functions/v1/generate-upload-url`);
    expect(JSON.parse(String(signCalls[0].init.body))).toEqual({
      bucket: "avatars",
      folder: "user-123",
      fileName: "avatar.png",
      contentType: "image/png",
      fileSize: 12,
    });
    expect((signCalls[0].init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${ACCESS_TOKEN}`,
    );

    const xhr = MockXHR.lastInstance!;
    expect(xhr).not.toBeNull();
    expect(xhr.method).toBe("PUT");
    expect(xhr.url).toBe("https://signed.example/sign/avatars/user-123/avatar.png?token=tok");
    expect(xhr.headers["Content-Type"]).toBe("image/png");

    xhr.emitProgress(50, 100);
    expect(progress).toEqual([50]);

    xhr.emitSuccess();

    await expect(result).resolves.toBe("user-123/avatar.png");
    expect(finalizeCalls).toHaveLength(1);
    expect(JSON.parse(String(finalizeCalls[0].init.body))).toEqual({
      action: "finalize",
      bucket: "avatars",
      path: "user-123/avatar.png",
    });
  });

  it("does not PUT when signing fails and surfaces the server error", async () => {
    const { fetchMock } = makeFetchMock({
      signError: "File too large: avatars allows a maximum of 2 MB",
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("XMLHttpRequest", MockXHR);

    const file = makePngFile("avatar.png", 100);
    await expect(
      uploadFileWithProgress(
        SUPABASE_URL,
        ACCESS_TOKEN,
        "avatars",
        "user-123/avatar.png",
        file,
        () => {},
      ),
    ).rejects.toThrow("File too large");
    expect(MockXHR.instances).toHaveLength(0);
  });

  it("rejects when the signed PUT fails with an HTTP error status", async () => {
    const { fetchMock } = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("XMLHttpRequest", MockXHR);

    const file = makePngFile();
    const result = uploadFileWithProgress(
      SUPABASE_URL,
      ACCESS_TOKEN,
      "avatars",
      "user-123/avatar.png",
      file,
      () => {},
    );

    await vi.waitFor(() => {
      if (!MockXHR.lastInstance) throw new Error("XHR not created");
    });
    const xhr = MockXHR.lastInstance!;
    xhr.status = 500;
    xhr.emitSuccess();

    await expect(result).rejects.toThrow("Upload failed with status 500");
  });

  it("rejects on network error during the PUT", async () => {
    const { fetchMock } = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("XMLHttpRequest", MockXHR);

    const file = makePngFile();
    const result = uploadFileWithProgress(
      SUPABASE_URL,
      ACCESS_TOKEN,
      "avatars",
      "user-123/avatar.png",
      file,
      () => {},
    );

    await vi.waitFor(() => {
      if (!MockXHR.lastInstance) throw new Error("XHR not created");
    });
    MockXHR.lastInstance!.emitError();

    await expect(result).rejects.toThrow("Upload failed due to a network error");
  });

  it("rejects with 'Upload cancelled' when the abort signal fires mid-PUT", async () => {
    const { fetchMock } = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("XMLHttpRequest", MockXHR);

    const controller = new AbortController();
    const file = makePngFile();
    const result = uploadFileWithProgress(
      SUPABASE_URL,
      ACCESS_TOKEN,
      "avatars",
      "user-123/avatar.png",
      file,
      () => {},
      controller.signal,
    );

    await vi.waitFor(() => {
      if (!MockXHR.lastInstance) throw new Error("XHR not created");
    });

    controller.abort();
    await expect(result).rejects.toThrow("Upload cancelled");
  });

  it("surfaces a finalize failure after a successful PUT", async () => {
    const { fetchMock } = makeFetchMock({ finalizeError: "Failed to finalize upload" });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("XMLHttpRequest", MockXHR);

    const file = makePngFile();
    const result = uploadFileWithProgress(
      SUPABASE_URL,
      ACCESS_TOKEN,
      "avatars",
      "user-123/avatar.png",
      file,
      () => {},
    );

    await vi.waitFor(() => {
      if (!MockXHR.lastInstance) throw new Error("XHR not created");
    });
    MockXHR.lastInstance!.emitSuccess();

    await expect(result).rejects.toThrow("Failed to finalize upload");
  });

  it("rejects paths without a top-level folder", async () => {
    const file = makePngFile();
    await expect(
      uploadFileWithProgress(SUPABASE_URL, ACCESS_TOKEN, "avatars", "avatar.png", file, () => {}),
    ).rejects.toThrow("Invalid upload path: avatar.png");
  });

  it("rejects paths that end with a trailing slash", async () => {
    const file = makePngFile();
    await expect(
      uploadFileWithProgress(SUPABASE_URL, ACCESS_TOKEN, "avatars", "user-123/", file, () => {}),
    ).rejects.toThrow("Invalid upload path: user-123/");
  });
});
