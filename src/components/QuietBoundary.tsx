// Renders nothing in place of children that failed to render. For what only
// an addon fills — a slot's buttons, the notices bell — which must never take
// the screen around it down: whatever an addon left, the worst it can do is
// not show up. Not reported: what failed came from an addon's data, not from
// the app.
import { Component, type ReactNode } from 'react';

export class QuietBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export default QuietBoundary;
