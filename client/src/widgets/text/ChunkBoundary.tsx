/**
 * The boundary around the lazy Markdown entry (plan #198 Part 3a §4.2, state 4): a chunk that fails
 * to load shows `fallback` instead of breaking the board. There is no retry: React keeps the
 * rejected lazy component, so a reload is the way back (the message says so).
 */
import { Component, type ReactNode } from 'react';

export interface ChunkBoundaryProps {
  readonly fallback: ReactNode;
  readonly children: ReactNode;
}

export class ChunkBoundary extends Component<ChunkBoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
