// The one place a visitor's scope changes. The filter and the gate only read a VisitorScope (see
// allow.ts); the owner's office holds the MutableScope and gives or takes a floor with `grant` and
// `revoke`, so the floor, its kanban project and its verified repositories can never fall out of step.
import type { VisitorScope } from './allow.js';

export class MutableScope implements VisitorScope {
  private readonly floorSet = new Set<string>();
  private readonly projectSet = new Set<string>();
  private readonly repoMap = new Map<string, ReadonlySet<string>>();

  constructor(readonly login: string) {}

  get floors(): ReadonlySet<string> {
    return this.floorSet;
  }

  get projects(): ReadonlySet<string> {
    return this.projectSet;
  }

  get repos(): ReadonlyMap<string, ReadonlySet<string>> {
    return this.repoMap;
  }

  /** The visitor may see floor `floorId` (and its project), verified against `repos` (see VisitorScope.repos). */
  grant(floorId: string, repos: ReadonlySet<string>) {
    this.floorSet.add(floorId);
    this.projectSet.add(floorId);
    this.repoMap.set(floorId, repos);
  }

  /** The visitor no longer may; true when they had it. */
  revoke(floorId: string): boolean {
    this.projectSet.delete(floorId);
    this.repoMap.delete(floorId);
    return this.floorSet.delete(floorId);
  }
}
