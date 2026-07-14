type RequestBodyKind = "json" | "multipart" | "none";

function loopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function configuredPublicOrigin(): string | undefined {
  const value = process.env.NOVA_PUBLIC_ORIGIN?.trim();
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function forbidden(message: string, status = 403): Response {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Protect the local companion API from DNS rebinding, cross-site browser
 * requests, and form-based CSRF. Requests made by local command-line clients
 * remain supported because they normally omit browser fetch metadata.
 */
export function rejectUntrustedLocalRequest(
  request: Request,
  bodyKind: RequestBodyKind = "none",
): Response | undefined {
  const requestUrl = new URL(request.url);
  const publicOrigin = configuredPublicOrigin();
  if (!loopbackHostname(requestUrl.hostname) && requestUrl.origin !== publicOrigin) {
    return forbidden("This API is available only from the local Gondola interface.");
  }

  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite === "cross-site") {
    return forbidden("Cross-site requests are not allowed.");
  }

  const origin = request.headers.get("origin");
  if (origin) {
    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      return forbidden("The request origin is invalid.");
    }
    // localhost, 127.0.0.1, and ::1 all address the same local interface. Next's
    // dev server can report the request URL under a different loopback alias than
    // the one the browser is using (e.g. serving 127.0.0.1 while the page is on
    // localhost), which would otherwise 403 every call. So trust any loopback
    // origin; non-loopback origins must still match the interface or public one.
    const originTrusted = loopbackHostname(originUrl.hostname)
      || originUrl.origin === requestUrl.origin
      || originUrl.origin === publicOrigin;
    if (!originTrusted) {
      return forbidden("The request origin does not match the local interface.");
    }
  }

  if (bodyKind === "none") return undefined;
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  const validContentType = bodyKind === "json"
    ? contentType.startsWith("application/json")
    : contentType.startsWith("multipart/form-data");
  if (!validContentType) {
    return forbidden(
      bodyKind === "json"
        ? "The request must use application/json."
        : "The request must use multipart/form-data.",
      415,
    );
  }
  return undefined;
}
