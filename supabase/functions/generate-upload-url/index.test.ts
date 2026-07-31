// @ts-nocheck
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { createHandler, BUCKET_CONFIG } from "./index.ts";

const USER_ID = "user-123";

function makeRequest(body, { auth = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth) headers.Authorization = "Bearer test-token";
  return new Request("http://localhost:8000/generate-upload-url", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function makeSupabase(options = {}) {
  const { event = null, isAdmin = false, signError = null, missingObject = false } = options;

  const calls = {
    sign: [],
    selects: [],
    updates: [],
    eventLookups: [],
    adminChecks: [],
  };

  function query(table, columns, eqs = []) {
    const q = {
      maybeSingle: async () => {
        calls.selects.push({ table, columns, eqs });
        if (table === "events") {
          calls.eventLookups.push({ columns, eqs });
          return { data: event, error: null };
        }
        return { data: missingObject ? null : { id: "object-1" }, error: null };
      },
    };
    q.eq = (col, value) => query(table, columns, [...eqs, [col, value]]);
    return q;
  }

  const supabase = {
    auth: {
      getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }),
    },
    storage: {
      from: (bucket) => ({
        createSignedUploadUrl: async (path, options_) => {
          calls.sign.push({ bucket, path, options: options_ });
          if (signError) return { data: null, error: { message: signError } };
          return {
            data: {
              signedUrl: `https://project.supabase.co/storage/v1/object/upload/sign/${bucket}/${path}?token=abc123`,
              path,
              token: "abc123",
            },
            error: null,
          };
        },
      }),
    },
    rpc: async (fn, args) => {
      calls.adminChecks.push({ fn, args });
      return { data: isAdmin, error: null };
    },
    from: (table) => ({
      select: (columns) => query(table, columns),
      update: (values) => {
        const upd2 = {
          eq: (col2, value2) => {
            const done = () => {
              calls.updates.push({
                table,
                values,
                filters: [col2, value2],
              });
              return Promise.resolve({ error: null });
            };
            return done();
          },
        };
        const upd1 = { eq: () => upd2 };
        return upd1;
      },
    }),
  };

  return { supabase, calls };
}

function validAvatarBody(overrides = {}) {
  return {
    bucket: "avatars",
    folder: USER_ID,
    fileName: "profile-pic.png",
    contentType: "image/png",
    fileSize: 1024 * 1024,
    ...overrides,
  };
}

function validEventGalleryBody(overrides = {}) {
  return {
    bucket: "event-gallery",
    folder: "11111111-1111-4111-8111-111111111111",
    fileName: "photo.jpg",
    contentType: "image/jpeg",
    fileSize: 1024,
    ...overrides,
  };
}

Deno.test("generate-upload-url - OPTIONS returns CORS headers", async () => {
  const { supabase } = makeSupabase();
  const handler = createHandler(supabase);
  const response = await handler(
    new Request("http://localhost:8000/generate-upload-url", { method: "OPTIONS" }),
  );
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(
    response.headers.get("Access-Control-Allow-Headers"),
    "authorization, x-client-info, apikey, content-type",
  );
});

Deno.test("generate-upload-url - non-POST method returns 405", async () => {
  const { supabase } = makeSupabase();
  const handler = createHandler(supabase);
  const response = await handler(
    new Request("http://localhost:8000/generate-upload-url", { method: "GET" }),
  );
  assertEquals(response.status, 405);
});

Deno.test("generate-upload-url - missing auth returns 401", async () => {
  const { supabase } = makeSupabase();
  const handler = createHandler(supabase);
  const response = await handler(makeRequest(validAvatarBody(), { auth: false }));
  assertEquals(response.status, 401);
  const data = await response.json();
  assertEquals(data.error, "Unauthorized");
});

Deno.test("generate-upload-url - invalid JSON body returns 400", async () => {
  const { supabase } = makeSupabase();
  const handler = createHandler(supabase);
  const req = new Request("http://localhost:8000/generate-upload-url", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
    },
    body: "not-json",
  });
  const response = await handler(req);
  assertEquals(response.status, 400);
});

Deno.test("generate-upload-url - unknown bucket returns 400", async () => {
  const { supabase } = makeSupabase();
  const handler = createHandler(supabase);
  const response = await handler(makeRequest(validAvatarBody({ bucket: "not-a-bucket" })));
  assertEquals(response.status, 400);
  const data = await response.json();
  assertEquals(data.error, "Unsupported bucket: not-a-bucket");
});

Deno.test("generate-upload-url - user bucket rejects folder other than user id", async () => {
  const { supabase, calls } = makeSupabase();
  const handler = createHandler(supabase);
  const response = await handler(makeRequest(validAvatarBody({ folder: "someone-else" })));
  assertEquals(response.status, 403);
  assertEquals(calls.sign.length, 0);
});

Deno.test("generate-upload-url - invalid folder rejected", async () => {
  const { supabase, calls } = makeSupabase();
  const handler = createHandler(supabase);
  const response = await handler(makeRequest(validAvatarBody({ folder: "../escape" })));
  assertEquals(response.status, 400);
  assertEquals(calls.sign.length, 0);
});

Deno.test("generate-upload-url - disallowed extension returns 415", async () => {
  const { supabase, calls } = makeSupabase();
  const handler = createHandler(supabase);
  const response = await handler(makeRequest(validAvatarBody({ fileName: "malware.exe" })));
  assertEquals(response.status, 415);
  assertEquals(calls.sign.length, 0);
});

Deno.test("generate-upload-url - disallowed content type returns 415", async () => {
  const { supabase, calls } = makeSupabase();
  const handler = createHandler(supabase);
  const response = await handler(makeRequest(validAvatarBody({ contentType: "text/html" })));
  assertEquals(response.status, 415);
  assertEquals(calls.sign.length, 0);
});

Deno.test("generate-upload-url - oversized file returns 413", async () => {
  const { supabase, calls } = makeSupabase();
  const handler = createHandler(supabase);
  const maxBytes = BUCKET_CONFIG.avatars.maxBytes;
  const response = await handler(makeRequest(validAvatarBody({ fileSize: maxBytes + 1 })));
  assertEquals(response.status, 413);
  const data = await response.json();
  assertEquals(data.error.includes("File too large"), true);
  assertEquals(calls.sign.length, 0);
});

Deno.test("generate-upload-url - non-positive file size returns 400", async () => {
  const { supabase, calls } = makeSupabase();
  const handler = createHandler(supabase);
  const response = await handler(makeRequest(validAvatarBody({ fileSize: -1 })));
  assertEquals(response.status, 400);
  assertEquals(calls.sign.length, 0);
});

Deno.test("generate-upload-url - signs URL for valid avatar upload", async () => {
  const { supabase, calls } = makeSupabase();
  const handler = createHandler(supabase);
  const response = await handler(makeRequest(validAvatarBody()));
  assertEquals(response.status, 200);

  const data = await response.json();
  assertEquals(typeof data.url, "string");
  assertEquals(data.path, `${USER_ID}/profile-pic.png`);
  assertEquals(data.token, "abc123");
  assertEquals(data.expiresIn, 900);

  assertEquals(calls.sign.length, 1);
  assertEquals(calls.sign[0].bucket, "avatars");
  assertEquals(calls.sign[0].path, `${USER_ID}/profile-pic.png`);
  assertEquals(calls.sign[0].options, { upsert: false });
});

Deno.test("generate-upload-url - sanitizes unsafe file names", async () => {
  const { supabase, calls } = makeSupabase();
  const handler = createHandler(supabase);
  const response = await handler(
    makeRequest(validAvatarBody({ fileName: "My  Photo (final)!.png" })),
  );
  assertEquals(response.status, 200);
  assertEquals(calls.sign[0].path, `${USER_ID}/my-photo-final-.png`);
});

Deno.test("generate-upload-url - sign error surfaces as 500", async () => {
  const { supabase } = makeSupabase({ signError: "storage unavailable" });
  const handler = createHandler(supabase);
  const response = await handler(makeRequest(validAvatarBody()));
  assertEquals(response.status, 500);
});

Deno.test("generate-upload-url - event-gallery non-UUID folder allowed", async () => {
  const { supabase, calls } = makeSupabase({ event: null });
  const handler = createHandler(supabase);
  const response = await handler(makeRequest(validEventGalleryBody({ folder: "mock-123" })));
  assertEquals(response.status, 200);
  assertEquals(calls.eventLookups.length, 0);
  assertEquals(calls.adminChecks.length, 0);
});

Deno.test("generate-upload-url - event-gallery event creator allowed", async () => {
  const { supabase, calls } = makeSupabase({
    event: { club_id: "club-1", created_by: USER_ID },
  });
  const handler = createHandler(supabase);
  const response = await handler(makeRequest(validEventGalleryBody()));
  assertEquals(response.status, 200);
  assertEquals(calls.eventLookups.length, 1);
  assertEquals(calls.adminChecks.length, 0);
});

Deno.test("generate-upload-url - event-gallery club admin allowed", async () => {
  const { supabase, calls } = makeSupabase({
    event: { club_id: "club-1", created_by: "someone-else" },
    isAdmin: true,
  });
  const handler = createHandler(supabase);
  const response = await handler(makeRequest(validEventGalleryBody()));
  assertEquals(response.status, 200);
  assertEquals(calls.adminChecks.length, 1);
  assertEquals(calls.adminChecks[0].fn, "is_club_admin");
  assertEquals(calls.adminChecks[0].args, { club_id: "club-1", user_id: USER_ID });
});

Deno.test("generate-upload-url - event-gallery non-admin rejected", async () => {
  const { supabase, calls } = makeSupabase({
    event: { club_id: "club-1", created_by: "someone-else" },
    isAdmin: false,
  });
  const handler = createHandler(supabase);
  const response = await handler(makeRequest(validEventGalleryBody()));
  assertEquals(response.status, 403);
  assertEquals(calls.sign.length, 0);
});

Deno.test("generate-upload-url - event-gallery missing event rejected", async () => {
  const { supabase, calls } = makeSupabase({ event: null });
  const handler = createHandler(supabase);
  const response = await handler(makeRequest(validEventGalleryBody()));
  assertEquals(response.status, 403);
  assertEquals(calls.sign.length, 0);
});

Deno.test("generate-upload-url - finalize claims ownership", async () => {
  const { supabase, calls } = makeSupabase();
  const handler = createHandler(supabase);
  const response = await handler(
    makeRequest({
      action: "finalize",
      bucket: "post-attachments",
      path: `${USER_ID}/photo.jpg`,
    }),
  );
  assertEquals(response.status, 200);
  const data = await response.json();
  assertEquals(data.ok, true);
  assertEquals(calls.updates.length, 1);
  assertEquals(calls.updates[0].table, "storage.objects");
  assertEquals(calls.updates[0].values, { owner: USER_ID });
});

Deno.test("generate-upload-url - finalize rejects wrong folder", async () => {
  const { supabase, calls } = makeSupabase();
  const handler = createHandler(supabase);
  const response = await handler(
    makeRequest({
      action: "finalize",
      bucket: "post-attachments",
      path: "someone-else/photo.jpg",
    }),
  );
  assertEquals(response.status, 403);
  assertEquals(calls.updates.length, 0);
});

Deno.test("generate-upload-url - finalize unknown bucket rejected", async () => {
  const { supabase, calls } = makeSupabase();
  const handler = createHandler(supabase);
  const response = await handler(
    makeRequest({ action: "finalize", bucket: "nope", path: `${USER_ID}/a.jpg` }),
  );
  assertEquals(response.status, 400);
  assertEquals(calls.updates.length, 0);
});

Deno.test("generate-upload-url - finalize invalid path rejected", async () => {
  const { supabase, calls } = makeSupabase();
  const handler = createHandler(supabase);
  const response = await handler(
    makeRequest({ action: "finalize", bucket: "post-attachments", path: "no-folder.jpg" }),
  );
  assertEquals(response.status, 400);
  assertEquals(calls.updates.length, 0);
});

Deno.test("generate-upload-url - finalize missing object returns 404", async () => {
  const { supabase, calls } = makeSupabase({ missingObject: true });
  const handler = createHandler(supabase);
  const response = await handler(
    makeRequest({ action: "finalize", bucket: "post-attachments", path: `${USER_ID}/a.jpg` }),
  );
  assertEquals(response.status, 404);
  assertEquals(calls.updates.length, 0);
});
