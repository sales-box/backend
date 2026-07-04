/**
 * Builds a safe, log-friendly description of a Google API error. Reads only
 * the standard error code/status fields, never the token or request body.
 */
export function describeOAuthError(error: unknown): string {
  const e = error as {
    name?: string;
    response?: { status?: number; data?: unknown };
  };
  const status = e?.response?.status;
  const data = e?.response?.data;

  let detail = '';
  if (typeof data === 'string') {
    detail = data;
  } else if (data && typeof data === 'object') {
    const d = data as { error?: unknown; error_description?: string };
    if (typeof d.error === 'string') {
      detail = d.error_description
        ? `${d.error} — ${d.error_description}`
        : d.error;
    } else if (d.error && typeof d.error === 'object') {
      const g = d.error as { code?: number; message?: string; status?: string };
      detail = `${g.status ?? g.code ?? ''} ${g.message ?? ''}`.trim();
    }
  }

  return (
    [e?.name, status ? `HTTP ${status}` : '', detail]
      .filter(Boolean)
      .join(' | ') || 'unknown'
  );
}
