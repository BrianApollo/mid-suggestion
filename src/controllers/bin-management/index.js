import { jsonResponse } from "../../lib/http.js";

export async function handleBinManagement(request, env, url) {
  console.log("[bin-management] endpoint hit");
  return jsonResponse({});
}
