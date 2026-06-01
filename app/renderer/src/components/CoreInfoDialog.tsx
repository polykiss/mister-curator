import { Copy } from 'lucide-react';
import type { JSX, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import type { SystemCatalogWireEntry, WikipediaSummary } from '@shared/preload-api';
import type { CoreEntry } from '@shared/types';

import { Button } from '@app/renderer/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@app/renderer/src/components/ui/dialog';
import { Skeleton } from '@app/renderer/src/components/ui/skeleton';

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
  // fix/core-info-dialog-v2-regressions — defensive self-fetch so the
  // dialog works even when the parent's systemCatalog state is still null
  // (cold-cache scenario: ensureCatalog() on the main side is still
  // fetching when CoresPane's useEffect first fires). We merge the
  // parent-prop catalog with a locally-fetched fallback; parent wins
  // once it populates.
  const [localCatalog, setLocalCatalog] = useState<Record<string, SystemCatalogWireEntry> | null>(null);

  useEffect(() => {
    if (!open || catalog !== null) return;
    let cancelled = false;
    void window.mister.getSystemCatalog().then((result) => {
      if (cancelled || result === null) return;
      setLocalCatalog(result);
    });
    return () => { cancelled = true; };
  }, [open, catalog]);

  const effectiveCatalog = catalog ?? localCatalog;
  const catalogEntry = core !== null ? (effectiveCatalog?.[core.id] ?? null) : null;

  // ── logo fetch ─────────────────────────────────────────────────────
  const logoUrlRef = useRef<string | null>(null);
  const [logoObjectUrl, setLogoObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (logoUrlRef.current !== null) {
        URL.revokeObjectURL(logoUrlRef.current);
        logoUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const url = catalogEntry?.logoUrl ?? null;
    if (url === null) { setLogoObjectUrl(null); return; }
    let cancelled = false;
    void window.mister.getSystemLogoBytes(url).then((bytes) => {
      if (cancelled || bytes === null) return;
      const blob = new Blob([new Uint8Array(bytes)]);
      if (logoUrlRef.current !== null) URL.revokeObjectURL(logoUrlRef.current);
      const created = URL.createObjectURL(blob);
      logoUrlRef.current = created;
      setLogoObjectUrl(created);
    });
    return () => { cancelled = true; };
  }, [catalogEntry?.logoUrl]);

  // ── console photo fetch ────────────────────────────────────────────
  const photoUrlRef = useRef<string | null>(null);
  const [photoObjectUrl, setPhotoObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (photoUrlRef.current !== null) {
        URL.revokeObjectURL(photoUrlRef.current);
        photoUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const url = catalogEntry?.photoUrl ?? null;
    if (url === null) { setPhotoObjectUrl(null); return; }
    let cancelled = false;
    void window.mister.getSystemLogoBytes(url).then((bytes) => {
      if (cancelled || bytes === null) return;
      const blob = new Blob([new Uint8Array(bytes)]);
      if (photoUrlRef.current !== null) URL.revokeObjectURL(photoUrlRef.current);
      const created = URL.createObjectURL(blob);
      photoUrlRef.current = created;
      setPhotoObjectUrl(created);
    });
    return () => { cancelled = true; };
  }, [catalogEntry?.photoUrl]);

  // ── Wikipedia summary ──────────────────────────────────────────────
  const [wikipedia, setWikipedia] = useState<WikipediaSummary | null | 'loading'>('loading');

  useEffect(() => {
    if (catalogEntry === null) { setWikipedia(null); return; }
    setWikipedia('loading');
    let cancelled = false;
    void window.mister.getSystemWikipediaSummary(catalogEntry.id).then((result) => {
      if (cancelled) return;
      setWikipedia(result);
    });
    return () => { cancelled = true; };
  }, [catalogEntry?.id]);

  const displayName = catalogEntry?.displayName ?? core?.id ?? '';
  const hasChips = catalogEntry !== null && (
    catalogEntry.company !== null || catalogEntry.yearStart !== null || catalogEntry.supportType !== null
  );

  // photo source: SS photo, then Wikipedia thumbnail, then nothing
  const photoSrc = photoObjectUrl ?? (
    wikipedia !== 'loading' && wikipedia !== null ? wikipedia.thumbnailUrl : null
  );
  const photoLoading = catalogEntry?.photoUrl !== null && photoObjectUrl === null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[1060px] gap-0 overflow-hidden p-0" hideDefaultClose>
        <DialogTitle className="sr-only">{displayName} — Core info</DialogTitle>
        <DialogDescription className="sr-only">
          Details and metadata for the {displayName} core.
        </DialogDescription>
        {core !== null ? (
          <>
            {/* ── header ─────────────────────────────────────────── */}
            <div className="px-9 pb-6 pt-[30px]">
              <div className="mb-4 text-caption font-bold uppercase tracking-[0.19em] text-fg-muted">
                Core info
              </div>
              <div className="flex flex-wrap items-center gap-[14px]">
                {/* logo */}
                <div className="flex h-12 items-center">
                  {catalogEntry?.logoUrl !== null && catalogEntry !== null ? (
                    logoObjectUrl !== null ? (
                      <img
                        src={logoObjectUrl}
                        alt={displayName}
                        className="max-h-12 max-w-[160px] object-contain invert"
                      />
                    ) : (
                      <Skeleton className="h-12 w-[120px]" />
                    )
                  ) : (
                    <span className="text-heading-sm font-bold tracking-[-0.01em] text-fg">
                      {displayName}
                    </span>
                  )}
                </div>
                {catalogEntry?.logoUrl !== null && catalogEntry !== null && (
                  <>
                    <span className="h-4 w-px bg-border-default" />
                    <span className="text-heading-sm font-bold tracking-[-0.01em] text-fg">
                      {displayName}
                    </span>
                  </>
                )}
                {hasChips && (
                  <>
                    <span className="h-4 w-px bg-border-default" />
                    <div className="flex flex-wrap gap-[7px]">
                      {catalogEntry!.company !== null && (
                        <Chip dot>{catalogEntry!.company}</Chip>
                      )}
                      {(catalogEntry!.yearStart !== null || catalogEntry!.yearEnd !== null) && (
                        <Chip>{formatYears(catalogEntry!.yearStart, catalogEntry!.yearEnd)}</Chip>
                      )}
                      {catalogEntry!.supportType !== null && (
                        <Chip>{catalogEntry!.supportType}</Chip>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>

            <hr className="border-border-default" />

            {/* ── body ───────────────────────────────────────────── */}
            <div className="grid" style={{ gridTemplateColumns: '1.4fr 320px' }}>

              {/* LEFT — stat sections */}
              <div className="px-9 pb-[34px] pt-[30px]">

                <StatSection title="Core">
                  <StatGrid>
                    <StatCell label="Core ID" span={1}>
                      <span className="flex items-center gap-1.5">
                        <span className="font-mono text-body text-fg">{core.id}</span>
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
                      </span>
                    </StatCell>
                    <StatCell label="Category">{core.category}</StatCell>
                    <StatCell label="Games dir">{core.gamesDirName ?? '—'}</StatCell>
                    {core.rbfPaths.length > 0 && (
                      <StatCell label="RBF path" mono span={3}>
                        {core.rbfPaths[0]}
                        {core.rbfPaths.length > 1 && (
                          <span className="ml-2 text-fg-muted">
                            +{core.rbfPaths.length - 1} more
                          </span>
                        )}
                      </StatCell>
                    )}
                  </StatGrid>
                </StatSection>

                <hr className="my-7 border-border-default" />

                <StatSection title="ROM library">
                  <StatGrid>
                    <StatCell label="Status">
                      {!core.gamesDirExists ? (
                        <span className="text-fg-muted">Missing</span>
                      ) : core.gamesDirHidden ? (
                        'Hidden'
                      ) : (
                        'Available'
                      )}
                    </StatCell>
                    <StatCell label="ROM count">
                      <CountDisplay count={core.romCount} recursive={core.recursiveRomCount} />
                    </StatCell>
                    <StatCell label="Hidden">
                      <CountDisplay count={core.hiddenCount} recursive={core.recursiveHiddenCount} />
                    </StatCell>
                    {core.arcadePlayableCount !== undefined && (
                      <StatCell label="Playable arcade">
                        {String(core.arcadePlayableCount)}
                      </StatCell>
                    )}
                  </StatGrid>
                </StatSection>

                {catalogEntry !== null && (
                  <>
                    <hr className="my-7 border-border-default" />

                    <StatSection title="ScreenScraper">
                      <StatGrid>
                        <StatCell label="System ID">{String(catalogEntry.id)}</StatCell>
                        <StatCell label="Display name">{catalogEntry.displayName}</StatCell>
                        {catalogEntry.company !== null && (
                          <StatCell label="Manufacturer">{catalogEntry.company}</StatCell>
                        )}
                        {catalogEntry.type !== null && (
                          <StatCell label="Type">{catalogEntry.type}</StatCell>
                        )}
                        {(catalogEntry.yearStart !== null || catalogEntry.yearEnd !== null) && (
                          <StatCell label="Years">
                            {formatYears(catalogEntry.yearStart, catalogEntry.yearEnd)}
                          </StatCell>
                        )}
                        {catalogEntry.supportType !== null && (
                          <StatCell label="Format">{catalogEntry.supportType}</StatCell>
                        )}
                        {catalogEntry.extensions.length > 0 && (
                          <StatCell label="Extensions" mono span={3}>
                            {catalogEntry.extensions.join(', ')}
                          </StatCell>
                        )}
                      </StatGrid>
                    </StatSection>
                  </>
                )}
              </div>

              {/* RIGHT — console image + about + facts */}
              <div
                className="flex flex-col border-l border-border-default px-7 pb-8 pt-[30px]"
                style={{ background: '#1c2531' }}
              >
                {/* console photo */}
                {(catalogEntry?.photoUrl !== null || (wikipedia !== 'loading' && wikipedia?.thumbnailUrl)) ? (
                  <div className="mb-[22px]">
                    {photoLoading ? (
                      <Skeleton className="h-[196px] w-full rounded-[11px]" />
                    ) : photoSrc !== null ? (
                      <ConsolePhotoCard src={photoSrc} alt={displayName} />
                    ) : null}
                  </div>
                ) : catalogEntry === null ? null : (
                  <div className="mb-[22px] h-[196px] w-full rounded-[11px] border border-border-default bg-elevated" />
                )}

                {/* About section */}
                {catalogEntry !== null && (
                  <>
                    <div className="mb-3 flex items-center gap-[9px]">
                      <span className="inline-block h-[6px] w-[6px] rounded-[2px] bg-accent" />
                      <span className="text-body-sm font-bold uppercase tracking-[0.15em] text-fg-muted">
                        About
                      </span>
                    </div>
                    {wikipedia === 'loading' ? (
                      <div className="space-y-2">
                        <Skeleton className="h-3 w-full" />
                        <Skeleton className="h-3 w-[90%]" />
                        <Skeleton className="h-3 w-[80%]" />
                        <Skeleton className="h-3 w-full" />
                        <Skeleton className="h-3 w-[70%]" />
                      </div>
                    ) : wikipedia !== null ? (
                      <div className="max-h-[220px] overflow-y-auto">
                        <p className="text-body leading-[1.62] text-[#bcc4d0] [text-wrap:pretty]">
                          {wikipedia.extract}
                        </p>
                      </div>
                    ) : (
                      <p className="text-body-sm text-fg-muted">
                        No Wikipedia article available.
                      </p>
                    )}

                    {/* Facts table */}
                    <div className="mt-[22px]">
                      {catalogEntry.company !== null && (
                        <FactRow k="Manufacturer" v={catalogEntry.company} />
                      )}
                      {(catalogEntry.yearStart !== null || catalogEntry.yearEnd !== null) && (
                        <FactRow k="Released" v={formatYears(catalogEntry.yearStart, catalogEntry.yearEnd)} />
                      )}
                      {catalogEntry.supportType !== null && (
                        <FactRow k="Media" v={catalogEntry.supportType} />
                      )}
                      {catalogEntry.type !== null && (
                        <FactRow k="Type" v={catalogEntry.type} />
                      )}
                    </div>
                  </>
                )}

                {catalogEntry === null && (
                  <p className="text-body-sm text-fg-muted">
                    No ScreenScraper mapping for this core.
                  </p>
                )}
              </div>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ─── local helpers ────────────────────────────────────────────────────────────

function Chip({ dot, children }: { dot?: boolean; children: ReactNode }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-[6px] rounded-full border border-border-default bg-elevated px-[10px] py-[4px] text-body-sm font-medium text-fg">
      {dot && <span className="inline-block h-[5px] w-[5px] rounded-full bg-accent" />}
      {children}
    </span>
  );
}

function StatSection({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <div>
      <div className="mb-5 flex items-center gap-[9px]">
        <span className="inline-block h-[6px] w-[6px] rounded-[2px] bg-accent" />
        <span className="text-body-sm font-bold uppercase tracking-[0.15em] text-fg-muted">
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}

function StatGrid({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="grid grid-cols-3 gap-x-[30px] gap-y-[22px]">
      {children}
    </div>
  );
}

function StatCell({
  label,
  mono,
  span,
  children,
}: {
  label: string;
  mono?: boolean;
  span?: number;
  children: ReactNode;
}): JSX.Element {
  return (
    <div style={span !== undefined ? { gridColumn: `span ${String(span)}` } : undefined}>
      <div className="mb-[7px] text-caption font-semibold uppercase tracking-[0.12em] text-fg-muted">
        {label}
      </div>
      <div
        className={
          mono
            ? 'break-all font-mono text-body tracking-[-0.01em] text-fg'
            : 'text-body font-medium leading-[1.35] text-fg'
        }
      >
        {children}
      </div>
    </div>
  );
}

function FactRow({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <div className="flex justify-between gap-4 border-t border-border-subtle py-[10px] text-body-lg">
      <span className="text-fg-muted">{k}</span>
      <span className="font-medium text-fg">{v}</span>
    </div>
  );
}

function ConsolePhotoCard({ src, alt }: { src: string; alt: string }): JSX.Element {
  return (
    <div
      className="relative h-[196px] w-full overflow-hidden rounded-[11px] border border-border-default"
      style={{ background: 'linear-gradient(158deg, #f6f8fa 0%, #e4e9ee 100%)' }}
    >
      <img
        src={src}
        alt={alt}
        className="absolute inset-0 h-full w-full object-contain p-3"
      />
    </div>
  );
}

function formatYears(start: number | null, end: number | null): string {
  if (start === null) return end !== null ? String(end) : '—';
  if (end === null) return `${String(start)}–present`;
  if (start === end) return String(start);
  return `${String(start)}–${String(end)}`;
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
        <span className="text-fg-muted">({String(recursive)} rec.)</span>
      </span>
    );
  }
  return <span>{String(count)}</span>;
}
