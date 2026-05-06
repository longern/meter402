import { routeHandlers, scheduledReconcile } from "./app";
import {
  asHttpError,
  corsPreflightResponse,
  errorResponse,
} from "./http";
import { dispatchRoute } from "./routes";
import type { Env } from "./types";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    try {
      if (request.method === "OPTIONS") {
        return corsPreflightResponse(request);
      }
      return await dispatchRoute(request, env, ctx, routeHandlers);
    } catch (error) {
      const httpError = asHttpError(error);
      if (httpError) {
        if (httpError.status >= 500) {
          console.error("Request failed", {
            status: httpError.status,
            code: httpError.code,
            message: httpError.message,
            extra: httpError.extra,
          });
        }
        return errorResponse(
          httpError.status,
          httpError.code,
          httpError.message,
          httpError.extra,
        );
      }
      console.error("Unhandled request error", error);
      return errorResponse(
        500,
        "internal_error",
        "An internal error occurred.",
      );
    }
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    scheduledReconcile(env, ctx);
  },
};
