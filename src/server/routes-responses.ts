/**
 * Responses-format route handler: POST /v1/responses.
 */
import { handleResponses, type ResponsesHandlerOptions } from "../proxy/responses-handler.js";
import { rejectUnsupportedResponsesRequest } from "../translator/protocol-fields.js";

/** Handle POST /v1/responses — translate Responses API to the GLM Chat Completions upstream. */
export async function handleResponsesRoute(
  req: Request,
  opts: ResponsesHandlerOptions,
): Promise<Response> {
  // 协议准入闸门：与 OpenAI 路由同一个判定表模块，只是 400 的形状
  // 换成 Responses 版 `{error:{code,message,param}}`。放在翻译之前 ——
  // `responsesToChatCompletions` 只搬它认识的字段，其余字段走到那里就是静默丢弃。
  const rejection = await rejectUnsupportedResponsesRequest(req);
  if (rejection) return rejection;
  return handleResponses(req, opts);
}
