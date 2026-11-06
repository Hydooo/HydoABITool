import { mirrorResponse, redisStore } from "../../lib/mirror.mjs";

function handle(request) {
  const id = new URL(request.url).pathname.split("/").at(-1);
  return mirrorResponse(request, redisStore(), id);
}

export { handle as GET, handle as PUT };
