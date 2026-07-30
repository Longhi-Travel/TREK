import { useState } from 'react';
import { Lock, Paperclip } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';

/**
 * Guest-side document access for the public shared page.
 *
 * - Normal files open with a plain same-origin GET (no secrets in the URL).
 * - Sensitive files need an unlock token: the guest enters the operator-issued
 *   code once, we exchange it at POST /api/shared/:token/files/unlock and keep
 *   the resulting short-lived token in sessionStorage (session-scoped by
 *   design — NEVER localStorage), then fetch the bytes with the X-Share-Unlock
 *   header and open them from an object URL so the unlock token never appears
 *   in a URL, browser history or server log.
 */

export interface SharedFileMeta {
  id: string;
  name: string;
  mime: string | null;
  size: number | null;
  sensitivity: 'sensitive' | 'normal';
  description: string | null;
}

const unlockStorageKey = (token: string) => `trek-shared-unlock:${token}`;

function storedUnlock(token: string): string | null {
  try {
    const raw = sessionStorage.getItem(unlockStorageKey(token));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { t: string; exp: number };
    if (!parsed.t || parsed.exp < Date.now() + 30_000) return null;
    return parsed.t;
  } catch {
    return null;
  }
}

async function openWithUnlock(token: string, file: SharedFileMeta, unlock: string): Promise<boolean> {
  const res = await fetch(`/api/shared/${encodeURIComponent(token)}/file/${encodeURIComponent(file.id)}`, {
    headers: { 'X-Share-Unlock': unlock },
  });
  if (!res.ok) return false;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  // PDFs/images open inline in a tab; everything else downloads with its name.
  const inline = (file.mime || '').match(/^(application\/pdf|image\/)/);
  if (inline) a.target = '_blank';
  else a.download = file.name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

export function SharedFileChips({ files }: { files: SharedFileMeta[] | undefined }) {
  const { t } = useTranslation();
  const { token } = useParams<{ token: string }>();
  const [unlockFor, setUnlockFor] = useState<SharedFileMeta | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<'invalid' | 'locked' | null>(null);
  const [busy, setBusy] = useState(false);

  if (!files || files.length === 0 || !token) return null;

  const openFile = async (file: SharedFileMeta) => {
    if (file.sensitivity === 'normal') {
      window.open(`/api/shared/${encodeURIComponent(token)}/file/${encodeURIComponent(file.id)}`, '_blank', 'noopener');
      return;
    }
    const existing = storedUnlock(token);
    if (existing && (await openWithUnlock(token, file, existing))) return;
    setError(null);
    setCode('');
    setUnlockFor(file);
  };

  const submitCode = async () => {
    if (!unlockFor || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/shared/${encodeURIComponent(token)}/files/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (res.status === 429) {
        setError('locked');
        return;
      }
      if (!res.ok) {
        setError('invalid');
        return;
      }
      const data = (await res.json()) as { unlock: string; expiresAt: string };
      try {
        sessionStorage.setItem(
          unlockStorageKey(token),
          JSON.stringify({ t: data.unlock, exp: Date.parse(data.expiresAt) || Date.now() + 3_600_000 })
        );
      } catch {
        /* private mode — the in-memory token below still works this once */
      }
      const target = unlockFor;
      setUnlockFor(null);
      setCode('');
      await openWithUnlock(token, target, data.unlock);
    } catch {
      setError('invalid');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {files.map((f) => (
          <button
            key={f.id}
            onClick={(e) => {
              e.stopPropagation();
              openFile(f);
            }}
            className="bg-surface-tertiary text-content-secondary border border-edge-faint"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '3px 9px',
              borderRadius: 14,
              fontSize: 'calc(10.5px * var(--fs-scale-caption, 1))',
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
              maxWidth: 240,
            }}
            title={f.sensitivity === 'sensitive' ? t('shared.sensitiveLocked') : f.name}
          >
            {f.sensitivity === 'sensitive' ? <Lock size={10} color="var(--warning)" /> : <Paperclip size={10} />}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
          </button>
        ))}
      </div>

      {unlockFor && (
        <div
          onClick={() => !busy && setUnlockFor(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'var(--overlay)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-surface-card"
            style={{ borderRadius: 14, padding: '20px 22px', maxWidth: 360, width: '100%', boxShadow: 'var(--shadow-modal)' }}
          >
            <div className="text-content" style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, marginBottom: 6 }}>
              <Lock size={15} color="var(--warning)" /> {t('shared.unlockTitle')}
            </div>
            <p className="text-content-muted" style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))', margin: '0 0 12px', lineHeight: 1.5 }}>
              {t('shared.unlockHint')}
            </p>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitCode()}
              autoFocus
              autoComplete="off"
              autoCapitalize="off"
              className="text-content bg-surface-input border border-edge"
              style={{
                width: '100%',
                borderRadius: 8,
                padding: '9px 12px',
                fontSize: 'calc(14px * var(--fs-scale-body, 1))',
                fontFamily: 'monospace',
                letterSpacing: 1,
                outline: 'none',
                marginBottom: 10,
              }}
            />
            {error && (
              <div className="text-danger" style={{ fontSize: 'calc(11px * var(--fs-scale-caption, 1))', marginBottom: 10 }}>
                {error === 'locked' ? t('shared.unlockLocked') : t('shared.unlockInvalid')}
              </div>
            )}
            <button
              onClick={submitCode}
              disabled={busy || code.length === 0}
              className="bg-accent text-accent-text"
              style={{
                width: '100%',
                padding: '9px 0',
                borderRadius: 8,
                border: 'none',
                fontWeight: 700,
                fontSize: 'calc(13px * var(--fs-scale-body, 1))',
                cursor: busy ? 'wait' : 'pointer',
                fontFamily: 'inherit',
                opacity: code.length === 0 ? 0.6 : 1,
              }}
            >
              {t('shared.unlock')}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
