import { errorResponse, readJsonObject } from "./http";
import { numberFromUnknown } from "./money";

export type OpenAiImageRequest = {
  model: string;
  input: Record<string, unknown>;
};

export async function readOpenAiImageRequest(
  request: Request,
  endpoint: string,
): Promise<OpenAiImageRequest | Response> {
  const contentType = request.headers.get("content-type") || "";
  let body: Record<string, unknown>;

  if (contentType.includes("multipart/form-data")) {
    body = await readImageMultipartRequest(request);
  } else if (contentType.includes("application/json")) {
    body = await readJsonObject(request);
  } else {
    return errorResponse(
      415,
      "unsupported_content_type",
      "Image requests must use JSON or multipart form data.",
    );
  }

  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (!prompt) {
    return errorResponse(400, "missing_prompt", "Image prompt is required.");
  }

  const n = numberFromUnknown(body.n) ?? 1;
  if (n !== 1) {
    return errorResponse(
      400,
      "unsupported_image_count",
      "Cloudflare AI image requests currently support n=1.",
    );
  }

  const requestedModel =
    typeof body.model === "string" && body.model
      ? body.model
      : endpoint === "images/edits"
        ? "gpt-image-2"
        : "gpt-image-2";
  const model = requestedModel.includes("/")
    ? requestedModel
    : `openai/${requestedModel}`;
  const input: Record<string, unknown> = { prompt };

  for (const field of ["quality", "size", "style", "background", "output_format"]) {
    const value = body[field];
    if (typeof value === "string" && value) input[field] = value;
  }

  const images = normalizeImageInputs(body);
  if (images.length > 0) {
    input.images = images;
  }

  return { model, input };
}

export function extractCloudflareAiImage(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const root = response as Record<string, unknown>;
  const result =
    root.result && typeof root.result === "object"
      ? (root.result as Record<string, unknown>)
      : root;
  const image = result.image;
  if (typeof image === "string" && image) return image;
  const images = result.images;
  if (Array.isArray(images) && typeof images[0] === "string") {
    return images[0];
  }
  return null;
}

export async function openAiImageDataItem(
  image: string,
): Promise<{ b64_json: string } | null> {
  const base64 = base64FromImageUri(image);
  if (base64) {
    return { b64_json: base64 };
  }
  if (looksLikeHttpUrl(image)) {
    const fetchedBase64 = await fetchImageAsBase64(image);
    return fetchedBase64 ? { b64_json: fetchedBase64 } : null;
  }
  return null;
}

async function readImageMultipartRequest(
  request: Request,
): Promise<Record<string, unknown>> {
  const formData = await request.formData();
  const body: Record<string, unknown> = {};
  const images: string[] = [];
  const fileReads: Array<Promise<void>> = [];
  formData.forEach((value, key) => {
    if (value instanceof File) {
      if (isImageFieldName(key)) {
        fileReads.push(
          fileToDataUrl(value).then((image) => {
            images.push(image);
          }),
        );
      }
      return;
    }
    if (isImageFieldName(key)) {
      images.push(String(value));
      return;
    }
    body[key] = String(value);
  });
  await Promise.all(fileReads);
  if (images.length > 0) body.images = images;
  return body;
}

function isImageFieldName(key: string): boolean {
  return key === "image" || key === "images" || key === "image[]" || key === "images[]";
}

function normalizeImageInputs(body: Record<string, unknown>): string[] {
  const images: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value) images.push(value);
  };
  add(body.image);
  const imageList = body.images;
  if (Array.isArray(imageList)) {
    for (const image of imageList) add(image);
  }
  return images;
}

async function fileToDataUrl(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(offset, offset + chunkSize));
  }
  const type = file.type || "application/octet-stream";
  return `data:${type};base64,${btoa(binary)}`;
}

function base64FromImageUri(image: string): string | null {
  const value = image.trim();
  const dataUrl = /^data:[^,]*;base64,(.*)$/i.exec(value);
  const candidate = dataUrl ? dataUrl[1] : value;
  const normalized = candidate.replace(/\s/g, "");
  if (!normalized || normalized.length % 4 === 1) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null;
  return normalized;
}

function looksLikeHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

async function fetchImageAsBase64(url: string): Promise<string | null> {
  const response = await fetch(url);
  if (!response.ok) return null;
  return base64FromBytes(new Uint8Array(await response.arrayBuffer()));
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(offset, offset + chunkSize));
  }
  return btoa(binary);
}
