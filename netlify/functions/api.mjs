// Netlify Function: serves /api/* using Netlify Blobs for storage.
import { getStore } from "@netlify/blobs";
import { createApi } from "../lib/api-core.mjs";

function blobStore(name) {
  const store = getStore({ name, consistency: "strong" });
  return {
    get: (key) => store.get(key, { type: "json" }),
    set: (key, value) => store.setJSON(key, value),
    del: (key) => store.delete(key),
    keys: async () => (await store.list()).blobs.map((b) => b.key),
  };
}

export default async (req) => {
  const handle = createApi({ users: blobStore("users"), sessions: blobStore("sessions"), saves: blobStore("saves") });
  return handle(req);
};

export const config = { path: "/api/*" };
