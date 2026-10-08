const REASONS: Record<string, string> = {
  ENOTFOUND: '域名解析失败', EAI_AGAIN: '域名解析暂时失败',
  ECONNREFUSED: '连接被拒绝', ECONNRESET: '连接被重置',
  ETIMEDOUT: '连接超时', UND_ERR_CONNECT_TIMEOUT: '连接超时',
  UND_ERR_SOCKET: '连接被对端关闭',
  CERT_HAS_EXPIRED: 'HTTPS 证书已过期',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'HTTPS 证书验证失败',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'HTTPS 证书不受信任',
}

/** Explain transport errors without exposing request URLs, headers or credentials. */
export function networkErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback
  if (error.message !== 'fetch failed') return error.message
  let current: unknown = error.cause
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const item = current as { code?: unknown; cause?: unknown; errors?: unknown[] }
    if (typeof item.code === 'string' && REASONS[item.code]) {
      return `书源${REASONS[item.code]}（${item.code}）。请检查网络或代理，或更换书源。`
    }
    current = item.cause ?? item.errors?.[0]
  }
  return '书源网络请求失败，请检查网络或代理，或更换书源。'
}
