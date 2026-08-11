/**
 * Fetch wrapper. `credentials: "same-origin"` on everything — the session cookie
 * is the only credential this client has.
 */
async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    // The server's error code travels on the thrown object so callers can
    // branch on `taken` vs `reserved` vs `cooldown` without parsing prose.
    const err = new Error(data.error ?? `http_${res.status}`);
    err.status = res.status;
    err.code = data.error;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  me: () => request("GET", "/api/me"),
  claimUsername: (username) => request("POST", "/api/me/username", { username }),
  checkUsername: (u) => request("GET", `/api/me/username/available?u=${encodeURIComponent(u)}`),
  updateProfile: (patch) => request("PATCH", "/api/me", patch),
  storage: () => request("GET", "/api/me/storage"),

  searchUsers: (q) => request("GET", `/api/users/search?q=${encodeURIComponent(q)}`),
  searchMessages: (q, { conversationId, before, limit } = {}) => {
    const qs = new URLSearchParams({ q });
    if (conversationId) qs.set("conversationId", conversationId);
    if (before) qs.set("before", before);
    if (limit) qs.set("limit", String(limit));
    return request("GET", `/api/search?${qs}`);
  },
  conversations: () => request("GET", "/api/conversations"),
  openConversation: (username) => request("POST", "/api/conversations", { username }),
  messages: (id, { before, at, limit } = {}) => {
    const qs = new URLSearchParams();
    if (before) qs.set("before", before);
    if (at) qs.set("at", at);
    if (limit) qs.set("limit", String(limit));
    const suffix = qs.toString() ? `?${qs}` : "";
    return request("GET", `/api/conversations/${id}/messages${suffix}`);
  },

  logout: () => request("POST", "/auth/logout"),

  deleteMessage: (conversationId, messageId) =>
    request("DELETE", `/api/conversations/${conversationId}/messages/${messageId}`),
  /** scope: "me" clears your copy silently; "everyone" destroys both and tells them. */
  deleteConversation: (id, scope = "me") =>
    request("DELETE", `/api/conversations/${id}?scope=${scope}`),
  dismissConversation: (id) => request("POST", `/api/conversations/${id}/dismiss`),
  /** mode: "anonymize" (default) or "purge". The handle is the confirmation. */
  deleteAccount: (confirmUsername, mode = "anonymize") =>
    request("DELETE", "/api/me", { confirmUsername, mode }),

  /**
   * Uploads bytes and returns { fileId, name, mime, size, kind }.
   *
   * Not through request(): a FormData body must not get a content-type header,
   * because the browser has to add its own multipart boundary. XHR rather than
   * fetch, because fetch still cannot report upload progress and a 25 MB video
   * with no progress bar looks broken.
   */
  upload(file, { onProgress, signal } = {}) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append("file", file);

      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/uploads");
      xhr.withCredentials = true;

      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) onProgress?.(e.loaded / e.total);
      });

      xhr.addEventListener("load", () => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText || "{}");
        } catch {
          /* a non-JSON body is a server fault; the status below still explains it */
        }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data.file);
        const err = new Error(data.error ?? `http_${xhr.status}`);
        err.status = xhr.status;
        err.code = data.error;
        err.data = data;
        reject(err);
      });

      xhr.addEventListener("error", () => reject(new Error("network")));
      xhr.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { code: "aborted" })));
      signal?.addEventListener("abort", () => xhr.abort());

      xhr.send(form);
    });
  },
};

/** The URL for an attachment. Authorized per request — never a public path. */
export const fileUrl = (fileId) => `/api/files/${fileId}`;
