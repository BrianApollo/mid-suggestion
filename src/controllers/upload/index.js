import { jsonResponse } from "../../lib/http.js";
import { resolveCompanyId } from "../../lib/company-data.js";

// R2 multipart upload — lets the browser push a file of ANY size into the CSV_BUCKET past the
// Worker's ~100MB request-body cap. The client slices the File into fixed-size parts and drives:
//   POST /api/upload/create?key=<key>                    → { uploadId }
//   PUT  /api/upload/part?key=&uploadId=&partNumber=N     (part bytes as the body) → { partNumber, etag }
//   POST /api/upload/complete?key=&uploadId=  body {parts:[{partNumber,etag}]}     → { ok, key, size }
// No R2 S3 credentials are stored anywhere — the multipart handle lives in R2, referenced by
// (key, uploadId). All three require a valid Bearer token (same auth as every tenant route).
// Parts do NOT need newline alignment; the processing step (sync-driver alarmR2) re-aligns on rows.

function guard(env, cid) {
  if (cid == null) return jsonResponse({ error: "not authenticated" }, { status: 401 });
  if (!env.CSV_BUCKET) return jsonResponse({ error: "R2 bucket not configured" }, { status: 500 });
  return null;
}

export async function handleUploadCreate(request, env, url) {
  const cid = await resolveCompanyId(env, request, url);
  const bad = guard(env, cid); if (bad) return bad;
  const key = url.searchParams.get("key");
  if (!key) return jsonResponse({ error: "key is required (?key=<object>)" }, { status: 400 });
  const mpu = await env.CSV_BUCKET.createMultipartUpload(key);
  return jsonResponse({ uploadId: mpu.uploadId, key: mpu.key });
}

export async function handleUploadPart(request, env, url) {
  const cid = await resolveCompanyId(env, request, url);
  const bad = guard(env, cid); if (bad) return bad;
  const key = url.searchParams.get("key");
  const uploadId = url.searchParams.get("uploadId");
  const partNumber = parseInt(url.searchParams.get("partNumber"), 10);
  if (!key || !uploadId || !Number.isInteger(partNumber) || partNumber < 1) {
    return jsonResponse({ error: "key, uploadId, and a partNumber>=1 are required" }, { status: 400 });
  }
  if (!request.body) return jsonResponse({ error: "empty part body" }, { status: 400 });
  const mpu = env.CSV_BUCKET.resumeMultipartUpload(key, uploadId);
  const uploaded = await mpu.uploadPart(partNumber, request.body);
  return jsonResponse({ partNumber, etag: uploaded.etag });
}

export async function handleUploadComplete(request, env, url) {
  const cid = await resolveCompanyId(env, request, url);
  const bad = guard(env, cid); if (bad) return bad;
  const key = url.searchParams.get("key");
  const uploadId = url.searchParams.get("uploadId");
  if (!key || !uploadId) return jsonResponse({ error: "key and uploadId are required" }, { status: 400 });
  let body;
  try { body = await request.json(); } catch (_) { return jsonResponse({ error: "body must be JSON { parts:[...] }" }, { status: 400 }); }
  const parts = (body?.parts || [])
    .map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag) }))
    .sort((a, b) => a.partNumber - b.partNumber);
  if (!parts.length) return jsonResponse({ error: "parts[] is required" }, { status: 400 });
  const mpu = env.CSV_BUCKET.resumeMultipartUpload(key, uploadId);
  const obj = await mpu.complete(parts);
  return jsonResponse({ ok: true, key, size: obj.size });
}
