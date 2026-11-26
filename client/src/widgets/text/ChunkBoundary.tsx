/** Stub (tests first): plan #198 Part 3a §4.2. */
import { Component, type ReactNode } from 'react';

export class ChunkBoundary extends Component<{ fallback: ReactNode; children: ReactNode }> {
  override render(): ReactNode {
    return this.props.children;
  }
}
