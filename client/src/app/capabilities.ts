/**
 * The app's capabilities (T25-015; plan #216 Part 2a): everything they gate is off until M-UI4.
 * The Inspector's environment and the Board list's ranking caption (T24-023) read them.
 */
export const CAPABILITIES = Object.freeze({ investigations: false, alerting: false, ai: false });
