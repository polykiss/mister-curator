import type { Rom } from '@shared/types';

/**
 * PR #23 round 3 part 2 — visual row-type taxonomy for the ROMs pane.
 *
 * Distinct from the underlying `Rom.kind` (`'file' | 'folder-atomic' |
 * 'folder-container'`) which encodes IPC-level semantics. `RowType`
 * encodes the SHAPE of the row in the table — what tile sits in the
 * thumbnail column, whether year/genre/rating mean anything, whether
 * the row pins to the top of the sort, etc.
 *
 *   • `game`              — a launchable file ROM. Box-art tile, full
 *                           metadata columns, sorts as the user asks.
 *   • `single-game-folder`— a folder that contains one game (the
 *                           X68000-style `<game>/<game>.zip` shape).
 *                           Box-art tile + folder badge overlay; sorts
 *                           with games (NOT pinned), since the user
 *                           thinks of it as "the game" rather than "a
 *                           folder".
 *   • `explorable-folder` — a multi-game / nested folder. 40px tile
 *                           with a FolderOpen icon, no metadata,
 *                           pinned to top by the sort.
 *   • `back`              — the synthetic "../up one level" row at
 *                           the top of a drilled-into folder. 40px
 *                           tile with a back icon, no metadata, no
 *                           sort participation (rendered separately).
 *
 * The mapping from `Rom.kind` is direct because the backend's
 * `classifyFolder` (in `shared/folder-rom.ts`) already encodes the
 * "is this folder one game?" signal as `'folder-atomic'`. We don't
 * re-run the analysis here — the source of truth stays in one place.
 */

export type RowType =
  | 'game'
  | 'single-game-folder'
  | 'explorable-folder'
  | 'back';

/**
 * Discriminated union over the two row payloads the ROMs table
 * renders: a real Rom, or the synthetic back-marker. Keeping `back`
 * in the union (rather than special-casing at every call site) lets
 * the renderer pass any row through one classifier and branch on a
 * single value downstream.
 */
export type RowPayload =
  | { readonly kind: 'rom'; readonly rom: Rom }
  | { readonly kind: 'back' };

export function classifyRow(payload: RowPayload): RowType {
  if (payload.kind === 'back') return 'back';
  switch (payload.rom.kind) {
    case 'file':
      return 'game';
    case 'folder-atomic':
      return 'single-game-folder';
    case 'folder-container':
      return 'explorable-folder';
  }
}
