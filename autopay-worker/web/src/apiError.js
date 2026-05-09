export function normalizeApiError(json, status) {
  if (json?.error && typeof json.error === "object") {
    return {
      code: typeof json.error.code === "string" ? json.error.code : "request_failed",
      message: typeof json.error.message === "string" ? json.error.message : `Request failed with HTTP ${status}`,
      details: json.error.details && typeof json.error.details === "object" ? json.error.details : {},
      status,
    };
  }
  if (json && typeof json === "object") {
    return {
      code: typeof json.code === "string" ? json.code : "request_failed",
      message: typeof json.message === "string" ? json.message : `Request failed with HTTP ${status}`,
      details: json.details && typeof json.details === "object" ? json.details : {},
      status: typeof json.status === "number" ? json.status : status,
    };
  }
  return {
    code: "request_failed",
    message: `Request failed with HTTP ${status}`,
    details: {},
    status,
  };
}
