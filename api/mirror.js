import { mirrorResponse, redisStore } from "../lib/mirror.mjs";

export function POST(request) {
  return mirrorResponse(request, redisStore());
}
