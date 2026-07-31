/**
 * Upload a file to Supabase Storage via a signed S3 (multipart-style) PUT URL
 * with XHR progress tracking.
 *
 * Previously this posted the file bytes straight to
 * `/storage/v1/object/<bucket>/<path>` with the user's JWT. That required RLS
 * INSERT policies on every bucket and left file sizes / types / folder
 * ownership enforced by SQL. The signed flow instead:
 *
 *   1. `POST /functions/v1/generate-upload-url` (edge function) returns a
 *      signed, expiring PUT URL for the object. The edge function validates
 *      the bucket, folder ownership, file type and size server-side.
 *   2. The file bytes are PUT directly to the signed URL via XHR so upload
 *      progress can still be reported (and aborted).
 *   3. The edge function "finalizes" the object by claiming its owner, so
 *      existing `auth.uid() = owner` DELETE policies keep working.
 *
 * The final object path is returned (the edge function sanitizes the file
 * name, so it can differ from the requested path).
 */
export interface SignedUploadParams {
  bucket: string;
  folder: string;
  fileName: string;
  contentType: string;
  fileSize: number;
}

export interface SignedUpload {
  url: string;
  path: string;
  token: string | null;
  expiresIn: number;
}

const GENERATE_UPLOAD_URL_PATH = "/functions/v1/generate-upload-url";

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: string }).name === "AbortError"
  );
}

async function postGenerateUploadUrl<T>(
  supabaseUrl: string,
  accessToken: string,
  body: Record<string, unknown>,
  abortSignal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${supabaseUrl}${GENERATE_UPLOAD_URL_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: abortSignal,
    });
  } catch (error) {
    if (isAbortError(error)) throw new Error("Upload cancelled");
    throw error;
  }

  if (!response.ok) {
    let message = `Upload server error (HTTP ${response.status})`;
    try {
      const payload = await response.json();
      if (payload?.error) message = payload.error;
    } catch {
      // Fall back to the status-based message.
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

export async function requestSignedUploadUrl(
  supabaseUrl: string,
  accessToken: string,
  params: SignedUploadParams,
  abortSignal?: AbortSignal,
): Promise<SignedUpload> {
  const data = await postGenerateUploadUrl<Partial<SignedUpload>>(
    supabaseUrl,
    accessToken,
    {
      bucket: params.bucket,
      folder: params.folder,
      fileName: params.fileName,
      contentType: params.contentType,
      fileSize: params.fileSize,
    },
    abortSignal,
  );

  if (!data.url || !data.path) {
    throw new Error("Invalid response from upload URL generator");
  }

  return {
    url: data.url,
    path: data.path,
    token: data.token ?? null,
    expiresIn: data.expiresIn ?? 900,
  };
}

export async function finalizeSignedUpload(
  supabaseUrl: string,
  accessToken: string,
  bucket: string,
  path: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  await postGenerateUploadUrl<{ ok?: boolean }>(
    supabaseUrl,
    accessToken,
    { action: "finalize", bucket, path },
    abortSignal,
  );
}

function putFileWithProgress(
  url: string,
  file: File,
  onProgress: (percent: number) => void,
  abortSignal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");

    if (abortSignal) {
      abortSignal.addEventListener("abort", () => {
        xhr.abort();
        reject(new Error("Upload cancelled"));
      });
    }

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload failed with status ${xhr.status}`));
      }
    };

    xhr.onerror = () => {
      reject(new Error("Upload failed due to a network error"));
    };

    xhr.send(file);
  });
}

export function uploadFileWithProgress(
  supabaseUrl: string,
  accessToken: string,
  bucket: string,
  path: string,
  file: File,
  onProgress: (percent: number) => void,
  abortSignal?: AbortSignal,
): Promise<string> {
  return (async () => {
    const slashIndex = path.lastIndexOf("/");
    if (slashIndex <= 0 || slashIndex === path.length - 1) {
      throw new Error(`Invalid upload path: ${path}`);
    }
    const folder = path.slice(0, slashIndex);
    const fileName = path.slice(slashIndex + 1);

    const signed = await requestSignedUploadUrl(
      supabaseUrl,
      accessToken,
      {
        bucket,
        folder,
        fileName,
        contentType: file.type || "application/octet-stream",
        fileSize: file.size,
      },
      abortSignal,
    );

    await putFileWithProgress(signed.url, file, onProgress, abortSignal);

    await finalizeSignedUpload(supabaseUrl, accessToken, bucket, signed.path, abortSignal);

    return signed.path;
  })();
}
