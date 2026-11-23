import { useState } from "react";
import { describeError, ownerCall } from "./api";
import { Notice } from "./ui";

interface GrantPreview {
  path: string;
  changed: boolean;
  foreign: boolean;
  diff?: string;
  fingerprint: string;
}

export function SudoGrantPreview({
  host,
  password,
  onReview,
  onError,
}: {
  host: string;
  password: string;
  onReview: (fingerprint: string | undefined) => void;
  onError: (error: unknown) => unknown;
}) {
  const [preview, setPreview] = useState<GrantPreview>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  async function review() {
    if (loading || !password) return;
    onReview(undefined);
    setPreview(undefined);
    setError(undefined);
    setLoading(true);
    try {
      const result = await ownerCall<{ grant: GrantPreview }>(
        "/v1/owner/hosts/preview-grant",
        { host, password },
      );
      setPreview(result.grant);
      if (!result.grant.foreign) onReview(result.grant.fingerprint);
    } catch (failure) {
      onError(failure);
      setError(describeError(failure));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="stack">
      <div>
        <button
          type="button"
          disabled={loading || !password}
          onClick={() => void review()}
        >
          {loading
            ? "Reading sudo rules"
            : preview
              ? "Refresh sudo preview"
              : "Preview sudo rules"}
        </button>
      </div>
      {preview ? (
        <section className="stack" aria-label="Sudo rules preview">
          <p>
            <code>{preview.path}</code>
          </p>
          {preview.foreign ? (
            <Notice tone="warn">
              The existing file belongs to another tool or administrator.
              Homectl leaves it in place.
            </Notice>
          ) : preview.changed ? (
            <pre className="mono" aria-label="Sudoers diff">
              {preview.diff}
            </pre>
          ) : (
            <Notice>The installed rules already match.</Notice>
          )}
        </section>
      ) : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
    </div>
  );
}
