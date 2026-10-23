import { constantTimeEqual, jsonError } from "./core";

export function requireApiToken(
  request: Request,
  environment: Record<string, string | undefined>,
  realm = "xiangying-api",
) {
  const expectedToken = environment.XIANGYING_API_TOKEN?.trim();
  if (!expectedToken)
    return jsonError(503, "API_AUTH_NOT_CONFIGURED", "请先配置 XIANGYING_API_TOKEN");

  const header = request.headers.get("Authorization")?.trim();
  const match = header ? /^Bearer\s+(\S+)$/iu.exec(header) : null;
  const suppliedToken = match?.[1];
  if (!suppliedToken || !constantTimeEqual(suppliedToken, expectedToken)) {
    return jsonError(401, "INVALID_API_TOKEN", "API Token 无效或缺失", {
      "WWW-Authenticate": `Bearer realm="${realm}"`,
    });
  }
  return null;
}
