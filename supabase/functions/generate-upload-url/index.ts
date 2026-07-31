// Edge function that issues signed S3 (multipart-style) upload URLs for
// Supabase Storage. It replaces browser -> Storage JWT uploads with a
// two-step flow:
//
//   1. `POST generate-upload-url`  ->  { url, path, token, expiresIn }
//   2. `PUT <url>` with the file bytes (handled client-side via XHR)
//   3. `POST generate-upload-url { action: "finalize" }` -> claims ownership
//
// Because the signed PUT is performed with a service-role generated URL it
// bypasses `storage.objects` RLS, so this function re-applies the same
// per-bucket constraints the RLS INSERT policies enforce for JWT uploads
// (file type, size, folder ownership) and, for club-gated buckets such as
// `event-gallery`, re-checks that the caller is allowed to upload.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.110.0";
import { verifyAuth } from "../shared/auth-middleware.ts";
import { corsHeaders } from "../shared/headers.ts";

const MB = 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 900; // 15 minutes

export interface BucketConfig {
  /** Maximum allowed file size in bytes. */
  maxBytes: number;
  /** Allowed MIME types (client must PUT with one of these). */
  contentTypes: string[];
  /** Allowed file extensions (derived from the requested file name). */
  extensions: string[];
  /**
   * "user" => the top-level folder must equal the authenticated user's id.
   * "event" => the top-level folder is an event id (any authenticated user).
   */
  folder: "user" | "event";
  /**
   * For club-gated buckets: when the folder is a UUID, the caller must be a
   * club admin of the event's club or the event creator (mirrors the RLS
   * policy in `20260726115200_event_gallery_bucket.sql`).
   */
  adminCheck?: boolean;
}

const IMAGE_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif"];
const IMAGE_2MB: Omit<BucketConfig, "folder"> = {
  maxBytes: 2 * MB,
  contentTypes: IMAGE_CONTENT_TYPES,
  extensions: IMAGE_EXTENSIONS,
};
const IMAGE_5MB: Omit<BucketConfig, "folder"> = {
  maxBytes: 5 * MB,
  contentTypes: ["image/jpeg", "image/png", "image/webp"],
  extensions: ["jpg", "jpeg", "png", "webp"],
};
const IMAGE_10MB: Omit<BucketConfig, "folder"> = {
  maxBytes: 10 * MB,
  contentTypes: IMAGE_CONTENT_TYPES,
  extensions: IMAGE_EXTENSIONS,
};
const IMAGE_20MB: Omit<BucketConfig, "folder"> = {
  maxBytes: 20 * MB,
  contentTypes: IMAGE_CONTENT_TYPES,
  extensions: IMAGE_EXTENSIONS,
};

export const BUCKET_CONFIG: Record<string, BucketConfig> = {
  avatars: { ...IMAGE_2MB, folder: "user" },
  "club-banners": { ...IMAGE_2MB, folder: "user" },
  "event-banners": { ...IMAGE_2MB, folder: "user" },
  "bug-screenshots": { ...IMAGE_5MB, folder: "user" },
  "post-attachments": { ...IMAGE_10MB, folder: "user" },
  "event-gallery": { ...IMAGE_20MB, folder: "event", adminCheck: true },
  "event-galleries": { ...IMAGE_20MB, folder: "event" },
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_FOLDER_PATTERN = /^[a-zA-Z0-9_-]+$/;
const SAFE_FILE_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Derives the file extension (lower-cased, no dot) from a file name. */
export function fileExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) return "";
  return fileName.slice(dotIndex + 1).toLowerCase();
}

/** Normalizes a requested file name into a safe Storage object name. */
export function sanitizeFileName(fileName: string): string {
  return fileName
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[._-]+/, "")
    .toLowerCase();
}

/**
 * Replicates the `event-gallery` RLS INSERT/UPDATE/DELETE policy: for a UUID
 * top-level folder the caller must be a club admin of the event's club or the
 * event's creator. Non-UUID folders (e.g. mock events) remain open to any
 * authenticated user, matching the `ELSE true` branch of the policy.
 */
async function assertEventGalleryAccess(
  supabase: any,
  userId: string,
  folder: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!UUID_PATTERN.test(folder)) return { ok: true };

  const { data: event, error } = await supabase
    .from("events")
    .select("club_id, created_by")
    .eq("id", folder)
    .maybeSingle();

  if (error) {
    console.error("generate-upload-url: failed to look up event:", error);
    return { ok: false, status: 500, error: "Failed to verify event access" };
  }
  if (!event) {
    return { ok: false, status: 403, error: "Event not found" };
  }
  if (event.created_by === userId) return { ok: true };

  const { data: isAdmin, error: adminError } = await supabase.rpc("is_club_admin", {
    club_id: event.club_id,
    user_id: userId,
  });
  if (adminError) {
    console.error("generate-upload-url: is_club_admin failed:", adminError);
    return { ok: false, status: 500, error: "Failed to verify event access" };
  }
  if (!isAdmin) {
    return {
      ok: false,
      status: 403,
      error: "You must be a club admin or the event creator to upload",
    };
  }
  return { ok: true };
}

async function signUpload(
  supabase: any,
  userId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const bucket = typeof body.bucket === "string" ? body.bucket : "";
  const config = BUCKET_CONFIG[bucket];
  if (!config) return json({ error: `Unsupported bucket: ${bucket}` }, 400);

  const folder = typeof body.folder === "string" ? body.folder.trim() : "";
  if (!folder || folder.length > 128 || !SAFE_FOLDER_PATTERN.test(folder)) {
    return json({ error: "Invalid folder" }, 400);
  }

  if (config.folder === "user") {
    if (folder !== userId) {
      return json({ error: "Folder must be your user id" }, 403);
    }
  } else if (config.adminCheck) {
    const access = await assertEventGalleryAccess(supabase, userId, folder);
    if (!access.ok) return json({ error: access.error }, access.status);
  }

  const rawFileName = typeof body.fileName === "string" ? body.fileName : "";
  const fileName = sanitizeFileName(rawFileName);
  if (!SAFE_FILE_NAME_PATTERN.test(fileName) || fileName.length > 128) {
    return json({ error: "Invalid file name" }, 400);
  }

  const extension = fileExtension(fileName);
  if (!extension || !config.extensions.includes(extension)) {
    return json(
      {
        error: `File extension not allowed in ${bucket}: .${extension || "none"}`,
      },
      415,
    );
  }

  const contentType = typeof body.contentType === "string" ? body.contentType : "";
  if (!config.contentTypes.includes(contentType)) {
    return json({ error: `Content type not allowed in ${bucket}: ${contentType}` }, 415);
  }

  const fileSize = typeof body.fileSize === "number" ? body.fileSize : NaN;
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    return json({ error: "Invalid file size" }, 400);
  }
  if (fileSize > config.maxBytes) {
    return json(
      {
        error: `File too large: ${bucket} allows a maximum of ${config.maxBytes / MB} MB`,
      },
      413,
    );
  }

  const path = `${folder}/${fileName}`;
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUploadUrl(path, { upsert: false });

  if (error || !data?.signedUrl || !data?.path) {
    console.error("generate-upload-url: createSignedUploadUrl failed:", error?.message ?? error);
    return json({ error: "Failed to generate signed upload URL" }, 500);
  }

  return json(
    {
      url: data.signedUrl,
      path: data.path,
      token: data.token ?? null,
      expiresIn: SIGNED_URL_TTL_SECONDS,
    },
    200,
  );
}

async function finalizeUpload(
  supabase: any,
  userId: string,
  bucket: string,
  path: string,
): Promise<Response> {
  const config = BUCKET_CONFIG[bucket];
  if (!config) return json({ error: `Unsupported bucket: ${bucket}` }, 400);

  const slashIndex = path.lastIndexOf("/");
  const folder = slashIndex > 0 ? path.slice(0, slashIndex) : "";
  const fileName = slashIndex > 0 ? path.slice(slashIndex + 1) : "";
  if (!folder || !SAFE_FOLDER_PATTERN.test(folder) || !SAFE_FILE_NAME_PATTERN.test(fileName)) {
    return json({ error: "Invalid path" }, 400);
  }

  if (config.folder === "user" && folder !== userId) {
    return json({ error: "Folder must be your user id" }, 403);
  }

  const { data: existing, error: selectError } = await supabase
    .from("storage.objects")
    .select("id")
    .eq("bucket_id", bucket)
    .eq("name", path)
    .maybeSingle();

  if (selectError) {
    console.error("generate-upload-url: finalize select failed:", selectError);
    return json({ error: "Failed to finalize upload" }, 500);
  }
  if (!existing) {
    return json({ error: "Uploaded object not found" }, 404);
  }

  const { error: updateError } = await supabase
    .from("storage.objects")
    .update({ owner: userId })
    .eq("bucket_id", bucket)
    .eq("name", path);

  if (updateError) {
    console.error("generate-upload-url: finalize update failed:", updateError);
    return json({ error: "Failed to finalize upload" }, 500);
  }

  return json({ ok: true, path }, 200);
}

async function handleRequest(req: Request, supabase: any): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let user;
  try {
    user = await verifyAuth(req, supabase);
  } catch {
    return json({ error: "Unauthorized" }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (body.action === "finalize") {
    const bucket = typeof body.bucket === "string" ? body.bucket : "";
    const path = typeof body.path === "string" ? body.path : "";
    return await finalizeUpload(supabase, user.id, bucket, path);
  }

  return await signUpload(supabase, user.id, body);
}

/**
 * Creates the function handler bound to a specific Supabase client. Exported
 * so unit tests can inject a fake client; `handler` wires up the real one.
 */
export function createHandler(supabase: any): (req: Request) => Promise<Response> {
  return (req: Request) => handleRequest(req, supabase);
}

export async function handler(req: Request): Promise<Response> {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.");
    }
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    return await handleRequest(req, supabase);
  } catch (error: unknown) {
    console.error("generate-upload-url error:", error);
    const message = error instanceof Error ? error.message : "An unexpected error occurred.";
    return json({ error: message }, 500);
  }
}

if (import.meta.main) {
  serve(handler);
}
