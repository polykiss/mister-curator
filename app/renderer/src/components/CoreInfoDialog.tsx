import { Copy } from 'lucide-react';
import type { JSX, ReactNode } from 'react';
import { toast } from 'sonner';

import type { SystemCatalogWireEntry } from '@shared/preload-api';
import type { CoreEntry } from '@shared/types';

import { Button } from '@app/renderer/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@app/renderer/src/components/ui/dialog';

interface Props {
  readonly core: CoreEntry | null;
  readonly catalog: Record<string, SystemCatalogWireEntry> | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function CoreInfoDialog({
  core,
  catalog,
  open,
  onOpenChange,
}: Props): JSX.Element {
  const catalogEntry = core !== null ? (catalog?.[core.id] ?? null) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Core info</DialogTitle>
        </DialogHeader>

        {core !== null ? (
          <div className="space-y-4 text-body">
            {/* ── Core ─────────────────────────────────────────── */}
            <InfoSection title="Core">
              <InfoRow label="Core ID">
                <span className="font-mono">{core.id}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 text-fg-muted hover:text-fg"
                  onClick={() => {
                    void navigator.clipboard.writeText(core.id).then(() => {
                      toast.success('Copied');
                    });
                  }}
                  aria-label="Copy core ID to clipboard"
                >
                  <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
                </Button>
              </InfoRow>

              <InfoRow label="Category">{core.category}</InfoRow>

              <InfoRow label="RBF paths">
                {core.rbfPaths.length === 0 ? (
                  <span className="text-fg-muted">—</span>
                ) : (
                  <div className="space-y-0.5">
                    {core.rbfPaths.map((p) => (
                      <div key={p} className="font-mono text-fg-muted">
                        {p}
                      </div>
                    ))}
                  </div>
                )}
              </InfoRow>

              <InfoRow label="Games dir">{core.gamesDirName ?? '—'}</InfoRow>
            </InfoSection>

            <hr className="border-subtle" />

            {/* ── ROM library ───────────────────────────────────── */}
            <InfoSection title="ROM library">
              <InfoRow label="Games dir status">
                {!core.gamesDirExists ? (
                  <span className="text-fg-muted">Missing</span>
                ) : core.gamesDirHidden ? (
                  <span>Hidden (dot-prefixed)</span>
                ) : (
                  <span>Available</span>
                )}
              </InfoRow>

              <InfoRow label="ROM count">
                <CountDisplay
                  count={core.romCount}
                  recursive={core.recursiveRomCount}
                />
              </InfoRow>

              <InfoRow label="Hidden">
                <CountDisplay
                  count={core.hiddenCount}
                  recursive={core.recursiveHiddenCount}
                />
              </InfoRow>

              {core.arcadePlayableCount !== undefined ? (
                <InfoRow label="Playable arcade">
                  {String(core.arcadePlayableCount)}
                </InfoRow>
              ) : null}
            </InfoSection>

            <hr className="border-subtle" />

            {/* ── ScreenScraper ─────────────────────────────────── */}
            <InfoSection title="ScreenScraper">
              {catalogEntry !== null ? (
                <>
                  <InfoRow label="System ID">{String(catalogEntry.id)}</InfoRow>
                  <InfoRow label="Display name">{catalogEntry.displayName}</InfoRow>
                  <InfoRow label="Has logo">
                    {catalogEntry.logoUrl !== null ? 'Yes' : 'No'}
                  </InfoRow>
                </>
              ) : (
                <p className="text-body-sm text-fg-muted">
                  No ScreenScraper mapping for this core.
                </p>
              )}
            </InfoSection>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ─── layout helpers ──────────────────────────────────────────────────────────

function InfoSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="space-y-2">
      <h3 className="text-body-sm font-medium uppercase tracking-wide text-fg-muted">
        {title}
      </h3>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function InfoRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <span className="w-36 shrink-0 text-body-sm text-fg-muted">{label}</span>
      <span className="flex flex-1 flex-wrap items-center gap-2 text-body">
        {children}
      </span>
    </div>
  );
}

function CountDisplay({
  count,
  recursive,
}: {
  count: number;
  recursive?: number;
}): JSX.Element {
  if (recursive !== undefined && recursive !== count) {
    return (
      <span>
        {String(count)}{' '}
        <span className="text-fg-muted">({String(recursive)} recursive)</span>
      </span>
    );
  }
  return <span>{String(count)}</span>;
}
