// Visitors cannot add pictures to someone else's whiteboard (the accepted scope of visiting): a
// picture goes up by POST, and a visitor's browser sends no writes anywhere but through the
// pipe, so an upload would land in the visitor's OWN office under the visited floor's id. The
// whiteboard window blocks it at the tool, at paste and drop, and again here at the upload itself.
import { visiting } from '../../multiplayer/visit';

export const NO_PICTURES_HINT = "Pictures can't be added while visiting";

/** Whether this page may put pictures on a board. */
export const canAddPictures = (): boolean => !visiting();

/** Runs `go` (the upload) unless visiting, in which case nothing is requested at all: says `hint` and resolves false. */
export function uploadUnlessVisiting(go: () => Promise<boolean>, hint: (text: string) => void): Promise<boolean> {
  if (canAddPictures()) return go();
  hint(NO_PICTURES_HINT);
  return Promise.resolve(false);
}
